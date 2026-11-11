import type { Database } from 'bun:sqlite';
import { isIP } from 'node:net';
import { runtimeNodeViews } from './runtime';

// Connection log: a seven-day rolling record of authenticated connections that
// nodes report every minute. Rows are aggregated per hour, so the table stays
// small while still answering "who reached what, from where, and when".
// Timestamps are unix seconds; `hour` is the UTC hour bucket.
type Row = Record<string, any>;
const get = (db: Database, sql: string, ...args: any[]) => db.query(sql).get(...args) as Row | null;
const rows = (db: Database, sql: string, ...args: any[]) => db.query(sql).all(...args) as Row[];

export const CONNECTION_RETENTION_DAYS = 7;
export const CONNECTION_RETENTION_SECONDS = CONNECTION_RETENTION_DAYS * 86400;
export const MAX_CONNECTION_RECORDS = 2000;
const MAX_CONNECTION_ROWS = 2_000_000;
const MAX_COUNT = 1_000_000_000;
const MAX_TARGET_LENGTH = 270;
// Batch identifiers stay replayable a little longer than the visible window so a
// node retrying against a stale clock still cannot double count one batch.
const BATCH_RETENTION_SECONDS = CONNECTION_RETENTION_SECONDS + 86400;
const PURGE_INTERVAL_SECONDS = 3600;

export type ConnectionSource = 'runtime' | 'basic';
export type ConnectionNetwork = 'tcp' | 'udp';

export class ConnectionLogError extends Error {
  readonly status = 400;
  constructor(readonly code: string, message: string) { super(message); this.name = 'ConnectionLogError'; }
}
// The explicit type annotation lets TypeScript treat a call as control flow that
// never returns, so validators narrow their inputs in the same statement.
const invalid: (message: string) => never = (message) => { throw new ConnectionLogError('VALIDATION', message); };
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : invalid('请检查连接日志的字段');
const hourOf = (seconds: number) => Math.floor(seconds / 3600) * 3600;
const isSafe = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export type ConnectionRecord = {
  user_id: number; node_id: number; hour: number; target: string;
  source_ip: string; network: ConnectionNetwork; count: number; first_at: number; last_at: number;
};
export type ConnectionBatchInput = { batch_id: string; records: ConnectionRecord[] };
const RECORD_FIELDS = ['user_id', 'node_id', 'hour', 'target', 'source_ip', 'network', 'count', 'first_at', 'last_at'] as const;

/** A target is a host with a port: the domain the client asked for, or the literal address. */
function connectionTarget(value: unknown): string {
  if (typeof value !== 'string') invalid('请检查连接日志的目标地址');
  const text = value.trim().toLowerCase();
  if (text.length < 3 || text.length > MAX_TARGET_LENGTH || /[\x00-\x20\x7f]/.test(text)) invalid('请检查连接日志的目标地址');
  const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.\-_]+):(\d{1,5})$/.exec(text);
  if (!match) invalid('请把连接目标写成 域名:端口 或 IP:端口');
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) invalid('请检查连接目标的端口');
  return text;
}

/** Shape and type checks only. Window, ownership and budget become per-record skips. */
export function validateConnectionBatch(body: unknown): ConnectionBatchInput {
  const input = object(body);
  for (const key of Object.keys(input)) if (!['batch_id', 'records'].includes(key)) invalid(`请检查连接日志字段：${key.slice(0, 40)}`);
  const batchID = input.batch_id;
  if (typeof batchID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(batchID)) invalid('请提供有效的批次 ID');
  if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > MAX_CONNECTION_RECORDS) invalid(`请提供 1 到 ${MAX_CONNECTION_RECORDS} 条连接记录`);
  const records = (input.records as unknown[]).map(raw => {
    const record = object(raw);
    for (const key of Object.keys(record)) if (!(RECORD_FIELDS as readonly string[]).includes(key)) invalid(`请检查连接记录字段：${key.slice(0, 40)}`);
    const uid = record.user_id, nid = record.node_id, hour = record.hour, count = record.count;
    if (!isSafe(uid) || uid < 1 || uid > Number.MAX_SAFE_INTEGER) invalid('请检查连接记录的用户 ID');
    if (!isSafe(nid) || nid < 1 || nid > Number.MAX_SAFE_INTEGER) invalid('请检查连接记录的节点 ID');
    if (!isSafe(hour) || hour % 3600 !== 0) invalid('请把连接记录的小时起点写成整点秒数');
    if (!isSafe(count) || count < 1 || count > MAX_COUNT) invalid('请检查连接记录的次数');
    if (!['tcp', 'udp'].includes(record.network)) invalid('请把连接类型写成 tcp 或 udp');
    const source = record.source_ip === undefined ? '' : record.source_ip;
    if (typeof source !== 'string' || source.length > 45) invalid('请检查连接记录的来源 IP');
    if (source !== '') {
      const address = source.trim();
      if (isIP(address) === 0) invalid('请把来源 IP 写成有效的 IPv4 或 IPv6 地址');
      if (address !== source) invalid('请检查连接记录的来源 IP');
    }
    // Node clocks drift; clamp the span into its own hour instead of rejecting.
    const lo = hour, hi = hour + 3599;
    const first = isSafe(record.first_at) ? Math.min(Math.max(record.first_at, lo), hi) : lo;
    const last = isSafe(record.last_at) ? Math.min(Math.max(record.last_at, first), hi) : first;
    return { user_id: uid, node_id: nid, hour, target: connectionTarget(record.target), source_ip: source, network: record.network as ConnectionNetwork, count, first_at: first, last_at: last };
  });
  return { batch_id: batchID, records };
}

const initialized = new WeakSet<Database>();
/** Additive schema. Repeat-safe and independent of the numbered user_version migrations. */
export function initializeConnectionLog(db: Database) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS connection_log(
    source TEXT NOT NULL, user_id INTEGER NOT NULL, node_id INTEGER NOT NULL, hour INTEGER NOT NULL,
    target TEXT NOT NULL, source_ip TEXT NOT NULL, network TEXT NOT NULL,
    count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
    PRIMARY KEY(source,user_id,node_id,hour,target,source_ip,network)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS connection_log_recent ON connection_log(last_at);
CREATE INDEX IF NOT EXISTS connection_log_node ON connection_log(source,node_id,last_at);
CREATE INDEX IF NOT EXISTS connection_log_user ON connection_log(user_id,last_at);
CREATE TABLE IF NOT EXISTS connection_batches(
    source TEXT NOT NULL, machine_id INTEGER NOT NULL, batch_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(source,machine_id,batch_id));
CREATE TABLE IF NOT EXISTS connection_log_state(id INTEGER PRIMARY KEY CHECK(id=1), row_count INTEGER NOT NULL, purged_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS user_last_active(user_id INTEGER PRIMARY KEY, last_at INTEGER NOT NULL, node_source TEXT NOT NULL, node_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS node_last_active(source TEXT NOT NULL, node_id INTEGER NOT NULL, last_at INTEGER NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(source,node_id));`);
  initialized.add(db);
}
/** Called after a restored or migrated database replaces the file contents. */
export function resetConnectionLogCache(db: Database) { initialized.delete(db); }
/** A rolled-back transaction can drop tables created inside it, so retry once. */
function guarded<T>(db: Database, write: () => T): T {
  initializeConnectionLog(db);
  try { return write(); }
  catch (error) {
    if (!String(error).includes('no such table')) throw error;
    resetConnectionLogCache(db); initializeConnectionLog(db); return write();
  }
}

export type RecordConnectionsInput = {
  source: ConnectionSource; machine_id: number; batch_id: string; records: ConnectionRecord[];
  now: Date; allowed_nodes: Set<number>;
};
export type RecordConnectionsResult = { accepted: true; stored: number; skipped: number; reused: boolean };

/**
 * Must run inside the caller's transaction: the batch ledger, the aggregated
 * rows and both last-active ledgers commit together or not at all.
 */
export function recordConnections(db: Database, input: RecordConnectionsInput): RecordConnectionsResult {
  if (!input || !['runtime', 'basic'].includes(input.source)) invalid('请使用有效的节点来源');
  if (!isSafe(input.machine_id) || input.machine_id < 1) invalid('请提供有效的机器 ID');
  return guarded(db, () => recordConnectionsIn(db, input));
}
function recordConnectionsIn(db: Database, input: RecordConnectionsInput): RecordConnectionsResult {
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  const ledger = get(db, 'SELECT created_at FROM connection_batches WHERE source=? AND machine_id=? AND batch_id=?', input.source, input.machine_id, input.batch_id);
  // A replayed batch is already accounted for; acknowledging it again is safe.
  if (ledger) return { accepted: true, stored: 0, skipped: 0, reused: true };
  const currentHour = hourOf(nowSeconds);
  const oldestHour = currentHour - CONNECTION_RETENTION_SECONDS;
  const newestHour = currentHour + 3600;
  const state = get(db, 'SELECT row_count, purged_at FROM connection_log_state WHERE id=1');
  let storedRows = Number(state?.row_count) || 0;
  let stored = 0, skipped = 0;
  const seenUsers = new Map<number, boolean>();
  for (const record of input.records) {
    // Stale or skewed buckets leave the window instead of reaching the table.
    if (record.hour < oldestHour || record.hour > newestHour) { skipped++; continue; }
    let exists = seenUsers.get(record.user_id);
    if (exists === undefined) { exists = !!get(db, 'SELECT id FROM users WHERE id=?', record.user_id); seenUsers.set(record.user_id, exists); }
    if (!exists || !input.allowed_nodes.has(record.node_id)) { skipped++; continue; }
    const prior = get(db, 'SELECT count FROM connection_log WHERE source=? AND user_id=? AND node_id=? AND hour=? AND target=? AND source_ip=? AND network=?', input.source, record.user_id, record.node_id, record.hour, record.target, record.source_ip, record.network);
    if (prior) {
      db.query('UPDATE connection_log SET count=count+?, first_at=MIN(first_at,?), last_at=MAX(last_at,?) WHERE source=? AND user_id=? AND node_id=? AND hour=? AND target=? AND source_ip=? AND network=?')
        .run(record.count, record.first_at, record.last_at, input.source, record.user_id, record.node_id, record.hour, record.target, record.source_ip, record.network);
    } else {
      // The soft row cap only refuses new keys; known keys keep accumulating.
      if (storedRows >= MAX_CONNECTION_ROWS) { skipped++; continue; }
      db.query('INSERT INTO connection_log(source,user_id,node_id,hour,target,source_ip,network,count,first_at,last_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(input.source, record.user_id, record.node_id, record.hour, record.target, record.source_ip, record.network, record.count, record.first_at, record.last_at);
      storedRows++;
    }
    touchActive(db, { source: input.source, user_id: record.user_id, node_id: record.node_id, at: record.last_at });
    stored++;
  }
  db.query('INSERT INTO connection_batches(source,machine_id,batch_id,created_at) VALUES(?,?,?,?)').run(input.source, input.machine_id, input.batch_id, nowSeconds);
  if (state) db.query('UPDATE connection_log_state SET row_count=? WHERE id=1').run(storedRows);
  else db.query('INSERT INTO connection_log_state(id,row_count,purged_at) VALUES(1,?,0)').run(storedRows);
  maybePurge(db, nowSeconds);
  return { accepted: true, stored, skipped, reused: false };
}

/** Records the newest observed activity for one user and one node. */
export function touchActive(db: Database, input: { source: ConnectionSource; user_id: number; node_id: number; at: number }) {
  if (!isSafe(input.user_id) || input.user_id < 1 || !isSafe(input.node_id) || input.node_id < 1 || !isSafe(input.at)) return;
  guarded(db, () => touchActiveIn(db, input));
}
function touchActiveIn(db: Database, input: { source: ConnectionSource; user_id: number; node_id: number; at: number }) {
  const user = get(db, 'SELECT last_at FROM user_last_active WHERE user_id=?', input.user_id);
  if (!user || Number(user.last_at) <= input.at) db.query('INSERT INTO user_last_active(user_id,last_at,node_source,node_id) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET last_at=excluded.last_at,node_source=excluded.node_source,node_id=excluded.node_id').run(input.user_id, input.at, input.source, input.node_id);
  const node = get(db, 'SELECT last_at FROM node_last_active WHERE source=? AND node_id=?', input.source, input.node_id);
  if (!node || Number(node.last_at) <= input.at) db.query('INSERT INTO node_last_active(source,node_id,last_at,user_id) VALUES(?,?,?,?) ON CONFLICT(source,node_id) DO UPDATE SET last_at=excluded.last_at,user_id=excluded.user_id').run(input.source, input.node_id, input.at, input.user_id);
}

/** Hourly at most: drops out-of-window rows and recounts the live row budget. */
function maybePurge(db: Database, nowSeconds: number) {
  const state = get(db, 'SELECT purged_at FROM connection_log_state WHERE id=1');
  const last = Number(state?.purged_at) || 0;
  if (last && nowSeconds - last < PURGE_INTERVAL_SECONDS) return;
  db.query('DELETE FROM connection_log WHERE hour < ?').run(hourOf(nowSeconds) - CONNECTION_RETENTION_SECONDS);
  db.query('DELETE FROM connection_batches WHERE created_at < ?').run(nowSeconds - BATCH_RETENTION_SECONDS);
  const live = Number(get(db, 'SELECT COUNT(*) count FROM connection_log')?.count) || 0;
  db.query('INSERT INTO connection_log_state(id,row_count,purged_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET row_count=excluded.row_count,purged_at=excluded.purged_at').run(live, nowSeconds);
}

/** Removes one account's rows. Nodes keep their own activity timestamp. */
export function purgeUserConnections(db: Database, userID: number) {
  initializeConnectionLog(db);
  if (!isSafe(userID) || userID < 1) return;
  db.query('DELETE FROM connection_log WHERE user_id=?').run(userID);
  db.query('DELETE FROM user_last_active WHERE user_id=?').run(userID);
  db.query('UPDATE node_last_active SET user_id=0 WHERE user_id=?').run(userID);
}

export type LastActive = { at: number; source: ConnectionSource; node_id: number; user_id: number };
const lastActiveMap = (db: Database, table: string, key: (row: Row) => string) => {
  const map = new Map<string, LastActive>();
  for (const row of rows(db, `SELECT * FROM ${table}`)) map.set(key(row), { at: Number(row.last_at) || 0, source: String(row.node_source ?? row.source) as ConnectionSource, node_id: Number(row.node_id) || 0, user_id: Number(row.user_id) || 0 });
  return map;
};
export function lastActiveForUsers(db: Database) {
  initializeConnectionLog(db);
  return lastActiveMap(db, 'user_last_active', row => String(row.user_id));
}
export function lastActiveForNodes(db: Database) {
  initializeConnectionLog(db);
  return lastActiveMap(db, 'node_last_active', row => `${row.source}:${row.node_id}`);
}

export type ConnectionFilter = { user_id?: number; node_id?: number; node_source?: ConnectionSource; query?: string; hours?: number; limit?: number; offset?: number };
export type ConnectionRow = {
  source: ConnectionSource; first_at: string; last_at: string; count: number;
  target: string; source_ip: string; network: ConnectionNetwork;
  // The raw IDs stay present so a row still renders after an account is deleted.
  user_id: number; node_id: number;
  user: { id: number; name: string; email: string } | null;
  node: { id: number; name: string; source: ConnectionSource } | null;
};
export type ConnectionPage = {
  rows: ConnectionRow[]; total: number; connections: number; targets: number; sources: number;
  hours: number; retention_days: number;
};
const HOURS = [1, 24, 168] as const;

/** Read-only listing. Names come from the live tables, so a deleted account reads as absent. */
export function listConnections(db: Database, filter: ConnectionFilter, now: Date): ConnectionPage {
  initializeConnectionLog(db);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const hours = HOURS.includes(filter.hours as typeof HOURS[number]) ? filter.hours as number : 24;
  const limit = Number.isSafeInteger(filter.limit) && filter.limit! >= 1 && filter.limit! <= 200 ? filter.limit! : 100;
  const offset = Number.isSafeInteger(filter.offset) && filter.offset! >= 0 && filter.offset! <= 10000 ? filter.offset! : 0;
  const where: string[] = ['last_at>=?', 'hour>=?'], args: any[] = [nowSeconds - hours * 3600, hourOf(nowSeconds) - CONNECTION_RETENTION_SECONDS];
  if (filter.user_id !== undefined) { where.push('user_id=?'); args.push(filter.user_id); }
  if (filter.node_id !== undefined) { where.push('node_id=?', 'source=?'); args.push(filter.node_id, filter.node_source ?? 'runtime'); }
  const query = typeof filter.query === 'string' ? filter.query.trim().slice(0, 100) : '';
  if (query) {
    // Escape LIKE wildcards so a typed % or _ stays a literal character.
    const escaped = query.replace(/[\\%_]/g, character => `\\${character}`);
    where.push("(target LIKE ? ESCAPE '\\' OR source_ip LIKE ? ESCAPE '\\')");
    args.push(`%${escaped}%`, `%${escaped}%`);
  }
  const clause = where.join(' AND ');
  const summary = get(db, `SELECT COUNT(*) total,COALESCE(SUM(count),0) connections,COUNT(DISTINCT target) targets,COUNT(DISTINCT CASE WHEN source_ip<>'' THEN source_ip END) sources FROM connection_log WHERE ${clause}`, ...args);
  const total = Number(summary?.total) || 0;
  const raw = total ? rows(db, `SELECT * FROM connection_log WHERE ${clause} ORDER BY last_at DESC,user_id,node_id,target,source_ip LIMIT ? OFFSET ?`, ...args, limit, offset) : [];
  const userIds = [...new Set(raw.map(row => Number(row.user_id)))];
  const users = new Map<number, Row>();
  if (userIds.length) for (const row of rows(db, `SELECT id,name,email FROM users WHERE id IN (${userIds.map(() => '?').join(',')})`, ...userIds)) users.set(Number(row.id), row);
  const nodeNames = new Map<string, string>(), legacyNames = new Map<number, string>();
  if (raw.some(row => row.source === 'runtime')) for (const node of runtimeNodeViews(db)) nodeNames.set(`runtime:${node.id}`, String(node.name ?? ''));
  if (raw.some(row => row.source === 'basic')) for (const row of rows(db, 'SELECT id,name FROM nodes')) legacyNames.set(Number(row.id), String(row.name ?? ''));
  const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
  return {
    hours, retention_days: CONNECTION_RETENTION_DAYS, total,
    connections: Number(summary?.connections) || 0,
    targets: Number(summary?.targets) || 0,
    sources: Number(summary?.sources) || 0,
    rows: raw.map(row => {
      const source = String(row.source) as ConnectionSource, nodeID = Number(row.node_id), user = users.get(Number(row.user_id));
      const name = source === 'runtime' ? nodeNames.get(`runtime:${nodeID}`) : legacyNames.get(nodeID);
      return {
        source, first_at: iso(Number(row.first_at)), last_at: iso(Number(row.last_at)), count: Number(row.count),
        target: String(row.target), source_ip: String(row.source_ip), network: String(row.network) as ConnectionNetwork,
        user_id: Number(row.user_id), node_id: nodeID,
        user: user ? { id: Number(user.id), name: String(user.name ?? ''), email: String(user.email ?? '') } : null,
        node: name === undefined ? null : { id: nodeID, name, source },
      };
    }),
  };
}
