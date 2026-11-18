import type { Database } from 'bun:sqlite';
import { ConnectionLogError, type ConnectionSource } from './connection-log';

// Domain traffic: bytes per (user, node, hour, registrable domain) reported by
// nodes that poll the core's Clash API. Rows keep 35 days so a monthly report
// can still read the whole previous month. Timestamps are unix seconds.
type Row = Record<string, any>;
const get = (db: Database, sql: string, ...args: any[]) => db.query(sql).get(...args) as Row | null;
const rows = (db: Database, sql: string, ...args: any[]) => db.query(sql).all(...args) as Row[];

export const DOMAIN_RETENTION_DAYS = 35;
export const DOMAIN_RETENTION_SECONDS = DOMAIN_RETENTION_DAYS * 86400;
export const MAX_DOMAIN_RECORDS = 2000;
const MAX_DOMAIN_ROWS = 2_000_000;
const MAX_DOMAIN_LENGTH = 253;
const BATCH_RETENTION_SECONDS = DOMAIN_RETENTION_SECONDS + 86400;
const PURGE_INTERVAL_SECONDS = 3600;

const invalid: (message: string) => never = (message) => { throw new ConnectionLogError('VALIDATION', message); };
const object = (value: unknown): Row => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : invalid('请检查域名流量的字段');
const hourOf = (seconds: number) => Math.floor(seconds / 3600) * 3600;
const isSafe = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export type DomainTrafficRecord = { user_id: number; node_id: number; hour: number; domain: string; upload_bytes: number; download_bytes: number };
export type DomainTrafficBatchInput = { batch_id: string; records: DomainTrafficRecord[] };
const RECORD_FIELDS = ['user_id', 'node_id', 'hour', 'domain', 'upload_bytes', 'download_bytes'] as const;

/** Shape and type checks only. Window, ownership and budget become per-record skips. */
export function validateDomainTrafficBatch(body: unknown): DomainTrafficBatchInput {
  const input = object(body);
  for (const key of Object.keys(input)) if (!['batch_id', 'records'].includes(key)) invalid(`请检查域名流量字段：${key.slice(0, 40)}`);
  const batchID = input.batch_id;
  if (typeof batchID !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(batchID)) invalid('请提供有效的批次 ID');
  if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > MAX_DOMAIN_RECORDS) invalid(`请提供 1 到 ${MAX_DOMAIN_RECORDS} 条域名流量记录`);
  const records = (input.records as unknown[]).map(raw => {
    const record = object(raw);
    for (const key of Object.keys(record)) if (!(RECORD_FIELDS as readonly string[]).includes(key)) invalid(`请检查域名流量记录字段：${key.slice(0, 40)}`);
    const uid = record.user_id, nid = record.node_id, hour = record.hour, up = record.upload_bytes, down = record.download_bytes;
    if (!isSafe(uid) || uid < 1) invalid('请检查域名流量的用户 ID');
    if (!isSafe(nid) || nid < 1) invalid('请检查域名流量的节点 ID');
    if (!isSafe(hour) || hour % 3600 !== 0) invalid('请把域名流量的小时起点写成整点秒数');
    if (!isSafe(up) || !isSafe(down) || !Number.isSafeInteger(up + down) || up + down < 1) invalid('请检查域名流量的字节数');
    if (typeof record.domain !== 'string') invalid('请检查域名流量的域名');
    const domain = record.domain.trim().toLowerCase();
    if (domain.length < 1 || domain.length > MAX_DOMAIN_LENGTH || /[\x00-\x20\x7f]/.test(domain)) invalid('请检查域名流量的域名');
    return { user_id: uid, node_id: nid, hour, domain, upload_bytes: up, download_bytes: down };
  });
  return { batch_id: batchID, records };
}

const initialized = new WeakSet<Database>();
export function initializeDomainTraffic(db: Database) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS domain_traffic(
    source TEXT NOT NULL, user_id INTEGER NOT NULL, node_id INTEGER NOT NULL, hour INTEGER NOT NULL, domain TEXT NOT NULL,
    upload_bytes INTEGER NOT NULL, download_bytes INTEGER NOT NULL,
    PRIMARY KEY(source,user_id,node_id,hour,domain)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS domain_traffic_hour ON domain_traffic(hour);
CREATE INDEX IF NOT EXISTS domain_traffic_user ON domain_traffic(user_id,hour);
CREATE TABLE IF NOT EXISTS domain_traffic_batches(
    source TEXT NOT NULL, machine_id INTEGER NOT NULL, batch_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    PRIMARY KEY(source,machine_id,batch_id));
CREATE TABLE IF NOT EXISTS domain_traffic_state(id INTEGER PRIMARY KEY CHECK(id=1), row_count INTEGER NOT NULL, purged_at INTEGER NOT NULL);`);
  initialized.add(db);
}
export function resetDomainTrafficCache(db: Database) { initialized.delete(db); }
function guarded<T>(db: Database, write: () => T): T {
  initializeDomainTraffic(db);
  try { return write(); }
  catch (error) {
    if (!String(error).includes('no such table')) throw error;
    resetDomainTrafficCache(db); initializeDomainTraffic(db); return write();
  }
}

export type RecordDomainTrafficInput = {
  source: ConnectionSource; machine_id: number; batch_id: string; records: DomainTrafficRecord[];
  now: Date; allowed_nodes: Set<number>;
};
export type RecordDomainTrafficResult = { accepted: true; stored: number; skipped: number; reused: boolean };

/** Must run inside the caller's transaction so the ledger and the rows commit together. */
export function recordDomainTraffic(db: Database, input: RecordDomainTrafficInput): RecordDomainTrafficResult {
  if (!input || !['runtime', 'basic'].includes(input.source)) invalid('请使用有效的节点来源');
  if (!isSafe(input.machine_id) || input.machine_id < 1) invalid('请提供有效的机器 ID');
  return guarded(db, () => recordIn(db, input));
}
function recordIn(db: Database, input: RecordDomainTrafficInput): RecordDomainTrafficResult {
  const nowSeconds = Math.floor(input.now.getTime() / 1000);
  if (get(db, 'SELECT created_at FROM domain_traffic_batches WHERE source=? AND machine_id=? AND batch_id=?', input.source, input.machine_id, input.batch_id)) return { accepted: true, stored: 0, skipped: 0, reused: true };
  const oldestHour = hourOf(nowSeconds) - DOMAIN_RETENTION_SECONDS, newestHour = hourOf(nowSeconds) + 3600;
  const state = get(db, 'SELECT row_count FROM domain_traffic_state WHERE id=1');
  let storedRows = Number(state?.row_count) || 0, stored = 0, skipped = 0;
  const seenUsers = new Map<number, boolean>();
  for (const record of input.records) {
    if (record.hour < oldestHour || record.hour > newestHour) { skipped++; continue; }
    let exists = seenUsers.get(record.user_id);
    if (exists === undefined) { exists = !!get(db, 'SELECT id FROM users WHERE id=?', record.user_id); seenUsers.set(record.user_id, exists); }
    if (!exists || !input.allowed_nodes.has(record.node_id)) { skipped++; continue; }
    const prior = get(db, 'SELECT upload_bytes,download_bytes FROM domain_traffic WHERE source=? AND user_id=? AND node_id=? AND hour=? AND domain=?', input.source, record.user_id, record.node_id, record.hour, record.domain);
    if (prior) {
      const up = Number(prior.upload_bytes) + record.upload_bytes, down = Number(prior.download_bytes) + record.download_bytes;
      if (!Number.isSafeInteger(up) || !Number.isSafeInteger(down) || !Number.isSafeInteger(up + down)) { skipped++; continue; }
      db.query('UPDATE domain_traffic SET upload_bytes=?,download_bytes=? WHERE source=? AND user_id=? AND node_id=? AND hour=? AND domain=?').run(up, down, input.source, record.user_id, record.node_id, record.hour, record.domain);
    } else {
      if (storedRows >= MAX_DOMAIN_ROWS) { skipped++; continue; }
      db.query('INSERT INTO domain_traffic(source,user_id,node_id,hour,domain,upload_bytes,download_bytes) VALUES(?,?,?,?,?,?,?)').run(input.source, record.user_id, record.node_id, record.hour, record.domain, record.upload_bytes, record.download_bytes);
      storedRows++;
    }
    stored++;
  }
  db.query('INSERT INTO domain_traffic_batches(source,machine_id,batch_id,created_at) VALUES(?,?,?,?)').run(input.source, input.machine_id, input.batch_id, nowSeconds);
  if (state) db.query('UPDATE domain_traffic_state SET row_count=? WHERE id=1').run(storedRows);
  else db.query('INSERT INTO domain_traffic_state(id,row_count,purged_at) VALUES(1,?,0)').run(storedRows);
  maybePurge(db, nowSeconds);
  return { accepted: true, stored, skipped, reused: false };
}

function maybePurge(db: Database, nowSeconds: number) {
  const last = Number(get(db, 'SELECT purged_at FROM domain_traffic_state WHERE id=1')?.purged_at) || 0;
  if (last && nowSeconds - last < PURGE_INTERVAL_SECONDS) return;
  db.query('DELETE FROM domain_traffic WHERE hour < ?').run(hourOf(nowSeconds) - DOMAIN_RETENTION_SECONDS);
  db.query('DELETE FROM domain_traffic_batches WHERE created_at < ?').run(nowSeconds - BATCH_RETENTION_SECONDS);
  const live = Number(get(db, 'SELECT COUNT(*) count FROM domain_traffic')?.count) || 0;
  db.query('INSERT INTO domain_traffic_state(id,row_count,purged_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET row_count=excluded.row_count,purged_at=excluded.purged_at').run(live, nowSeconds);
}

export function purgeUserDomainTraffic(db: Database, userID: number) {
  initializeDomainTraffic(db);
  if (!isSafe(userID) || userID < 1) return;
  db.query('DELETE FROM domain_traffic WHERE user_id=?').run(userID);
}

export type DomainTrafficFilter = { user_id?: number; node_id?: number; node_source?: ConnectionSource; query?: string; hours?: number; limit?: number };
export type DomainTrafficRow = { domain: string; upload_bytes: number; download_bytes: number; total_bytes: number; users: number };
export type DomainTrafficPage = { rows: DomainTrafficRow[]; total_bytes: number; domains: number; hours: number };
const HOURS = [1, 24, 168] as const;

/** Hour buckets are the unit, so a window includes every bucket that overlaps it. */
export function listDomainTraffic(db: Database, filter: DomainTrafficFilter, now: Date): DomainTrafficPage {
  initializeDomainTraffic(db);
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const hours = HOURS.includes(filter.hours as typeof HOURS[number]) ? filter.hours as number : 24;
  const limit = Number.isSafeInteger(filter.limit) && filter.limit! >= 1 && filter.limit! <= 200 ? filter.limit! : 50;
  const where: string[] = ['hour>=?'], args: any[] = [hourOf(nowSeconds - hours * 3600)];
  if (filter.user_id !== undefined) { where.push('user_id=?'); args.push(filter.user_id); }
  if (filter.node_id !== undefined) { where.push('node_id=?', 'source=?'); args.push(filter.node_id, filter.node_source ?? 'runtime'); }
  const query = typeof filter.query === 'string' ? filter.query.trim().slice(0, 100).toLowerCase() : '';
  if (query) { where.push("domain LIKE ? ESCAPE '\\'"); args.push(`%${query.replace(/[\\%_]/g, c => `\\${c}`)}%`); }
  const clause = where.join(' AND ');
  const summary = get(db, `SELECT COUNT(DISTINCT domain) domains,COALESCE(SUM(upload_bytes+download_bytes),0) total FROM domain_traffic WHERE ${clause}`, ...args);
  const list = rows(db, `SELECT domain,SUM(upload_bytes) up,SUM(download_bytes) down,COUNT(DISTINCT user_id) users FROM domain_traffic WHERE ${clause} GROUP BY domain ORDER BY SUM(upload_bytes+download_bytes) DESC,domain LIMIT ?`, ...args, limit);
  return {
    hours, domains: Number(summary?.domains) || 0, total_bytes: Number(summary?.total) || 0,
    rows: list.map(row => ({ domain: String(row.domain), upload_bytes: Number(row.up), download_bytes: Number(row.down), total_bytes: Number(row.up) + Number(row.down), users: Number(row.users) })),
  };
}

/** Busiest domain per user over an inclusive unix-second window; ties break by name. */
export function topDomainByUser(db: Database, userIds: number[], start: number, end: number): Map<number, { domain: string; bytes: bigint }> {
  const result = new Map<number, { domain: string; bytes: bigint }>();
  if (!userIds.length) return result;
  const exists = get(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='domain_traffic'");
  if (!exists) return result;
  const marks = userIds.map(() => '?').join(',');
  for (const row of rows(db, `SELECT user_id,domain,CAST(SUM(upload_bytes) AS TEXT) up,CAST(SUM(download_bytes) AS TEXT) down FROM domain_traffic WHERE hour BETWEEN ? AND ? AND user_id IN (${marks}) GROUP BY user_id,domain`, start, end, ...userIds)) {
    const bytes = BigInt(row.up) + BigInt(row.down), uid = Number(row.user_id), domain = String(row.domain);
    const best = result.get(uid);
    if (bytes > 0n && (!best || bytes > best.bytes || (bytes === best.bytes && domain < best.domain))) result.set(uid, { domain, bytes });
  }
  return result;
}
