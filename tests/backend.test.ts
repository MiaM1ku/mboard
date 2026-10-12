import { afterEach, describe, expect, test } from 'bun:test';
import { createApp, type AppOptions } from '../src/server/app';
import { startServer } from '../src/server/server';
import { hash } from '../src/server/database';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const apps: ReturnType<typeof createApp>[] = [];
const dirs: string[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const pass = 'correct horse battery 123';
function harness(options: AppOptions = {}) {
  const app = createApp(options); apps.push(app);
  async function request(path: string, method = 'GET', data?: any, cookie?: string, extra?: HeadersInit) {
    const headers = new Headers(extra); if (cookie) headers.set('cookie', cookie);
    if (!['GET','HEAD'].includes(method) && !path.startsWith('/api/node/')) headers.set('origin', headers.get('origin') ?? 'http://localhost');
    if (data !== undefined) headers.set('content-type', 'application/json');
    const response = await app.fetch(new Request(`http://localhost${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }));
    const text = await response.text(); let body: any; try { body = JSON.parse(text); } catch { body = text; }
    return { response, status: response.status, body, data: body?.data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  return { app, request };
}
async function fixture(options: AppOptions = {}) {
  const h = harness(options);
  const setup = await h.request('/api/v1/auth/setup','POST',{email:'admin@example.com',name:'管理者',password:pass});
  expect(setup.status).toBe(201); const admin = setup.cookie!;
  const g1 = (await h.request('/api/v1/admin/groups','POST',{name:'基础组'},admin)).data;
  const g2 = (await h.request('/api/v1/admin/groups','POST',{name:'独立组'},admin)).data;
  const machine = (await h.request('/api/v1/admin/machines','POST',{name:'机器 A',host:'node.example.com',enabled:true},admin)).data;
  const user = (await h.request('/api/v1/admin/users','POST',{email:'user@example.com',name:'用户',password:pass,enabled:true,quota_bytes:10000,expires_at:null,group_ids:[g1.id]},admin)).data;
  const node = (await h.request('/api/v1/admin/nodes','POST',{name:'VLESS',host:'node.example.com',port:443,protocol:'vless',enabled:true,machine_id:machine.machine.id,group_ids:[g1.id],tls:true,server_name:'node.example.com'},admin)).data;
  const login = await h.request('/api/v1/auth/login','POST',{email:'user@example.com',password:pass});
  expect(login.status).toBe(200);
  return { ...h,admin,user,userCookie:login.cookie!,login:login.data,g1,g2,machine:machine.machine,token:machine.token,node,
    nodeRequest: (path:string, method = 'GET', body?:any, token = machine.token) => h.request(`/api/node/v1/${path}`,method,body,undefined,{'authorization':`Bearer ${token}`}) };
}

describe('fresh installation, atomic setup and authentication', () => {
  test('fresh database is empty and concurrent setup creates one admin', async () => {
    const h = harness();
    expect((await h.request('/api/v1/auth/status')).data).toEqual({setup_required:true,user:null});
    expect(h.app.db.query('SELECT count(*) n FROM users').get()).toEqual({n:0});
    const input = {email:'admin@example.com',name:'管理员',password:pass};
    const replies = await Promise.all(Array.from({length:4},() => h.request('/api/v1/auth/setup','POST',input)));
    expect(replies.map(r => r.status).sort()).toEqual([201,409,409,409]);
    const win = replies.find(r => r.status === 201)!;
    expect(win.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(win.response.headers.get('set-cookie')).toContain('SameSite=Strict');
    expect((await h.request('/api/v1/auth/status','GET',undefined,win.cookie)).data.setup_required).toBe(false);
    expect((await h.request('/api/v1/me','GET',undefined,win.cookie)).data.role).toBe('admin');
    expect(h.app.db.query('SELECT count(*) n FROM users').get()).toEqual({n:1});
  });
  test('rejects weak passwords, foreign origins, malformed bodies and SQL injection', async () => {
    const h = harness(); const b = {email:'admin@example.com',name:'Admin',password:'short'};
    expect((await h.request('/api/v1/auth/setup','POST',b)).status).toBe(400);
    expect((await h.request('/api/v1/auth/setup','POST',{...b,password:pass},undefined,{origin:'https://evil.example'})).status).toBe(403);
    const missingOrigin = await h.app.fetch(new Request('http://localhost/api/v1/auth/setup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...b,password:pass})}));
    expect(missingOrigin.status).toBe(403);
    const malformed = await h.app.fetch(new Request('http://localhost/api/v1/auth/setup',{method:'POST',headers:{origin:'http://localhost','content-type':'application/json'},body:'{' }));
    expect(malformed.status).toBe(400);
    const setup = await h.request('/api/v1/auth/setup','POST',{...b,password:pass});
    expect((await h.request('/api/v1/auth/login','POST',{email:"'OR1=1--@example.com",password:pass})).status).toBe(401);
    expect((await h.request('/api/v1/admin/groups','POST',{name:"'); DROP TABLE users; --"},setup.cookie)).status).toBe(201);
    expect((await h.request('/api/v1/me','GET',undefined,setup.cookie)).status).toBe(200);
    expect((await h.request('/api/v1/auth/login','POST',{email:b.email,password:'wrong'})).body.error).toMatchObject({code:'LOGIN_FAILED'});
  });
  test('rate limits login and does not trust spoofed proxy headers by default', async () => {
    const h = harness({loginLimit:2});
    for(let i=0;i<2;i++) expect((await h.request('/api/v1/auth/login','POST',{email:'a@b.com',password:'bad'},undefined,{'x-forwarded-for':`10.0.0.${i}`})).status).toBe(401);
    expect((await h.request('/api/v1/auth/login','POST',{email:'a@b.com',password:'bad'},undefined,{'x-forwarded-for':'different'})).status).toBe(429);
  });
  test('proxy users have separate account buckets and a bounded shared peer ceiling', async () => {
    let clock = new Date('2026-10-13T00:00:00Z'); const h = harness({loginLimit:2,peerLoginLimit:5,now:()=>clock});
    const login = (addr:string) => h.request('/api/v1/auth/login','POST',{email:addr,password:'wrong'});
    expect((await login('first@example.com')).status).toBe(401);
    expect((await login('first@example.com')).status).toBe(401);
    expect((await login('first@example.com')).status).toBe(429);
    expect((await login('second@example.com')).status).toBe(401);
    expect((await login('second@example.com')).status).toBe(401);
    expect((await login('third@example.com')).status).toBe(429);
    clock = new Date(clock.getTime()+900001);
    expect((await login('first@example.com')).status).toBe(401);
  });
  test('HTTPS session cookies are secure and logout invalidates the session', async () => {
    const h = harness();
    const r = await h.app.fetch(new Request('https://localhost/api/v1/auth/setup',{method:'POST',headers:{origin:'https://localhost','content-type':'application/json'},body:JSON.stringify({email:'a@b.com',name:'Admin',password:pass})}));
    const cookie = r.headers.get('set-cookie')!; expect(cookie).toContain('; Secure');
    const session = cookie.split(';')[0];
    expect((await h.request('/api/v1/auth/logout','POST',undefined,session)).status).toBe(200);
    expect((await h.request('/api/v1/me','GET',undefined,session)).status).toBe(401);
  });
  test('explicit public origin supports HTTPS proxy cookies without trusting forwarded headers', async () => {
    const h = harness({publicOrigin:'https://panel.example.com'});
    const input = {email:'admin@example.com',name:'管理员',password:pass};
    const wrong = await h.request('/api/v1/auth/setup','POST',input,undefined,{'x-forwarded-proto':'https','x-forwarded-host':'panel.example.com'});
    expect(wrong.status).toBe(403);
    const response = await h.request('/api/v1/auth/setup','POST',input,undefined,{origin:'https://panel.example.com'});
    expect(response.status).toBe(201); expect(response.response.headers.get('set-cookie')).toContain('; Secure');
    expect((await h.request('/api/v1/admin/groups','POST',{name:'可用组'},response.cookie,{origin:'https://panel.example.com'})).status).toBe(201);
    expect((await h.request('/api/v1/admin/groups','POST',{name:'其他组'},response.cookie,{origin:'https://evil.example.com'})).status).toBe(403);
    for (const origin of ['https://panel.example.com/path','https://user:password@panel.example.com','file:///tmp','https://panel.example.com?x=1','https://panel.example.com#hash']) expect(()=>createApp({publicOrigin:origin})).toThrow();
    const dev = harness({publicOrigin:'http://127.0.0.1:5180'});
    const devSetup = await dev.request('/api/v1/auth/setup','POST',input,undefined,{origin:'http://127.0.0.1:5180'});
    expect(devSetup.status).toBe(201); expect(devSetup.response.headers.get('set-cookie')).not.toContain('; Secure');
  });
  test('password change revokes other sessions but preserves current session', async () => {
    const f = await fixture();
    const second = await f.request('/api/v1/auth/login','POST',{email:f.user.email,password:pass});
    expect((await f.request('/api/v1/me/password','PATCH',{current_password:'wrong',new_password:pass+'new'},f.userCookie)).status).toBe(400);
    expect((await f.request('/api/v1/me/password','PATCH',{current_password:pass,new_password:pass+'new'},f.userCookie)).status).toBe(200);
    expect((await f.request('/api/v1/me','GET',undefined,second.cookie)).status).toBe(401);
    expect((await f.request('/api/v1/me','GET',undefined,f.userCookie)).status).toBe(200);
    expect((await f.request('/api/v1/auth/login','POST',{email:f.user.email,password:pass})).status).toBe(401);
    expect((await f.request('/api/v1/auth/login','POST',{email:f.user.email,password:pass+'new'})).status).toBe(200);
  });
  test('session expires and disabled users cannot log in or retain a session', async () => {
    let clock = new Date('2026-10-13T00:00:00Z');
    const f = await fixture({now:()=>clock,sessionSeconds:60});
    expect((await f.request(`/api/v1/admin/users/${f.user.id}`,'PATCH',{enabled:false},f.admin)).status).toBe(200);
    expect((await f.request('/api/v1/me','GET',undefined,f.userCookie)).status).toBe(401);
    expect((await f.request('/api/v1/auth/login','POST',{email:f.user.email,password:pass})).status).toBe(401);
    clock = new Date(clock.getTime()+61000);
    expect((await f.request('/api/v1/me','GET',undefined,f.admin)).status).toBe(401);
  });
});

describe('RBAC, grants, subscriptions and safe administrative mutations', () => {
  test('user group isolation and real protocol configuration with credential rotation', async () => {
    const f = await fixture();
    const other = await f.request('/api/v1/admin/nodes','POST',{name:'其他组',host:'other.example.com',port:444,protocol:'vless',enabled:true,machine_id:f.machine.id,group_ids:[f.g2.id],tls:false,server_name:''},f.admin);
    expect(other.status).toBe(201);
    const trojan = await f.request('/api/v1/admin/nodes','POST',{name:'Trojan',host:'node.example.com',port:8443,protocol:'trojan',enabled:true,machine_id:f.machine.id,group_ids:[f.g1.id],tls:true,server_name:'node.example.com'},f.admin);
    const ss = await f.request('/api/v1/admin/nodes','POST',{name:'SS',host:'node.example.com',port:8388,protocol:'shadowsocks',enabled:true,machine_id:f.machine.id,group_ids:[f.g1.id],tls:false,server_name:''},f.admin);
    expect(trojan.status).toBe(201); expect(ss.status).toBe(201);
    expect((await f.request('/api/v1/admin/users','GET',undefined,f.userCookie)).status).toBe(403);
    const list = (await f.request('/api/v1/nodes','GET',undefined,f.userCookie)).data;
    expect(list.map((n:any)=>n.id)).toEqual([f.node.id,trojan.data.id,ss.data.id]);
    const users = (await f.request('/api/v1/admin/users','GET',undefined,f.admin)).data;
    expect(users.every((u:any)=>u.subscription_token === '')).toBe(true);
    expect(users.every((u:any)=>!u.password_hash && !u.credential)).toBe(true);
    const sub = await f.request(`/s/${f.login.subscription_token}`);
    expect(sub.status).toBe(200); expect(sub.body.data).toBeUndefined();
    const outbound = sub.body.outbounds.find((o:any)=>o.tag === `node-${f.node.id}`);
    expect(outbound).toMatchObject({type:'vless',server:'node.example.com',server_port:443,tls:{enabled:true,server_name:'node.example.com'}});
    expect(outbound.uuid).toMatch(/^[0-9a-f-]{36}$/);
    const config = (await f.nodeRequest('config')).data;
    const inbound = config.config.inbounds.find((n:any)=>n.tag===`node-${f.node.id}`);
    expect(inbound.users).toEqual([{name:String(f.user.id),uuid:outbound.uuid}]);
    expect(inbound.tls.certificate_path).toBe(`/etc/mboard-node/tls/${f.node.id}.crt`);
    const ssInbound = config.config.inbounds.find((n:any)=>n.tag===`node-${ss.data.id}`);
    expect(ssInbound).toMatchObject({method:'aes-128-gcm',users:[{name:String(f.user.id),password:outbound.uuid}]});
    expect(config.config.inbounds.find((n:any)=>n.tag===`node-${other.data.id}`).users).toEqual([]);
    const rotate = await f.request('/api/v1/me/subscription/rotate','POST',undefined,f.userCookie);
    expect(rotate.status).toBe(200);
    expect((await f.request(`/s/${f.login.subscription_token}`)).status).toBe(404);
    const sub2 = await f.request(`/s/${rotate.data.subscription_token}`);
    const uuid2 = sub2.body.outbounds.find((o:any)=>o.type==='vless').uuid;
    expect(uuid2).not.toBe(outbound.uuid);
    const config2 = (await f.nodeRequest('config')).data;
    expect(config2.revision).toBeGreaterThan(config.revision);
    expect(config2.config.inbounds[0].users[0].uuid).toBe(uuid2);
    const audit = (await f.request('/api/v1/admin/audit','GET',undefined,f.admin)).data;
    expect(JSON.stringify(audit)).not.toContain(rotate.data.subscription_token);
    expect(JSON.stringify(audit)).not.toContain(uuid2);
    expect(JSON.stringify(audit)).not.toContain(pass);
  });
  test('quota crossing, expiry and disabled machines gate configs with new revisions', async () => {
    let clock = new Date('2026-10-13T00:00:00Z'); const f = await fixture({now:()=>clock});
    await f.request(`/api/v1/admin/users/${f.user.id}`,'PATCH',{quota_bytes:10,expires_at:'2026-10-14T00:00:00Z'},f.admin);
    const before = (await f.nodeRequest('config')).data;
    expect((await f.nodeRequest('traffic','POST',{batch_id:'quota',records:[{user_id:f.user.id,node_id:f.node.id,upload_bytes:7,download_bytes:3}]})).data.accepted).toBe(true);
    expect((await f.request(`/s/${f.login.subscription_token}`)).status).toBe(403);
    expect((await f.request('/api/v1/nodes','GET',undefined,f.userCookie)).data).toEqual([]);
    const over = (await f.nodeRequest('config')).data;
    expect(over.revision).toBeGreaterThan(before.revision); expect(over.config.inbounds[0].users).toEqual([]);
    await f.request(`/api/v1/admin/users/${f.user.id}`,'PATCH',{quota_bytes:0},f.admin);
    const restored = (await f.nodeRequest('config')).data; expect(restored.config.inbounds[0].users.length).toBe(1);
    clock = new Date('2026-10-14T00:00:01Z');
    const expired = (await f.nodeRequest('config')).data; expect(expired.revision).toBeGreaterThan(restored.revision); expect(expired.config.inbounds[0].users).toEqual([]);
    expect((await f.request(`/s/${f.login.subscription_token}`)).status).toBe(403);
    await f.request(`/api/v1/admin/machines/${f.machine.id}`,'PATCH',{enabled:false},f.admin);
    expect((await f.nodeRequest('config')).status).toBe(401);
  });
  test('preserves last admin and rejects destructive deletes with dependencies', async () => {
    const f = await fixture(); const adminId = (await f.request('/api/v1/me','GET',undefined,f.admin)).data.id;
    expect((await f.request(`/api/v1/admin/users/${adminId}`,'DELETE',undefined,f.admin)).body.error.code).toBe('LAST_ADMIN');
    expect((await f.request(`/api/v1/admin/users/${adminId}`,'PATCH',{enabled:false},f.admin)).status).toBe(409);
    expect((await f.request(`/api/v1/admin/machines/${f.machine.id}`,'DELETE',undefined,f.admin)).status).toBe(409);
    expect((await f.request(`/api/v1/admin/groups/${f.g1.id}`,'DELETE',undefined,f.admin)).status).toBe(409);
    expect((await f.request('/api/v1/admin/users','POST',{email:'duplicate@example.com',name:'Dup',password:pass,group_ids:[999]},f.admin)).status).toBe(400);
    expect(f.app.db.query('SELECT id FROM users WHERE email=?').get('duplicate@example.com')).toBeNull();
    expect((await f.request(`/api/v1/admin/nodes/${f.node.id}`,'DELETE',undefined,f.admin)).status).toBe(200);
    const config = (await f.nodeRequest('config')).data; expect(config.config.inbounds).toEqual([]);
    expect((await f.request(`/api/v1/admin/users/${f.user.id}`,'DELETE',undefined,f.admin)).status).toBe(200);
    expect((await f.request('/api/v1/me','GET',undefined,f.userCookie)).status).toBe(401);
    expect((await f.request(`/api/v1/admin/groups/${f.g1.id}`,'DELETE',undefined,f.admin)).status).toBe(200);
    expect((await f.request(`/api/v1/admin/machines/${f.machine.id}`,'DELETE',undefined,f.admin)).status).toBe(200);
  });
  test('validates port uniqueness, protocol, enums, groups, lengths and role mass assignment', async () => {
    const f = await fixture();
    const base = {name:'New',host:'node.example.com',port:443,protocol:'vless',machine_id:f.machine.id,tls:false};
    expect((await f.request('/api/v1/admin/nodes','POST',base,f.admin)).status).toBe(409);
    expect((await f.request('/api/v1/admin/nodes','POST',{...base,port:65536},f.admin)).status).toBe(400);
    expect((await f.request('/api/v1/admin/nodes','POST',{...base,protocol:'vmess'},f.admin)).status).toBe(400);
    expect((await f.request('/api/v1/admin/nodes','POST',{...base,protocol:'trojan',port:444,tls:false},f.admin)).status).toBe(400);
    expect((await f.request('/api/v1/admin/nodes','POST',{...base,protocol:'shadowsocks',port:444,tls:true},f.admin)).status).toBe(400);
    expect((await f.request(`/api/v1/admin/users/${f.user.id}`,'PATCH',{role:'admin'},f.admin)).status).toBe(400);
    expect((await f.request(`/api/v1/admin/users/${f.user.id}`,'PATCH',{quota_bytes:1.2},f.admin)).status).toBe(400);
    expect((await f.request('/api/v1/traffic?days=999','GET',undefined,f.userCookie)).status).toBe(400);
    expect((await f.request('/api/v1/traffic?days=x','GET',undefined,f.userCookie)).status).toBe(400);
    expect((await f.request('/api/v1/admin/groups','POST',{name:'x'.repeat(101)},f.admin)).status).toBe(400);
    expect((await f.request('/api/v1/admin/groups','POST',{name:f.g1.name},f.admin)).status).toBe(409);
  });
});

describe('machine authentication, heartbeat and transactional accounting', () => {
  test('tokens are hashed, sessions rejected, rotation disables old token and heartbeat sets online', async () => {
    const f = await fixture();
    const stored = f.app.db.query('SELECT token_hash FROM machines WHERE id=?').get(f.machine.id) as any;
    expect(stored.token_hash).toBe(hash(f.token)); expect(stored.token_hash).not.toBe(f.token);
    expect((await f.request('/api/node/v1/config','GET',undefined,f.admin,{'authorization':`Bearer ${f.token}`})).status).toBe(401);
    expect((await f.request('/api/node/v1/config')).status).toBe(401);
    expect((await f.nodeRequest('config','GET',undefined,'f'.repeat(64))).status).toBe(401);
    const revision = (await f.nodeRequest('config')).data.revision;
    const beat = await f.nodeRequest('heartbeat','POST',{version:'mboard-node/1.0',uptime_seconds:10,config_revision:revision});
    expect(beat.status).toBe(200); expect(beat.data.config_revision).toBe(revision);
    expect((await f.request('/api/v1/admin/machines','GET',undefined,f.admin)).data[0]).toMatchObject({online:true,version:'mboard-node/1.0'});
    expect((await f.request('/api/v1/admin/overview','GET',undefined,f.admin)).data).toMatchObject({online_nodes:1,online_machines:1});
    const token = (await f.request(`/api/v1/admin/machines/${f.machine.id}/token`,'POST',undefined,f.admin)).data.token;
    expect((await f.nodeRequest('config')).status).toBe(401);
    expect((await f.nodeRequest('config','GET',undefined,token)).data.revision).toBeGreaterThan(revision);
  });
  test('duplicate batch and multiple same-user records count once and match ledger', async () => {
    const f = await fixture();
    const batch = {batch_id:'batch-001',records:[{user_id:f.user.id,node_id:f.node.id,upload_bytes:11,download_bytes:13},{user_id:f.user.id,node_id:f.node.id,upload_bytes:17,download_bytes:19}]};
    const replies = await Promise.all(Array.from({length:5},() => f.nodeRequest('traffic','POST',batch)));
    expect(replies.every(r=>r.data.accepted === true)).toBe(true);
    const me = (await f.request('/api/v1/me','GET',undefined,f.userCookie)).data;
    expect(me).toMatchObject({upload_bytes:28,download_bytes:32});
    expect((await f.request('/api/v1/traffic','GET',undefined,f.userCookie)).data[0]).toMatchObject({upload_bytes:28,download_bytes:32});
    const overview = (await f.request('/api/v1/admin/overview','GET',undefined,f.admin)).data;
    expect(overview).toMatchObject({upload_bytes:28,download_bytes:32});
    expect(f.app.db.query('SELECT count(*) n FROM traffic_batches').get()).toEqual({n:1});
  });
  test('ownership, grants and unsafe counters reject entire batch without ledger or counter writes', async () => {
    const f = await fixture();
    const other = (await f.request('/api/v1/admin/machines','POST',{name:'Other',host:'other.example.com',enabled:true},f.admin)).data;
    const foreign = (await f.request('/api/v1/admin/nodes','POST',{name:'foreign',host:'other.example.com',port:443,protocol:'vless',machine_id:other.machine.id,tls:false,group_ids:[f.g1.id]},f.admin)).data;
    const valid = {user_id:f.user.id,node_id:f.node.id,upload_bytes:1,download_bytes:2};
    for (const [i,invalid] of [
      {...valid,node_id:foreign.id}, {...valid,user_id:1}, {...valid,upload_bytes:-1}, {...valid,download_bytes:0.5}, {...valid,upload_bytes:Number.MAX_SAFE_INTEGER+1}, {...valid,user_id:999}
    ].entries()) {
      const r = await f.nodeRequest('traffic','POST',{batch_id:`invalid-${i}`,records:[valid,invalid]});
      expect([400,403]).toContain(r.status);
    }
    expect((await f.request('/api/v1/me','GET',undefined,f.userCookie)).data.upload_bytes).toBe(0);
    expect(f.app.db.query('SELECT count(*) n FROM traffic_batches').get()).toEqual({n:0});
    expect(f.app.db.query('SELECT count(*) n FROM traffic_daily').get()).toEqual({n:0});
    const overflow = await f.nodeRequest('traffic','POST',{batch_id:'overflow',records:[{...valid,upload_bytes:Number.MAX_SAFE_INTEGER,download_bytes:0},valid]});
    expect(overflow.status).toBe(400);
    expect((await f.request('/api/v1/me','GET',undefined,f.userCookie)).data.upload_bytes).toBe(0);
  });
  test('node request enforces 1 MiB body limit and rejects foreign cookie route use', async () => {
    const f = await fixture();
    const huge = await f.nodeRequest('heartbeat','POST',{version:'a'.repeat(1048576),uptime_seconds:1,config_revision:1});
    expect(huge.status).toBe(413); expect(huge.body.error.code).toBe('BODY_LIMIT');
    expect((await f.request('/api/v1/admin/users','GET',undefined,undefined,{'authorization':`Bearer ${f.token}`})).status).toBe(401);
  });
});

describe('mutation race windows', () => {
  test('setup is atomic across two SQLite connections', async () => {
    const dir = mkdtempSync(join(tmpdir(),'mboard-setup-race-')); dirs.push(dir);
    const first = harness({dbPath:join(dir,'db.sqlite')}), second = harness({dbPath:join(dir,'db.sqlite')});
    const input = {email:'first@example.com',name:'管理员',password:pass};
    const replies = await Promise.all([first.request('/api/v1/auth/setup','POST',input),second.request('/api/v1/auth/setup','POST',{...input,email:'second@example.com'})]);
    expect(replies.map(r=>r.status).sort()).toEqual([201,409]);
    expect(first.app.db.query("SELECT COUNT(*) n FROM users WHERE role='admin'").get()).toEqual({n:1});
  });
  test('revoked browser sessions cannot finish a delayed mutation body', async () => {
    const f = await fixture(); let writer!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({start(c) {writer=c;}});
    const pending = f.app.fetch(new Request('http://localhost/api/v1/tickets',{method:'POST',headers:{origin:'http://localhost',cookie:f.userCookie,'content-type':'application/json'},body:stream}));
    await f.request('/api/v1/auth/logout','POST',undefined,f.userCookie);
    writer.enqueue(new TextEncoder().encode(JSON.stringify({subject:'迟到的工单',body:'内容'}))); writer.close();
    expect((await pending).status).toBe(401);
    expect(f.app.db.query('SELECT COUNT(*) n FROM tickets').get()).toEqual({n:0});
  });
  test('rotated machine tokens cannot finish delayed traffic or heartbeat bodies', async () => {
    const f = await fixture(); let trafficWriter!: ReadableStreamDefaultController<Uint8Array>, heartbeatWriter!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({start(c) {trafficWriter=c;}}), beatStream = new ReadableStream<Uint8Array>({start(c) {heartbeatWriter=c;}});
    const headers = {authorization:`Bearer ${f.token}`,'content-type':'application/json'};
    const pending = f.app.fetch(new Request('http://localhost/api/node/v1/traffic',{method:'POST',headers,body:stream}));
    const beat = f.app.fetch(new Request('http://localhost/api/node/v1/heartbeat',{method:'POST',headers,body:beatStream}));
    await f.request(`/api/v1/admin/machines/${f.machine.id}/token`,'POST',undefined,f.admin);
    trafficWriter.enqueue(new TextEncoder().encode(JSON.stringify({batch_id:'delayed',records:[{user_id:f.user.id,node_id:f.node.id,upload_bytes:1,download_bytes:2}]}))); trafficWriter.close();
    heartbeatWriter.enqueue(new TextEncoder().encode(JSON.stringify({version:'old',uptime_seconds:1,config_revision:1}))); heartbeatWriter.close();
    expect((await pending).status).toBe(401); expect((await beat).status).toBe(401);
    expect(f.app.db.query('SELECT COUNT(*) n FROM traffic_batches').get()).toEqual({n:0});
    expect((await f.request('/api/v1/admin/machines','GET',undefined,f.admin)).data[0].last_seen_at).toBeNull();
  });
});

describe('production HTTP entry', () => {
  test('real Bun server preserves JSON body-limit errors and canonical HTTPS cookies', async () => {
    const dir = mkdtempSync(join(tmpdir(),'mboard-http-')); dirs.push(dir);
    const reservation = Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response('reserved')}); const port = reservation.port; reservation.stop(true);
    const running = startServer({MBOARD_HOST:'127.0.0.1',MBOARD_PORT:String(port),MBOARD_DATA_DIR:dir,MBOARD_PUBLIC_ORIGIN:'https://panel.example.com'});
    try {
      const base = `http://127.0.0.1:${port}`;
      const oversized = await fetch(`${base}/api/v1/auth/setup`,{method:'POST',headers:{origin:'https://panel.example.com','content-type':'application/json',connection:'close'},keepalive:false,body:JSON.stringify({name:'x'.repeat(1048576),email:'admin@example.com',password:pass})});
      expect(oversized.status).toBe(413); expect(oversized.headers.get('content-type')).toContain('application/json'); expect((await oversized.json()).error.code).toBe('BODY_LIMIT');
      const setup = await fetch(`${base}/api/v1/auth/setup`,{method:'POST',headers:{origin:'https://panel.example.com','content-type':'application/json',connection:'close'},keepalive:false,body:JSON.stringify({name:'管理者',email:'admin@example.com',password:pass})});
      expect(setup.status).toBe(201); expect(setup.headers.get('set-cookie')).toContain('; Secure'); expect((await setup.json()).data.role).toBe('admin');
      expect((await (await fetch(`${base}/api/v1/site`)).json()).data.site_name).toBe('mboard');
    } finally { running.stop(); }
  });
});

describe('content, tickets, static safety and persistence', () => {
  test('content CRUD, plain-text content, settings and ticket owner isolation', async () => {
    const f = await fixture();
    const notice = await f.request('/api/v1/admin/notices','POST',{title:'公告',body:'<script>plain text</script>'},f.admin);
    const guide = await f.request('/api/v1/admin/guides','POST',{title:'连接帮助',body:'内容',category:'客户端'},f.admin);
    expect(notice.status).toBe(201); expect(guide.status).toBe(201);
    expect((await f.request('/api/v1/notices','GET',undefined,f.userCookie)).data[0].body).toBe('<script>plain text</script>');
    expect((await f.request(`/api/v1/admin/guides/${guide.data.id}`,'PATCH',{body:'新版说明'},f.admin)).data.body).toBe('新版说明');
    expect((await f.request('/api/v1/guides','GET',undefined,f.userCookie)).data[0].body).toBe('新版说明');
    expect((await f.request('/api/v1/admin/settings','PATCH',{site_name:'我的面板',site_description:'新的介绍'},f.admin)).data.site_name).toBe('我的面板');
    expect((await f.request('/api/v1/site')).data).toEqual({site_name:'我的面板',site_description:'新的介绍'});
    const ticket = await f.request('/api/v1/tickets','POST',{subject:'连接帮助',body:'请协助'},f.userCookie);
    expect(ticket.status).toBe(201); expect(ticket.data.messages.length).toBe(1);
    const outsider = (await f.request('/api/v1/admin/users','POST',{email:'outsider@example.com',name:'其他用户',password:pass},f.admin)).data;
    const login = await f.request('/api/v1/auth/login','POST',{email:outsider.email,password:pass});
    expect((await f.request(`/api/v1/tickets/${ticket.data.id}/messages`,'POST',{body:'越权回复'},login.cookie)).status).toBe(404);
    expect((await f.request(`/api/v1/tickets/${ticket.data.id}`,'PATCH',{status:'closed'},login.cookie)).status).toBe(404);
    expect((await f.request('/api/v1/tickets','GET',undefined,login.cookie)).data).toEqual([]);
    const reply = await f.request(`/api/v1/tickets/${ticket.data.id}/messages`,'POST',{body:'可尝试重新连接'},f.admin);
    expect(reply.data.messages[1].author_role).toBe('admin');
    expect((await f.request('/api/v1/admin/tickets','GET',undefined,f.admin)).data.length).toBe(1);
    expect((await f.request(`/api/v1/tickets/${ticket.data.id}`,'PATCH',{status:'closed'},f.userCookie)).data.status).toBe('closed');
    expect((await f.request(`/api/v1/tickets/${ticket.data.id}/messages`,'POST',{body:'更多'},f.userCookie)).status).toBe(409);
    expect((await f.request(`/api/v1/admin/notices/${notice.data.id}`,'DELETE',undefined,f.admin)).status).toBe(200);
    expect((await f.request(`/api/v1/admin/guides/${guide.data.id}`,'DELETE',undefined,f.admin)).status).toBe(200);
  });
  test('SPA fallback works while traversal, hidden files, symlink escape and directories are blocked', async () => {
    const root = mkdtempSync(join(tmpdir(),'mboard-static-')); dirs.push(root); const dist = join(root,'dist'); mkdirSync(dist); mkdirSync(join(dist,'assets'));
    writeFileSync(join(dist,'index.html'),'<html>mboard</html>'); writeFileSync(join(dist,'assets','main.js'),'console.log("safe")'); writeFileSync(join(root,'secret.txt'),'SECRET'); symlinkSync(join(root,'secret.txt'),join(dist,'escape.txt'));
    const h = harness({distDir:dist});
    expect((await h.request('/user/overview')).body).toBe('<html>mboard</html>');
    expect((await h.request('/assets/main.js')).status).toBe(200);
    expect((await h.request('/assets/main.js')).response.headers.get('content-type')).toContain('javascript');
    for(const path of ['/escape.txt','/%2e%2e%2fsecret.txt','/.env','/assets','/missing.js','/%5c..%5csecret.txt']) expect((await h.request(path)).status).toBe(404);
    expect((await h.request('/unknown','POST',{},undefined)).status).toBe(404);
    expect((await h.request('/')).response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
  test('SQLite data and setup state persist while revisions advance across restarts', async () => {
    const dir = mkdtempSync(join(tmpdir(),'mboard-db-')); dirs.push(dir); const dbPath = join(dir,'mboard.sqlite');
    const f = await fixture({dbPath}); const revision = (await f.nodeRequest('config')).data.revision;
    f.app.close(); apps.splice(apps.indexOf(f.app),1);
    const h = harness({dbPath});
    expect((await h.request('/api/v1/auth/status')).data.setup_required).toBe(false);
    expect((await h.request('/api/v1/me','GET',undefined,f.userCookie)).data.email).toBe(f.user.email);
    expect((await h.request('/api/node/v1/config','GET',undefined,undefined,{authorization:`Bearer ${f.token}`})).data.revision).toBeGreaterThan(revision);
  });
});
