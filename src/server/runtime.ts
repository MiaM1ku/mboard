import type { Database } from 'bun:sqlite';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

type Row = Record<string, any>;
export type RuntimeSupplement = { kind: string; id: string | number; payload: Row };
export type RestoreRuntimeOptions = { supplements?: RuntimeSupplement[]; coreVersion?: '1.12' | '1.14' };
export type TrafficLabel = { label: string; user_id: number; node_id: number };
export type RuntimeFile = { path_under_mboard_tls: string; content: string; mode: number };
export type CompiledMachine = { revision: number; config: Row; traffic_labels: TrafficLabel[]; files: RuntimeFile[]; warnings: string[] };
export type RuntimeEndpoint = { id: number | string; name: string; protocol: string; host: string; port: number; credential: string; settings: Row; native_outbounds?: Row[] };
export class RuntimeCompileError extends Error { constructor(public code: string, public entity: string) { super(`Runtime ${code}: ${entity}`); this.name = 'RuntimeCompileError'; } }
function fail(code: string, entity: string): never { throw new RuntimeCompileError(code, entity); }
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (s: any, fallback: any = {}) => { if (s == null || s === '') return fallback; if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return fail('invalid-json', 'source field'); } };
const arr = (s: any): any[] => { const v = json(s, []); return Array.isArray(v) ? v : fail('expected-array', 'source field'); };
const obj = (s: any): Row => { const v = json(s, {}); return v && typeof v === 'object' && !Array.isArray(v) ? v : fail('expected-object-or-decrypted-supplement', 'source field'); };
const yes = (s: any, defaultValue = true) => s == null ? defaultValue : ![false, 0, '0', 'false'].includes(s);
const id = (s: any, entity: string) => Number.isSafeInteger(Number(s)) && Number(s) > 0 ? Number(s) : fail('invalid-id', entity);
const port = (s: any, entity: string) => Number.isInteger(Number(s)) && Number(s) > 0 && Number(s) < 65536 ? Number(s) : fail('invalid-port', entity);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const kindAliases: Record<string, string> = { users: 'v2_user', user: 'v2_user', nodes: 'v2_server', node: 'v2_server', machines: 'v2_server_machine', machine: 'v2_server_machine', bindings: 'v2_server_machine_binding', route_profiles: 'v2_server_route_profile', outbound_templates: 'v2_outbound_template', route_templates: 'v2_route_template', rule_sets: 'v2_rule_set' };
const kind = (s: string) => kindAliases[s] || s;

/** Additive schema: does not alter user_version, core tables, or archived rows. */
export function initializeRuntime(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_nodes (id INTEGER PRIMARY KEY, parent_id INTEGER, protocol TEXT NOT NULL, enabled INTEGER NOT NULL, show INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_machines (id INTEGER PRIMARY KEY, state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','active','disabled')), active INTEGER NOT NULL DEFAULT 0, token_hash TEXT UNIQUE, applied_revision INTEGER, last_seen_at TEXT, version TEXT, core_ready INTEGER NOT NULL DEFAULT 0, telemetry_ready INTEGER NOT NULL DEFAULT 0, core_version TEXT NOT NULL DEFAULT '1.14', payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS runtime_bindings (machine_id INTEGER NOT NULL REFERENCES runtime_machines(id), node_id INTEGER NOT NULL REFERENCES runtime_nodes(id), payload TEXT NOT NULL, PRIMARY KEY(machine_id,node_id));
CREATE TABLE IF NOT EXISTS runtime_identity_credentials (user_id INTEGER NOT NULL, node_id INTEGER NOT NULL, profile_id TEXT NOT NULL DEFAULT '', credential TEXT NOT NULL, PRIMARY KEY(user_id,node_id,profile_id));
CREATE TABLE IF NOT EXISTS runtime_source_records (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,id));
CREATE TABLE IF NOT EXISTS runtime_metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  const columns=new Set((db.query('PRAGMA table_info(runtime_machines)').all() as Row[]).map(c=>c.name));
  for(const column of ['last_seen_at','version'])if(!columns.has(column))db.exec(`ALTER TABLE runtime_machines ADD COLUMN ${column} TEXT`);
}
function source(db: Database, table: string): Row[] { return (db.query('SELECT payload FROM runtime_source_records WHERE kind=? ORDER BY id').all(table) as Row[]).map(r => obj(r.payload)); }
function nodes(db: Database): Row[] { return (db.query('SELECT payload FROM runtime_nodes ORDER BY id').all() as Row[]).map(r => obj(r.payload)); }
function machine(db: Database, machineID: number): Row { const m = db.query('SELECT * FROM runtime_machines WHERE id=?').get(machineID) as Row; if (!m) fail('machine-not-found', `machine ${machineID}`); return m; }

/** Repeat imports enrich missing source fields but never reactivate a machine or rotate identities. */
export function restoreRuntime(db: Database, options: RestoreRuntimeOptions = {}) {
  initializeRuntime(db);
  return db.transaction(() => {
    const raw = db.query('SELECT kind,id,payload FROM legacy_records ORDER BY kind,id').all() as Row[];
    const records = new Map<string, RuntimeSupplement>();
    for (const r of raw) records.set(`${kind(r.kind)}:${r.id}`, { kind: kind(r.kind), id: r.id, payload: obj(r.payload) });
    for (const s of options.supplements || []) {
      const k = kind(s.kind); const key = `${k}:${s.id}`; const previous = records.get(key)?.payload || {};
      records.set(key, { kind: k, id: s.id, payload: { ...previous, ...s.payload } });
    }
    for (const r of records.values()) {
      const prior = db.query('SELECT payload FROM runtime_source_records WHERE kind=? AND id=?').get(r.kind, String(r.id)) as Row | null;
      // The supplemental plaintext remains private; repeated raw imports can't replace it with ciphertext.
      const old = prior ? obj(prior.payload) : {};
      const payload = { ...old, ...r.payload };
      if (r.kind === 'v2_outbound_template' && typeof r.payload.settings === 'string' && typeof old.settings === 'object') payload.settings = old.settings;
      for (const key of ['tls_material', 'server_psk', 'native_config']) if (old[key] && !r.payload[key]) payload[key] = old[key];
      db.query('INSERT INTO runtime_source_records VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload').run(r.kind, String(r.id), JSON.stringify(payload));
    }
    for (const n of source(db, 'v2_server')) {
      const nid = id(n.id, 'node'); const protocol = String(n.type || n.protocol || '').toLowerCase();
      db.query('INSERT INTO runtime_nodes VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,protocol=excluded.protocol,enabled=excluded.enabled,show=excluded.show,payload=excluded.payload').run(nid, Number(n.parent_id) || null, protocol, Number(yes(n.enabled)), Number(yes(n.show)), JSON.stringify(n));
    }
    for (const m of source(db, 'v2_server_machine')) {
      const mid = id(m.id, 'machine');
      db.query('INSERT INTO runtime_machines(id,state,core_version,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET core_version=excluded.core_version,payload=excluded.payload').run(mid, yes(m.is_active ?? m.enabled) ? 'pending' : 'disabled', options.coreVersion || '1.14', JSON.stringify(m));
    }
    const ns = new Map(nodes(db).map(n => [Number(n.id), n]));
    const unmatched: string[] = [];
    const bindings = source(db, 'v2_server_machine_binding');
    // Legacy single-machine fields supplement, never replace, explicit many-to-many bindings.
    for (const n of ns.values()) if (Number(n.machine_id) > 0 && !bindings.some(b => Number(b.server_id || b.node_id) === Number(n.id) && Number(b.machine_id) === Number(n.machine_id))) bindings.push({ machine_id: n.machine_id, server_id: n.id });
    for (const b of bindings) {
      const mid = id(b.machine_id, 'binding machine'); const nid = id(b.server_id || b.node_id, 'binding node');
      if (!ns.has(nid) || !db.query('SELECT id FROM runtime_machines WHERE id=?').get(mid)) { unmatched.push(`machine ${mid}, node ${nid}`); continue; }
      db.query('INSERT INTO runtime_bindings VALUES(?,?,?) ON CONFLICT(machine_id,node_id) DO UPDATE SET payload=excluded.payload').run(mid, nid, JSON.stringify(b));
    }
    for (const user of source(db, 'v2_user')) {
      if (!db.query('SELECT id FROM users WHERE id=?').get(Number(user.id))) continue;
      if (!user.uuid) fail('missing-original-uuid', `user ${Number(user.id)}`);
      persistIdentity(db, Number(user.id), 0, '', String(user.uuid));
    }
    // One-time identity derivation happens here, not when a subscription is requested.
    for (const u of db.query('SELECT id,credential FROM users').all() as Row[]) for (const n of ns.values()) {
      const root = rootFor(ns, n); const base = rootCredential(db, u);
      persistIdentity(db, u.id, n.id, '', deriveEntry(base, n));
      for (const p of profiles(db, root)) persistIdentity(db, u.id, n.id, profileID(p), deriveEntry(deriveUUID(base, 'xboard-route-profile:v1:' + profileID(p).toLowerCase()), n));
    }
    return { nodes: ns.size, machines: (db.query('SELECT count(*) AS n FROM runtime_machines').get() as Row).n, bindings: (db.query('SELECT count(*) AS n FROM runtime_bindings').get() as Row).n, unmatched_bindings: unmatched, state: 'pending' as const };
  }).immediate();
}
export function ensureRuntimeIdentities(db:Database,userID?:number) {
  const all=nodes(db),ns=new Map(all.map(n=>[Number(n.id),n]));
  const users=db.query(userID===undefined?'SELECT id,credential FROM users':'SELECT id,credential FROM users WHERE id=?').all(...(userID===undefined?[]:[userID])) as Row[];
  for(const u of users)for(const n of all){const root=rootFor(ns,n),base=rootCredential(db,u);persistIdentity(db,u.id,n.id,'',deriveEntry(base,n));for(const p of profiles(db,root))persistIdentity(db,u.id,n.id,profileID(p),deriveEntry(deriveUUID(base,'xboard-route-profile:v1:'+profileID(p).toLowerCase()),n));}
}
export function rotateRuntimeIdentities(db:Database,userID:number,credential:string) {
  db.transaction(()=>{db.query('DELETE FROM runtime_identity_credentials WHERE user_id=?').run(userID);persistIdentity(db,userID,0,'',credential);ensureRuntimeIdentities(db,userID)}).immediate();
}
function persistIdentity(db: Database, uid: number, nid: number, pid: string, credential: string) { db.query('INSERT OR IGNORE INTO runtime_identity_credentials VALUES(?,?,?,?)').run(uid, nid, pid, credential); }
function rootCredential(db: Database, user: Row): string { return (db.query('SELECT credential FROM runtime_identity_credentials WHERE user_id=? AND node_id=0 AND profile_id=?').get(user.id, '') as Row | null)?.credential || user.credential; }
export function deriveUUID(base: string, domain: string) {
  const hex = base.replaceAll('-', '').toLowerCase(); const key = /^[a-f0-9]{32}$/.test(hex) ? Buffer.from(hex, 'hex') : Buffer.from(base);
  const bytes = Buffer.from(createHmac('sha256', key).update(domain).digest().subarray(0, 16)); bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const s = bytes.toString('hex'); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
function deriveEntry(base: string, n: Row) { return Number(n.parent_id) > 0 && ['vless','trojan','shadowsocks'].includes(n.type || n.protocol) ? deriveUUID(base, 'xboard-child-node:v1:' + n.id) : base; }
function rootFor(ns: Map<number, Row>, n: Row): Row { const seen = new Set<number>(); while (Number(n.parent_id) > 0) { if (seen.has(Number(n.id))) fail('parent-cycle', `node ${n.id}`); seen.add(Number(n.id)); const parent = ns.get(Number(n.parent_id)); if (!parent) fail('missing-parent', `node ${n.id}`); n = parent; } return n; }
function profileID(p: Row) { if (!p.uuid || !/^[A-Za-z0-9-]{1,64}$/.test(String(p.uuid))) fail('invalid-profile-uuid', `profile ${Number(p.id)}`); return String(p.uuid); }
function profiles(db: Database, root: Row) { return source(db, 'v2_server_route_profile').filter(p => Number(p.server_id || p.node_id) === Number(root.id) && yes(p.enabled)); }
function supportsProfiles(root: Row) { return ['trojan','shadowsocks'].includes(root.type || root.protocol) || (root.type === 'vless' && Number(obj(root.protocol_settings).tls) === 2); }
function profileAllows(p: Row, n: Row) { const entries = arr(p.entry_server_ids).map(Number).filter(v => v > 0); return !entries.length || entries.includes(Number(n.id)); }
function eligible(db: Database, u: Row, n: Row) {
  if (!yes(u.enabled) || !yes(n.enabled)) return false;
  if (u.expires_at) { const t = typeof u.expires_at === 'number' ? u.expires_at * 1000 : Date.parse(u.expires_at); if (!Number.isFinite(t) || t <= Date.now()) return false; }
  if (Number(u.quota_bytes) > 0 && Number(u.upload_bytes) + Number(u.download_bytes) >= Number(u.quota_bytes)) return false;
  const groups = arr(n.group_ids).map(Number); if (!groups.length) return false;
  const granted = (db.query('SELECT group_id FROM user_groups WHERE user_id=?').all(u.id) as Row[]).map(r => r.group_id);
  return groups.some(g => granted.includes(g));
}
function identity(db: Database, u: Row, n: Row, pid = ''): string {
  const stored = db.query('SELECT credential FROM runtime_identity_credentials WHERE user_id=? AND node_id=? AND profile_id=?').get(u.id, n.id, pid) as Row;
  if (!stored) fail('identity-not-restored', `user ${u.id}, node ${n.id}`); return stored.credential;
}
function label(u: Row, n: Row, pid = '') { return `mb:u:${u.id}:n:${n.id}:p:${pid || '0'}`; }
function keySize(method: string) { return method === '2022-blake3-aes-128-gcm' ? 16 : ['2022-blake3-aes-256-gcm','2022-blake3-chacha20-poly1305'].includes(method) ? 32 : 0; }
export function shadowsocksServerPSK(root: Row, method: string): string {
  const size = keySize(method); if (!size) fail('unsupported-shadowsocks-multiuser-method', `node ${root.id}`);
  const explicit = root.server_psk || obj(root.protocol_settings).server_psk;
  if (explicit) { if (Buffer.from(String(explicit), 'base64').length !== size) fail('invalid-server-psk', `node ${root.id}`); return String(explicit); }
  if (!/^\d+$/.test(String(root.created_at))) fail('ambiguous-server-psk-timestamp-needs-supplement', `node ${root.id}`);
  return Buffer.from(createHash('md5').update(String(root.created_at)).digest('hex').slice(0,size)).toString('base64');
}
function ssUserPSK(credential: string, method: string) { const size = keySize(method); return Buffer.from(credential.slice(0,size)).toString('base64'); }

export function provisionMachineToken(db: Database, machineID: number) { machine(db, machineID); const token = randomBytes(32).toString('hex'); db.query('UPDATE runtime_machines SET token_hash=? WHERE id=?').run(sha(token), machineID); return token; }
export function authenticateRuntimeMachine(db: Database, token: string): number | null { if (!/^[a-f0-9]{64}$/.test(token)) return null; const m = db.query("SELECT id,token_hash FROM runtime_machines WHERE token_hash=? AND state!='disabled'").get(sha(token)) as Row; return m && timingSafeEqual(Buffer.from(m.token_hash), Buffer.from(sha(token))) ? m.id : null; }
export function activateMachine(db: Database, machineID: number, probe: { verified: boolean; appliedRevision: number; coreReady: boolean; telemetryReady: boolean }) {
  const compiled = compileMachine(db, machineID);
  if (!probe.verified || !probe.coreReady || !probe.telemetryReady || probe.appliedRevision !== compiled.revision) fail('activation-probe-required', `machine ${machineID}`);
  if (!machine(db, machineID).token_hash) fail('fresh-token-required', `machine ${machineID}`);
  db.query("UPDATE runtime_machines SET state='active',active=1,applied_revision=?,core_ready=1,telemetry_ready=1 WHERE id=?").run(compiled.revision, machineID);
}
export function heartbeatRuntimeMachine(db: Database, machineID: number, body: { applied_revision?: number; config_revision?: number; core_ready?: boolean; telemetry_ready?: boolean; version?: string }) {
  machine(db,machineID);const current=compileMachine(db,machineID).revision;const applied=body.applied_revision ?? body.config_revision;
  if(applied != null && (!Number.isSafeInteger(applied)||applied<0))fail('invalid-applied-revision',`machine ${machineID}`);
  const matching=applied===current;db.query('UPDATE runtime_machines SET last_seen_at=?,version=?,applied_revision=?,core_ready=?,telemetry_ready=? WHERE id=?').run(new Date().toISOString(),String(body.version||'').slice(0,128),applied ?? null,Number(matching&&body.core_ready===true),Number(matching&&body.telemetry_ready===true),machineID);
  return {revision:current,applied_revision:applied ?? null,ready:matching&&body.core_ready===true&&body.telemetry_ready===true};
}
export function runtimeMachineViews(db: Database) { return (db.query('SELECT id,state,active,applied_revision,last_seen_at,version,core_ready,telemetry_ready,payload FROM runtime_machines ORDER BY id').all() as Row[]).map(m=>{const p=obj(m.payload);return {id:m.id,name:p.name||`Machine ${m.id}`,host:p.host||p.address||'',enabled:m.state!=='disabled',runtime:true,state:m.state,active:!!m.active,last_seen_at:m.last_seen_at,version:m.version,applied_revision:m.applied_revision,core_ready:!!m.core_ready,telemetry_ready:!!m.telemetry_ready};}); }
export function runtimeNodeViews(db: Database) { const ms=runtimeMachineViews(db);const bindings=db.query('SELECT machine_id,node_id FROM runtime_bindings').all() as Row[];const all=nodes(db);const ns=new Map(all.map(n=>[Number(n.id),n]));return all.map(n=>{const root=rootFor(ns,n);const machine_ids=[...new Set(bindings.filter(b=>Number(b.node_id)===Number(root.id)||Number(b.node_id)===Number(n.id)).map(b=>Number(b.machine_id)))];const active=machine_ids.some(id=>ms.some(m=>m.id===id&&m.active&&m.core_ready&&m.telemetry_ready));return {id:Number(n.id),name:n.name,host:n.host,port:Number(n.port),server_port:Number(root.server_port||root.port),protocol:root.type||root.protocol,parent_id:Number(n.parent_id)||null,enabled:yes(n.enabled),show:yes(n.show),group_ids:arr(n.group_ids),rate:Number(n.rate ?? 1),rate_time_enable:yes(n.rate_time_enable,false),rate_time_ranges:arr(n.rate_time_ranges),tags:arr(n.tags),sort:Number(n.sort)||0,transfer_enable:Number(n.transfer_enable)||0,machine_ids,active,runtime:true,state:active?'active':'pending'};}); }
export function deactivateMachine(db: Database, machineID: number) { db.query("UPDATE runtime_machines SET state='pending',active=0,core_ready=0,telemetry_ready=0 WHERE id=?").run(machineID); }

function tlsFor(root: Row, m: Row, files: RuntimeFile[]): Row | undefined {
  const ps = obj(root.protocol_settings); const protocol = root.type || root.protocol;
  const tlsMode = typeof ps.tls === 'object' ? 1 : Number(ps.tls ?? (['trojan','anytls'].includes(protocol) ? 1 : 0));
  if (!tlsMode) { if (['trojan','anytls'].includes(protocol)) fail('tls-required', `node ${root.id}`); return undefined; }
  const ts = obj(typeof ps.tls === 'object' ? ps.tls : ps.tls_settings); const tls: Row = { enabled: true };
  if (tlsMode === 2) {
    const r = obj(ps.reality_settings || ps.reality || ps.tlsSettings?.reality || ps.tlsSettings); const name = r.server_name || ts.server_name || ps.server_name;
    if (!r.private_key || !r.public_key || !name) fail('incomplete-reality', `node ${root.id}`);
    let handshakeHost=String(r.dest || name);let handshakePort=port(r.server_port || 443,`node ${root.id}`);
    const dest=/^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(handshakeHost);if(dest){handshakeHost=dest[1]||dest[2]!;handshakePort=port(dest[3],`node ${root.id}`);}
    const short = Array.isArray(r.short_id) ? r.short_id : [r.short_id ?? '']; if (short.some((s: any) => !/^(?:[a-fA-F0-9]{2}){0,8}$/.test(String(s)))) fail('invalid-reality-short-id', `node ${root.id}`);
    return { enabled:true, server_name:name, reality:{enabled:true,handshake:{server:handshakeHost,server_port:handshakePort},private_key:r.private_key,short_id:short} };
  }
  const cc = obj(root.cert_config); const perMachine = obj(obj(m.payload).tls_material); const material = obj(perMachine[String(root.id)] || root.tls_material || cc);
  tls.server_name = ts.server_name || ps.server_name || cc.server_name || cc.cert_domain || root.server_name || '';
  if (material.verified === true && material.certificate_path && material.private_key_path) {
    for (const key of ['certificate_path','private_key_path']) if (!String(material[key]).startsWith('/etc/mboard-node/tls/') || String(material[key]).includes('..')) fail('invalid-provisioned-tls-path', `node ${root.id}`);
    tls.certificate_path = material.certificate_path; tls.key_path = material.private_key_path;
  } else {
    const certificate = material.certificate || material.cert || material.cert_content; const privateKey = material.private_key || material.key || material.key_content;
    if (!certificate || !privateKey || !String(certificate).includes('-----BEGIN CERTIFICATE-----') || !/-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----/.test(String(privateKey))) fail('tls-material-needs-verified-supplement', `node ${root.id}`);
    const certPath = `${root.id}.crt`; const keyPath = `${root.id}.key`;
    files.push({path_under_mboard_tls:certPath,content:certificate,mode:0o600},{path_under_mboard_tls:keyPath,content:privateKey,mode:0o600});
    tls.certificate_path = '/etc/mboard-node/tls/' + certPath; tls.key_path = '/etc/mboard-node/tls/' + keyPath;
  }
  if (ps.alpn || ts.alpn) tls.alpn = arr(ps.alpn || ts.alpn);
  for (const k of ['min_version','max_version','cipher_suites']) if (ts[k]) tls[k] = ts[k];
  if (ts.ech?.enabled) { if (!ts.ech.key && !ts.ech.key_path) fail('missing-ech-key', `node ${root.id}`); tls.ech = {enabled:true,...(ts.ech.key ? {key:arr(ts.ech.key)} : {key_path:ts.ech.key_path})}; }
  return tls;
}
function transportSettings(ps: Row, n: Row): Row | undefined {
  let type=String(ps.network||n.network||'tcp').toLowerCase();if(type==='tcp')return undefined;if(type==='h2')type='http';if(!['ws','grpc','http','httpupgrade'].includes(type))fail('unsupported-transport',`node ${n.id}`);
  const settings=clone(obj(ps.network_settings));
  if(type==='grpc' && settings.serviceName){settings.service_name=settings.serviceName;delete settings.serviceName;}
  if(type==='ws' && settings.host){if(!settings.headers)settings.headers={Host:settings.host};delete settings.host;}
  const allowed:Row={ws:['path','headers','max_early_data','early_data_header_name'],grpc:['service_name','idle_timeout','ping_timeout','permit_without_stream'],http:['host','path','method','headers','idle_timeout','ping_timeout'],httpupgrade:['host','path','headers']};
  if(Object.keys(settings).some(k=>!allowed[type].includes(k)))fail('unsupported-transport-setting',`node ${n.id}`);
  return {type,...settings};
}
function applyProtocol(root: Row, inbound: Row, m: Row, files: RuntimeFile[]) {
  const ps = obj(root.protocol_settings); const type = root.type || root.protocol;
  const known=new Set(['tls','flow','utls','network','multiplex','encryption','tls_settings','tlsSettings','network_settings','reality_settings','reality','cipher','method','server_psk','obfs','plugin','plugin_opts','obfs_settings','padding_scheme','server_name','allow_insecure','alpn','decryption','proxy_protocol']);
  for(const [k,v] of Object.entries(ps))if(!known.has(k) && v!=null && v!=='' && v!==false)fail('unsupported-protocol-setting',`node ${root.id}`);
  if (!['vless','trojan','shadowsocks','anytls'].includes(type)) fail('unsupported-protocol', `node ${root.id}`);
  if (ps.encryption?.enabled || (ps.decryption && ps.decryption !== 'none')) fail('unsupported-vless-encryption', `node ${root.id}`);
  if (ps.plugin || ps.obfs) fail('unsupported-shadowsocks-plugin-or-obfs', `node ${root.id}`);
  if (ps.proxy_protocol || root.proxy_protocol) fail('unsupported-proxy-protocol', `node ${root.id}`);
  const transport=transportSettings(ps,root);if(transport)inbound.transport=transport;
  if (ps.multiplex?.enabled) { const mux = obj(ps.multiplex); inbound.multiplex = {enabled:true,padding:!!mux.padding}; if (mux.brutal?.enabled) inbound.multiplex.brutal = mux.brutal; }
  if (type === 'shadowsocks') { inbound.method = ps.cipher || ps.method; inbound.password = shadowsocksServerPSK(root, inbound.method); }
  else { const tls = tlsFor(root, m, files); if (tls) inbound.tls = tls; }
  if (type === 'anytls') { if (m.core_version !== '1.14') fail('anytls-needs-core-1.14', `machine ${m.id}`); if (ps.padding_scheme) inbound.padding_scheme = arr(ps.padding_scheme); }
}

function outbound(raw: Row, tag: string, version: string, endpoints: Row[], warnings: string[]): Row | null {
  const type = String(raw.protocol || raw.type || '').toLowerCase().replace('socks5','socks'); const s = obj(raw.settings || {});
  const o: Row = {type,tag,...s};
  if (raw.type && !raw.settings) Object.assign(o, raw, {tag});
  if (o.secret_key) { o.private_key = o.secret_key; delete o.secret_key; }
  if (o.address && !o.server && type !== 'wireguard') { o.server = o.address; delete o.address; }
  if (o.port && !o.server_port && type !== 'wireguard') { o.server_port = Number(o.port); delete o.port; }
  if (o.proxy_tag || raw.proxy_tag) { o.detour = o.proxy_tag || raw.proxy_tag; delete o.proxy_tag; }
  if (!['direct','block','vless','trojan','shadowsocks','socks','wireguard','anytls','http'].includes(type)) fail('unsupported-outbound', 'routing attachment');
  if (type === 'block') return null;
  if (type === 'wireguard') {
    if (!o.private_key) fail('missing-wireguard-private-key', 'routing attachment');
    const peers = arr(o.peers);
    if (!peers.length && o.peer_public_key) peers.push({address:o.server,port:o.server_port,public_key:o.peer_public_key,pre_shared_key:o.pre_shared_key,allowed_ips:['0.0.0.0/0','::/0'],reserved:o.reserved});
    for (const p of peers) {
      if (p.endpoint) { const match = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(p.endpoint); if (!match) fail('invalid-wireguard-endpoint','routing attachment'); p.address = match[1] || match[2]; p.port = port(match[3], 'wireguard peer'); delete p.endpoint; }
      if(p.server) {p.address=p.server;delete p.server;} if(p.server_port) {p.port=p.server_port;delete p.server_port;}
      if(!p.address || !p.public_key)fail('incomplete-wireguard-peer','routing attachment');p.port=port(p.port,'wireguard peer');
      if(!p.allowed_ips) p.allowed_ips=['0.0.0.0/0','::/0'];
      if(typeof p.reserved==='string')p.reserved=[...Buffer.from(p.reserved,'base64')];
    }
    if (version === '1.14') {
      const ep: Row = { ...o, type:'wireguard', address:o.local_address || o.address, peers };
      for(const k of ['local_address','server','server_port','peer_public_key','pre_shared_key','reserved'])delete ep[k];
      if('system_interface' in ep) {ep.system=ep.system_interface;delete ep.system_interface;}if(ep.interface_name){ep.name=ep.interface_name;delete ep.interface_name;}
      if('gso' in ep){delete ep.gso;warnings.push('WireGuard gso removed by upstream endpoint schema.');}
      if(ep.network)fail('wireguard-network-restriction-needs-native-supplement','routing attachment');
      if (!Array.isArray(ep.address) || !peers.length) fail('incomplete-wireguard-endpoint','routing attachment');
      endpoints.push(ep); warnings.push('WireGuard outbound migrated to 1.14 endpoint; validate pinned core before cutover.'); return null;
    }
    o.peers = peers.map(p=>{const peer={...p,server:p.address,server_port:p.port};delete peer.address;delete peer.port;return peer;}); warnings.push('WireGuard outbound requires deprecated compatibility in pinned 1.12 core.'); return o;
  }
  if (type !== 'direct') { if (!o.server) fail('missing-outbound-server','routing attachment'); o.server_port = port(o.server_port, 'routing attachment'); }
  if (type === 'socks') { o.version = '5'; if (o.user) {o.username=o.user;delete o.user;} if (o.pass) {o.password=o.pass;delete o.pass;} }
  if (['vless','trojan','anytls','http'].includes(type)) {
    if (type==='vless' && !o.uuid) fail('missing-outbound-uuid','routing attachment');
    if (typeof o.tls === 'boolean') o.tls = {enabled:o.tls,server_name:o.server_name || '',insecure:!!o.allow_insecure};
    const network = o.network; if (network && network !== 'tcp') o.transport = {type:network,...(o.path ? {path:o.path} : {}),...(o.service_name ? {service_name:o.service_name} : {})};
    for (const k of ['server_name','allow_insecure','network','path','service_name']) delete o[k];
  }
  if(type==='shadowsocks' && o.cipher){o.method=o.method||o.cipher;delete o.cipher;}
  if(['trojan','anytls','shadowsocks'].includes(type)&&!o.password)fail('missing-outbound-password','routing attachment');
  return o;
}
function attachments(db: Database, root: Row) {
  const templates = new Map(source(db,'v2_outbound_template').map(t=>[Number(t.id),t]));
  return source(db,'v2_server_outbound_template').filter(a=>Number(a.server_id)===Number(root.id) && yes(a.enabled)).map(a=>{
    const t=templates.get(Number(a.outbound_template_id)); if(!t) fail('missing-outbound-template',`node ${root.id}`); if(!yes(t.enabled)) return null;
    return {...t, tag:a.tag, source_template_id:Number(t.id)};
  }).filter(Boolean) as Row[];
}
function scopedTag(root: Row, tag: string) { if (!tag || !/^[A-Za-z0-9_.:-]{1,128}$/.test(tag)) fail('invalid-outbound-tag', `node ${root.id}`); return tag === 'direct' || tag === 'block' ? tag : `n${root.id}:${tag}`; }
function profileTag(db: Database, root: Row, p: Row) {
  if (p.outbound_template_id == null) return 'direct';
  const a=attachments(db,root).find(a=>Number(a.source_template_id)===Number(p.outbound_template_id)); if(!a) fail('profile-outbound-not-attached', `node ${root.id}, profile ${p.id}`); return scopedTag(root,a.tag);
}
function compileRouteSets(db: Database, root: Row, ruleSets: Map<string,Row>) {
  const definitions=source(db,'v2_rule_set');
  const register=(tag: string, cfg: Row) => {
    if(!tag || !/^[A-Za-z0-9_.:!@-]{1,128}$/.test(tag))fail('invalid-rule-set-tag',`node ${root.id}`);
    const entry={...cfg,tag};const previous=ruleSets.get(tag);
    if(previous && JSON.stringify(previous)!==JSON.stringify(entry))fail('conflicting-rule-set',`node ${root.id}`);
    ruleSets.set(tag,entry);return tag;
  };
  const resolveSource=(definition: Row) => {
    if(!yes(definition.enabled))fail('missing-rule-set',`node ${root.id}`);
    const cfg=clone(obj(obj(definition.settings).singbox));cfg.type=String(cfg.type||'remote').toLowerCase();
    if(!['remote','local'].includes(cfg.type) || !(cfg.type==='remote'?cfg.url:cfg.path) || !['binary','source'].includes(cfg.format))fail('incomplete-rule-set',`node ${root.id}`);
    if(cfg.download_detour)cfg.download_detour=scopedTag(root,String(cfg.download_detour));
    return register(String(definition.tag||''),cfg);
  };
  return {
    resolve(value: any) {
      const key=String(value);const definition=definitions.find(r=>String(r.uuid)===key || String(r.tag)===key);
      return definition?resolveSource(definition):key;
    },
    geo(selector: string) {
      const match=/^(geosite|geoip):(.+)$/i.exec(selector);if(!match)fail('unsupported-geo-selector',`node ${root.id}`);
      const family=match[1]!.toLowerCase(),name=match[2]!.toLowerCase();
      // Custom assets (ext:, filenames, query expressions) need an explicit source rule-set.
      if(!/^[a-z0-9][a-z0-9_.!@-]*$/.test(name))fail('custom-geo-selector-needs-rule-set',`node ${root.id}`);
      const tag=`${family}-${name}`;const definition=definitions.find(r=>String(r.tag)===tag);
      return definition?resolveSource(definition):register(tag,{type:'remote',format:'binary',url:`https://raw.githubusercontent.com/SagerNet/sing-${family}/rule-set/${tag}.srs`});
    }
  };
}
type RouteSets = ReturnType<typeof compileRouteSets>;
function routeHasDomain(rule: Row): boolean { return !!(rule.domain || rule.domain_suffix || rule.domain_regex || rule.domain_keyword || rule.rule_set || (rule.rules && arr(rule.rules).some(routeHasDomain))); }
function normalizeRoute(raw: Row, root: Row, tags: Set<string>, sets: RouteSets): Row[] {
  const r = clone(raw); if(r.outboundTag) {if(!r.outbound)r.outbound=r.outboundTag;delete r.outboundTag;}
  if(r.outbound === 'block' || r.action === 'reject') {r.action='reject';delete r.outbound;}
  else if(r.outbound) {r.outbound=scopedTag(root,String(r.outbound));r.action='route';if(!tags.has(r.outbound)) fail('route-target-missing',`node ${root.id}`);}
  if(r.type==='logical') {
    if(!['and','or'].includes(r.mode) || !arr(r.rules).length || Object.keys(r).some(k=>!['type','mode','rules','invert','action','outbound'].includes(k)))fail('unsupported-logical-route',`node ${root.id}`);
    r.rules=arr(r.rules).flatMap(child=>normalizeRoute(obj(child),root,tags,sets));return [r];
  }
  if(r.type && !['default','field'].includes(r.type))fail('unsupported-route-type',`node ${root.id}`);delete r.type;
  if(r.ip) {if(r.ip_cidr)fail('conflicting-route-ip-field',`node ${root.id}`);r.ip_cidr=r.ip;delete r.ip;}
  const supported = new Set(['inbound','auth_user','domain','domain_suffix','domain_keyword','domain_regex','ip_cidr','ip_is_private','source_ip_cidr','source_ip_is_private','port','port_range','source_port','source_port_range','network','protocol','rule_set','rule_set_ip_cidr_match_source','action','outbound','invert','process_name','process_path','clash_mode','query_type','geosite','geoip','source_geoip']);
  if(Object.keys(r).some(k=>!supported.has(k))) fail('unsupported-route-field',`node ${root.id}`);
  if(r.rule_set)r.rule_set=arr(r.rule_set).map(sets.resolve);
  const exact:string[]=[], suffix:string[]=arr(r.domain_suffix),regex:string[]=arr(r.domain_regex),keyword:string[]=arr(r.domain_keyword);
  const destinationGeo:Row[]=[],sourceGeo:Row[]=[];
  const geo=(value: string, source=false): Row => {
    if(value.toLowerCase()==='geoip:private')return {[source?'source_ip_is_private':'ip_is_private']:true};
    return {rule_set:[sets.geo(value)],...(source?{rule_set_ip_cidr_match_source:true}:{})};
  };
  for(const value of arr(r.domain)) {
    const d=String(value);if(/^(geosite|geoip):/i.test(d))destinationGeo.push(geo(d));else if(d.startsWith('domain:'))suffix.push(d.slice(7));else if(d.startsWith('full:'))exact.push(d.slice(5));else if(d.startsWith('regexp:'))regex.push(d.slice(7));else if(d.startsWith('keyword:'))keyword.push(d.slice(8));else exact.push(d);
  }
  // Native domain suffixes can also contain panel geosite wrappers.
  const ordinarySuffix=suffix.filter(d=>{if(/^geosite:/i.test(String(d))){destinationGeo.push(geo(String(d)));return false;}return true;});
  for(const [key,values] of [['domain',exact],['domain_suffix',ordinarySuffix],['domain_regex',regex],['domain_keyword',keyword]] as const) {delete r[key];if(values.length)r[key]=values;}
  for(const [key,source] of [['ip_cidr',false],['source_ip_cidr',true]] as const) {
    if(!r[key])continue;const ordinary=arr(r[key]).filter(v=>{if(/^geoip:/i.test(String(v))){(source?sourceGeo:destinationGeo).push(geo(String(v),source));return false;}return true;});delete r[key];if(ordinary.length)r[key]=ordinary;
  }
  for(const [key,family,source] of [['geosite','geosite',false],['geoip','geoip',false],['source_geoip','geoip',true]] as const) {for(const name of arr(r[key]))(source?sourceGeo:destinationGeo).push(geo(`${family}:${name}`,source));delete r[key];}
  if(!destinationGeo.length && !sourceGeo.length)return [r];
  // Geo rule-sets belong to the same OR group as ordinary destination/source
  // selectors. Keep auth, ports and invert outside that group, never a catch-all.
  const action:Row={};for(const key of ['action','outbound','invert']) {if(key in r)action[key]=r[key];delete r[key];}
  const groups:Row[]=[];
  for(const [branches,keys] of [[destinationGeo,['domain','domain_suffix','domain_keyword','domain_regex','ip_cidr','ip_is_private']],[sourceGeo,['source_ip_cidr','source_ip_is_private']]] as [Row[],string[]][]) {
    if(!branches.length)continue;const ordinary:Row={};for(const key of keys) {if(key in r)ordinary[key]=r[key];delete r[key];}
    if(Object.keys(ordinary).length)branches.unshift(ordinary);
    groups.push(branches.length===1?branches[0]!:{type:'logical',mode:'or',rules:branches});
  }
  if(Object.keys(r).length)groups.push(r);
  return [{...(groups.length===1?groups[0]:{type:'logical',mode:'and',rules:groups}),...action}];
}
function compileRoutes(db: Database, root: Row, tags: Set<string>, ruleSets: Map<string,Row>): Row[] {
  const rules:Row[]=[],sets=compileRouteSets(db,root,ruleSets);
  const templates=new Map(source(db,'v2_route_template').map(t=>[Number(t.id),t]));
  const outboundUUIDs=new Map(attachments(db,root).map(a=>[String(a.uuid),a.tag]));
  for(const a of source(db,'v2_server_route_template').filter(a=>Number(a.server_id)===Number(root.id) && yes(a.enabled))) {
    const t=templates.get(Number(a.route_template_id)); if(!t) fail('missing-route-template',`node ${root.id}`);if(!yes(t.enabled))continue;
    for(const rule of arr(t.rules)) {
      if(yes(rule.disabled,false))continue;
      const match=obj(rule.match); const action=obj(rule.action); const native:Row={};
      const aliases:Row={domains:'domain',domain_suffixes:'domain_suffix',domain_keywords:'domain_keyword',domain_regexes:'domain_regex',ip_cidrs:'ip_cidr',source_ip_cidrs:'source_ip_cidr',source_cidrs:'source_ip_cidr',source_ports:'source_port',ports:'port',port_ranges:'port_range',networks:'network',protocols:'protocol',rule_sets:'rule_set'};
      for(const [k,v] of Object.entries(match)) {if(!aliases[k] && !['domain','domain_suffix','domain_keyword','domain_regex','ip_cidr','port','network','protocol'].includes(k))fail('unsupported-route-match',`node ${root.id}`);native[aliases[k]||k]=v;}
      if(native.rule_set) native.rule_set=arr(native.rule_set).map(uuid=>{const tag=sets.resolve(uuid);if(!ruleSets.has(tag))fail('missing-rule-set',`node ${root.id}`);return tag;});
      if(!Object.keys(native).length)fail('empty-route-match',`node ${root.id}`);
      // Each populated old selector is an independent OR branch, including port ranges.
      for(const [selector,values] of Object.entries(native)) {
        const branch:Row={[selector]:values};
        if(selector==='port'||selector==='source_port') {const numeric:number[]=[],ranges:string[]=[];for(const value of arr(values)){const v=String(value);if(/^\d+[:-]\d+$/.test(v)){const [lo,hi]=v.split(/[:-]/).map(x=>port(x,`node ${root.id}`));if(lo!>hi!)fail('invalid-route-port-range',`node ${root.id}`);ranges.push(`${lo}:${hi}`);}else numeric.push(port(value,`node ${root.id}`));}delete branch[selector];if(numeric.length)branch[selector]=numeric;if(ranges.length)branch[selector==='port'?'port_range':'source_port_range']=ranges;}
        if(action.type==='block' || action.type==='reject')branch.action='reject';else if(action.type==='direct')branch.outbound='direct';else if(action.type==='route')branch.outbound=outboundUUIDs.get(String(action.target))||action.target;else fail('unsupported-route-action',`node ${root.id}`);
        rules.push(...normalizeRoute(branch,root,tags,sets));
      }
    }
  }
  for(const raw of arr(root.custom_routes)) rules.push(...normalizeRoute(raw,root,tags,sets));
  rules.push({action:'reject',ip_cidr:['10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.0.0.0/24','192.168.0.0/16','198.18.0.0/15','fc00::/7','fe80::/10','::1/128']});
  const legacyRoutes=new Map(source(db,'v2_server_route').map(r=>[Number(r.id),r]));
  for(const rid of arr(root.route_ids)) {const r=legacyRoutes.get(Number(rid));if(!r)fail('missing-legacy-route',`node ${root.id}`);const matches=arr(r.match);if(!matches.length)fail('empty-legacy-route',`node ${root.id}`);const destination=r.action==='direct'?'direct':r.action==='proxy'?r.action_value:'block';const domains=matches.filter(x=>!String(x).includes('/')).map(x=>String(x).replace(/^\*\./,''));const cidrs=matches.filter(x=>String(x).includes('/'));if(domains.length)rules.push(...normalizeRoute({domain_suffix:domains,outbound:destination},root,tags,sets));if(cidrs.length)rules.push(...normalizeRoute({ip_cidr:cidrs,outbound:destination},root,tags,sets));}
  if(rules.some(routeHasDomain))rules.unshift({action:'sniff'});
  return rules.map(r=>{
    if(r.type!=='logical' && !r.invert)return {...r,inbound:[`mb:n:${root.id}`]};
    const match=clone(r),action:Row={};for(const key of ['action','outbound']) {if(key in match)action[key]=match[key];delete match[key];}
    return {type:'logical',mode:'and',rules:[{inbound:[`mb:n:${root.id}`]},match],...action};
  });
}

export function compileMachine(db: Database, machineID: number): CompiledMachine {
  const m=machine(db,machineID); const all=nodes(db); const ns=new Map(all.map(n=>[Number(n.id),n]));
  const bindings=db.query('SELECT * FROM runtime_bindings WHERE machine_id=? ORDER BY node_id').all(machineID) as Row[];
  const roots=new Map<number,Row>();for(const b of bindings) {const n=ns.get(Number(b.node_id));if(!n)fail('missing-bound-node',`machine ${machineID}`);const root=rootFor(ns,n);if(yes(root.enabled))roots.set(Number(root.id),root);}
  if(!roots.size)fail('no-enabled-bindings',`machine ${machineID}`);
  const config:Row={log:{level:'info',timestamp:true},inbounds:[],outbounds:[{type:'direct',tag:'direct'}],route:{rules:[],final:'direct'}};
  const traffic_labels:TrafficLabel[]=[],files:RuntimeFile[]=[],warnings:string[]=[],endpoints:Row[]=[],ruleSets=new Map<string,Row>();const tags=new Set(['direct']);const authAliases=new Map<string,string[]>();
  const users=db.query('SELECT * FROM users ORDER BY id').all() as Row[]; const ports=new Set<number>();
  for(const root of roots.values()) {
    const p=port(root.server_port || root.port,`node ${root.id}`);if(ports.has(p))fail('physical-port-collision',`machine ${machineID}, node ${root.id}`);ports.add(p);
    const inbound:Row={type:root.type||root.protocol,tag:`mb:n:${root.id}`,listen:'::',listen_port:p,users:[]};applyProtocol(root,inbound,m,files);
    const profileList=profiles(db,root);if(profileList.length && !supportsProfiles(root))fail('profiles-not-supported-by-source-protocol',`node ${root.id}`);
    for(const raw of [...attachments(db,root),...arr(root.custom_outbounds)]) {const tag=scopedTag(root,String(raw.tag||''));if(tags.has(tag))fail('duplicate-outbound-tag',`node ${root.id}`);tags.add(tag);const out=outbound(raw,tag,m.core_version,endpoints,warnings);if(out)config.outbounds.push(out);}
    const entries=all.filter(n=>Number(rootFor(ns,n).id)===Number(root.id) && yes(n.enabled));
    const profileRules:Row[]=[];
    for(const u of users) for(const n of entries) {
      if(!eligible(db,u,n))continue;
      for(const profile of [null,...profileList.filter(p=>profileAllows(p,n))]) {
        const pid=profile?profileID(profile):'';const credential=identity(db,u,n,pid);const auth=label(u,n,pid);const serverUser:Row={name:auth};
        if(inbound.type==='vless') {serverUser.uuid=credential;const flow=obj(root.protocol_settings).flow;if(flow)serverUser.flow=flow;}
        else serverUser.password=inbound.type==='shadowsocks'?ssUserPSK(credential,inbound.method):credential;
        inbound.users.push(serverUser);traffic_labels.push({label:auth,user_id:u.id,node_id:Number(n.id)});
        const legacyAuth=Number(n.parent_id)>0?`xb:u:${u.id}:cn:${n.id}${pid?`:rp:${pid}`:''}`:pid?`xb:u:${u.id}:rp:${pid}`:credential;
        authAliases.set(legacyAuth,[...(authAliases.get(legacyAuth)||[]),auth]);authAliases.set(auth,[auth]);
        if(profile) {const target=profileTag(db,root,profile);if(!tags.has(target))fail('profile-route-target-missing',`node ${root.id}`);profileRules.push({inbound:[inbound.tag],auth_user:[auth],action:'route',outbound:target});}
      }
    }
    // Source destination/private guards precede authenticated profile fallback.
    config.route.rules.push(...compileRoutes(db,root,tags,ruleSets),...profileRules);config.inbounds.push(inbound);
  }
  if(endpoints.length)config.endpoints=endpoints;
  if(ruleSets.size) {config.route.rule_set=[...ruleSets.values()];config.experimental={cache_file:{enabled:true,path:'/var/lib/mboard-node/cache.db'}};}
  const extra=obj(m.payload).native_config;
  if(extra) {
    const native=obj(extra);if(native.inbounds?.length)fail('native-inbounds-must-be-normalized-supplement',`machine ${machineID}`);
    for(const k of Object.keys(native))if(!['outbounds','endpoints','route','dns','experimental'].includes(k))fail('unsupported-machine-native-field',`machine ${machineID}`);
    for(const out of arr(native.outbounds)) {if(tags.has(out.tag))fail('duplicate-native-outbound',`machine ${machineID}`);config.outbounds.push(out);tags.add(out.tag);}
    if(native.endpoints)config.endpoints=[...(config.endpoints||[]),...arr(native.endpoints)];
    if(native.route) {const route=obj(native.route);config.route.rules=[...arr(route.rules),...config.route.rules,...arr(route.rules_after)];if(route.rule_set)config.route.rule_set=[...(config.route.rule_set||[]),...arr(route.rule_set)];if(route.final)config.route.final=route.final;for(const k of Object.keys(route))if(!['rules','rules_after','rule_set','final'].includes(k))config.route[k]=route[k];}
    if(native.dns)config.dns=native.dns;if(native.experimental)config.experimental={...config.experimental,...native.experimental};
  }
  const definedRuleSets=new Set(arr(config.route.rule_set).map(set=>String(set.tag)));
  const visitRule=(rule: Row) => {
    if(rule.rule_set && arr(rule.rule_set).some(tag=>!definedRuleSets.has(String(tag))))fail('missing-rule-set',`machine ${machineID}`);
    if(rule.auth_user)rule.auth_user=[...new Set(arr(rule.auth_user).flatMap(alias=>authAliases.get(String(alias))||[String(alias)]))];
    if(rule.outbound && !tags.has(rule.outbound) && !endpoints.some(e=>e.tag===rule.outbound))fail('unresolved-route-target',`machine ${machineID}`);
    if(rule.rules)for(const child of arr(rule.rules))visitRule(child);
  };
  for(const rule of config.route.rules)visitRule(rule);
  config.experimental={...config.experimental,v2ray_api:{listen:'127.0.0.1:19090',stats:{enabled:true,users:traffic_labels.map(t=>t.label)}}};
  const digest=sha(JSON.stringify({config,traffic_labels,files}));
  const revision=db.transaction(()=>{const key=`machine:${machineID}:config`;const old=db.query('SELECT value FROM runtime_metadata WHERE key=?').get(key) as Row | null;const prior=old?obj(old.value):{digest:'',revision:0};const revision=prior.digest===digest?Number(prior.revision):Number(prior.revision)+1;if(!Number.isSafeInteger(revision))fail('revision-overflow',`machine ${machineID}`);db.query('INSERT INTO runtime_metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify({digest,revision}));return revision;}).immediate();
  return {revision,config,traffic_labels,files,warnings:[...new Set(warnings)]};
}

function publicSettings(value: any): any { if(Array.isArray(value))return value.map(publicSettings);if(value && typeof value==='object'){const safe:Row={};const serverOnly=new Set(['private_key','decryption','server_psk','key','key_path','key_content','private_key_path','certificate_path','cert_content']);for(const [k,v] of Object.entries(value))if(!serverOnly.has(k))safe[k]=publicSettings(v);return safe;}return value; }
function clientSettings(ps: Row, protocol: string, n: Row): Row {
  const settings:Row={};
  if(protocol==='shadowsocks') {settings.method=ps.cipher||ps.method;return settings;}
  if(protocol==='vless' && ps.flow)settings.flow=ps.flow;
  const mode=typeof ps.tls==='object'?1:Number(ps.tls ?? (['trojan','anytls'].includes(protocol)?1:0));
  if(mode) {
    const ts=obj(typeof ps.tls==='object'?ps.tls:ps.tls_settings||ps.tlsSettings);
    const tls:Row={enabled:true,server_name:ts.server_name||ps.server_name||n.server_name||n.host};
    if(yes(ts.allow_insecure ?? ps.allow_insecure,false))tls.insecure=true;
    if(ts.alpn||ps.alpn)tls.alpn=arr(ts.alpn||ps.alpn);
    if(ps.utls?.enabled)tls.utls={enabled:true,fingerprint:ps.utls.fingerprint||'chrome'};
    if(mode===2) {const reality=obj(ps.reality_settings||ps.reality||ps.tlsSettings?.reality||ps.tlsSettings);const short=Array.isArray(reality.short_id)?reality.short_id[0]:reality.short_id;if(!reality.public_key)fail('missing-client-reality-key',`node ${n.id}`);tls.server_name=reality.server_name||tls.server_name;tls.reality={enabled:true,public_key:reality.public_key,short_id:short||''};}
    if(ts.ech?.enabled) {const ech:Row={enabled:true};if(ts.ech.config)ech.config=Array.isArray(ts.ech.config)?ts.ech.config:[ts.ech.config];if(ts.ech.query_server_name)ech.query_server_name=ts.ech.query_server_name;tls.ech=ech;}
    settings.tls=tls;
  }
  const transport=transportSettings(ps,n);if(transport)settings.transport=transport;
  if(ps.multiplex?.enabled){const mux=obj(ps.multiplex);settings.multiplex={enabled:true,protocol:mux.protocol||'yamux',padding:!!mux.padding};if(mux.max_connections!=null)settings.multiplex.max_connections=Number(mux.max_connections);if(mux.brutal?.enabled)settings.multiplex.brutal=mux.brutal;}
  return publicSettings(settings);
}
export function authorizedEndpoints(db: Database, userID: number): RuntimeEndpoint[] {
  const u=db.query('SELECT * FROM users WHERE id=?').get(userID) as Row;if(!u)return [];
  const all=nodes(db);const ns=new Map(all.map(n=>[Number(n.id),n]));const activeRoots=new Set<number>();
  for(const b of db.query("SELECT b.node_id FROM runtime_bindings b JOIN runtime_machines m ON m.id=b.machine_id WHERE m.active=1 AND m.state='active' AND m.core_ready=1 AND m.telemetry_ready=1").all() as Row[]) {const n=ns.get(Number(b.node_id));if(n)activeRoots.add(Number(rootFor(ns,n).id));}
  const result:RuntimeEndpoint[]=[];
  for(const n of all) {
    const root=rootFor(ns,n);if(!yes(n.show)||!yes(root.enabled)||!eligible(db,u,n)||!activeRoots.has(Number(root.id)))continue;
    const ps={...obj(root.protocol_settings),...obj(n.protocol_settings)};const protocol=root.type||root.protocol;
    for(const profile of [null,...profiles(db,root).filter(p=>profileAllows(p,n))]) {
      const pid=profile?profileID(profile):'';const cred=identity(db,u,n,pid);const credential=protocol==='shadowsocks'?`${shadowsocksServerPSK(root,ps.cipher||ps.method)}:${ssUserPSK(cred,ps.cipher||ps.method)}`:cred;
      const safe=clientSettings(ps,protocol,{...root,...n});
      result.push({id:profile?`${n.id}:p:${pid}`:Number(n.id),name:profile?`${n.name} · ${profile.name}`:n.name,protocol,host:String(n.host),port:port(n.port,`node ${n.id}`),credential,settings:safe});
    }
  }
  return result;
}
/** Write a private per-machine deployment bundle. Never use this result in public API responses. */
export function writePrivateMachineBundle(compiled: CompiledMachine, path: string) {
  const target=resolve(path);mkdirSync(dirname(target),{recursive:true,mode:0o700});chmodSync(dirname(target),0o700);writeFileSync(target,JSON.stringify(compiled),{mode:0o600});chmodSync(target,0o600);
}
