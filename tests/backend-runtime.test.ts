import { describe, test, expect } from 'bun:test';
import { openDatabase } from '../src/server/database';
import { restoreRuntime, compileMachine, authorizedEndpoints, activateMachine, provisionMachineToken, authenticateRuntimeMachine, heartbeatRuntimeMachine, deriveUUID, shadowsocksServerPSK, RuntimeCompileError } from '../src/server/runtime';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const oldUUID='12345678-1234-4123-8123-123456789abc';
const future='2099-01-01T00:00:00.000Z';
const tls={verified:true,certificate_path:'/etc/mboard-node/tls/10.crt',private_key_path:'/etc/mboard-node/tls/10.key'};
function fixture(type='shadowsocks', extra: Record<string,any>={}) {
  const db=openDatabase();
  db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,quota_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(1,'user@example.test','User','user','hash','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','a'.repeat(64),1000,future,future);
  db.exec("INSERT INTO groups(id,name) VALUES(1,'A'),(2,'B'); INSERT INTO user_groups VALUES(1,1);");
  const archive=(kind:string,id:number,payload:any)=>db.query('INSERT INTO legacy_records VALUES(?,?,?,?)').run(kind,String(id),JSON.stringify(payload),future);
  const ps=type==='shadowsocks'?{cipher:'2022-blake3-aes-128-gcm'}:type==='vless'?{tls:2,flow:'xtls-rprx-vision',reality_settings:{server_name:'example.test',server_port:443,private_key:'private',public_key:'public',short_id:'abcd'}}:{tls:type==='anytls'?{server_name:'example.test'}:1};
  archive('v2_user',1,{id:1,uuid:oldUUID});
  archive('v2_server',10,{id:10,type,name:'Root',host:'root.example.test',port:443,server_port:8443,enabled:'1',show:'1',parent_id:'0',group_ids:[1],protocol_settings:ps,created_at:'1700000000',tls_material:tls,...extra});
  archive('v2_server_machine',2,{id:2,name:'Machine'});
  archive('v2_server_machine_binding',1,{id:1,machine_id:2,server_id:10});
  return {db,archive};
}
function activate(db:ReturnType<typeof openDatabase>,id=2) { const c=compileMachine(db,id);provisionMachineToken(db,id);activateMachine(db,id,{verified:true,appliedRevision:c.revision,coreReady:true,telemetryReady:true});return c; }

describe('independent runtime restoration',()=>{
  test('restores additive pending rows with original identity and preserves archive',()=>{
    const {db}=fixture();const before=db.query('SELECT * FROM legacy_records').all();
    const r=restoreRuntime(db);expect(r.nodes).toBe(1);expect(authorizedEndpoints(db,1)).toEqual([]);
    expect(db.query('SELECT * FROM legacy_records').all()).toEqual(before);expect((db.query('SELECT credential FROM users').get() as any).credential).not.toBe(oldUUID);
    expect((db.query('SELECT credential FROM runtime_identity_credentials WHERE node_id=0').get() as any).credential).toBe(oldUUID);
    const c=activate(db);const endpoint=authorizedEndpoints(db,1)[0]!;
    expect(c.config.inbounds[0].listen_port).toBe(8443);expect(endpoint.port).toBe(443);
    const [server,user]=endpoint.credential.split(':');expect(c.config.inbounds[0].password).toBe(server);expect(c.config.inbounds[0].users[0].password).toBe(user);
    expect(server).toBe(Buffer.from(createHash('md5').update('1700000000').digest('hex').slice(0,16)).toString('base64'));
    expect(user).toBe(Buffer.from(oldUUID.slice(0,16)).toString('base64'));db.close();
  });
  test('idempotent repeat restoration keeps credentials, token and activation',()=>{
    const {db}=fixture();restoreRuntime(db);const token=provisionMachineToken(db,2);const c=compileMachine(db,2);activateMachine(db,2,{verified:true,appliedRevision:c.revision,coreReady:true,telemetryReady:true});
    const credentials=db.query('SELECT * FROM runtime_identity_credentials').all();restoreRuntime(db);
    expect(db.query('SELECT * FROM runtime_identity_credentials').all()).toEqual(credentials);expect(compileMachine(db,2).revision).toBe(c.revision);expect(authenticateRuntimeMachine(db,token)).toBe(2);expect(authorizedEndpoints(db,1).length).toBe(1);db.close();
  });
  test('child alias shares physical inbound but has isolated client identity and port',()=>{
    const {db,archive}=fixture();archive('v2_server',11,{id:11,parent_id:10,type:'shadowsocks',name:'Child',host:'child.example.test',port:444,server_port:9999,enabled:1,show:1,group_ids:[1],protocol_settings:{cipher:'2022-blake3-aes-128-gcm'},created_at:'1800000000'});
    restoreRuntime(db);const c=activate(db);expect(c.config.inbounds).toHaveLength(1);expect(c.config.inbounds[0].users).toHaveLength(2);
    const endpoints=authorizedEndpoints(db,1);expect(endpoints).toHaveLength(2);expect(endpoints[1]!.port).toBe(444);expect(endpoints[1]!.credential.split(':')[0]).toBe(endpoints[0]!.credential.split(':')[0]);expect(endpoints[1]!.credential.split(':')[1]).not.toBe(endpoints[0]!.credential.split(':')[1]);
    expect(c.traffic_labels.map(t=>t.node_id)).toEqual([10,11]);db.close();
  });
  test('profile identity preserves source derivation, filters entry and scopes outbound',()=>{
    const {db,archive}=fixture('vless');archive('v2_server',11,{id:11,parent_id:10,type:'vless',name:'Child',host:'child.test',port:443,enabled:1,show:1,group_ids:[1],protocol_settings:{}});
    archive('v2_outbound_template',5,{id:5,uuid:'template-5',protocol:'shadowsocks',enabled:1,settings:'ENCRYPTED-SENTINEL'});
    archive('v2_server_outbound_template',3,{id:3,server_id:10,outbound_template_id:5,tag:'exit',enabled:1});
    archive('v2_server_route_profile',4,{id:4,server_id:10,uuid:'profile-4',name:'Exit',enabled:1,outbound_template_id:5,entry_server_ids:[11]});
    restoreRuntime(db,{supplements:[{kind:'v2_outbound_template',id:5,payload:{settings:{server:'exit.test',server_port:443,method:'2022-blake3-aes-128-gcm',password:'secret'}}}]});const c=activate(db);
    expect(c.config.outbounds[1].tag).toBe('n10:exit');expect(c.config.inbounds[0].users).toHaveLength(3);
    const expected=deriveUUID(deriveUUID(oldUUID,'xboard-route-profile:v1:profile-4'),'xboard-child-node:v1:11');expect(c.config.inbounds[0].users[2].uuid).toBe(expected);
    expect(c.config.route.rules.find((r:any)=>r.auth_user)).toMatchObject({auth_user:['mb:u:1:n:11:p:profile-4'],outbound:'n10:exit'});
    const ep=authorizedEndpoints(db,1);expect(ep).toHaveLength(3);expect(ep[2]!.credential).toBe(expected);expect(ep[0]!.settings.tls.reality.private_key).toBeUndefined();expect(ep[0]!.settings.tls.reality.public_key).toBe('public');expect(ep[0]!.settings.reality_settings).toBeUndefined();
    restoreRuntime(db);expect(compileMachine(db,2).revision).toBe(c.revision);db.close();
  });
  test.each(['vless','trojan','anytls'])('%s client credential matches native server auth',(type)=>{
    const {db}=fixture(type);restoreRuntime(db);const c=activate(db);const e=authorizedEndpoints(db,1)[0]!;expect(c.config.inbounds[0].users[0][type==='vless'?'uuid':'password']).toBe(e.credential);expect(c.files).toHaveLength(0);db.close();
  });
  test('grants, expiry, quota, hidden aliases and disabled users gate access',()=>{
    const {db,archive}=fixture();archive('v2_server',11,{id:11,parent_id:10,type:'shadowsocks',name:'Other',host:'other.test',port:443,enabled:1,show:1,group_ids:[2],protocol_settings:{cipher:'2022-blake3-aes-128-gcm'}});restoreRuntime(db);activate(db);expect(authorizedEndpoints(db,1)).toHaveLength(1);
    db.exec("UPDATE users SET expires_at='2000-01-01'");expect(compileMachine(db,2).traffic_labels).toHaveLength(0);expect(authorizedEndpoints(db,1)).toHaveLength(0);
    db.query('UPDATE users SET expires_at=?,upload_bytes=1000').run(future);expect(authorizedEndpoints(db,1)).toHaveLength(0);
    db.exec('UPDATE users SET upload_bytes=0,enabled=0');expect(authorizedEndpoints(db,1)).toHaveLength(0);db.close();
  });
  test('hidden entry retains authorized old-client auth but is omitted from subscription',()=>{
    const {db,archive}=fixture();archive('v2_server',11,{id:11,parent_id:10,type:'shadowsocks',name:'Hidden',host:'hidden.test',port:443,enabled:1,show:0,group_ids:[1],protocol_settings:{cipher:'2022-blake3-aes-128-gcm'}});restoreRuntime(db);const c=activate(db);expect(c.traffic_labels).toHaveLength(2);expect(authorizedEndpoints(db,1)).toHaveLength(1);db.close();
  });
  test('unmatched binding stays reported and cannot activate nonexistent physical source',()=>{
    const {db,archive}=fixture();archive('v2_server_machine_binding',2,{id:2,machine_id:999,server_id:10});restoreRuntime(db);expect(restoreRuntime(db).unmatched_bindings).toEqual(['machine 999, node 10']);expect(()=>compileMachine(db,999)).toThrow(RuntimeCompileError);db.close();
  });
  test('multi-machine root compiles once per machine and pending others stay pending',()=>{
    const {db,archive}=fixture('trojan');archive('v2_server_machine',3,{id:3});archive('v2_server_machine_binding',2,{id:2,machine_id:3,server_id:10});restoreRuntime(db);activate(db);expect(compileMachine(db,3).config.inbounds).toHaveLength(1);expect((db.query('SELECT active FROM runtime_machines WHERE id=3').get() as any).active).toBe(0);db.close();
  });
  test('activation requires verified correct revision, fresh token and both readiness probes',()=>{
    const {db}=fixture();restoreRuntime(db);const c=compileMachine(db,2);expect(()=>activateMachine(db,2,{verified:true,appliedRevision:c.revision,coreReady:true,telemetryReady:true})).toThrow('fresh-token-required');provisionMachineToken(db,2);
    expect(()=>activateMachine(db,2,{verified:true,appliedRevision:999999,coreReady:true,telemetryReady:true})).toThrow('activation-probe-required');expect(()=>activateMachine(db,2,{verified:true,appliedRevision:c.revision,coreReady:true,telemetryReady:false})).toThrow('activation-probe-required');expect(authorizedEndpoints(db,1)).toHaveLength(0);db.close();
  });
  test('malformed config fails sanitized and leaves machine pending',()=>{
    const {db}=fixture('vless',{protocol_settings:{tls:2,reality_settings:{private_key:'SECRET-DO-NOT-LOG'}}});restoreRuntime(db);
    try{compileMachine(db,2);throw Error('expected fail');}catch(e){expect(String(e)).toContain('incomplete-reality');expect(String(e)).not.toContain('SECRET-DO-NOT-LOG');}
    expect((db.query('SELECT active FROM runtime_machines').get() as any).active).toBe(0);db.close();
  });
  test('encrypted routing and missing TLS are never silently degraded',()=>{
    const {db,archive}=fixture('trojan',{tls_material:{}});restoreRuntime(db);expect(()=>compileMachine(db,2)).toThrow('tls-material-needs-verified-supplement');
    archive('v2_outbound_template',5,{id:5,protocol:'vless',settings:'SECRET-CIPHERTEXT'});archive('v2_server_outbound_template',1,{id:1,server_id:10,outbound_template_id:5,tag:'exit',enabled:1});restoreRuntime(db,{supplements:[{kind:'v2_server',id:10,payload:{tls_material:tls}}]});expect(()=>compileMachine(db,2)).toThrow(RuntimeCompileError);db.close();
  });
  test('numeric revisions change with grants and heartbeat readiness requires exact revision',()=>{
    const {db}=fixture();restoreRuntime(db);const first=compileMachine(db,2);expect(first.revision).toBe(1);expect(compileMachine(db,2).revision).toBe(1);
    expect(heartbeatRuntimeMachine(db,2,{applied_revision:1,core_ready:true,telemetry_ready:true}).ready).toBe(true);
    db.exec('DELETE FROM user_groups');const next=compileMachine(db,2);expect(next.revision).toBe(2);expect(heartbeatRuntimeMachine(db,2,{applied_revision:1,core_ready:true,telemetry_ready:true}).ready).toBe(false);db.close();
  });
  test('TLS content generates private files while endpoint settings never contain PEM',()=>{
    const {db}=fixture('trojan',{tls_material:undefined,cert_config:{cert_mode:'content',cert_content:'-----BEGIN CERTIFICATE-----\\nSYNTHETIC\\n-----END CERTIFICATE-----',key_content:'-----BEGIN PRIVATE KEY-----\\nSYNTHETIC\\n-----END PRIVATE KEY-----'}});restoreRuntime(db);const c=activate(db);expect(c.files).toHaveLength(2);expect(c.files[0]!.mode).toBe(0o600);expect(c.config.inbounds[0].tls.certificate_path).toBe('/etc/mboard-node/tls/10.crt');expect(JSON.stringify(authorizedEndpoints(db,1))).not.toContain('SYNTHETIC');db.close();
  });
  test('WireGuard 1.14 translates deprecated peers into routed endpoints',()=>{
    const {db}=fixture('shadowsocks',{custom_outbounds:[{protocol:'wireguard',tag:'warp',settings:{secret_key:'synthetic-private',local_address:['172.16.0.2/32'],peers:[{endpoint:'[2001:db8::1]:2408',public_key:'synthetic-public',allowed_ips:['0.0.0.0/0','::/0'],reserved:[1,2,3]}],system_interface:false,interface_name:'warp0'}}],custom_routes:[{domain:['domain:example.test'],outboundTag:'warp'}]});restoreRuntime(db);const c=compileMachine(db,2);expect(c.config.endpoints[0]).toMatchObject({type:'wireguard',tag:'n10:warp',address:['172.16.0.2/32'],system:false,name:'warp0',peers:[{address:'2001:db8::1',port:2408,public_key:'synthetic-public',reserved:[1,2,3]}]});expect(c.config.endpoints[0].secret_key).toBeUndefined();expect(c.config.route.rules.find((r:any)=>r.domain_suffix)).toMatchObject({domain_suffix:['example.test'],outbound:'n10:warp'});expect(c.warnings).toHaveLength(1);db.close();
  });
  test('template rule selectors preserve source OR semantics and numeric port ranges',()=>{
    const {db,archive}=fixture();archive('v2_route_template',3,{id:3,enabled:1,rules:[{match:{domains:['example.test'],ports:['443','8000-8100']},action:{type:'direct'}}]});archive('v2_server_route_template',1,{id:1,server_id:10,route_template_id:3,enabled:1});restoreRuntime(db);const rules=compileMachine(db,2).config.route.rules;expect(rules.find((r:any)=>r.domain)).toMatchObject({domain:['example.test'],outbound:'direct'});expect(rules.find((r:any)=>r.port)).toMatchObject({port:[443],port_range:['8000:8100'],outbound:'direct'});expect(rules.find((r:any)=>r.domain).port).toBeUndefined();db.close();
  });
  test('legacy root auth route aliases translate to runtime labels',()=>{
    const {db}=fixture('shadowsocks',{custom_routes:[{auth_user:[oldUUID],outbound:'direct'}]});restoreRuntime(db);const c=compileMachine(db,2);expect(c.config.route.rules.find((r:any)=>r.auth_user).auth_user).toEqual(['mb:u:1:n:10:p:0']);db.close();
  });
  test('canonical geosite custom route keeps its scoped SOCKS target and enables cached rule-sets',()=>{
    const {db}=fixture('shadowsocks',{custom_outbounds:[{tag:'warp',protocol:'socks',settings:{address:'127.0.0.1',port:40000}}],custom_routes:[{domain:['geosite:google'],outboundTag:'warp'}]});restoreRuntime(db);
    const c=compileMachine(db,2);expect(c.config.outbounds[1]).toEqual({type:'socks',tag:'n10:warp',server:'127.0.0.1',server_port:40000,version:'5'});
    expect(c.config.route.rules[0]).toEqual({action:'sniff',inbound:['mb:n:10']});
    expect(c.config.route.rules[1]).toEqual({rule_set:['geosite-google'],action:'route',outbound:'n10:warp',inbound:['mb:n:10']});
    expect(c.config.route.rule_set).toEqual([{type:'remote',format:'binary',tag:'geosite-google',url:'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-google.srs'}]);
    expect(c.config.experimental.cache_file.enabled).toBe(true);expect(compileMachine(db,2).revision).toBe(c.revision);db.close();
  });
  test('missing custom target still fails sanitized instead of dropping the geosite route',()=>{
    const {db}=fixture('shadowsocks',{custom_routes:[{domain:['geosite:google'],auth_user:['SYNTHETIC-AUTH-NOT-TO-LOG'],outboundTag:'warp'}]});restoreRuntime(db);
    try {compileMachine(db,2);throw Error('expected fail');} catch(e) {expect(String(e)).toContain('route-target-missing: node 10');expect(String(e)).not.toContain('SYNTHETIC-AUTH-NOT-TO-LOG');}
    db.close();
  });
  test('mixed geo and ordinary selectors stay OR inside auth, ports and inversion',()=>{
    const {db}=fixture('shadowsocks',{custom_routes:[{domain:['geosite:google','full:example.test','domain:other.test'],ip_cidr:['198.51.100.0/24'],auth_user:[oldUUID],port:[443],invert:true,outbound:'direct'}]});restoreRuntime(db);
    const c=compileMachine(db,2),rule=c.config.route.rules[1];expect(rule).toMatchObject({type:'logical',mode:'and',action:'route',outbound:'direct'});expect(rule.inbound).toBeUndefined();
    expect(rule.rules[0]).toEqual({inbound:['mb:n:10']});expect(rule.rules[1]).toEqual({type:'logical',mode:'and',invert:true,rules:[{type:'logical',mode:'or',rules:[{domain:['example.test'],domain_suffix:['other.test'],ip_cidr:['198.51.100.0/24']},{rule_set:['geosite-google']}]},{auth_user:['mb:u:1:n:10:p:0'],port:[443]}]});db.close();
  });
  test('plain mixed domain aliases remain one inverted native match',()=>{
    const {db}=fixture('shadowsocks',{custom_routes:[{domain:['full:exact.test','domain:suffix.test','regexp:^regex\\.test$','keyword:word'],domain_suffix:['native.test'],invert:true,outbound:'block'}]});restoreRuntime(db);
    expect(compileMachine(db,2).config.route.rules[1]).toEqual({type:'logical',mode:'and',action:'reject',rules:[{inbound:['mb:n:10']},{domain:['exact.test'],domain_suffix:['native.test','suffix.test'],domain_regex:['^regex\\.test$'],domain_keyword:['word'],invert:true}]});db.close();
  });
  test('native logical OR recurses through geo, auth aliases and scoped endpoint targets',()=>{
    const {db}=fixture('shadowsocks',{custom_outbounds:[{protocol:'wireguard',tag:'warp',settings:{private_key:'synthetic-private',local_address:['172.16.0.2/32'],peers:[{address:'192.0.2.1',port:2408,public_key:'synthetic-public'}]}}],custom_routes:[{type:'logical',mode:'or',rules:[{domain:['geosite:google']},{type:'logical',mode:'and',rules:[{auth_user:[oldUUID]},{ip_cidr:['geoip:cn']}]}],outbound:'warp'}]});restoreRuntime(db);
    const c=compileMachine(db,2),rule=c.config.route.rules[1];expect(rule.outbound).toBe('n10:warp');expect(c.config.endpoints[0].tag).toBe('n10:warp');
    expect(rule.rules[1]).toEqual({type:'logical',mode:'or',rules:[{rule_set:['geosite-google']},{type:'logical',mode:'and',rules:[{auth_user:['mb:u:1:n:10:p:0']},{rule_set:['geoip-cn']}]}]});
    expect(c.config.route.rule_set.map((r:any)=>r.tag)).toEqual(['geosite-google','geoip-cn']);db.close();
  });
  test('geo source wrappers use source CIDR mode and private ranges do not fetch assets',()=>{
    const {db}=fixture('shadowsocks',{custom_routes:[{source_ip_cidr:['geoip:cn','geoip:private','192.0.2.0/24'],outbound:'direct'},{geoip:['private'],outbound:'block'}]});restoreRuntime(db);
    const c=compileMachine(db,2);expect(c.config.route.rules[1].rules[1]).toEqual({type:'logical',mode:'or',rules:[{source_ip_cidr:['192.0.2.0/24']},{rule_set:['geoip-cn'],rule_set_ip_cidr_match_source:true},{source_ip_is_private:true}]});
    expect(c.config.route.rules[2]).toEqual({ip_is_private:true,action:'reject',inbound:['mb:n:10']});expect(c.config.route.rule_set).toHaveLength(1);db.close();
  });
  test('source UUID uses explicit custom rule-set settings instead of inferred geosite URLs',()=>{
    const {db,archive}=fixture();archive('v2_rule_set',9,{id:9,uuid:'custom-source-9',tag:'adsaibands',enabled:1,settings:{singbox:{format:'source',url:'https://rules.example.test/custom.json',update_interval:'24h'}}});
    archive('v2_route_template',3,{id:3,enabled:1,rules:[{match:{rule_sets:['custom-source-9'],domains:['geosite:category-ai-!cn']},action:{type:'direct'}}]});archive('v2_server_route_template',1,{id:1,server_id:10,route_template_id:3,enabled:1});restoreRuntime(db);
    const c=compileMachine(db,2);expect(c.config.route.rule_set).toContainEqual({type:'remote',format:'source',tag:'adsaibands',url:'https://rules.example.test/custom.json',update_interval:'24h'});
    expect(c.config.route.rule_set).toContainEqual({type:'remote',format:'binary',tag:'geosite-category-ai-!cn',url:'https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/geosite-category-ai-!cn.srs'});
    expect(c.config.route.rules.some((r:any)=>r.rule_set?.includes('adsaibands'))).toBe(true);db.close();
  });
  test('custom external geosite selectors require explicit rule-sets',()=>{
    const {db}=fixture('shadowsocks',{custom_routes:[{domain:['geosite:ext:private.dat:custom'],outbound:'direct'}]});restoreRuntime(db);expect(()=>compileMachine(db,2)).toThrow('custom-geo-selector-needs-rule-set');db.close();
  });
  test.skipIf(!process.env.MBOARD_TEST_SING_BOX)('pinned core accepts synthesized geosite SOCKS and scoped logical routes',()=>{
    for(const custom_routes of [
      [{domain:['geosite:google'],outboundTag:'warp'}],
      [{type:'logical',mode:'or',rules:[{domain:['geosite:google','domain:example.test'],port:[443],invert:true},{source_ip_cidr:['geoip:cn'],auth_user:[oldUUID]}],outbound:'warp'}]
    ]) {
      const {db}=fixture('shadowsocks',{custom_outbounds:[{tag:'warp',protocol:'socks',settings:{address:'127.0.0.1',port:40000}}],custom_routes});restoreRuntime(db);
      const result=spawnSync(process.env.MBOARD_TEST_SING_BOX!,['check','-c','/dev/stdin'],{input:JSON.stringify(compileMachine(db,2).config),encoding:'utf8'});
      expect(result.stderr).toBe('');expect(result.status).toBe(0);db.close();
    }
  });
  test('explicit PSK wins over ambiguous date timestamp',()=>{expect(shadowsocksServerPSK({id:1,created_at:'2024-01-01',server_psk:Buffer.from('1234567890123456').toString('base64')},'2022-blake3-aes-128-gcm')).toBe(Buffer.from('1234567890123456').toString('base64'));expect(()=>shadowsocksServerPSK({id:1,created_at:'2024-01-01'},'2022-blake3-aes-128-gcm')).toThrow('ambiguous-server-psk');});
});
