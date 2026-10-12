#!/usr/bin/env bun
/** Offline-only import. Validation never opens the destination or generates secrets. */
import { closeSync, fchmodSync, fsyncSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Row = Record<string, unknown>;
type User = { id: number; email: string; name: string; enabled: boolean; upload_bytes: number; download_bytes: number; quota_bytes: number; expires_at: string | null; created_at: string; group_ids: number[] };
type Group = { id: number; name: string };
type Machine = { id: number; name: string; host: string; enabled: boolean };
type Node = { id: number; name: string; host: string; port: number; protocol: 'vless' | 'trojan' | 'shadowsocks'; enabled: boolean; machine_id: number | null; tls: boolean; server_name: string; created_at: string; group_ids: number[] };
type Plan = { users: User[]; groups: Group[]; nodes: Node[]; machines: Machine[]; warnings: string[]; format: string };
const fail = (message: string): never => { throw new Error(message); };
const own = (r: Row, key: string) => Object.hasOwn(r, key);
const row = (v: unknown, at: string): Row => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Row : fail(`${at}: expected an object`);
function integer(v: unknown, at: string, min = 0, max = Number.MAX_SAFE_INTEGER, legacy = false): number {
  if (legacy && typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)) v = Number(v);
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail(`${at}: expected a safe integer in ${min}..${max}`);
}
function boolean(v: unknown, at: string, legacy = false): boolean {
  if (typeof v === 'boolean') return v;
  if (legacy && (v === 0 || v === '0')) return false;
  if (legacy && (v === 1 || v === '1')) return true;
  return fail(`${at}: expected ${legacy ? 'boolean or 0/1' : 'boolean'}`);
}
function text(v: unknown, at: string, max = 255, empty = false): string {
  if (typeof v !== 'string' || v.length > max || (!empty && !v.trim()) || /[\x00-\x1f\x7f]/.test(v)) return fail(`${at}: invalid text (maximum ${max} characters)`);
  return v.trim();
}
function host(v: unknown, at: string): string {
  const value = text(v, at, 253);
  if (!/^[a-zA-Z0-9.:[\]_-]+$/.test(value)) fail(`${at}: expected a hostname or IP address without URL, path, or whitespace`);
  return value;
}
function time(v: unknown, at: string, nullable: boolean, legacy: boolean): string | null {
  if (v === null && nullable) return null;
  if (legacy) {
    const seconds = integer(v, at, 0, 253402300799, true);
    return new Date(seconds * 1000).toISOString();
  }
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v)) return fail(`${at}: expected UTC ISO 8601 ${nullable ? 'or null' : ''}`);
  const d = new Date(v);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 19) !== v.slice(0, 19)) fail(`${at}: invalid calendar date`);
  return d.toISOString();
}
function list(v: unknown, at: string, legacy = false): unknown[] {
  if (legacy && typeof v === 'string') {
    try { v = JSON.parse(v); } catch { fail(`${at}: expected an array or JSON-encoded array`); }
  }
  return Array.isArray(v) ? v : fail(`${at}: expected an array`);
}
function ids(v: unknown, at: string, legacy = false): number[] {
  const values = list(v, at, legacy).map((x, i) => integer(x, `${at}[${i}]`, 1, Number.MAX_SAFE_INTEGER, legacy));
  if (new Set(values).size !== values.length) fail(`${at}: duplicate group ID`);
  return values;
}
function only(r: Row, fields: string[], at: string) {
  const allowed = new Set(fields);
  const unknown = Object.keys(r).filter(k => !allowed.has(k));
  if (unknown.length) fail(`${at}: unmapped fields ${unknown.join(', ')}; remove deliberately or normalize them first`);
}
function absentFeature(r: Row, key: string, at: string) {
  const v = r[key];
  if (v === undefined || v === null || v === '' || v === false || v === 0 || v === '0') return;
  if (Array.isArray(v) && v.length === 0) return;
  if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v as Row).length === 0) return;
  if (v === '[]' || v === '{}') return;
  fail(`${at}.${key}: unsupported configuration; explicitly normalize after reviewing its effect`);
}
function unique<T>(items: T[], key: (v: T) => string | number, at: string) {
  const seen = new Set<string | number>();
  for (const item of items) { const k = key(item); if (seen.has(k)) fail(`${at}: duplicate identifier or value`); seen.add(k); }
}

export function validateExport(input: unknown): Plan {
  const root = row(input, 'export');
  const legacy = own(root, 'v2_user');
  const warnings = new Set<string>();
  const now = new Date().toISOString();
  const expected = legacy ? ['v2_user', 'v2_server_group', 'v2_server', 'v2_server_vless', 'v2_server_trojan', 'v2_server_shadowsocks', 'v2_server_machine'] : ['users', 'groups', 'nodes', 'machines'];
  // Unknown empty tables are harmless but are inventoried. Nonempty tables need a deliberate offline conversion.
  for (const key of Object.keys(root)) if (!expected.includes(key)) {
    if (legacy && Array.isArray(root[key]) && (root[key] as unknown[]).length === 0) warnings.add(`Empty unmapped table ${key} omitted.`);
    else fail(`export.${key}: unsupported table or format; provide only documented tables or normalized export`);
  }
  if (!legacy) for (const key of expected) if (!own(root, key)) fail(`export.${key}: required array (use [] explicitly when empty)`);
  if (legacy && !own(root, 'v2_server_group')) fail('export.v2_server_group: required group table');
  const table = (name: string) => list(root[name] ?? [], `export.${name}`).map((v, i) => ({ r: row(v, `${name}[${i}]`), at: `${name}[${i}]` }));
  const num = (v: unknown, at: string, min = 0, max = Number.MAX_SAFE_INTEGER) => integer(v, at, min, max, legacy);
  const flag = (v: unknown, at: string) => boolean(v, at, legacy);
  const ignored = (r: Row, mapped: string[], at: string) => {
    for (const key of Object.keys(r)) if (!mapped.includes(key)) warnings.add(`Legacy field ${at.split('[')[0]}.${key} omitted (values never printed).`);
  };
  const groups = table(legacy ? 'v2_server_group' : 'groups').map(({r, at}): Group => {
    if (!legacy) only(r, ['id', 'name'], at); else ignored(r, ['id', 'name'], at);
    return { id: num(r.id, `${at}.id`, 1), name: text(r.name, `${at}.name`, 120) };
  });
  const users = table(legacy ? 'v2_user' : 'users').map(({r, at}): User => {
    const fields = ['id', 'email', 'name', 'enabled', 'upload_bytes', 'download_bytes', 'quota_bytes', 'expires_at', 'created_at', 'group_ids', 'role', 'password', 'password_hash', 'credential', 'subscription_token'];
    if (!legacy) only(r, fields, at);
    else ignored(r, ['id', 'email', 'name', 'banned', 'access_enabled', 'u', 'd', 'transfer_enable', 'expired_at', 'created_at', 'group_id'], at);
    if (own(r, 'role') && r.role !== 'admin' && r.role !== 'user') fail(`${at}.role: invalid role`);
    const email = text(r.email, `${at}.email`, 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`${at}.email: invalid email`);
    const upload_bytes = num(legacy ? r.u : r.upload_bytes ?? 0, `${at}.upload_bytes`);
    const download_bytes = num(legacy ? r.d : r.download_bytes ?? 0, `${at}.download_bytes`);
    if (!Number.isSafeInteger(upload_bytes + download_bytes)) fail(`${at}: total traffic exceeds safe integer range`);
    const quota_bytes = num(legacy ? r.transfer_enable : r.quota_bytes ?? 0, `${at}.quota_bytes`);
    let enabled: boolean;
    let group_ids: number[];
    if (legacy) {
      for (const key of ['group_ids', 'user_groups', 'node_ids']) absentFeature(r, key, at);
      // Both gates matter in this Xboard version; missing gates cannot safely mean enabled.
      enabled = !flag(r.banned, `${at}.banned`) && flag(r.access_enabled, `${at}.access_enabled`);
      // Validate access_enabled even when banned, rather than short-circuiting malformed values.
      flag(r.access_enabled, `${at}.access_enabled`);
      if (!own(r, 'group_id')) fail(`${at}.group_id: required (null explicitly means no grant)`);
      group_ids = r.group_id === null ? [] : [num(r.group_id, `${at}.group_id`, 1)];
      if (quota_bytes === 0) fail(`${at}.transfer_enable: zero would become unlimited in mboard; explicitly normalize quota and enabled after reviewing access`);
      for (const field of ['speed_limit', 'device_limit']) if (r[field] !== undefined && r[field] !== null && num(r[field], `${at}.${field}`) > 0) fail(`${at}.${field}: enforcement is unsupported; explicitly normalize after reviewing access`);
      if (r.parent_id !== undefined && r.parent_id !== null && num(r.parent_id, `${at}.parent_id`) > 0) fail(`${at}.parent_id: child-account semantics unsupported; normalize explicitly`);
    } else {
      enabled = flag(r.enabled ?? true, `${at}.enabled`);
      group_ids = ids(r.group_ids, `${at}.group_ids`);
    }
    if (!group_ids.length) warnings.add('Some users have explicit empty grants and will receive no nodes.');
    return { id: num(r.id, `${at}.id`, 1), email, name: own(r, 'name') ? text(r.name, `${at}.name`, 120) : email, enabled, upload_bytes, download_bytes, quota_bytes,
      expires_at: time(legacy ? r.expired_at : r.expires_at ?? null, `${at}.expires_at`, true, legacy),
      created_at: own(r, 'created_at') ? time(r.created_at, `${at}.created_at`, false, legacy)! : now, group_ids };
  });
  let totalTraffic = 0;
  for (const user of users) {
    totalTraffic += user.upload_bytes + user.download_bytes;
    if (!Number.isSafeInteger(totalTraffic)) fail('users: aggregate upload/download traffic exceeds safe integer range');
  }
  const machines = table(legacy ? 'v2_server_machine' : 'machines').map(({r, at}): Machine => {
    if (!legacy) only(r, ['id', 'name', 'host', 'enabled', 'token', 'token_hash', 'last_seen_at', 'version', 'config_revision'], at);
    else ignored(r, ['id', 'name', 'host', 'is_active'], at);
    return { id: num(r.id, `${at}.id`, 1), name: text(r.name, `${at}.name`, 120), host: host(r.host, `${at}.host`), enabled: flag(legacy ? r.is_active : r.enabled ?? true, `${at}.enabled`) };
  });
  const sourceNodes: {r: Row; at: string}[] = legacy ? [
    ...table('v2_server'),
    ...table('v2_server_vless').map(x => ({...x, r: {...x.r, type: 'vless'}})),
    ...table('v2_server_trojan').map(x => ({...x, r: {...x.r, type: 'trojan'}})),
    ...table('v2_server_shadowsocks').map(x => ({...x, r: {...x.r, type: 'shadowsocks'}})),
  ] : table('nodes');
  if (legacy && own(root, 'v2_server') && ['v2_server_vless', 'v2_server_trojan', 'v2_server_shadowsocks'].some(k => own(root, k))) fail('export: do not mix unified v2_server and per-protocol tables');
  const nodes = sourceNodes.map(({r, at}): Node => {
    if (!legacy) only(r, ['id', 'name', 'host', 'port', 'protocol', 'enabled', 'machine_id', 'tls', 'server_name', 'created_at', 'group_ids'], at);
    else ignored(r, ['id', 'name', 'host', 'port', 'type', 'enabled', 'show', 'machine_id', 'tls', 'server_name', 'created_at', 'group_ids', 'network', 'cipher'], at);
    const sourceProtocol = legacy ? r.type : r.protocol;
    const protocol: Node['protocol'] = sourceProtocol === 'vless' || sourceProtocol === 'trojan' || sourceProtocol === 'shadowsocks' ? sourceProtocol : fail(`${at}.protocol: unsupported protocol (only vless, trojan, shadowsocks)`);
    for (const key of Object.keys(r)) if (/reality|outbound|routing|route_profile|encrypted/i.test(key)) absentFeature(r, key, at);
    for (const key of ['protocol_settings', 'reality_settings', 'network_settings', 'custom_outbounds', 'custom_routes', 'route_ids', 'outbound', 'outbound_template', 'outbound_template_id', 'reality', 'flow', 'parent_id', 'ports', 'rate_time_enable', 'rate_time_ranges', 'allow_insecure', 'cert_config']) absentFeature(r, key, at);
    if (r.network !== undefined && r.network !== null && r.network !== '' && r.network !== 'tcp') fail(`${at}.network: unsupported transport; TCP only`);
    if (legacy && r.rate !== undefined && Number(r.rate) !== 1) fail(`${at}.rate: traffic multiplier must be 1; normalize explicitly`);
    if (legacy && r.server_port !== undefined && r.server_port !== null && num(r.server_port, `${at}.server_port`, 1, 65535) !== num(r.port, `${at}.port`, 1, 65535)) fail(`${at}.server_port: distinct inbound/client ports unsupported`);
    if (protocol === 'shadowsocks' && r.cipher !== undefined && r.cipher !== 'aes-128-gcm') fail(`${at}.cipher: only aes-128-gcm is supported`);
    const tls = flag(r.tls, `${at}.tls`);
    if (protocol === 'shadowsocks' && tls) fail(`${at}.tls: shadowsocks TLS is unsupported`);
    if (protocol === 'trojan' && !tls) fail(`${at}.tls: trojan requires TLS`);
    const enabled = legacy ? flag(r.show, `${at}.show`) && (own(r, 'enabled') ? flag(r.enabled, `${at}.enabled`) : true) : flag(r.enabled ?? true, `${at}.enabled`);
    if (legacy && own(r, 'enabled')) flag(r.enabled, `${at}.enabled`);
    if (!own(r, 'machine_id')) fail(`${at}.machine_id: required (null explicitly means unassigned)`);
    const group_ids = ids(r.group_ids, `${at}.group_ids`, legacy);
    if (!group_ids.length) warnings.add('Some nodes have explicit empty grants and will reach no users.');
    if (r.machine_id === null) warnings.add('Some nodes are explicitly unassigned; bind them to a machine before deployment.');
    return { id: num(r.id, `${at}.id`, 1), name: text(r.name, `${at}.name`, 120), host: host(r.host, `${at}.host`), port: num(r.port, `${at}.port`, 1, 65535), protocol, enabled, tls,
      server_name: r.server_name === undefined || r.server_name === '' ? '' : host(r.server_name, `${at}.server_name`), machine_id: r.machine_id === null ? null : num(r.machine_id, `${at}.machine_id`, 1), group_ids,
      created_at: own(r, 'created_at') ? time(r.created_at, `${at}.created_at`, false, legacy)! : now };
  });
  for (const [name, items] of [['users', users], ['groups', groups], ['nodes', nodes], ['machines', machines]] as const) unique(items as {id:number}[], v => v.id, `${name}.id`);
  unique(users, u => u.email, 'users.email'); unique(groups, g => g.name, 'groups.name');
  const groupIds = new Set(groups.map(g => g.id)); const machineIds = new Set(machines.map(m => m.id));
  for (const [kind, items] of [['users', users], ['nodes', nodes]] as const) for (const item of items) for (const id of item.group_ids) if (!groupIds.has(id)) fail(`${kind} id ${item.id}: unknown group ${id}`);
  for (const n of nodes) if (n.machine_id !== null && !machineIds.has(n.machine_id)) fail(`nodes id ${n.id}: unknown machine ${n.machine_id}`);
  unique(nodes.filter(n => n.machine_id !== null), n => `${n.machine_id}:${n.port}`, 'nodes machine/port');
  warnings.add('Every imported account is role=user. First-admin setup remains available.');
  warnings.add('All passwords, user UUID credentials, subscription tokens and machine tokens are replaced. Existing clients and agents must be reconfigured.');
  warnings.add('Machine heartbeat/version state resets and configuration revision starts at 1.');
  if (legacy) warnings.add('Historical traffic totals only: orders, balances, resets, tickets, audit, routing templates and traffic history are not migrated.');
  return { users, groups, nodes, machines, warnings: [...warnings].sort(), format: legacy ? 'xboard-v2' : 'normalized' };
}

const HELP = `Offline Xboard JSON migration (dry-run by default)
  bun scripts/migrate-xboard.ts --input export.json
  bun scripts/migrate-xboard.ts --input export.json --apply --db data/mboard.sqlite --credentials-out /secure/new-credentials.json
Options: --input PATH (required), --apply, --dry-run, --db PATH,
         --credentials-out PATH (required on apply, must not exist), --help
No passwords or tokens are printed. Imported roles are always user.`;
function options(argv: string[]) {
  const out: {input?: string; db?: string; credentials?: string; apply: boolean; dryRun: boolean; help: boolean} = { apply: false, dryRun: false, help: false };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (seen.has(a)) fail(`Duplicate option ${a}`); seen.add(a);
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (['--input', '--db', '--credentials-out'].includes(a)) {
      const v = argv[++i]; if (!v || v.startsWith('--')) fail(`${a}: requires a path`);
      if (a === '--input') out.input = resolve(v); else if (a === '--db') out.db = resolve(v); else out.credentials = resolve(v);
    } else fail(`Unknown option ${a}`);
  }
  if (out.help) return out;
  if (!out.input) fail('--input is required');
  if (out.apply && out.dryRun) fail('--apply conflicts with --dry-run');
  if (out.apply && (!out.db || !out.credentials)) fail('--apply requires --db and --credentials-out');
  if (out.credentials === out.input || out.db === out.input || (out.credentials && out.credentials === out.db)) fail('Input, database and credentials paths must be different');
  return out;
}
export async function main(argv = process.argv.slice(2)) {
  const opt = options(argv);
  if (opt.help) { console.log(HELP); return; }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(opt.input!, 'utf8')); } catch { fail('Cannot read input as JSON. Check the path and export syntax; no destination was opened.'); }
  const plan = validateExport(raw);
  const summary = { format: plan.format, users: plan.users.length, groups: plan.groups.length, nodes: plan.nodes.length, machines: plan.machines.length, user_grants: plan.users.reduce((a,u) => a + u.group_ids.length, 0), node_grants: plan.nodes.reduce((a,n) => a + n.group_ids.length, 0), warnings: plan.warnings };
  if (!opt.apply) { console.log(JSON.stringify({ mode: 'dry-run', valid: true, ...summary }, null, 2)); return; }
  // Sequential Argon2 hashing bounds memory. Secrets are unique across every category.
  const { secret } = await import('../src/server/database.ts');
  const secrets = new Set<string>();
  const uuid = () => { let v: string; do { v = crypto.randomUUID(); } while (secrets.has(v)); secrets.add(v); return v; };
  const token = () => { let v: string; do { v = secret(); } while (secrets.has(v)); secrets.add(v); return v; };
  const importedUsers: {user: User; password: string; password_hash: string; credential: string; subscription_token: string}[] = [];
  for (const user of plan.users) {
    const password = uuid();
    importedUsers.push({ user, password, password_hash: await Bun.password.hash(password, { algorithm: 'argon2id' }), credential: uuid(), subscription_token: token() });
  }
  const importedMachines = plan.machines.map(machine => ({ machine, token: token() }));
  const credentialDocument = { format: 'mboard-migration-credentials-v1', created_at: new Date().toISOString(), password_policy: 'Bootstrap passwords: ask each user to change their password after first login. No forced first-login gate.',
    users: importedUsers.map(x => ({id: x.user.id, email: x.user.email, password: x.password, credential: x.credential, subscription_token: x.subscription_token})),
    machines: importedMachines.map(x => ({id: x.machine.id, token: x.token})) };
  let fd: number | undefined; let app: Awaited<ReturnType<typeof import('../src/server/app.ts').createApp>> | undefined; let committed = false;
  try {
    // Exclusive creation refuses existing files and symlinks; chmod defeats a permissive umask.
    try { fd = openSync(opt.credentials!, 'wx', 0o600); fchmodSync(fd, 0o600); } catch { fail('Cannot exclusively create credentials output. Choose a new file in an existing private directory.'); }
    const { createApp } = await import('../src/server/app.ts');
    app = createApp({ dbPath: opt.db!, initializeRuntime: false });
    const db = app.db;
    db.transaction(() => {
      // Under the write lock: do not race first-admin setup or another import.
      const tables = ['users', 'groups', 'nodes', 'machines', 'user_groups', 'node_groups', 'sessions', 'notices', 'guides', 'tickets', 'messages', 'traffic_batches', 'traffic_daily', 'audit'];
      for (const t of tables) if ((db.query(`SELECT COUNT(*) AS count FROM ${t}`).get() as {count:number}).count !== 0) fail(`Destination ${t} is not empty. Import requires a fresh database.`);
      const setup = db.query("SELECT value FROM settings WHERE key='setup_complete'").get() as {value:string} | null;
      if (setup?.value !== '0') fail('Destination first-admin setup is already complete. Use a fresh database.');
      for (const g of plan.groups) db.query('INSERT INTO groups(id,name) VALUES(?,?)').run(g.id, g.name);
      for (const {machine: m, token} of importedMachines) db.query('INSERT INTO machines(id,name,host,enabled,token_hash,last_seen_at,version,config_revision) VALUES(?,?,?,?,?,NULL,NULL,1)').run(m.id, m.name, m.host, Number(m.enabled), new Bun.CryptoHasher('sha256').update(token).digest('hex'));
      for (const x of importedUsers) {
        const u = x.user;
        db.query("INSERT INTO users(id,email,name,role,enabled,password_hash,credential,subscription_token,upload_bytes,download_bytes,quota_bytes,expires_at,created_at) VALUES(?,?,?,'user',?,?,?,?,?,?,?,?,?)").run(u.id,u.email,u.name,Number(u.enabled),x.password_hash,x.credential,x.subscription_token,u.upload_bytes,u.download_bytes,u.quota_bytes,u.expires_at,u.created_at);
        for (const g of u.group_ids) db.query('INSERT INTO user_groups(user_id,group_id) VALUES(?,?)').run(u.id,g);
      }
      for (const n of plan.nodes) {
        db.query('INSERT INTO nodes(id,name,host,port,protocol,enabled,machine_id,tls,server_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(n.id,n.name,n.host,n.port,n.protocol,Number(n.enabled),n.machine_id,Number(n.tls),n.server_name,n.created_at);
        for (const g of n.group_ids) db.query('INSERT INTO node_groups(node_id,group_id) VALUES(?,?)').run(n.id,g);
      }
      writeFileSync(fd!, JSON.stringify(credentialDocument, null, 2) + '\n', {encoding: 'utf8'});
      fsyncSync(fd!); // No DB commit if the credential write fails.
    }).immediate();
    committed = true;
  } catch (error) {
    // Only unlink a file this process successfully created. Existing outputs stay untouched.
    if (!committed && fd !== undefined) { try { unlinkSync(opt.credentials!); } catch { console.error('Cleanup failed: remove this failed run\'s credential file only after confirming the database is empty.'); } }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    app?.close();
  }
  console.log(JSON.stringify({ mode: 'apply', committed: true, ...summary, credentials_written: true, credentials_mode: '0600', setup_required: true }, null, 2));
}
if (import.meta.main) main().catch(error => { console.error(`Migration failed: ${error instanceof Error ? error.message : 'unknown failure'}`); process.exitCode = 1; });
