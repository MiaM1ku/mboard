import { afterEach, describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { createApp, type AppOptions } from '../src/server/app';
import { hash } from '../src/server/database';
import { activateMachine, compileMachine, provisionMachineToken, restoreRuntime } from '../src/server/runtime';

// Synthetic source rows only. Every app owns an in-memory DB and closes after its test.
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.close(); });
const future = '2099-01-01T00:00:00.000Z';
const oldUUID = '12345678-1234-4123-8123-123456789abc';
const privateKey = 'SYNTHETIC-REALITY-PRIVATE-KEY';
function fixture(options: AppOptions = {}) {
  const app = createApp(options); apps.push(app);
  const db = app.db;
  db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,quota_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(1,'user@example.test','User','user','synthetic-hash','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a'.repeat(64),1000,future,future);
  db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,created_at) VALUES(?,?,?,?,?,?,?,?)').run(2,'admin@example.test','Admin','admin','synthetic-hash','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','b'.repeat(64),future);
  db.exec("INSERT INTO groups(id,name) VALUES(1,'Granted'),(2,'Denied'); INSERT INTO user_groups VALUES(1,1);");
  for (const [uid,token] of [[1,'c'.repeat(64)],[2,'d'.repeat(64)]] as const) db.query('INSERT INTO sessions VALUES(?,?,?)').run(hash(token),uid,future);
  const userCookie = `mboard_session=${'c'.repeat(64)}`, adminCookie = `mboard_session=${'d'.repeat(64)}`;
  const archive = (kind: string, id: number, payload: Record<string, any>) => db.query('INSERT INTO legacy_records VALUES(?,?,?,?)').run(kind,String(id),JSON.stringify(payload),future);
  archive('v2_user',1,{id:1,uuid:oldUUID});
  archive('v2_server',10,{id:10,name:'Restored SS2022',type:'shadowsocks',host:'ss.example.test',port:443,server_port:8443,parent_id:0,enabled:1,show:1,group_ids:[1],created_at:'1700000000',protocol_settings:{cipher:'2022-blake3-aes-128-gcm'}});
  archive('v2_server',11,{id:11,name:'Restored Reality',type:'vless',host:'reality.example.test',port:444,server_port:8444,parent_id:0,enabled:1,show:1,group_ids:[1],protocol_settings:{tls:2,flow:'xtls-rprx-vision',reality_settings:{server_name:'cover.example.test',server_port:443,private_key:privateKey,public_key:'synthetic-public-key',short_id:'abcd'}}});
  archive('v2_server_machine',2,{id:2,name:'Runtime Machine',host:'runtime.example.test'});
  archive('v2_server_machine_binding',1,{id:1,machine_id:2,server_id:10});
  archive('v2_server_machine_binding',2,{id:2,machine_id:2,server_id:11});
  restoreRuntime(db);
  const token = provisionMachineToken(db,2);
  async function request(path: string, method = 'GET', data?: unknown, cookie?: string, extra?: HeadersInit) {
    const headers = new Headers(extra);
    if (cookie) headers.set('cookie',cookie);
    if (!['GET','HEAD'].includes(method) && !path.startsWith('/api/node/')) headers.set('origin',headers.get('origin') || options.publicOrigin || 'http://localhost');
    if (data !== undefined) headers.set('content-type','application/json');
    const response = await app.fetch(new Request(`http://localhost${path}`,{method,headers,body:data === undefined ? undefined : JSON.stringify(data)}));
    const text = await response.text(); let body: any; try { body = JSON.parse(text); } catch { body = text; }
    return {response,status:response.status,text,body,data:body?.data};
  }
  const node = (path: string, method = 'GET', data?: unknown, bearer = token) => request(`/api/node/v1/${path}`,method,data,undefined,{authorization:`Bearer ${bearer}`});
  const activate = () => { const c = compileMachine(db,2); activateMachine(db,2,{verified:true,appliedRevision:c.revision,coreReady:true,telemetryReady:true}); return c; };
  const record = (patch: Record<string, any> = {}) => ({user_id:1,node_id:10,upload_bytes:5,download_bytes:7,...patch});
  const heartbeat = (revision = compileMachine(db,2).revision, ready = true) => node('heartbeat','POST',{version:'synthetic-core/1.14',uptime_seconds:60,config_revision:revision,core_ready:ready,telemetry_ready:ready});
  const counts = () => db.query('SELECT upload_bytes,download_bytes FROM users WHERE id=1').get();
  return {app,db,request,node,activate,archive,token,userCookie,adminCookie,record,heartbeat,counts};
}

test('imported legacy subscription links keep format selection until owner rotation',async()=>{const f=fixture({publicOrigin:'https://panel.example.test',subscriptionOrigin:'https://sub.example.test'}),old='legacySubscriptionKey'.padEnd(32,'x');f.db.query('UPDATE legacy_records SET payload=? WHERE kind=? AND id=?').run(JSON.stringify({id:1,uuid:oldUUID,token:old}),'v2_user','1');f.activate();await f.heartbeat();for(const path of[`/s/${old}`,`/api/v1/client/subscribe?token=${old}&flag=clashmeta`]){const r=await f.request(path,'GET',undefined,undefined,{Host:'sub.example.test','User-Agent':'clash.meta/1.19.0'});expect(r.status).toBe(200);expect(r.response.headers.get('content-type')).toContain('yaml');expect(parse(r.text).proxies.length).toBeGreaterThan(0)}const before=compileMachine(f.db,2).config.inbounds[0].users[0].password;expect((await f.request('/api/v1/me/subscription/rotate','POST',undefined,f.userCookie,{Host:'panel.example.test'})).status).toBe(200);expect((await f.request(`/s/${old}`,'GET',undefined,undefined,{Host:'sub.example.test'})).status).toBe(404);expect(compileMachine(f.db,2).config.inbounds[0].users[0].password).not.toBe(before)});

describe('restored runtime REST integration', () => {
  test('runtime bearer selects native config, exposes no bundle files, and keeps server secrets inside authorized config', async () => {
    const f=fixture(); const r=await f.node('config'); expect(r.status).toBe(200);
    expect(Object.keys(r.data).sort()).toEqual(['config','revision','traffic_labels']);
    expect(r.data.config.inbounds.map((n:any)=>n.listen_port)).toEqual([8443,8444]);
    expect(r.data.config.inbounds[1].tls.reality.private_key).toBe(privateKey);
    expect(r.data.traffic_labels).toEqual([{label:'mb:u:1:n:10:p:0',user_id:1,node_id:10},{label:'mb:u:1:n:11:p:0',user_id:1,node_id:11}]);
    const {config,...publicEnvelope}=r.data; expect(JSON.stringify(publicEnvelope)).not.toContain(privateKey);
    expect(config.experimental.v2ray_api.listen).toBe('127.0.0.1:19090');
  });
  test('runtime authentication rejects missing, malformed, session-cookie, rotated and disabled tokens', async () => {
    const f=fixture(); expect((await f.request('/api/node/v1/config')).status).toBe(401);
    expect((await f.node('config','GET',undefined,'bad')).status).toBe(401);
    expect((await f.request('/api/node/v1/config','GET',undefined,f.adminCookie,{authorization:`Bearer ${f.token}`})).status).toBe(401);
    const next=provisionMachineToken(f.db,2); expect((await f.node('config')).status).toBe(401); expect((await f.node('config','GET',undefined,next)).status).toBe(200);
    f.db.exec("UPDATE runtime_machines SET state='disabled' WHERE id=2"); expect((await f.node('config','GET',undefined,next)).status).toBe(401);
  });
  test('pending nodes stay out of subscriptions until activation and valid ready heartbeat makes live counts accurate', async () => {
    const f=fixture(); expect((await f.request('/api/v1/nodes','GET',undefined,f.userCookie)).data).toEqual([]);
    let overview=(await f.request('/api/v1/admin/overview','GET',undefined,f.adminCookie)).data;
    expect(overview).toMatchObject({nodes:2,machines:1,online_nodes:0,online_machines:0});
    const c=f.activate(); const hb=await f.heartbeat(c.revision); expect(hb.status).toBe(200); expect(hb.data.config_revision).toBe(c.revision);
    overview=(await f.request('/api/v1/admin/overview','GET',undefined,f.adminCookie)).data;
    expect(overview).toMatchObject({nodes:2,machines:1,online_nodes:2,online_machines:1});
    expect(overview.recent_machines[0]).toMatchObject({runtime:true,active:true,core_ready:true,telemetry_ready:true,applied_revision:c.revision,config_revision:c.revision,online:true});
    expect((await f.request('/api/v1/overview','GET',undefined,f.userCookie)).data.nodes).toHaveLength(2);
    expect(JSON.stringify(overview)).not.toContain(privateKey); expect(JSON.stringify(overview)).not.toContain(f.token);
  });
  test('wrong revision and failed readiness withdraw runtime endpoints', async () => {
    const f=fixture();const c=f.activate(); expect((await f.heartbeat(c.revision+1)).status).toBe(200);
    expect((await f.request('/api/v1/nodes','GET',undefined,f.userCookie)).data).toEqual([]);
    expect((await f.request('/s/'+'a'.repeat(64))).text).not.toContain('ss.example.test');
    await f.heartbeat(c.revision,false);expect((await f.request('/api/v1/admin/overview','GET',undefined,f.adminCookie)).data.online_machines).toBe(0);
    await f.heartbeat(c.revision);expect((await f.request('/api/v1/nodes','GET',undefined,f.userCookie)).data).toHaveLength(2);
  });
  test('heartbeat rejects unsafe integers, unexpected fields and nonboolean readiness without writes', async () => {
    const f=fixture();const base={version:'v',uptime_seconds:1,config_revision:1,core_ready:true,telemetry_ready:true};
    for(const body of [{...base,uptime_seconds:Number.MAX_SAFE_INTEGER+1},{...base,config_revision:-1},{...base,core_ready:1},{...base,applied_revision:1}]) expect((await f.node('heartbeat','POST',body)).status).toBe(400);
    expect((f.db.query('SELECT last_seen_at FROM runtime_machines WHERE id=2').get() as any).last_seen_at).toBeNull();
  });
  test('stale telemetry stops live counts and subscription publication', async () => {
    const f=fixture();f.activate();await f.heartbeat();f.db.query('UPDATE runtime_machines SET last_seen_at=?').run(new Date(Date.now()-120000).toISOString());
    expect((await f.request('/api/v1/admin/overview','GET',undefined,f.adminCookie)).data).toMatchObject({online_nodes:0,online_machines:0});
    expect((await f.request('/s/'+'a'.repeat(64))).text).not.toContain('ss.example.test');
    expect((await f.request('/api/v1/nodes','GET',undefined,f.userCookie)).data).toEqual([]);
  });
  test('a new compiled revision invalidates old ready health until that exact revision is applied', async () => {
    const f=fixture();const c=f.activate();await f.heartbeat(c.revision);
    f.db.exec('INSERT INTO user_groups VALUES(2,1)'); const next=await f.node('config');expect(next.data.revision).toBeGreaterThan(c.revision);
    expect((await f.request('/api/v1/admin/overview','GET',undefined,f.adminCookie)).data.online_machines).toBe(0);
    expect((await f.request('/s/'+'a'.repeat(64))).text).not.toContain('ss.example.test');
    await f.heartbeat(next.data.revision);expect((await f.request('/api/v1/admin/overview','GET',undefined,f.adminCookie)).data.online_machines).toBe(1);
  });
  test('disabled restored aliases stay absent from user nodes and live subscriptions', async () => {
    const f=fixture();f.archive('v2_server',12,{id:12,parent_id:10,type:'shadowsocks',name:'Disabled alias',host:'disabled.example.test',port:445,enabled:0,show:1,group_ids:[1],protocol_settings:{cipher:'2022-blake3-aes-128-gcm'}});restoreRuntime(f.db);f.activate();await f.heartbeat();
    const nodes=(await f.request('/api/v1/nodes','GET',undefined,f.userCookie)).data;
    expect(nodes.map((n:any)=>n.id)).toEqual([10,11]);expect((await f.request('/api/v1/overview','GET',undefined,f.userCookie)).data.nodes.map((n:any)=>n.id)).toEqual([10,11]);
    expect((await f.request('/s/'+'a'.repeat(64))).text).not.toContain('disabled.example.test');
  });
  test('traffic uses runtime labels, updates daily/node ledgers and deduplicates batches', async () => {
    const f=fixture();const batch={batch_id:'same',records:[f.record(),f.record({node_id:11,upload_bytes:3,download_bytes:4})]};
    expect((await f.node('traffic','POST',batch)).status).toBe(200);expect((await f.node('traffic','POST',batch)).status).toBe(200);
    expect(f.counts()).toEqual({upload_bytes:8,download_bytes:11});
    expect(f.db.query('SELECT upload_bytes,download_bytes FROM traffic_daily WHERE user_id=1').get()).toEqual({upload_bytes:8,download_bytes:11});
    expect(f.db.query('SELECT node_id,upload_bytes,download_bytes FROM runtime_node_traffic ORDER BY node_id').all()).toEqual([{node_id:10,upload_bytes:5,download_bytes:7},{node_id:11,upload_bytes:3,download_bytes:4}]);
    expect((await f.request('/api/v1/admin/overview','GET',undefined,f.adminCookie)).data).toMatchObject({upload_bytes:8,download_bytes:11});
  });
  test('runtime traffic rejects foreign nodes/users, revoked grants, and rolls back partial batches', async () => {
    const f=fixture();
    for(const bad of [f.record({node_id:999}),f.record({user_id:2}),f.record({upload_bytes:Number.MAX_SAFE_INTEGER+1}),f.record({download_bytes:-1}),f.record({extra:true})]) {
      const r=await f.node('traffic','POST',{batch_id:'bad',records:[f.record(),bad]});expect([400,403]).toContain(r.status);expect(f.counts()).toEqual({upload_bytes:0,download_bytes:0});
      expect(f.db.query('SELECT * FROM runtime_node_traffic').all()).toEqual([]);expect(f.db.query('SELECT * FROM runtime_traffic_batches').all()).toEqual([]);
    }
    f.db.exec('DELETE FROM user_groups WHERE user_id=1');expect((await f.node('traffic','POST',{batch_id:'revoked',records:[f.record()]})).status).toBe(403);
  });
  test.each(['quota','expiry'])('delayed runtime traffic remains accountable after %s eligibility ends', async kind => {
    const f=fixture();await f.node('config');
    if(kind==='quota')f.db.exec('UPDATE users SET upload_bytes=1000 WHERE id=1');else f.db.exec("UPDATE users SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=1");
    const r=await f.node('traffic','POST',{batch_id:'delayed',records:[f.record()]});expect(r.status).toBe(200);expect(f.counts()).toEqual({upload_bytes:kind==='quota'?1005:5,download_bytes:7});
  });
  test('runtime traffic rejects global unsafe aggregates atomically', async () => {
    const f=fixture();f.db.query('UPDATE users SET upload_bytes=?,quota_bytes=0 WHERE id=2').run(Number.MAX_SAFE_INTEGER-2);
    const r=await f.node('traffic','POST',{batch_id:'global-overflow',records:[f.record()]});expect(r.status).toBe(400);expect(r.body.error.code).toBe('VALIDATION');expect(f.counts()).toEqual({upload_bytes:0,download_bytes:0});
    expect(f.db.query('SELECT * FROM runtime_traffic_batches').all()).toEqual([]);
  });
  test('runtime traffic treats SQLite aggregate overflow as validation, not an internal server failure', async () => {
    const f=fixture();
    const insert=f.db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,upload_bytes,created_at) VALUES(?,?,?,?,?,?,?,?,?)');
    f.db.transaction(()=>{for(let id=3;id<1028;id++)insert.run(id,`synthetic-${id}@example.test`,'Synthetic','user','synthetic-hash',`synthetic-credential-${id}`,id.toString(16).padStart(64,'0'),Number.MAX_SAFE_INTEGER,future);})();
    const r=await f.node('traffic','POST',{batch_id:'sqlite-sum-overflow',records:[f.record()]});
    expect(r.status).toBe(400);expect(r.body.error.code).toBe('VALIDATION');expect(f.counts()).toEqual({upload_bytes:0,download_bytes:0});
    expect(f.db.query('SELECT * FROM runtime_node_traffic').all()).toEqual([]);expect(f.db.query('SELECT * FROM runtime_traffic_batches').all()).toEqual([]);
  });
  test('runtime traffic rejects overflowing existing daily and node counters', async () => {
    const f=fixture();const day=new Date().toISOString().slice(0,10);
    f.db.query('INSERT INTO traffic_daily VALUES(?,?,?,?)').run(1,day,Number.MAX_SAFE_INTEGER,0);
    expect((await f.node('traffic','POST',{batch_id:'daily-overflow',records:[f.record()]})).status).toBe(400);expect(f.counts()).toEqual({upload_bytes:0,download_bytes:0});
    f.db.exec('DELETE FROM traffic_daily');f.db.query('INSERT INTO runtime_node_traffic VALUES(?,?,?,?,?)').run(10,1,day,Number.MAX_SAFE_INTEGER,0);
    expect((await f.node('traffic','POST',{batch_id:'node-overflow',records:[f.record()]})).status).toBe(400);expect(f.counts()).toEqual({upload_bytes:0,download_bytes:0});
  });
  test('legacy and runtime machine ID collision keeps bearer configs and batch ledgers separate', async () => {
    const f=fixture();const legacyToken='e'.repeat(64);
    f.db.query('INSERT INTO machines(id,name,host,token_hash) VALUES(?,?,?,?)').run(2,'Legacy Machine','legacy.example.test',hash(legacyToken));
    f.db.query('INSERT INTO nodes(id,name,host,port,protocol,machine_id,tls,created_at) VALUES(?,?,?,?,?,?,?,?)').run(20,'Legacy SS','legacy.example.test',443,'shadowsocks',2,0,future);f.db.exec('INSERT INTO node_groups VALUES(20,1)');
    expect((await f.node('config','GET',undefined,legacyToken)).data.config.inbounds[0].tag).toBe('node-20');expect((await f.node('config')).data.config.inbounds[0].tag).toBe('mb:n:10');
    expect((await f.node('traffic','POST',{batch_id:'collision',records:[f.record({node_id:20})]},legacyToken)).status).toBe(200);
    expect((await f.node('traffic','POST',{batch_id:'collision',records:[f.record()]})).status).toBe(200);expect(f.counts()).toEqual({upload_bytes:10,download_bytes:14});
    expect(f.db.query('SELECT machine_id,batch_id FROM traffic_batches').all()).toEqual([{machine_id:2,batch_id:'collision'}]);expect(f.db.query('SELECT machine_id,batch_id FROM runtime_traffic_batches').all()).toEqual([{machine_id:2,batch_id:'collision'}]);
    expect((await f.node('traffic','POST',{batch_id:'foreign',records:[f.record({node_id:20})]})).status).toBe(403);
  });
});

describe('subscription template REST integration', () => {
  test('template administration enforces session/admin/origin boundaries', async () => {
    const f=fixture();const path='/api/v1/admin/subscription/templates';expect((await f.request(path)).status).toBe(401);expect((await f.request(path,'GET',undefined,f.userCookie)).status).toBe(403);
    expect((await f.request(path,'GET',undefined,f.adminCookie)).data).toHaveLength(6);
    expect((await f.request(path+'/singbox','PUT',{content:'{}'},f.adminCookie,{origin:'https://evil.example'})).status).toBe(403);
  });
  test('save, validate and preview preserve exact template bytes and user DNS/rules/metadata in live fetch without network calls', async () => {
    const f=fixture({publicOrigin:'https://panel.example.test',subscriptionOrigin:'https://sub.example.test'});f.activate();await f.heartbeat();
    const source={dns:{servers:[{type:'https',tag:'custom-dns',server:'dns.example.test'}]},outbounds:[{type:'selector',tag:'custom',outbounds:['direct']},{type:'direct',tag:'direct'}],route:{rules:[{domain_suffix:['custom.example.test'],outbound:'direct'}],final:'custom'},experimental:{cache_file:{enabled:true}},remote:'http://127.0.0.1:9/never-fetch',title:'$app_name',subscription:'$subs_link',domain:'$subs_domain'};
    const content='\n'+JSON.stringify(source,null,2)+'\n';const path='/api/v1/admin/subscription/templates/singbox';
    const originalFetch=globalThis.fetch;let networkCalls=0;globalThis.fetch=(async()=>{networkCalls++;throw Error('Unexpected network fetch');}) as unknown as typeof fetch;
    try {
      expect((await f.request(path+'/validate','POST',{content},f.adminCookie)).data.valid).toBe(true);
      const preview=await f.request(path+'/preview','POST',{content},f.adminCookie);expect(preview.status).toBe(200);expect(preview.data.node_count).toBe(4);expect(JSON.parse(preview.data.content).dns).toEqual(source.dns);
      const saved=await f.request(path,'PUT',{content},f.adminCookie);expect(saved.status).toBe(200);expect(saved.data).toMatchObject({content,source:'custom'});
      expect((await f.request(path,'GET',undefined,f.adminCookie)).data.content).toBe(content);
      const live=await f.request('/s/'+'a'.repeat(64),'GET',undefined,undefined,{host:'sub.example.test'});expect(live.status).toBe(200);const result=JSON.parse(live.text);
      for(const key of ['dns','route','experimental','remote'] as const)expect(result[key]).toEqual(source[key]);
      // JSON has no legacy text-token dialect: unknown user metadata stays byte-for-byte meaningful.
      expect(result.subscription).toBe(source.subscription);expect(result.domain).toBe(source.domain);expect(result.title).toBe(source.title);
      expect(result.outbounds.filter((o:any)=>o.server)).toHaveLength(2);expect(live.text).not.toContain(privateKey);expect(networkCalls).toBe(0);
      expect((await f.request(path,'GET',undefined,f.adminCookie)).data.content).toBe(content);
    } finally {globalThis.fetch=originalFetch;}
  });
  test('saved INI retains DNS/rules and resolves live subscription metadata without fetching providers', async () => {
    const f=fixture({publicOrigin:'https://panel.example.test',subscriptionOrigin:'https://sub.example.test'});f.activate();await f.heartbeat();
    const content='#!MANAGED-CONFIG $subs_link interval=86400 strict=false\r\n# Synthetic original\r\n[General]\r\ndns-server = 1.1.1.1\r\nalways-real-ip = $subs_domain\r\n[Proxy]\r\n$proxies\r\n[Proxy Group]\r\nUser choice = select, DIRECT, $proxy_group\r\n[Panel]\r\nuserinfo = $subscribe_info\r\n[Rule]\r\nDOMAIN-SUFFIX,custom.example.test,DIRECT\r\nFINAL,User choice\r\n';
    const path='/api/v1/admin/subscription/templates/surge';
    expect((await f.request(path+'/validate','POST',{content},f.adminCookie)).data.valid).toBe(true);
    expect((await f.request(path,'PUT',{content},f.adminCookie)).data.content).toBe(content);
    const originalFetch=globalThis.fetch;let networkCalls=0;globalThis.fetch=(async()=>{networkCalls++;throw Error('Unexpected network fetch');}) as unknown as typeof fetch;
    try {
      const live=await f.request('/s/'+'a'.repeat(64)+'?format=surge','GET',undefined,undefined,{host:'sub.example.test'});expect(live.status).toBe(200);
      expect(live.text).toContain('#!MANAGED-CONFIG https://sub.example.test/s/'+'a'.repeat(64));expect(live.text).toContain('always-real-ip = sub.example.test');
      expect(live.text).toContain('dns-server = 1.1.1.1');expect(live.text).toContain('title=');expect(live.text).toContain('上传流量：0 B');expect(live.text).not.toContain('$subscribe_info');
      expect(live.text.slice(live.text.indexOf('[Rule]'))).toBe(content.slice(content.indexOf('[Rule]')));expect(live.text).toContain('Restored SS2022 = ss');expect(live.text).not.toContain(privateKey);expect(networkCalls).toBe(0);
      expect((await f.request(path,'GET',undefined,f.adminCookie)).data.content).toBe(content);
    } finally {globalThis.fetch=originalFetch;}
  });
  test('invalid template returns sanitized validation and cannot replace saved content', async () => {
    const f=fixture();const path='/api/v1/admin/subscription/templates/singbox';const before=(await f.request(path,'GET',undefined,f.adminCookie)).data;
    const invalid='{"password":"SYNTHETIC-DO-NOT-ECHO"';const check=await f.request(path+'/validate','POST',{content:invalid},f.adminCookie);expect(check.status).toBe(200);expect(check.data.valid).toBe(false);expect(check.text).not.toContain('SYNTHETIC-DO-NOT-ECHO');
    for(const [suffix,method] of [['','PUT'],['/preview','POST']] as const){const r=await f.request(path+suffix,method,{content:invalid},f.adminCookie);expect(r.status).toBe(400);expect(r.body.error.code).toBe('TEMPLATE_VALIDATION');expect(r.text).not.toContain('SYNTHETIC-DO-NOT-ECHO');}
    expect((await f.request(path,'GET',undefined,f.adminCookie)).data).toEqual(before);
  });
  test('actual multi-format subscriptions convert SS2022/Reality, respect UA/query, and never expose private material', async () => {
    const f=fixture();f.activate();await f.heartbeat();const path='/s/'+'a'.repeat(64);
    for(const format of ['singbox','clashmeta','stash','surge','surfboard','clash']){
      const r=await f.request(path+'?format='+format);expect(r.status).toBe(200);expect(r.response.headers.get('cache-control')).toBe('no-store');expect(r.text).not.toContain(privateKey);
      if(format==='singbox'){const nodes=JSON.parse(r.text).outbounds.filter((o:any)=>o.server);expect(nodes).toHaveLength(2);expect(nodes[0].method).toBe('2022-blake3-aes-128-gcm');expect(nodes[1].tls.reality.public_key).toBe('synthetic-public-key');}
      else if(['clashmeta','stash'].includes(format)){const root=parse(r.text);expect(root.proxies).toHaveLength(2);expect(root.proxies[0].cipher).toBe('2022-blake3-aes-128-gcm');expect(root.proxies[1]['reality-opts']['public-key']).toBe('synthetic-public-key');}
      else if(format==='clash')expect(parse(r.text).proxies).toEqual([]);else {expect(r.text).toContain('Restored SS2022 = ss');expect(r.text).not.toContain('Restored Reality =');}
    }
    expect((await f.request(path,'GET',undefined,undefined,{'user-agent':'mihomo/1.19.1'})).response.headers.get('content-type')).toContain('yaml');
    expect((await f.request(path+'?format=singbox','GET',undefined,undefined,{'user-agent':'Surge'})).response.headers.get('content-type')).toContain('json');
    expect((await f.request(path+'?format=invalid')).status).toBe(400);
    const head=await f.request(path,'HEAD');expect(head.status).toBe(200);expect(head.text).toBe('');expect(Number(head.response.headers.get('content-length'))).toBeGreaterThan(0);
  });
  test('builtin singbox keeps legacy node-ID tags and selector membership contract', async () => {
    const f=fixture();f.db.query('INSERT INTO nodes(id,name,host,port,protocol,tls,created_at) VALUES(?,?,?,?,?,?,?)').run(20,'Display name','legacy.example.test',443,'shadowsocks',0,future);f.db.exec('INSERT INTO node_groups VALUES(20,1)');
    const r=await f.request('/s/'+'a'.repeat(64));expect(r.status).toBe(200);const root=JSON.parse(r.text);expect(root.outbounds.find((o:any)=>o.server==='legacy.example.test')).toMatchObject({tag:'node-20',method:'aes-128-gcm',password:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'});expect(root.outbounds.find((o:any)=>o.type==='selector').outbounds).toContain('node-20');
  });
  test('subscription Host scope blocks admin/node APIs, writes and foreign hosts', async () => {
    const f=fixture({publicOrigin:'https://panel.example.test',subscriptionOrigin:'https://sub.example.test'});f.activate();await f.heartbeat();
    for(const path of ['/api/v1/site','/api/v1/admin/subscription/templates','/api/node/v1/config'])expect((await f.request(path,'GET',undefined,f.adminCookie,{host:'sub.example.test'})).status).toBe(404);
    expect((await f.request('/s/'+'a'.repeat(64),'POST',{},undefined,{host:'sub.example.test'})).status).toBe(404);
    expect((await f.request('/s/'+'a'.repeat(64),'GET',undefined,undefined,{host:'evil.example.test'})).status).toBe(404);
    expect((await f.request('/s/'+'a'.repeat(64),'GET',undefined,undefined,{host:'sub.example.test'})).status).toBe(200);
  });
});
