import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  getTemplate, initializeSubscriptionTemplates, listTemplates, MAX_TEMPLATE_BYTES,
  renderShareLinks, renderSubscription, saveTemplate, selectSubscriptionFormat, TEMPLATE_NAMES, TemplateValidationError,
  validateTemplate, type SubscriptionEndpoint, type TemplateName,
} from '../src/server/subscriptions';

const databases: Database[] = [], dirs: string[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function database(path = ':memory:') { const db = new Database(path, { create: true, strict: true }); databases.push(db); return db; }
function legacy(db: Database, contents: Record<TemplateName, string>) {
  db.exec('CREATE TABLE IF NOT EXISTS legacy_records (kind TEXT,id TEXT,payload TEXT,created_at TEXT,PRIMARY KEY(kind,id))');
  TEMPLATE_NAMES.forEach((name, index) => db.query('INSERT INTO legacy_records VALUES (?,?,?,?)').run('v2_subscribe_templates', String(index + 1), JSON.stringify({ id: index + 1, name, content: contents[name], created_at: '2020-01-01', updated_at: '2021-02-03' }), '2022-03-04'));
}
const endpoint = (patch: Partial<SubscriptionEndpoint> = {}): SubscriptionEndpoint => ({ id: 1, name: '香港 HK', protocol: 'trojan', host: 'authorized.example.test', port: 443, credential: 'synthetic-password', settings: { tls: { enabled: true, server_name: 'sni.example.test' } }, ...patch });
function template(name: TemplateName, content?: string) { const db = database(); initializeSubscriptionTemplates(db); return { name, content: content ?? getTemplate(db, name)!.content }; }
const customIni = '# 用户自己的注释\r\n[General]\r\ndns-server = 1.1.1.1\r\n[Proxy]\r\n本地 = direct\r\n[Proxy Group]\r\n香港 = select, 本地, policy-regex-filter=HK|香港, url=http://test.example/\r\n总选择 = select, 香港, DIRECT\r\n[Rule]\r\nDOMAIN-SUFFIX,custom.example,香港\r\nFINAL,总选择\r\n';
const legacyRules = Array.from({ length: 510 }, (_, i) => `DOMAIN-SUFFIX,rule-${i}.example.test,Proxy`);
const legacyIni = '#!MANAGED-CONFIG $subs_link interval=86400 strict=false\r\n# OriginalRestore\r\n[General]\r\ndns-server=1.1.1.1\r\nalways-real-ip=$subs_domain\r\n[Proxy]\r\n  $proxies  \r\n[Proxy Group]\r\nProxy=select,auto,fallback,$proxy_group\r\nauto=url-test,$proxy_group,url=https://probe.example.test/204,interval=300\r\nfallback=fallback,$proxy_group,url=https://probe.example.test/204,interval=300\r\n[Panel]\r\nuserinfo=$subscribe_info\r\n[Rule]\r\n' + legacyRules.join('\r\n') + '\r\nFINAL,Proxy\r\n';
const legacyYaml = '# OriginalRestore\n dns: {enable: true, nameserver: [https://dns.example.test/query]}\n'.replace('\n dns:', '\ndns:')
  + 'proxies: $proxies # authorized nodes\nproxy-groups:\n'
  + '  - {name: "$app_name", type: select, proxies: [auto, fallback, DIRECT, "$proxy_group"]}\n'
  + '  - {name: auto, type: url-test, proxies: $proxy_group, url: https://probe.example.test/204, interval: 300}\n'
  + '  - {name: fallback, type: fallback, proxies: [$proxy_group], url: https://probe.example.test/204, interval: 300}\n'
  + 'rules:\n' + legacyRules.map(rule => '  - ' + rule.replace(/,Proxy$/, ',$app_name')).join('\n') + '\n  - MATCH,$app_name\n';
const synthetic = {
  singbox: '{\n "dns":{"servers":[{"type":"https","tag":"自定义","server":"dns.example"}]}, "outbounds":[{"type":"selector","tag":"选择","outbounds":["direct"]},{"type":"direct","tag":"direct"}], "route":{"rules":[{"domain_suffix":["custom.example"],"outbound":"direct"}],"final":"选择"}}\n',
  clash: '# custom clash\nproxies: []\nproxy-groups: [{name: 选择, type: select, proxies: [DIRECT]}]\nrules: ["DOMAIN-SUFFIX,custom.example,DIRECT"]\n',
  clashmeta: '# custom meta\nproxies: []\nproxy-groups: [{name: 选择, type: select, proxies: [DIRECT]}]\nrules: ["DOMAIN-SUFFIX,custom.example,DIRECT"]\n',
  stash: '# custom stash\nproxies: []\nproxy-groups: [{name: 选择, type: select, proxies: [DIRECT]}]\nrules: ["DOMAIN-SUFFIX,custom.example,DIRECT"]\n',
  surge: customIni,
  surfboard: customIni,
} satisfies Record<TemplateName, string>;

test('CN relay mode uses separate front and exit controls while normal exits remain direct',()=>{
 const front={name:'CN HTTP',type:'http',server:'192.0.2.1',port:443,headers:{Host:'cdn.example.test'}};
 const source=JSON.stringify({proxies:[front],'x-mboard-dialer-proxy':{front:'CN前置',group:'CN中转',provider:'cn-relay'},'proxy-groups':[{name:'总模式',type:'select',proxies:['节点选择','CN中转','DIRECT']},{name:'CN前置',type:'select',proxies:['DIRECT','CN HTTP']},{name:'CN中转',type:'select',proxies:[],use:['cn-relay']},{name:'节点选择',type:'select',proxies:[]}],rules:['MATCH,总模式']});
 const outputs=parse(renderSubscription(template('clashmeta',source),[endpoint({name:'JP exit'}),endpoint({id:2,name:'HK exit'})]).content);
 expect(outputs['proxy-groups'].map((g:any)=>g.name)).toEqual(['总模式','CN前置','CN中转','节点选择']);expect(outputs['proxy-groups'][1].proxies).toEqual(['DIRECT','CN HTTP']);expect(outputs['proxy-groups'][2].proxies).toEqual([]);expect(outputs['proxy-groups'][2].use).toEqual(['cn-relay']);expect(outputs['proxy-groups'][0].proxies).toContain('CN中转');
 const provider=outputs['proxy-providers']['cn-relay'];expect(provider.type).toBe('inline');expect(provider.override).toEqual({'dialer-proxy':'CN前置'});expect(provider.payload.map((p:any)=>p.name)).toEqual(['JP exit','HK exit']);
 for(const proxy of outputs.proxies)expect(proxy['dialer-proxy']).toBeUndefined();expect(outputs['x-mboard-dialer-proxy']).toBeUndefined();
 const collision=JSON.parse(source);collision['proxy-providers']={'cn-relay':{type:'http',url:'https://private.example.test'}};expect(validateTemplate('clashmeta',JSON.stringify(collision)).valid).toBe(false);
 const cyclic=JSON.parse(source);cyclic['x-mboard-dialer-proxy'].group='CN前置';expect(validateTemplate('clashmeta',JSON.stringify(cyclic)).valid).toBe(false);
});

test('Clash Meta optional dialer binds only dynamic exits and keeps front selection static',()=>{
 const fronts=Array.from({length:5},(_,i)=>({name:`国内前置${i+1}`,type:'http',server:`192.0.2.${i+1}`,port:443,tls:false,udp:false,headers:{Host:'cdn.example.test','X-Test-Auth':'synthetic-private','User-Agent':'synthetic-agent'}}));
 const source=JSON.stringify({proxies:fronts,'x-mboard-dialer-proxy':'国内前置','proxy-groups':[{name:'国内前置',type:'select','default-selected':'DIRECT',proxies:['DIRECT',...fronts.map(f=>f.name)]},{name:'大流量',type:'select',filter:'US|JP',proxies:['$proxy_group']}],rules:['MATCH,大流量']});
 const saved=template('clashmeta',source),r=renderSubscription(saved,[endpoint({name:'US Exit'}),endpoint({id:2,name:'HK Exit'})]),cfg=parse(r.content);
 expect(cfg.proxies).toHaveLength(7);expect(cfg['x-mboard-dialer-proxy']).toBeUndefined();expect(cfg['proxy-groups'][0].proxies).toEqual(['DIRECT',...fronts.map(f=>f.name)]);expect(cfg['proxy-groups'][0]['default-selected']).toBe('DIRECT');expect(cfg['proxy-groups'][1].proxies).toEqual(['US Exit']);
 expect(cfg.proxies.slice(0,5)).toEqual(fronts);for(const p of cfg.proxies.slice(5))expect(p['dialer-proxy']).toBe('国内前置');for(const p of cfg.proxies.slice(0,5))expect(p['dialer-proxy']).toBeUndefined();expect(r.node_count).toBe(2);expect(saved.content).toBe(source);
});

test('dialer validation rejects loops, missing/ambiguous members and header injection without echoing credentials',()=>{
 const base={proxies:[{name:'front',type:'http',server:'192.0.2.1',port:443,headers:{Host:'cdn.example.test'}}],'x-mboard-dialer-proxy':'前置','proxy-groups':[{name:'前置',type:'select',proxies:['DIRECT','front']}],rules:['MATCH,前置']};
 for(const patch of [{...base,'x-mboard-dialer-proxy':'missing'},{...base,'proxy-groups':[{name:'前置',type:'select',proxies:['前置']}]},{...base,'proxy-groups':[{name:'前置',type:'select',proxies:['$proxy_group']}]},{...base,proxies:[{...base.proxies[0],'dialer-proxy':'前置'}]},{...base,proxies:[{...base.proxies[0],headers:{Host:'private-secret\r\nInjected: x'}}]}]){const content=JSON.stringify(patch),validation=validateTemplate('clashmeta',content);expect(validation.valid).toBe(false);expect(JSON.stringify(validation)).not.toContain('private-secret');expect(()=>renderSubscription(template('clashmeta',content),[endpoint()])).toThrow(TemplateValidationError)}
 expect(validateTemplate('stash',JSON.stringify(base)).valid).toBe(false);
});

test('dialer-free formats stay unchanged and nested static dialer groups never receive exits',()=>{
 const source=JSON.stringify({proxies:[{name:'front',type:'http',server:'192.0.2.1',port:443}],'x-mboard-dialer-proxy':'前置','proxy-groups':[{name:'前置',type:'select',proxies:['DIRECT','子前置']},{name:'子前置',type:'select',proxies:['front']},{name:'出口',type:'select',proxies:[]}],rules:['MATCH,出口']});
 const cfg=parse(renderSubscription(template('clashmeta',source),[endpoint({name:'JP exit'})]).content);expect(cfg['proxy-groups'][0].proxies).toEqual(['DIRECT','子前置']);expect(cfg['proxy-groups'][1].proxies).toEqual(['front']);expect(cfg['proxy-groups'][2].proxies).toEqual(['JP exit']);
 for(const name of ['clash','clashmeta','stash']as const){const cfg=parse(renderSubscription(template(name),[endpoint()]).content);for(const p of cfg.proxies)expect(p['dialer-proxy']).toBeUndefined()}
});

test('YAML group filter materializes only matching nodes and keeps HK separate from bulk download', () => {
  const filter='(?i)🇸🇬|🇯🇵|🇺🇸|SG|JP|US|Starhub|Sony|LightSail|Akko|Bitsflow|DMIT|新加坡|日本|美国';
  const content='# preserve exact template\nproxies: []\nproxy-groups:\n  - name: 大流量下载\n    type: url-test\n    filter: "'+filter+'"\n    exclude-type: trusttunnel\n    url: https://probe.example.test/204\n  - {name: HK自动, type: url-test, filter: "(?i)🇭🇰|港|HK"}\nrules: ["MATCH,大流量下载"]\n';
  const db=database();initializeSubscriptionTemplates(db);const saved=saveTemplate(db,'clashmeta',content);
  const inputs=['🇭🇰AliCDT','🇭🇰Ciallo@腾讯IX','🇸🇬LightSail','🇯🇵Zouter','🇺🇸bitsflow','🇩🇪MhyIDC 9929','🇩🇪Akko'].map((name,id)=>endpoint({name,id:id+1}));
  const cfg=parse(renderSubscription(saved,inputs).content);
  expect(cfg['proxy-groups'][0].proxies).toEqual(['🇸🇬LightSail','🇯🇵Zouter','🇺🇸bitsflow','🇩🇪Akko']);
  expect(cfg['proxy-groups'][0].proxies.some((name:string)=>name.includes('🇭🇰'))).toBe(false);
  expect(cfg['proxy-groups'][1].proxies).toEqual(['🇭🇰AliCDT','🇭🇰Ciallo@腾讯IX']);
  expect(cfg['proxy-groups'][0].filter).toBe(filter);expect(cfg.rules).toEqual(['MATCH,大流量下载']);expect(getTemplate(db,'clashmeta')!.content).toBe(content);
});

test('YAML include, exclude and type selectors apply to expanded markers while authored nested groups survive', () => {
  const inputs=[endpoint({id:1,name:'🇭🇰Akko HK'}),endpoint({id:2,name:'🇺🇸Akko US'}),endpoint({id:3,name:'🇯🇵Sony JP'}),endpoint({id:4,name:'🇸🇬SS',protocol:'shadowsocks',settings:{method:'aes-128-gcm'}})];
  const content='proxies: []\nproxy-groups:\n  - {name: 总模式, type: select, proxies: [大流量, DIRECT]}\n  - {name: 大流量, type: select, filter: "(?i)Akko|Sony|SS", exclude-filter: "(?i)🇭🇰|HK|香港", exclude-type: "Shadowsocks|HTTP", proxies: [手动, DIRECT, "$proxy_group"]}\n  - {name: 手动, type: select, proxies: ["/(?i)us|jp/"]}\nrules: ["MATCH,总模式"]\n';
  for(const format of ['clash','clashmeta','stash'] as const){const cfg=parse(renderSubscription(template(format,content),inputs).content);expect(cfg['proxy-groups'][1].proxies).toEqual(['手动','DIRECT','🇺🇸Akko US','🇯🇵Sony JP']);expect(cfg['proxy-groups'][2].proxies).toEqual(['🇺🇸Akko US','🇯🇵Sony JP']);expect(cfg['proxy-groups'][0].proxies).toContain('大流量')}
});

test('YAML delimited inline case-insensitive selectors and explicit type exclusions are respected', () => {
 const content='proxies: [{name: Static HTTP, type: http, server: static.example.test, port: 443}]\nproxy-groups: [{name: HK, type: select, proxies: ["/(?i)HK/", Static HTTP, DIRECT], exclude-type: HTTP}]\nrules: ["MATCH,HK"]\n';
 const cfg=parse(renderSubscription(template('clashmeta',content),[endpoint({name:'lowercase hk'}),endpoint({id:2,name:'Japan JP'})]).content);
 expect(cfg['proxy-groups'][0].proxies).toEqual(['lowercase hk','DIRECT']);expect(cfg.proxies).toHaveLength(3);
});

test('invalid or unsafe YAML exclude selectors keep generated members excluded rather than silently broadening a group',()=>{
 for(const pattern of ['[','(?=private-secret)']){const content=JSON.stringify({proxies:[],'proxy-groups':[{name:'safe',type:'select',proxies:['DIRECT','$proxy_group'],filter:'US|HK','exclude-filter':pattern}],rules:['MATCH,safe']});const result=renderSubscription(template('clashmeta',content),[endpoint({name:'US'}),endpoint({id:2,name:'HK'})]);expect(parse(result.content)['proxy-groups'][0].proxies).toEqual(['DIRECT']);expect(result.warnings.length).toBeGreaterThan(0);expect(result.warnings.join('')).not.toContain('private-secret')}
});

test('tencent ix hostname becomes one load-balance group over two hidden addresses', () => {
  const content = 'proxies: []\nproxy-groups:\n  - {name: 选择, type: select, proxies: [DIRECT]}\n  - {name: 香港自动, type: url-test, filter: "(?i)🇭🇰|港|HK", url: http://cp.cloudflare.com/, interval: 600}\nrules: ["MATCH,选择"]\n';
  const result = renderSubscription(template('clashmeta', content), [endpoint({ name: '🇭🇰Bage@腾讯IX', host: 'tx.example', port: 50000 }), endpoint({ id: 2, name: '其他节点', host: 'direct.example.test' })]);
  const root = parse(result.content);
  const hidden = root.proxies.filter((proxy: { hidden?: boolean }) => proxy.hidden);
  expect(hidden.map((proxy: { server: string }) => proxy.server)).toEqual(['192.0.2.10', '192.0.2.11']);
  expect(root.proxies.filter((proxy: { hidden?: boolean }) => !proxy.hidden).map((proxy: { server: string }) => proxy.server)).toEqual(['direct.example.test']);
  const balance = root['proxy-groups'].find((group: { name: string }) => group.name === '🇭🇰Bage@腾讯IX');
  expect(balance).toMatchObject({ type: 'load-balance', strategy: 'round-robin', proxies: hidden.map((proxy: { name: string }) => proxy.name) });
  const select = root['proxy-groups'].find((group: { name: string }) => group.name === '选择');
  expect(select.proxies).toContain('🇭🇰Bage@腾讯IX');
  expect(select.proxies.some((name: string) => hidden.some((proxy: { name: string }) => proxy.name === name))).toBe(false);
  expect(result.content).not.toContain('tx.example');
});
test('six archived original records seed before defaults, including names, IDs, timestamps and exact bytes', () => {
  const db = database(); legacy(db, synthetic); initializeSubscriptionTemplates(db);
  expect(listTemplates(db)).toHaveLength(6);
  TEMPLATE_NAMES.forEach((name, index) => expect(getTemplate(db, name)).toEqual({ id: index + 1, name, content: synthetic[name], created_at: '2020-01-01', updated_at: '2021-02-03', source: 'archive' }));
  initializeSubscriptionTemplates(db);
  TEMPLATE_NAMES.forEach(name => expect(getTemplate(db, name)!.content).toBe(synthetic[name]));
});
test('restart, saved edits and render never rewrite archived template content', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mboard-subscriptions-test-')); dirs.push(dir); const path = join(dir, 'test.sqlite');
  const db = database(path); legacy(db, synthetic); initializeSubscriptionTemplates(db);
  const saved = synthetic.surge.replace('custom.example', 'edited.example');
  saveTemplate(db, 'surge', saved);
  db.close(); databases.splice(databases.indexOf(db), 1);
  const reopened = database(path); initializeSubscriptionTemplates(reopened);
  expect(getTemplate(reopened, 'surge')!.content).toBe(saved);
  expect(getTemplate(reopened, 'surge')!.source).toBe('custom');
  TEMPLATE_NAMES.filter(n => n !== 'surge').forEach(name => {
    renderSubscription(getTemplate(reopened, name)!, [endpoint()]);
    expect(getTemplate(reopened, name)!.content).toBe(synthetic[name]);
  });
});
test('archive imported after first startup replaces only builtin defaults, never saved content', () => {
  const db = database(); initializeSubscriptionTemplates(db); saveTemplate(db, 'clash', synthetic.clash);
  legacy(db, synthetic); initializeSubscriptionTemplates(db);
  expect(getTemplate(db, 'clash')!.source).toBe('custom');
  expect(getTemplate(db, 'surge')!.content).toBe(synthetic.surge);
  expect(getTemplate(db, 'surge')!.id).toBe(5);
});
test('invalid archive payload rolls back instead of silently replacing the user content with defaults', () => {
  const db = database(); db.exec("CREATE TABLE legacy_records(kind TEXT,id TEXT,payload TEXT); INSERT INTO legacy_records VALUES ('v2_subscribe_templates','1','bad secret payload');");
  expect(() => initializeSubscriptionTemplates(db)).toThrow('请检查归档模板 JSON 格式');
  expect(db.query("SELECT name FROM sqlite_master WHERE name='subscription_templates'").get()).toBeNull();
});
test('save validates first, keeps exact original whitespace, and has no partial update on failure', () => {
  const db = database(); initializeSubscriptionTemplates(db); const original = getTemplate(db, 'singbox')!;
  expect(() => saveTemplate(db, 'singbox', '{"secret":"do-not-echo"')).toThrow(TemplateValidationError);
  expect(getTemplate(db, 'singbox')).toEqual(original);
  const saved = '\n' + synthetic.singbox + '\n'; expect(saveTemplate(db, 'singbox', saved).content).toBe(saved);
  expect(() => saveTemplate(db, 'Unknown', saved)).toThrow('请选择支持');
});
test('content limit uses UTF-8 bytes, with a 512 KiB ceiling', () => {
  const content = synthetic.singbox.replace('"dns":', '"padding":"' + '中'.repeat(Math.ceil(MAX_TEMPLATE_BYTES / 3)) + '","dns":');
  expect(validateTemplate('singbox', content).errors[0]!.message).toContain('512 KiB');
  expect(validateTemplate('singbox', '').valid).toBe(false);
});
test('explicit format/target, recognized UA priority, aliases and default singbox', () => {
  expect(selectSubscriptionFormat('Clash', { target: 'Surge' })).toBe('surge');
  expect(selectSubscriptionFormat('Surge', new URLSearchParams('target=clash&format=sing-box'))).toBe('singbox');
  for (const [ua, name] of [['sing-box/1.12.0', 'singbox'], ['Hiddify', 'singbox'], ['SFM', 'singbox'], ['Clash', 'clash'], ['ClashX Meta', 'clashmeta'], ['ClashMetaForAndroid', 'clashmeta'], ['mihomo/1.19.1', 'clashmeta'], ['Clash Verge', 'clashmeta'], ['Stash/3.3.0', 'stash'], ['Surge iOS', 'surge'], ['Surfboard', 'surfboard']] as const) expect(selectSubscriptionFormat(ua)).toBe(name);
  expect(selectSubscriptionFormat('unknown-client')).toBe('singbox');
  expect(() => selectSubscriptionFormat('', { format: 'exe' })).toThrow('支持的订阅格式');
  expect(selectSubscriptionFormat('Shadowrocket/2592 CFNetwork/1494 Darwin/23.4.0')).toBe('shadowrocket');
  expect(selectSubscriptionFormat('Quantumult%20X/1.0.30')).toBe('quantumultx');
  expect(selectSubscriptionFormat('Quantumult X/1.0.29')).toBe('quantumultx');
  expect(selectSubscriptionFormat('Loon/3.2.1')).toBe('loon');
  expect(selectSubscriptionFormat('Shadowrocket/2592', { format: 'singbox' })).toBe('singbox');
  expect(selectSubscriptionFormat('browser', new URLSearchParams('flag=quanx'))).toBe('quantumultx');
});
test('shadowrocket, quantumult x and loon receive share links instead of sing-box json', () => {
  const nodes = [
    endpoint({ name: '🇭🇰 Reality', protocol: 'vless', credential: '12345678-1234-4234-8234-123456789abc', settings: { flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: 'example.test', utls: { fingerprint: 'chrome' }, reality: { enabled: true, public_key: 'PUBLIC_KEY', short_id: 'abcd' } } } }),
    endpoint({ id: 2, name: 'SS2022', protocol: 'shadowsocks', port: 20180, credential: 'c2VydmVy:dXNlcg', settings: { method: '2022-blake3-aes-128-gcm' } }),
    endpoint({ id: 3, name: 'Trojan', protocol: 'trojan', settings: { tls: { enabled: true, server_name: 'sni.example.test', reality: { enabled: true, public_key: 'PUBLIC_KEY', short_id: 'ab' } } } }),
    endpoint({ id: 4, name: 'AnyTLS', protocol: 'anytls', settings: { tls: { enabled: true, server_name: 'sg.example.test' } } }),
  ];
  const rocket = renderShareLinks('shadowrocket', nodes, { userAgent: 'Shadowrocket/2592', metadata: { upload_bytes: 1024 ** 3, download_bytes: 0, quota_bytes: 0, expires_at: null } });
  const text = Buffer.from(rocket.content, 'base64').toString('utf8');
  expect(rocket.content_type).toContain('text/plain');
  expect(rocket.node_count).toBe(4);
  expect(text).toContain('STATUS=🚀↑:1GB,↓:0GB,TOT:不限💡Expires:长期有效');
  expect(text).toContain('xtls=2');
  expect(text).toContain('pbk=PUBLIC_KEY');
  expect(text).toContain('sid=abcd');
  expect(text).toContain('fp=chrome');
  expect(text).toContain(`ss://${Buffer.from('2022-blake3-aes-128-gcm:c2VydmVy:dXNlcg').toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}@authorized.example.test:20180`);
  expect(text).toContain('security=reality');
  expect(text).toContain('anytls://synthetic-password@authorized.example.test:443?sni=sg.example.test');
  const old = renderShareLinks('shadowrocket', nodes, { userAgent: 'Shadowrocket/1990' });
  expect(Buffer.from(old.content, 'base64').toString('utf8')).not.toContain('anytls://');
  expect(old.node_count).toBe(3);
  const qx = Buffer.from(renderShareLinks('quantumultx', nodes).content, 'base64').toString('utf8');
  expect(qx).toContain('vless=authorized.example.test:443,method=none,password=12345678-1234-4234-8234-123456789abc');
  expect(qx).toContain('reality-base64-pubkey=PUBLIC_KEY');
  expect(qx).toContain('reality-hex-shortid=abcd');
  expect(qx).toContain('vless-flow=xtls-rprx-vision');
  expect(qx).toContain('trojan=authorized.example.test:443,password=synthetic-password,over-tls=true');
  expect(qx).toContain('anytls=authorized.example.test:443,password=synthetic-password');
  const loon = renderShareLinks('loon', nodes);
  expect(loon.content.startsWith('🇭🇰 Reality=VLESS,')).toBe(true);
  expect(loon.content).toContain('public-key=PUBLIC_KEY');
  expect(loon.content).toContain('=anytls,');
  expect(loon.content).not.toContain('=trojan,');
  expect(loon.node_count).toBe(3);
  const skipped = renderShareLinks('shadowrocket', [endpoint({ protocol: 'vmess', credential: 'invented-secret' })]);
  expect(skipped.node_count).toBe(0);
  expect(skipped.warnings.join('') + Buffer.from(skipped.content, 'base64').toString('utf8')).not.toContain('invented-secret');
  expect(renderShareLinks('quantumultx', [endpoint({ protocol: 'vless', settings: { transport: { type: 'grpc', service_name: 'tun' }, tls: { enabled: true, server_name: 'sni.example.test' } } })]).node_count).toBe(0);
});
test('invalid JSON, YAML and INI errors are generic Chinese issues without raw credentials', () => {
  for (const [name, content] of [
    ['singbox', '{"password":"secret-value"'], ['singbox', '[]'], ['singbox', '{"outbounds":{}}'],
    ['clash', 'proxies: [secret-value\n'], ['clash', 'proxies: []\nproxies: [secret-value]\nproxy-groups: []'],
    ['clash', 'proxies: !evil secret-value\nproxy-groups: []'], ['clash', '---\nproxies: []\nproxy-groups: []\n---\nsecret-value'],
    ['surge', '[Proxy\nsecret-value'], ['surge', '[Proxy]\ninvalid-secret-value\n[Proxy Group]\n[Rule]'],
    ['surge', '[Proxy]\np = trojan, "secret-value\n[Proxy Group]\n[Rule]'],
  ] as [TemplateName, string][]) {
    const result = validateTemplate(name, content); expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain('secret-value'); expect(result.errors[0]!.message).toMatch(/[\u4e00-\u9fff]/);
  }
  const position = validateTemplate('clash', 'proxies: [\nproxy-groups: []').errors[0]!;
  expect(position.line).toBeGreaterThan(0); expect(position.column).toBeGreaterThan(0);
});
test('safe YAML anchors work within bounds, excessive aliases are rejected', () => {
  expect(validateTemplate('clash', 'dns: &dns {enable: true}\nx-dns: *dns\nproxies: []\nproxy-groups: []').valid).toBe(true);
  const recursive = 'x: &a [*a]\nproxies: []\nproxy-groups: []';
  expect(validateTemplate('clash', recursive).valid).toBe(false);
});
test('JSON keeps advanced DNS/route/experimental settings and only caller supplied authorized endpoints', () => {
  const source = JSON.parse(synthetic.singbox); source.experimental = { cache_file: { enabled: true }, custom: { nested: [1, 2] } };
  const settings = { flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: 'reality.example', utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: 'synthetic-key', short_id: 'abcd' } }, transport: { type: 'ws', path: '/preserved', headers: { Host: 'test.example' } }, domain_resolver: '自定义' };
  const e = endpoint({ protocol: 'vless', credential: 'synthetic-uuid', settings });
  const rendered = renderSubscription(template('singbox', JSON.stringify(source)), [e]); const root = JSON.parse(rendered.content);
  expect(root.dns).toEqual(source.dns); expect(root.route).toEqual(source.route); expect(root.experimental).toEqual(source.experimental);
  expect(root.outbounds.at(-1)).toMatchObject({ ...settings, uuid: e.credential, server: e.host, server_port: e.port, type: 'vless' });
  expect(root.outbounds[0].outbounds).toEqual(['direct', e.name]);
  expect(rendered.node_count).toBe(1); expect(rendered.content).not.toContain('unauthorized.example');
  expect(renderSubscription(template('singbox', JSON.stringify(source)), []).content).not.toContain(e.credential);
});
test('settings cannot override endpoint identity or credentials', () => {
  const rendered = renderSubscription(template('singbox'), [endpoint({ settings: { server: 'unauthorized.example', server_port: 9, uuid: 'other-user', password: 'other-user', type: 'unknown', tag: 'other', tls: { enabled: true } } })]);
  expect(rendered.content).not.toContain('other-user'); expect(rendered.content).not.toContain('unauthorized.example');
  expect(JSON.parse(rendered.content).outbounds.at(-1).password).toBe('synthetic-password');
});
test('Sing-box include/exclude/fallback groups use old priority and nested group names', () => {
  const content = JSON.stringify({ outbounds: [
    { type: 'selector', tag: 'HK', outbounds: [], include: 'HK|香港', exclude: 'slow' },
    { type: 'urltest', tag: 'JP', outbounds: [], include: 'Japan', fallback: ['JP|日本', 'direct'] },
    { type: 'selector', tag: 'nested', outbounds: ['HK'], include: 'no-match', fallback: 'JP' },
    { type: 'direct', tag: 'direct' },
  ] });
  const rendered = JSON.parse(renderSubscription(template('singbox', content), [endpoint(), endpoint({ id: 2, name: '日本 JP' }), endpoint({ id: 3, name: 'HK slow' })]).content);
  expect(rendered.outbounds[0].outbounds).toEqual(['香港 HK']); expect(rendered.outbounds[1].outbounds).toEqual(['日本 JP']); expect(rendered.outbounds[2].outbounds).toEqual(['HK', 'JP']);
  expect(rendered.outbounds[0].include).toBeUndefined(); expect(rendered.outbounds[0].exclude).toBeUndefined();
});
test('bad/unsafe group regex skips matches with safe warnings, rather than throwing or leaking its source', () => {
  const content = JSON.stringify({ outbounds: [{ type: 'selector', tag: 'x', outbounds: ['direct'], include: '(secret-value)+', fallback: 'direct' }, { type: 'direct', tag: 'direct' }] });
  const result = renderSubscription(template('singbox', content), [endpoint()]); expect(result.warnings.length).toBeGreaterThan(0); expect(result.warnings.join('')).not.toContain('secret-value');
});
test('three YAML formats preserve custom DNS/rules/providers/nested groups and comments', () => {
  const source = '# 用户规则注释\ndns: {enable: true, nameserver: [https://dns.example/dns-query]}\nproxy-providers: {custom: {type: http, url: https://provider.example/proxies}}\nrule-providers: {mine: {type: http, behavior: domain, url: https://rules.example/list}}\nproxies: [{name: 本地, type: direct}]\nproxy-groups:\n  - {name: 香港, type: select, proxies: ["/HK|香港/i", 本地]}\n  - {name: 总选择, type: select, proxies: [香港, DIRECT]}\n  - {name: 外部, type: select, proxies: [], use: [custom]}\nrules: ["DOMAIN-SUFFIX,custom.example,香港", "MATCH,总选择"]\n';
  for (const name of ['clash', 'clashmeta', 'stash'] as const) {
    const result = renderSubscription(template(name, source), [endpoint(), endpoint({ id: 2, name: '日本 JP' })]); const root = parse(result.content), old = parse(source);
    for (const key of ['dns', 'rules', 'proxy-providers', 'rule-providers']) expect(root[key]).toEqual(old[key]);
    expect(result.content).toContain('# 用户规则注释'); expect(root.proxies).toHaveLength(3);
    expect(root['proxy-groups'][0].proxies).toEqual(['香港 HK', '本地']);
    expect(root['proxy-groups'][1].proxies).toEqual(['香港', 'DIRECT', '香港 HK', '日本 JP']);
    expect(root['proxy-groups'][2].use).toEqual(['custom']);
  }
});
test('VLESS Reality, SS2022 and AnyTLS supported conversions and legacy Clash skips', () => {
  const endpoints = [endpoint({ protocol: 'vless', name: 'Reality', settings: { flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: 'r.test', reality: { enabled: true, public_key: 'key', short_id: '12ab' }, utls: { enabled: true, fingerprint: 'chrome' } } } }), endpoint({ protocol: 'shadowsocks', name: 'SS2022', settings: { method: '2022-blake3-aes-128-gcm' }, credential: 'server-key:user-key' }), endpoint({ protocol: 'anytls', name: 'AnyTLS' })];
  const result = renderSubscription(template('clashmeta'), endpoints); const root = parse(result.content);
  expect(root.proxies[0]).toMatchObject({ type: 'vless', flow: 'xtls-rprx-vision', 'reality-opts': { 'public-key': 'key', 'short-id': '12ab' } });
  expect(root.proxies[1]).toMatchObject({ type: 'ss', cipher: '2022-blake3-aes-128-gcm', password: 'server-key:user-key' });
  expect(root.proxies[2].type).toBe('anytls'); expect(result.node_count).toBe(3);
  const clash = renderSubscription(template('clash'), endpoints); expect(clash.node_count).toBe(0); expect(clash.warnings.length).toBeGreaterThan(0); expect(parse(clash.content).proxies).toEqual([]);
});
test('client-version capability gates AnyTLS, Reality and SS2022', () => {
  const anytls = endpoint({ protocol: 'anytls' });
  expect(renderSubscription(template('singbox'), [anytls], { userAgent: 'sing-box/1.11.0' }).node_count).toBe(0);
  expect(renderSubscription(template('singbox'), [anytls], { clientVersion: '1.12.0' }).node_count).toBe(1);
  expect(renderSubscription(template('stash'), [anytls], { userAgent: 'Stash/3.2.0' }).node_count).toBe(0);
  expect(renderSubscription(template('stash'), [anytls], { userAgent: 'Stash/3.3.0' }).node_count).toBe(1);
  const ss = endpoint({ protocol: 'shadowsocks', settings: { method: '2022-blake3-aes-128-gcm' } });
  expect(renderSubscription(template('stash'), [ss], { clientVersion: '2.9.0' }).node_count).toBe(0);
});
test('unsupported endpoint features/protocols skipped rather than invalid unknown config emitted', () => {
  const input = [endpoint({ protocol: 'invented-secret' }), endpoint({ settings: { transport: { type: 'xhttp' } } }), endpoint({ settings: { tls: { enabled: true, ech: { enabled: true } } } }), endpoint({ name: 'inject\n[Rule]' })];
  const result = renderSubscription(template('clashmeta'), input); expect(result.node_count).toBe(0); expect(parse(result.content).proxies).toEqual([]); expect(result.warnings.join('')).not.toContain('invented-secret');
});
test('INI appends proxies with no placeholders, fills filtered/nested groups, preserves Rule/General bytes', () => {
  for (const name of ['surge', 'surfboard'] as const) {
    const result = renderSubscription(template(name, customIni), [endpoint(), endpoint({ id: 2, name: '日本 JP' })]);
    expect(result.content).toContain('香港 HK = trojan, authorized.example.test, 443, password=synthetic-password');
    expect(result.content).toContain('香港 = select, 本地, 香港 HK, policy-regex-filter=HK|香港, url=http://test.example/');
    expect(result.content).toContain('总选择 = select, 香港, DIRECT, 香港 HK, 日本 JP');
    expect(result.content.slice(result.content.indexOf('[Rule]'))).toBe(customIni.slice(customIni.indexOf('[Rule]')));
    expect(result.content.split('[Proxy]')[0]).toBe(customIni.split('[Proxy]')[0]!);
    expect(result.node_count).toBe(2); expect(result.content_type).toContain('text/plain');
  }
});
test('INI credentials and policy names escape commas, equals, quotes and backslashes without rule injection', () => {
  const e = endpoint({ name: '名字,="\\ test', credential: 'pass,="\\#', host: 'host.example' });
  const result = renderSubscription(template('surge'), [e]);
  expect(result.content).toContain('"名字,=\\"\\\\ test" = trojan');
  expect(result.content).toContain('password="pass,=\\"\\\\#"');
  expect(result.content).toContain('节点选择 = select, DIRECT, "名字,=\\"\\\\ test"');
  expect(validateTemplate('surge', result.content).valid).toBe(true);
});
test('INI SS2022 and AnyTLS syntax differs for Surge and Surfboard; VLESS skipped', () => {
  const endpoints = [endpoint({ protocol: 'anytls', name: 'AnyTLS' }), endpoint({ protocol: 'shadowsocks', name: 'SS2022', settings: { method: '2022-blake3-aes-256-gcm' } }), endpoint({ protocol: 'vless', name: 'VLESS' })];
  const surge = renderSubscription(template('surge'), endpoints); expect(surge.content).toContain('AnyTLS = anytls, authorized.example.test, 443, password=synthetic-password');
  const surfboard = renderSubscription(template('surfboard'), endpoints); expect(surfboard.content).toContain('AnyTLS = anytls, authorized.example.test, 443, synthetic-password');
  expect(surge.node_count).toBe(2); expect(surge.content).not.toContain('VLESS =');
});
test('old INI injection tokens work without requiring tokens in newly imported content', () => {
  const content = '[Proxy]\n$proxies\n[Proxy Group]\n选择 = select, $proxy_group\n[Rule]\nFINAL,选择\n';
  const result = renderSubscription(template('surge', content), [endpoint()]); expect(result.content).not.toContain('$proxies'); expect(result.content).toContain('选择 = select, 香港 HK');
});
test('duplicate endpoint names avoid collisions with static proxies and groups', () => {
  const input = [endpoint({ name: '节点选择' }), endpoint({ name: '节点选择', id: 2 })];
  const result = renderSubscription(template('singbox'), input); const root = JSON.parse(result.content);
  expect(root.outbounds.map((o: any) => o.tag)).toEqual(['节点选择', 'direct', '节点选择 (2)', '节点选择 (3)']);
});
test('optional native compiled chains retain advanced fields but pin public endpoint identity', () => {
  const e = endpoint({ protocol: 'shadowsocks', settings: { method: 'aes-128-gcm' }, native_outbounds: [{ type: 'shadowtls', tag: 'outer', server: 'outer.example', server_port: 443, version: 3, password: 'synthetic-outer' }, { type: 'shadowsocks', tag: 'inner', server: 'wrong.example', server_port: 1, method: 'aes-128-gcm', password: 'other-user', detour: 'outer' }] });
  const root = JSON.parse(renderSubscription(template('singbox'), [e]).content);
  expect(root.outbounds.at(-1)).toMatchObject({ tag: e.name, detour: `${e.name} · 1`, server: e.host, server_port: e.port, password: e.credential });
  expect(root.outbounds.at(-2).version).toBe(3); expect(root.outbounds[0].outbounds).toContain(e.name);
});
test('YAML dynamic anchors, alias-valued group collections and anchored filters keep resolving', () => {
  for (const source of [
    'proxies: &nodes []\nx-proxies: *nodes\nproxy-groups: []\n',
    'x-groups: &groups [{name: G, type: select, proxies: [DIRECT]}]\nproxies: []\nproxy-groups: *groups\n',
    'proxies: []\nproxy-groups: [{name: G, type: select, proxies: [&filter /N/]}]\nx-filter: *filter\n',
    'proxies: []\nproxy-providers: {remote: {type: http, url: https://provider.example}}\nproxy-groups: [{name: G, type: select, use: [remote]}]\n',
  ]) {
    expect(validateTemplate('clashmeta', source).valid).toBe(true);
    const root = parse(renderSubscription(template('clashmeta', source), [endpoint({ name: 'N' })]).content);
    expect(root.proxies.at(-1).name).toBe('N');
    if (root['proxy-groups'].length) expect(root['proxy-groups'][0].proxies).toContain('N');
    if (root['x-filter']) expect(root['x-filter']).toBe('/N/');
  }
});
test('INI header-like and comment-like names remain policies, not injected sections/comments', () => {
  const result = renderSubscription(template('surge'), [endpoint({ name: '[Rule]' }), endpoint({ id: 2, name: '// hidden' })]);
  expect(result.content).toContain('"[Rule]" = trojan'); expect(result.content).toContain('"// hidden" = trojan'); expect(validateTemplate('surge', result.content).valid).toBe(true);
});
test('overlapping ungrouped regex repeats are skipped on public rendering paths', () => {
  const content = JSON.stringify({ outbounds: [{ type: 'selector', tag: 'x', outbounds: ['direct'], include: 'a*a*a*b' }, { type: 'direct', tag: 'direct' }] });
  const result = renderSubscription(template('singbox', content), [endpoint({ name: 'a'.repeat(256) })]);
  expect(result.warnings.join('')).toContain('过于复杂'); expect(JSON.parse(result.content).outbounds[0].outbounds).toEqual(['direct']);
});
test('native chain private tags avoid static collisions and chains never degrade in cross-format conversions', () => {
  const e = endpoint({ name: 'N', native_outbounds: [{ type: 'shadowtls', tag: 'outer', server: 'outer.example', server_port: 443 }, { type: 'trojan', tag: 'inner', detour: 'outer' }] });
  const source = JSON.stringify({ outbounds: [{ type: 'direct', tag: 'N · 1' }, { type: 'selector', tag: 'select', outbounds: [] }] });
  const result = JSON.parse(renderSubscription(template('singbox', source), [e]).content);
  expect(new Set(result.outbounds.map((v: any) => v.tag)).size).toBe(result.outbounds.length);
  expect(result.outbounds.at(-1).detour).toBe('N · 1 (2)');
  for (const name of ['clashmeta', 'surge'] as const) expect(renderSubscription(template(name), [e]).node_count).toBe(0);
});
test('HTTPUpgrade maps normalized host/path to Mihomo WebSocket upgrade options', () => {
  const result = renderSubscription(template('clashmeta'), [endpoint({ settings: { transport: { type: 'httpupgrade', path: '/upgrade', host: 'upgrade.example' }, tls: { enabled: true } } })]);
  expect(parse(result.content).proxies[0]).toMatchObject({ network: 'ws', 'ws-opts': { 'v2ray-http-upgrade': true, path: '/upgrade', headers: { Host: 'upgrade.example' } } });
});

test('legacy structural archive restores five custom formats and semantic sing-box content without rewriting bytes', () => {
  const db = database();
  const singbox = '\n' + JSON.stringify({ outbounds: [
    { type: 'selector', tag: 'Proxy', outbounds: ['auto', 'fallback', 'direct'] },
    { type: 'urltest', tag: 'auto', outbounds: [], url: 'https://probe.example.test/204', interval: '5m' },
    { type: 'selector', tag: 'fallback', outbounds: ['direct'], include: 'unmatched', fallback: 'auto' },
    { type: 'direct', tag: 'direct' },
  ], route: { final: 'Proxy' }, experimental: { cache_file: { enabled: true } } }, null, 2) + '\n\n';
  const contents = { singbox, clash: '\n' + legacyYaml, clashmeta: legacyYaml + '\n', stash: legacyYaml, surge: legacyIni, surfboard: '\r\n' + legacyIni };
  legacy(db, contents); initializeSubscriptionTemplates(db);
  for (const name of TEMPLATE_NAMES) {
    const original = getTemplate(db, name)!;
    const rendered = renderSubscription(original, [endpoint()], { metadata: { app_name: 'Proxy', subs_link: 'https://subscribe.example.test/fake', subs_domain: 'subscribe.example.test', subscribe_info: 'title=Test, content=2GB' } });
    expect(rendered.node_count).toBe(1); expect(getTemplate(db, name)!.content).toBe(contents[name]);
    if (name === 'singbox') {
      const root = JSON.parse(rendered.content);
      expect(root.outbounds[0].outbounds).toEqual(['auto', 'fallback', 'direct', '香港 HK']);
      expect(root.outbounds[1].outbounds).toEqual(['香港 HK']);
      expect(root.outbounds[2].outbounds).toEqual(['direct', 'auto']);
      expect(root.route).toEqual({ final: 'Proxy' }); expect(root.experimental.cache_file.enabled).toBe(true);
    }
  }
  initializeSubscriptionTemplates(db);
  for (const name of TEMPLATE_NAMES) expect(getTemplate(db, name)!.content).toBe(contents[name]);
});

test('real-structure legacy INI renders bare markers once and keeps all 511 rules byte-for-byte', () => {
  const metadata = { subs_link: 'https://subscribe.example.test/client?token=fake', subs_domain: 'subscribe.example.test', subscribe_info: 'title=Test, content=Upload: 1GB\\nDownload: 2GB' };
  const db = database(); initializeSubscriptionTemplates(db);
  for (const name of ['surge', 'surfboard'] as const) {
    const source = '\r\n' + legacyIni + '\r\n'; saveTemplate(db, name, source);
    const result = renderSubscription(getTemplate(db, name)!, [endpoint(), endpoint({ id: 2, name: '日本 JP' })], { metadata });
    expect(result.content).not.toMatch(/\$(?:proxies|proxy_group|subs_link|subs_domain|subscribe_info)\b/);
    expect(result.content).toContain('Proxy = select, auto, fallback, 香港 HK, 日本 JP');
    expect(result.content).toContain('auto = url-test, 香港 HK, 日本 JP, url=https://probe.example.test/204, interval=300');
    expect(result.content).toContain('fallback = fallback, 香港 HK, 日本 JP, url=https://probe.example.test/204, interval=300');
    expect(result.content.split('香港 HK = trojan')).toHaveLength(2);
    expect(result.content.slice(result.content.indexOf('[Rule]'))).toBe(source.slice(source.indexOf('[Rule]')));
    expect(result.content).toContain('#!MANAGED-CONFIG ' + metadata.subs_link);
    expect(result.content).toContain(metadata.subscribe_info);
    expect(validateTemplate(name, result.content).valid).toBe(true);
    expect(getTemplate(db, name)!.content).toBe(source);
  }
});
test('repeated INI markers dedupe authorized definitions and memberships, including empty subscriptions', () => {
  const source = '[Proxy]\n$proxies\n$proxies\n[Proxy Group]\nProxy=select,auto,DIRECT,$proxy_group,$proxy_group\nauto=url-test,$proxy_group,url=https://probe.example.test,interval=300\n[Rule]\nFINAL,Proxy\n';
  for (const name of ['surge', 'surfboard'] as const) {
    const result = renderSubscription(template(name, source), [endpoint({ name: 'node,="\\quoted', credential: 'password,="\\secret' })]);
    expect(result.content.split(' = trojan')).toHaveLength(2);
    expect(result.content).toContain('Proxy = select, auto, DIRECT, "node,=\\"\\\\quoted"');
    expect(result.content).not.toContain('$proxy_group'); expect(result.content).not.toContain('$proxies');
    expect(validateTemplate(name, result.content).valid).toBe(true);
    const empty = renderSubscription(template(name, source), []);
    expect(empty.content).toContain('Proxy = select, auto, DIRECT'); expect(empty.content).not.toContain('$proxy_group');
    expect(empty.content).not.toContain('$proxies'); expect(empty.node_count).toBe(0);
  }
});
test('INI injection recognizes whole tokens only and leaves comments, option values and Rule data alone', () => {
  const source = '[Proxy]\n# $proxies documentation\n$proxies_suffix=direct\n[Proxy Group]\nProxy=select,auto,$proxy_group_suffix,url=https://example.test/$proxy_group\nauto=url-test,$proxy_group,url=https://probe.example.test,interval=300\n[Rule]\nDOMAIN,$proxies.example.test,Proxy\nFINAL,Proxy\n';
  const result = renderSubscription(template('surge', source), [endpoint()]);
  expect(result.content).toContain('# $proxies documentation');
  expect(result.content).toContain('$proxies_suffix=direct');
  expect(result.content).toContain('Proxy = select, auto, $proxy_group_suffix, 香港 HK, url=https://example.test/$proxy_group');
  expect(result.content.slice(result.content.indexOf('[Rule]'))).toBe(source.slice(source.indexOf('[Rule]')));
  expect(result.content.split('香港 HK = trojan')).toHaveLength(2);
});
test('three real-structure YAML legacy formats expand markers with nested groups and 511 rules intact', () => {
  const db = database(); initializeSubscriptionTemplates(db);
  for (const name of ['clash', 'clashmeta', 'stash'] as const) {
    const source = '\n' + legacyYaml + '\n'; saveTemplate(db, name, source);
    const result = renderSubscription(getTemplate(db, name)!, [endpoint(), endpoint({ id: 2, name: '日本 JP' })], { metadata: { app_name: 'Proxy' } });
    const root = parse(result.content);
    expect(root.proxies).toHaveLength(2);
    expect(root['proxy-groups'][0].proxies).toEqual(['auto', 'fallback', 'DIRECT', '香港 HK', '日本 JP']);
    expect(root['proxy-groups'][1].proxies).toEqual(['香港 HK', '日本 JP']);
    expect(root['proxy-groups'][2].proxies).toEqual(['香港 HK', '日本 JP']);
    expect(root.rules).toEqual([...legacyRules, 'MATCH,Proxy']);
    expect(root.dns).toEqual(parse(source).dns);
    expect(result.content).toContain('# OriginalRestore'); expect(result.content).toContain('# authorized nodes');
    expect(result.content).not.toMatch(/\$(?:proxies|proxy_group|app_name)\b/);
    expect(validateTemplate(name, result.content).valid).toBe(true);
    expect(getTemplate(db, name)!.content).toBe(source);
  }
});
test('YAML markers support sequence, null and aliased scalar forms without duplicating proxies', () => {
  for (const source of [
    'proxies: [$proxies, $proxies]\nproxy-groups: [{name: Proxy, type: select, proxies: [DIRECT, $proxy_group, $proxy_group]}]\n',
    'proxies:\nproxy-groups: [{name: Proxy, type: select, proxies: null}]\n',
    'x-nodes: &nodes $proxies\nproxies: *nodes\nx-members: &members $proxy_group\nproxy-groups: [{name: Proxy, type: select, proxies: *members}]\n',
    'proxies: [&marker $proxies]\nproxy-groups: [{name: Proxy, type: select, proxies: [&members $proxy_group]}]\nx-marker: *marker\nx-members: *members\n',
  ]) {
    const result = renderSubscription(template('clashmeta', source), [endpoint()]); const root = parse(result.content);
    expect(root.proxies).toHaveLength(1);
    expect(root['proxy-groups'][0].proxies.filter((v: string) => v === '香港 HK')).toHaveLength(1);
    expect(root.proxies.some((v: unknown) => v === '$proxies')).toBe(false);
    expect(root['proxy-groups'][0].proxies).not.toContain('$proxy_group');
    if (source.includes('x-nodes')) { expect(root['x-nodes']).toEqual(root.proxies); expect(root['x-members']).toEqual(root['proxy-groups'][0].proxies); }
    if (source.includes('x-marker')) { expect(root['x-marker']).toBe('$proxies'); expect(root['x-members']).toBe('$proxy_group'); }
    const empty = parse(renderSubscription(template('clashmeta', source), []).content);
    expect(empty.proxies).toEqual([]); expect(empty['proxy-groups'][0].proxies).not.toContain('$proxy_group');
  }
});
test('metadata is escaped as YAML scalars, strips controls and never reprocesses endpoint fields', () => {
  const source = 'proxies: []\nproxy-groups: [{name: "$app_name", type: select, proxies: [DIRECT]}]\nrules: ["MATCH,$app_name"]\nx-name: "$app_name_suffix"\n';
  const app_name = 'Site: "quoted"\nproxies: []';
  const result = renderSubscription(template('clashmeta', source), [endpoint({ name: '$app_name', credential: '$app_name-password' })], { metadata: { app_name } });
  const root = parse(result.content);
  expect(root['proxy-groups'][0].name).toBe('Site: "quoted" proxies: []');
  expect(root.rules).toEqual(['MATCH,Site: "quoted" proxies: []']);
  expect(root['x-name']).toBe('$app_name_suffix'); expect(root.proxies[0].name).toBe('$app_name');
  expect(root.proxies[0].password).toBe('$app_name-password');
  const ini = renderSubscription(template('surge', legacyIni), [endpoint({ name: '$subs_link', credential: '$subscribe_info' })], { metadata: { subs_link: 'https://example.test/fake\n[Rule]\r\nINJECT', subscribe_info: 'title=Test, content=2GB\0safe' } });
  expect(ini.content.split('[Rule]')).toHaveLength(3); // One header, one sanitized literal in the managed-config comment.
  expect(ini.content).toContain('#!MANAGED-CONFIG https://example.test/fake [Rule]  INJECT');
  expect(ini.content).toContain('$subs_link = trojan'); expect(ini.content).toContain('password=$subscribe_info');
  expect(ini.content).toContain('title=Test, content=2GB safe');
  expect(validateTemplate('surge', ini.content).valid).toBe(true);
});

test('preview and actual subscriptions share one result contract and only their supplied endpoints', () => {
  const t = template('singbox'); const preview = renderSubscription(t, [endpoint({ host: 'preview.invalid', credential: 'preview-only' })]); const real = renderSubscription(t, [endpoint()]);
  expect(Object.keys(preview).sort()).toEqual(['content', 'content_type', 'node_count', 'template_name', 'warnings']);
  expect(preview.content).toContain('preview-only'); expect(real.content).not.toContain('preview-only'); expect(preview.content).not.toContain('synthetic-password');
});

// Public PHP resource only: never read an archive, database or customer endpoint for these fixtures.
const phpSingboxDefault = readFileSync(new URL('./fixtures/legacy-singbox-shape.json', import.meta.url), 'utf8');
const legacySingboxDefault = phpSingboxDefault + ' '.repeat(Math.max(0, 4095 - Buffer.byteLength(phpSingboxDefault)));
const realityEndpoint = (host: string): SubscriptionEndpoint => endpoint({
  name: '合成 Reality', protocol: 'vless', host, credential: '00000000-0000-4000-8000-000000000001',
  settings: { flow: 'xtls-rprx-vision', tls: { enabled: true, server_name: 'reality.example.test', utls: { enabled: true, fingerprint: 'chrome' }, reality: { enabled: true, public_key: 'hSDwCYkwp1R0i33ctD73Wg2_Og0mOBr066SpjqqbTmo', short_id: '0123456789abcdef' } } },
});

test('4095-byte synthetic semantic PHP default stays exact at rest and older/unknown renders keep the previous output', () => {
  expect(Buffer.byteLength(legacySingboxDefault)).toBe(4095);
  expect(JSON.parse(legacySingboxDefault)).toEqual(JSON.parse(phpSingboxDefault));
  const db = database(); const contents = { ...synthetic, singbox: legacySingboxDefault };
  legacy(db, contents); initializeSubscriptionTemplates(db);
  const original = getTemplate(db, 'singbox')!, nodes = [realityEndpoint('192.0.2.1')];
  const expected = JSON.parse(legacySingboxDefault);
  expected.outbounds.filter((outbound: any) => ['selector', 'urltest'].includes(outbound.type)).forEach((outbound: any) => outbound.outbounds.push(nodes[0]!.name));
  expected.outbounds.push({ ...nodes[0]!.settings, type: 'vless', tag: nodes[0]!.name, server: nodes[0]!.host, server_port: 443, uuid: nodes[0]!.credential });
  const previousOutput = JSON.stringify(expected, null, 2) + '\n';
  for (const options of [{}, { userAgent: 'mboard-subscription-verifier' }, { userAgent: 'sing-box/1.10.7' }, { clientVersion: 'unknown', userAgent: 'sing-box/1.14.3' }]) {
    expect(renderSubscription(original, nodes, options).content).toBe(previousOutput);
  }
  renderSubscription(original, nodes, { userAgent: 'sing-box/1.14.3' });
  initializeSubscriptionTemplates(db);
  for (const name of TEMPLATE_NAMES) expect(getTemplate(db, name)!.content).toBe(contents[name]);
});

test('known 1.12+ core versions migrate DNS resolution, sniff scope and special actions without losing rule sets or Chinese groups', () => {
  const source = JSON.parse(legacySingboxDefault), nodes = [realityEndpoint('node.example.test')];
  for (const options of [{ userAgent: 'sing-box/1.12.0' }, { userAgent: 'sing-box/1.14.3' }, { userAgent: 'SFA/1.14.3' }, { userAgent: 'SFM/1.14.3' }, { clientVersion: '1.14.3', userAgent: 'unknown' }]) {
    const rendered = renderSubscription(template('singbox', legacySingboxDefault), nodes, options), root = JSON.parse(rendered.content);
    expect(rendered.warnings).toHaveLength(1); expect(rendered.warnings[0]).toContain('sniff_override_destination');
    expect(root.dns.servers).toEqual([
      { type: 'https', tag: 'remote', server: '1.1.1.1', path: '/dns-query', detour: '节点选择' },
      { type: 'https', tag: 'local', server: '223.5.5.5', path: '/dns-query' },
    ]);
    expect(root.dns.rules).toEqual(source.dns.rules.slice(1));
    expect(root.dns.strategy).toBe('prefer_ipv4'); expect(root.route.default_domain_resolver).toBe('local');
    expect(root.route.rule_set).toEqual(source.route.rule_set); expect(root.experimental).toEqual(source.experimental);
    expect(root.route.rules.slice(6)).toEqual([{ protocol: 'dns', action: 'hijack-dns' }, ...source.route.rules.slice(1)]);
    const tags = root.inbounds.map((inbound: any) => inbound.tag);
    expect(tags).toEqual(['mboard-in-1', 'socks-in', 'mixed-in']);
    for (const [index, tag] of tags.entries()) {
      expect(root.route.rules[index * 2]).toEqual({ inbound: [tag], action: 'resolve', strategy: 'prefer_ipv4' });
      expect(root.route.rules[index * 2 + 1]).toEqual({ inbound: [tag], action: 'sniff' });
    }
    for (const inbound of root.inbounds) for (const key of ['sniff', 'sniff_override_destination', 'domain_strategy', 'endpoint_independent_nat']) expect(inbound[key]).toBeUndefined();
    expect(root.outbounds.some((outbound: any) => ['block', 'dns'].includes(outbound.type))).toBe(false);
    expect(root.outbounds[0]).toMatchObject({ tag: '节点选择', default: '自动选择', outbounds: ['自动选择', nodes[0]!.name] });
    expect(root.outbounds.at(-1)).toMatchObject({ server: 'node.example.test', tls: nodes[0]!.settings!.tls });
  }
});

test('sniff destination override limits are surfaced for modern conversion, not unchanged legacy output', () => {
  expect(validateTemplate('singbox', legacySingboxDefault).warnings.join('')).toContain('sniff_override_destination');
  expect(renderSubscription(template('singbox', legacySingboxDefault), [realityEndpoint('192.0.2.1')], { userAgent: 'sing-box/1.10.7' }).warnings).toEqual([]);
  const root = JSON.parse(legacySingboxDefault);
  root.inbounds.forEach((inbound: any) => { inbound.sniff_override_destination = false; });
  expect(renderSubscription(template('singbox', JSON.stringify(root)), [realityEndpoint('192.0.2.1')], { userAgent: 'sing-box/1.14.3' }).warnings).toEqual([]);
});

test('modern migration rewrites referenced rcode/block/DNS logical rules and allocates collision-free inbound tags', () => {
  const source = JSON.parse(legacySingboxDefault);
  source.inbounds[1].tag = 'mboard-in-1'; source.inbounds[1].sniff_timeout = '1s';
  source.dns.rules.push({ domain_suffix: ['blocked.example.test'], server: 'block' });
  source.route.rules.push({ type: 'logical', mode: 'or', rules: [{ domain_suffix: ['blocked.example.test'] }, { domain: ['blocked.test'] }], outbound: 'block' });
  const root = JSON.parse(renderSubscription(template('singbox', JSON.stringify(source)), [realityEndpoint('192.0.2.1')], { userAgent: 'sing-box/1.14.3' }).content);
  expect(root.inbounds[0].tag).toBe('mboard-in-1-2');
  expect(root.route.rules[3]).toEqual({ inbound: ['mboard-in-1'], action: 'sniff', timeout: '1s' });
  expect(root.dns.rules.at(-1)).toEqual({ domain_suffix: ['blocked.example.test'], action: 'predefined', rcode: 'NOERROR' });
  expect(root.route.rules.at(-1)).toEqual({ type: 'logical', mode: 'or', rules: source.route.rules.at(-1).rules, action: 'reject' });
});

test('unsupported semantic migrations warn at syntax validation and fail modern rendering without deleting user config', () => {
  for (const patch of [
    (root: any) => { root.custom_unknown = { secret: 'not-for-errors' }; },
    (root: any) => { root.outbounds[0].outbounds.push('block'); },
    (root: any) => { root.dns.rules[0].domain_suffix = ['private.example.test']; },
    (root: any) => { root.dns.servers[0].strategy = 'ipv6_only'; },
    (root: any) => { root.route.rules.push({ geoip: ['cn'], outbound: 'direct' }); },
    (root: any) => { root.dns.rules.unshift({ domain_suffix: ['priority.example.test'], server: 'remote' }); },
    (root: any) => { root.dns.servers.unshift(root.dns.servers.pop()); },
    (root: any) => { root.outbounds.unshift(root.outbounds.splice(2, 1)[0]); },
    (root: any) => { root.outbounds[1].domain_resolver = 'block'; },
  ]) {
    const root = JSON.parse(legacySingboxDefault); patch(root); const content = JSON.stringify(root);
    const validation = validateTemplate('singbox', content);
    expect(validation.valid).toBe(true); expect(validation.warnings.join('')).toContain('手动'); expect(validation.warnings.join('')).not.toContain('not-for-errors');
    expect(() => renderSubscription(template('singbox', content), [realityEndpoint('192.0.2.1')], { userAgent: 'sing-box/1.14.3' })).toThrow(TemplateValidationError);
    expect(JSON.parse(renderSubscription(template('singbox', content), [], { userAgent: 'sing-box/1.10.7' }).content).dns).toEqual(root.dns);
  }
});

test('the five other formats render identically regardless of a sing-box user agent or explicit core version', () => {
  for (const name of TEMPLATE_NAMES.filter(name => name !== 'singbox')) {
    const original = template(name, synthetic[name]);
    const prior = renderSubscription(original, [endpoint()]);
    const modern = renderSubscription(original, [endpoint()], { userAgent: 'sing-box/1.14.3', clientVersion: '1.14.3' });
    expect(modern).toEqual(prior); expect(original.content).toBe(synthetic[name]);
  }
});

const singboxCore = process.env.MBOARD_SINGBOX_TEST_CORE || '/tmp/mboard-core-build/sing-box';
test.skipIf(!existsSync(singboxCore))('pinned sing-box 1.14.3 check accepts two synthetic native Reality renders of the PHP default', () => {
  const coreVersion = spawnSync(singboxCore, ['version'], { encoding: 'utf8' });
  expect(coreVersion.status).toBe(0); expect(coreVersion.stdout).toContain('sing-box version 1.14.3');
  for (const [index, host] of ['192.0.2.1', 'node.example.test'].entries()) {
    const source = JSON.parse(legacySingboxDefault);
    if (index === 1) {
      source.dns.rules.push({ domain_suffix: ['blocked.example.test'], server: 'block' });
      source.route.rules.push({ domain_suffix: ['blocked.example.test'], outbound: 'block' });
    }
    const result = renderSubscription(template('singbox', JSON.stringify(source)), [realityEndpoint(host)], { userAgent: 'sing-box/1.14.3' });
    const dir = mkdtempSync(join(tmpdir(), 'mboard-singbox-core-test-')); dirs.push(dir);
    const config = join(dir, 'synthetic.json'); writeFileSync(config, result.content);
    const checked = spawnSync(singboxCore, ['check', '-c', config], { encoding: 'utf8', timeout: 15000 });
    expect(checked.error).toBeUndefined(); expect(checked.status, checked.stderr + checked.stdout).toBe(0);
    expect(checked.stderr).not.toMatch(/deprecated|legacy|FATAL/i);
  }
});

