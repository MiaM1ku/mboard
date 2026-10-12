import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyArchive, main, validateArchive } from '../scripts/import-archive';
import { createApp } from '../src/server/app';
import { hash, openDatabase } from '../src/server/database';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
const original = 'Original-login-password';
const digest = Bun.password.hashSync(original,{algorithm:'bcrypt',cost:4}).replace('$2b$','$2y$');
const fixture = () => ({ format:'mboard-staged-import-v1', tables: {
  v2_user:Array.from({length:46},(_,i) => ({id:i+10,email:`person${i}@example.com`,password:digest,password_algo:null,password_salt:null,banned:i === 2 ? 1 : 0,is_admin:i === 0 || i === 2 ? 1 : 0,access_enabled:i === 1 ? 0 : 1,group_id:3,u:i+10,d:i+20,transfer_enable:i === 3 ? 0 : i === 5 ? 1 : 100000,expired_at:i === 4 ? 0 : null,created_at:1700000000,uuid:'old-user-uuid',token:'old-subscription-token',plan_id:12,speed_limit:10,parent_id:i === 8 ? 10 : null})),
  v2_server_group:[{id:3,name:'Standard'},{id:8,name:'Plus'},{id:11,name:'Other'}],
  v2_server:Array.from({length:28},(_,i) => ({id:i+30,name:`Legacy ${i}`,type:i<15 ? 'vless' : i<26 ? 'shadowsocks' : i===26 ? 'trojan' : 'anytls',host:`edge${i}.example.com`,port:'443',machine_id:i<21 ? i+50 : null,parent_id:i === 1 ? 30 : null,group_ids:'[3,8]',protocol_settings:JSON.stringify({method:'2022-blake3-aes-128-gcm',private_key:'PRIVATE-REALITY',server_key:'PRIVATE-SERVER'}),custom_routes:[{outbound:'PRIVATE-OUTBOUND'}],reality_template_id:7})),
  v2_server_machine:Array.from({length:21},(_,i) => ({id:i+50,name:`Machine ${i}`,host:`edge${i}.example.com`,token:'PRIVATE-MACHINE-TOKEN',encrypted_credentials:'PRIVATE-CREDENTIALS'})),
  v2_server_machine_binding:Array.from({length:21},(_,i) => ({id:i+1,server_id:i+30,machine_id:i+50,state:'active'})),
  v2_server_route_profile:Array.from({length:5},(_,i) => ({id:i+1,settings:{private_key:'PRIVATE-ROUTE'}})),
  v2_server_outbound_template:Array.from({length:7},(_,i) => ({id:i+1,password:'PRIVATE-OUTBOUND'})),
  v2_server_route_template:[{id:1,settings:'PRIVATE-ROUTE-TEMPLATE'}],
  unknown_private_table:[{value:'ENCRYPTED-SETTINGS'},{id:1,secret:'SECRET-ONE'},{id:1,secret:'SECRET-TWO'}],
} });
function files(data: unknown = fixture()) {
  const dir = mkdtempSync(join(tmpdir(),'mboard-staged-test-')); dirs.push(dir); chmodSync(dir,0o700);
  const input=join(dir,'archive.json'), db=join(dir,'db.sqlite');
  writeFileSync(input,JSON.stringify(data),{mode:0o600});
  return {dir,input,db,args:['--input',input,'--db',db,'--apply']};
}
const request = (path: string, options: {method?: string; body?: unknown; cookie?: string} = {}) => new Request(`http://local${path}`,{method:options.method ?? 'GET',headers:{...(options.body ? {origin:'http://local','content-type':'application/json'} : {}),...(options.cookie ? {cookie:options.cookie} : {})},...(options.body ? {body:JSON.stringify(options.body)} : {})});
async function login(app: ReturnType<typeof createApp>, i = 0, password = original) {
  const response=await app.fetch(request('/api/v1/auth/login',{method:'POST',body:{email:`person${i}@example.com`,password}}));
  expect(response.status).toBe(200); return response.headers.get('set-cookie')!.split(';')[0]!;
}

test('v2 schema upgrade keeps existing users and default zero quota semantics', () => {
  const f=files(); const db=openDatabase(f.db);
  db.exec("DROP TABLE legacy_records; DROP TABLE import_runs; PRAGMA user_version=1");
  db.query('INSERT INTO users(email,name,password_hash,credential,subscription_token,created_at) VALUES(?,?,?,?,?,?)').run('existing@example.com','Existing',digest,'uuid','token','2026-01-01T00:00:00Z');
  db.close(); const upgraded=openDatabase(f.db);
  try { expect(upgraded.query('PRAGMA user_version').get()).toEqual({user_version:2}); expect(upgraded.query('SELECT email,quota_bytes FROM users').get()).toEqual({email:'existing@example.com',quota_bytes:0}); }
  finally { upgraded.close(); }
});

test('staged archive maps account and expiry gates without converting node configs', () => {
  const source=fixture(), plan=validateArchive(source);
  expect(plan.summary).toEqual({users:46,nodes:28,machines:21,groups:3});
  expect(plan.users[0]).toMatchObject({id:10,email:'person0@example.com',role:'admin',password_hash:digest,enabled:1,group_ids:[3],upload_bytes:10,download_bytes:20,quota_bytes:100000});
  expect(plan.users[1]).toMatchObject({enabled:1,group_ids:[]});
  expect(plan.users[2]).toMatchObject({enabled:0,role:'admin'});
  expect(plan.users[3]?.quota_bytes).toBe(0);
  expect(plan.users[4]?.expires_at).toBe('1970-01-01T00:00:00.000Z');
  expect(plan.enabled_admins).toBe(1);
  for (const [kind, rows] of Object.entries(source.tables)) {
    expect(plan.records.filter(r=>r.kind===kind).map(r=>JSON.parse(r.payload))).toEqual(rows);
  }
});

test('dry-run is default, validates all records and creates no destination', async () => {
  const f=files(); const report=await main(['--input',f.input,'--db',f.db]);
  expect(report.mode).toBe('dry-run'); expect(report.users).toBe(46); expect(existsSync(f.db)).toBe(false);
  await expect(main(['--input',f.input,'--db',f.db,'--apply','--dry-run'])).rejects.toThrow('conflicts');
  expect(existsSync(f.db)).toBe(false);
});

test('apply preserves every raw row, exact IDs, grants, hashes, u/d and admin role', async () => {
  const source=fixture(), f=files(source); await main(f.args);
  expect(statSync(f.db).mode & 0o777).toBe(0o600);
  const db=new Database(f.db,{readonly:true});
  try {
    expect(db.query('SELECT COUNT(*) count FROM users').get()).toEqual({count:46});
    expect(db.query('SELECT COUNT(*) count FROM groups').get()).toEqual({count:3});
    for (const table of ['machines','nodes','sessions','node_groups','traffic_daily']) expect(db.query(`SELECT COUNT(*) count FROM ${table}`).get()).toEqual({count:0});
    expect(db.query('SELECT id,email,role,enabled,password_hash,upload_bytes,download_bytes,quota_bytes FROM users WHERE id=10').get()).toEqual({id:10,email:'person0@example.com',role:'admin',enabled:1,password_hash:digest,upload_bytes:10,download_bytes:20,quota_bytes:100000});
    expect(db.query('SELECT group_id FROM user_groups WHERE user_id=11').all()).toEqual([]);
    expect(db.query("SELECT value FROM settings WHERE key='setup_complete'").get()).toEqual({value:'1'});
    const u=db.query('SELECT credential,subscription_token FROM users WHERE id=10').get() as any;
    expect(u.credential).not.toBe('old-user-uuid'); expect(u.subscription_token).not.toBe('old-subscription-token'); expect(u.subscription_token).toMatch(/^[a-f0-9]{64}$/);
    for (const [kind,rows] of Object.entries(source.tables)) expect(db.query('SELECT payload FROM legacy_records WHERE kind=? ORDER BY rowid').all(kind).map((r:any)=>JSON.parse(r.payload))).toEqual(rows);
    expect(db.query('SELECT archive_sha256 FROM import_runs').get()).toEqual({archive_sha256:hash(readFileSync(f.input,'utf8'))});
  } finally { db.close(); }
});

test('original bcrypt password logs in and admin inventory never exposes raw secrets', async () => {
  const f=files(); await main(f.args); const app=createApp({dbPath:f.db});
  try {
    expect((await app.fetch(request('/api/v1/admin/imports'))).status).toBe(401);
    const admin=await login(app), member=await login(app,3);
    expect((await app.fetch(request('/api/v1/admin/imports',{cookie:member}))).status).toBe(403);
    const response=await app.fetch(request('/api/v1/admin/imports',{cookie:admin})); expect(response.status).toBe(200);
    const body=await response.json() as any, text=JSON.stringify(body);
    expect(body.data.summary).toMatchObject({users:46,nodes:28,machines:21,groups:3});
    expect(body.data.summary.imported_at).toMatch(/^\d{4}-/);
    expect(body.data.nodes.every((n:any)=>n.state === 'pending')).toBe(true);
    expect(body.data.nodes.find((n:any)=>n.id===31)).toMatchObject({parent_id:30,machine_id:51,group_ids:[3,8],protocol:'vless',port:443});
    expect(body.data.nodes.find((n:any)=>n.id===57).protocol).toBe('anytls');
    expect(body.data.machines[0]).toEqual({id:50,name:'Machine 0',state:'pending'});
    for (const forbidden of ['PRIVATE-','ENCRYPTED-SETTINGS','SECRET-ONE','SECRET-TWO',digest,'old-subscription-token','old-user-uuid','payload','password_hash','protocol_settings','custom_routes']) expect(text).not.toContain(forbidden);
    expect((await app.fetch(request('/api/v1/admin/imports/raw',{cookie:admin}))).status).toBe(404);
    const view=await app.fetch(request('/api/v1/me',{cookie:member})); const user=(await view.json() as any).data;
    const config=await app.fetch(request(`/s/${user.subscription_token}`)); expect(config.status).toBe(200);
    expect((await config.json() as any).outbounds.some((o:any)=>['vless','trojan','shadowsocks','anytls'].includes(o.type))).toBe(false);
    expect((await app.fetch(request('/api/v1/nodes',{cookie:member}))).status).toBe(200);
    expect((await app.fetch(request('/api/v1/auth/status'))).status).toBe(200);
    expect((await (await app.fetch(request('/api/v1/auth/status'))).json() as any).data.setup_required).toBe(false);
    const banned=await app.fetch(request('/api/v1/auth/login',{method:'POST',body:{email:'person2@example.com',password:original}})); expect(banned.status).toBe(401);
  } finally { app.close(); }
});

test('bcrypt long UTF8 passwords preserve PHP 72-byte truncation at login and change', async () => {
  const source=fixture(), long='界'.repeat(23)+'éé'+'suffix-is-truncated';
  const bytes=new TextEncoder().encode(long).subarray(0,72);
  source.tables.v2_user[0]!.password=Bun.password.hashSync(bytes,{algorithm:'bcrypt',cost:4}).replace('$2b$','$2y$');
  const f=files(source); await main(f.args); const app=createApp({dbPath:f.db});
  try {
    const cookie=await login(app,0,long);
    const change=await app.fetch(request('/api/v1/me/password',{method:'PATCH',cookie,body:{current_password:long,new_password:'new-argon-password'}}));
    expect(change.status).toBe(200); await login(app,0,'new-argon-password');
  } finally { app.close(); }
});

test('zero/null quotas stay unlimited; epoch expiry, access-disabled and exhausted grants stay blocked', async () => {
  const source=fixture(); (source.tables.v2_user[7] as any).transfer_enable=null;
  const f=files(source); await main(f.args); const app=createApp({dbPath:f.db});
  try {
    app.db.query("INSERT INTO nodes(id,name,host,port,protocol,tls,created_at) VALUES(1,'New node','new.example.com',443,'vless',1,'2026-01-01T00:00:00Z')").run();
    app.db.query('INSERT INTO node_groups(node_id,group_id) VALUES(1,3)').run();
    for (const i of [1,3,4,5,7]) {
      const u=app.db.query('SELECT subscription_token FROM users WHERE id=?').get(i+10) as any;
      const res=await app.fetch(request(`/s/${u.subscription_token}`));
      expect(res.status).toBe(i===4 || i===5 ? 403 : 200);
      if (res.status===200) expect((await res.json() as any).outbounds.filter((o:any)=>o.type==='vless').length).toBe(i===1 ? 0 : 1);
    }
  } finally { app.close(); }
});

test('duplicate/nonfresh apply refuses without changing imported data or runtime revisions', async () => {
  const f=files(); await main(f.args);
  const before=new Database(f.db,{readonly:true}); const rows=before.query('SELECT * FROM import_runs').all(); before.close();
  await expect(main(f.args)).rejects.toThrow('not fresh');
  const db=new Database(f.db,{readonly:true});
  try { expect(db.query('SELECT * FROM import_runs').all()).toEqual(rows); expect(db.query('SELECT COUNT(*) count FROM users').get()).toEqual({count:46}); }
  finally { db.close(); }
  const changed=files(); const setup=openDatabase(changed.db); setup.query("UPDATE settings SET value='custom' WHERE key='site_name'").run(); setup.close();
  await expect(main(changed.args)).rejects.toThrow('not fresh');
});

test('validation rejects unsupported algorithms and malformed accounting without leaking hashes', async () => {
  for (const change of [{password_algo:'sha256'}, {password:'UNSUPPORTED-SECRET-HASH'}, {u:-1}, {d:'9007199254740992'}, {expired_at:undefined}, {is_admin:undefined}, {access_enabled:undefined}, {group_id:999}]) {
    const source=fixture(); Object.assign(source.tables.v2_user[0]!,change); const f=files(source);
    let message=''; try { await main(f.args); } catch (error:any) { message=error.message; }
    expect(message).not.toBe(''); expect(message).not.toContain('UNSUPPORTED-SECRET-HASH'); expect(message).not.toContain(digest); expect(existsSync(f.db)).toBe(false);
  }
  const source=fixture(); source.tables.v2_user[1]!.id=10; expect(()=>validateArchive(source)).toThrow('duplicate');
});

test('archives without enabled admins keep setup available and preserve banned admin role', () => {
  const source=fixture(); source.tables.v2_user[0]!.banned=1;
  const db=openDatabase();
  try { applyArchive(db,validateArchive(source),'testdigest'); expect(db.query("SELECT value FROM settings WHERE key='setup_complete'").get()).toEqual({value:'0'}); expect(db.query("SELECT COUNT(*) count FROM users WHERE role='admin'").get()).toEqual({count:2}); }
  finally { db.close(); }
});

test('CLI refuses world-readable archives and symlink destinations', async () => {
  const f=files(); chmodSync(f.input,0o644); await expect(main(f.args)).rejects.toThrow('private regular file'); expect(existsSync(f.db)).toBe(false);
  chmodSync(f.input,0o600); const target=join(f.dir,'target.sqlite'); const db=openDatabase(target); db.close(); symlinkSync(target,f.db);
  await expect(main(f.args)).rejects.toThrow('not a symlink'); expect(readFileSync(target).length).toBeGreaterThan(0);
});
