#!/usr/bin/env bun
/** Dedicated staged import: preserve complete raw records, activate only accounts/groups. */
import { Database } from 'bun:sqlite';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openDatabase, hash, secret as backendSecret } from '../src/server/database';

type Row = Record<string, unknown>;
type CoreUser = { id: number; email: string; name: string; role: 'admin' | 'user'; enabled: number; password_hash: string; upload_bytes: number; download_bytes: number; quota_bytes: number; expires_at: string | null; created_at: string; group_ids: number[] };
type Archived = { kind: string; id: string; payload: string };
export type ImportPlan = { users: CoreUser[]; groups: {id: number; name: string}[]; records: Archived[]; summary: {users: number; nodes: number; machines: number; groups: number}; table_counts: Record<string, number>; enabled_admins: number };
const FORMAT = 'mboard-staged-import-v1';
const required = ['v2_user','v2_server_group','v2_server','v2_server_machine'];
const fail = (message: string): never => { throw new Error(message); };
const row = (v: unknown, at: string): Row => v && typeof v === 'object' && !Array.isArray(v) ? v as Row : fail(`${at}: expected a raw row object`);
const num = (v: unknown, at: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v)) v = Number(v);
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max ? v : fail(`${at}: expected a safe nonnegative integer`);
};
const flag = (v: unknown, at: string): number => v === true || v === 1 || v === '1' ? 1 : v === false || v === 0 || v === '0' ? 0 : fail(`${at}: expected boolean or 0/1`);
const text = (v: unknown, at: string, max: number): string => typeof v === 'string' && !!v.trim() && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : fail(`${at}: expected valid text`);
const seconds = (v: unknown, at: string): string => new Date(num(v, at, 0, 253402300799) * 1000).toISOString();
function unique<T>(values: T[], key: (v: T) => string | number, at: string) {
  if (new Set(values.map(key)).size !== values.length) fail(`${at}: duplicate IDs or values`);
}

export function validateArchive(input: unknown): ImportPlan {
  const root = row(input, 'archive');
  if (root.format !== FORMAT) fail(`archive: expected format ${FORMAT}`);
  const source = row(root.tables, 'archive.tables');
  for (const kind of required) if (!Object.hasOwn(source, kind)) fail(`${kind}: required array (use [] when empty)`);
  const tables: Record<string, Row[]> = Object.create(null);
  const records: Archived[] = [], table_counts: Record<string, number> = Object.create(null);
  for (const [kind, values] of Object.entries(source)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(kind)) fail('archive.tables: invalid table name');
    const rows: unknown[] = Array.isArray(values) ? values : fail(`${kind}: expected an array`);
    tables[kind] = rows.map((value, index) => row(value, `${kind}[${index}]`));
    table_counts[kind] = rows.length;
    // Tables without a single ID (settings, pivots, migrations, composite PKs)
    // use an ordinal archive key. The payload always retains the original row.
    const ids = tables[kind]!.map(r => r.id === undefined || r.id === null ? null : String(r.id));
    const counts = new Map<string, number>();
    for (const id of ids) if (id !== null) counts.set(id, (counts.get(id) ?? 0) + 1);
    tables[kind]!.forEach((r, index) => {
      const sourceId = ids[index];
      const id = sourceId !== null && sourceId !== undefined && counts.get(sourceId) === 1 && !sourceId.startsWith('@row:') ? sourceId : `@row:${index}`;
      records.push({ kind, id, payload: JSON.stringify(r) });
    });
  }
  // Require real IDs for the visible inventory, but never normalize protocols,
  // templates, Reality, parent/child relationships or machine bindings.
  for (const kind of ['v2_server','v2_server_machine']) {
    const ids = tables[kind]!.map((r, i) => num(r.id, `${kind}[${i}].id`, 1));
    unique(ids, id => id, kind);
  }
  const groups = tables.v2_server_group!.map((r, i) => ({ id: num(r.id, `v2_server_group[${i}].id`, 1), name: text(r.name, `v2_server_group[${i}].name`, 100) }));
  unique(groups, g => g.id, 'v2_server_group');
  unique(groups, g => g.name, 'v2_server_group');
  const groupIds = new Set(groups.map(g => g.id));
  const users = tables.v2_user!.map((r, i): CoreUser => {
    const at = `v2_user[${i}]`;
    const id = num(r.id, `${at}.id`, 1);
    const email = text(r.email, `${at}.email`, 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(`${at}.email: expected a valid email`);
    // Values never enter errors. Salted MD5/SHA etc. cannot preserve login through
    // Bun's verifier and must be handled explicitly before this fresh import.
    if (r.password_algo !== undefined && r.password_algo !== null && r.password_algo !== '' && r.password_algo !== 'bcrypt') fail(`${at}.password_algo: unsupported algorithm; original-password import requires bcrypt`);
    const password_hash = typeof r.password === 'string' && /^\$2[aby]\$(?:0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/.test(r.password)
      ? r.password : fail(`${at}.password: unsupported hash format or bcrypt cost; expected bcrypt 2a/2b/2y with cost 04..16`);
    const enabled = 1 - flag(r.banned, `${at}.banned`), access = flag(r.access_enabled, `${at}.access_enabled`);
    const role = flag(r.is_admin, `${at}.is_admin`) ? 'admin' : 'user';
    if (!Object.hasOwn(r, 'group_id')) fail(`${at}.group_id: required (null means no group)`);
    const gid = r.group_id === null ? null : num(r.group_id, `${at}.group_id`, 1);
    if (gid !== null && !groupIds.has(gid)) fail(`${at}.group_id: unknown group`);
    const upload_bytes = num(r.u ?? 0, `${at}.u`), download_bytes = num(r.d ?? 0, `${at}.d`);
    if (!Number.isSafeInteger(upload_bytes + download_bytes)) fail(`${at}: traffic total exceeds safe integer range`);
    if (!Object.hasOwn(r, 'transfer_enable') || !Object.hasOwn(r, 'expired_at')) fail(`${at}: transfer_enable and expired_at are required`);
    return { id, email, name: typeof r.name === 'string' && r.name.trim() ? text(r.name, `${at}.name`, 100) : email,
      role, enabled, password_hash, upload_bytes, download_bytes,
      // This Xboard source explicitly uses 0/null as unlimited; bytes stay bytes.
      quota_bytes: num(r.transfer_enable ?? 0, `${at}.transfer_enable`),
      // 0 is an expired Unix timestamp, NEVER an unlimited null expiry.
      expires_at: r.expired_at === null ? null : seconds(r.expired_at, `${at}.expired_at`),
      created_at: seconds(r.created_at, `${at}.created_at`), group_ids: access && gid !== null ? [gid] : [] };
  });
  unique(users, u => u.id, 'v2_user'); unique(users, u => u.email.toLowerCase(), 'v2_user.email');
  let total = 0;
  for (const u of users) { total += u.upload_bytes + u.download_bytes; if (!Number.isSafeInteger(total)) fail('v2_user: aggregate traffic exceeds safe integer range'); }
  return { users, groups, records, summary: {users:users.length, groups:groups.length, nodes:tables.v2_server!.length, machines:tables.v2_server_machine!.length}, table_counts, enabled_admins:users.filter(u => u.enabled && u.role === 'admin').length };
}

/** All core/archive/history rows must be empty. Only untouched default settings are allowed. */
export function assertFresh(db: Database) {
  const names = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as {name: string}[];
  for (const {name} of names) {
    if (name === 'settings') continue;
    const quoted = '"' + name.replaceAll('"','""') + '"';
    if ((db.query(`SELECT COUNT(*) count FROM ${quoted}`).get() as {count:number}).count > 0) fail('Destination is not fresh; use a new private database for staged import');
  }
  if (names.some(n => n.name === 'settings')) {
    const settings = db.query('SELECT key,value FROM settings ORDER BY key').all();
    const expected = [{key:'setup_complete',value:'0'},{key:'site_description',value:'欢迎使用您的连接面板'},{key:'site_name',value:'mboard'}];
    if (JSON.stringify(settings) !== JSON.stringify(expected)) fail('Destination is not fresh; setup or settings have already changed');
  }
}

export function applyArchive(db: Database, plan: ImportPlan, digest: string, importedAt = new Date().toISOString()) {
  return db.transaction(() => {
    assertFresh(db);
    for (const g of plan.groups) db.query('INSERT INTO groups(id,name) VALUES(?,?)').run(g.id,g.name);
    for (const u of plan.users) {
      db.query('INSERT INTO users(id,email,name,role,enabled,password_hash,credential,subscription_token,upload_bytes,download_bytes,quota_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
        u.id,u.email,u.name,u.role,u.enabled,u.password_hash,crypto.randomUUID(),backendSecret(),u.upload_bytes,u.download_bytes,u.quota_bytes,u.expires_at,u.created_at,
      );
      for (const gid of u.group_ids) db.query('INSERT INTO user_groups(user_id,group_id) VALUES(?,?)').run(u.id,gid);
    }
    const archive = db.query('INSERT INTO legacy_records(kind,id,payload,created_at) VALUES(?,?,?,?)');
    for (const r of plan.records) archive.run(r.kind,r.id,r.payload,importedAt);
    db.query('INSERT INTO import_runs(id,format,archive_sha256,summary,created_at) VALUES(?,?,?,?,?)').run(backendSecret(),FORMAT,digest,JSON.stringify({...plan.summary,table_counts:plan.table_counts}),importedAt);
    if (plan.enabled_admins) db.query("UPDATE settings SET value='1' WHERE key='setup_complete'").run();
    return { ...plan.summary, imported_at:importedAt, archived_records:plan.records.length, enabled_admins:plan.enabled_admins };
  }).immediate();
}

function privateDirectory(path: string) {
  const stat = statSync(path);
  if (!stat.isDirectory() || (stat.mode & 0o077) !== 0) fail('Use a private owner-only directory (mode 0700) for the archive and database');
}
function existingDestination(path: string) {
  let stat;
  try { stat = lstatSync(path); } catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('Destination must be a private regular file (mode 0600), not a symlink');
  const db = new Database(path,{readonly:true});
  try { assertFresh(db); } finally { db.close(); }
}
export async function main(args: string[]) {
  const opts: Record<string,string> = {}; let apply = false, dry = false;
  for (let i=0;i<args.length;i++) {
    const arg = args[i]!;
    if (arg === '--apply') { if (apply) fail('Repeated --apply'); apply=true; }
    else if (arg === '--dry-run') { if (dry) fail('Repeated --dry-run'); dry=true; }
    else if (arg === '--input' || arg === '--db') { if (opts[arg] || !args[i+1] || args[i+1]!.startsWith('--')) fail(`Provide one value for ${arg}`); opts[arg]=args[++i]!; }
    else fail('Use --input /private/archive.json --db /private/mboard.sqlite [--dry-run | --apply]');
  }
  if (!opts['--input'] || !opts['--db']) fail('Both --input and --db are required');
  if (apply && dry) fail('--apply conflicts with --dry-run');
  const input = resolve(opts['--input']), destination = resolve(opts['--db']);
  if (input === destination) fail('Input and destination must be different files');
  privateDirectory(dirname(realpathSync(input)));
  const fd = openSync(input,constants.O_RDONLY | constants.O_NOFOLLOW);
  let source: string;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) fail('Archive must be a private regular file (mode 0600)');
    source = readFileSync(fd,'utf8');
  } finally { closeSync(fd); }
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch { fail('Archive JSON is invalid; check the private export locally'); }
  const plan = validateArchive(parsed);
  existingDestination(destination);
  const report = {format:FORMAT,mode:apply ? 'apply' : 'dry-run',...plan.summary,archived_records:plan.records.length,table_counts:plan.table_counts,enabled_admins:plan.enabled_admins};
  if (!apply) { console.log(JSON.stringify(report)); return report; }
  mkdirSync(dirname(destination),{recursive:true,mode:0o700});
  privateDirectory(realpathSync(dirname(destination)));
  // The service must be stopped: account/group rows + complete archive are committed
  // together; no sessions, machines or live nodes are created.
  const db = openDatabase(destination);
  try {
    const result = applyArchive(db,plan,hash(source));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    chmodSync(destination,0o600);
    console.log(JSON.stringify({...report,...result}));
    return {...report,...result};
  } finally { db.close(); }
}
if (import.meta.main) {
  try { await main(Bun.argv.slice(2)); }
  catch (error) { console.error(error instanceof Error ? error.message : 'Staged import needs attention'); process.exitCode=1; }
}
