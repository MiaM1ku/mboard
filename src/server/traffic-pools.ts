import type { Database } from 'bun:sqlite';
import { runtimeMachineViews, runtimeNodeViews } from './runtime';

type Row = Record<string, any>;
const DAY = 86400000, OFFSET = 8 * 3600000;
export const POOL_TIMEZONE = 'Asia/Shanghai';
export const POOL_KINDS = ['entry', 'exit', 'node'] as const;
export type PoolKind = typeof POOL_KINDS[number];
export const POOL_BILLINGS = ['single', 'double'] as const;
export type PoolBilling = typeof POOL_BILLINGS[number];
export type PoolMember = { type: 'node' | 'machine'; id: number; name: string };
export type PoolWarning = { code: 'partial-history' | 'unattributed-machine-traffic'; message: string };

export class PoolError extends Error {
  readonly status = 400;
  constructor(readonly code: string, message: string) { super(message); this.name = 'PoolError'; }
}
const bad = (message: string): never => { throw new PoolError('VALIDATION', message); };
const rows = (db: Database, sql: string, ...args: any[]) => db.query(sql).all(...args) as Row[];
const get = (db: Database, sql: string, ...args: any[]) => db.query(sql).get(...args) as Row | null;
const localDate = (ms: number) => new Date(ms + OFFSET).toISOString().slice(0, 10);

/** Local midnight of the reset day, clamped to the end of short months. */
function resetInstant(year: number, month: number, resetDay: number): number {
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return Date.UTC(year, month, Math.min(resetDay, lastDay)) - OFFSET;
}
export function poolCycle(now: Date, resetDay: number) {
  const local = new Date(now.getTime() + OFFSET);
  let year = local.getUTCFullYear(), month = local.getUTCMonth();
  let start = resetInstant(year, month, resetDay);
  if (now.getTime() < start) {
    month -= 1;
    const back = new Date(Date.UTC(year, month, 1));
    year = back.getUTCFullYear(); month = back.getUTCMonth();
    start = resetInstant(year, month, resetDay);
  }
  const next = new Date(Date.UTC(year, month + 1, 1));
  const end = resetInstant(next.getUTCFullYear(), next.getUTCMonth(), resetDay);
  return { start, end, start_date: localDate(start), end_date: localDate(end) };
}

const hourlyReady = new WeakSet<Database>();
/** Archive-only apps skip the full initializer, so the ingest path creates its own ledger table. */
function ensureHourlyTable(db: Database) {
  if (hourlyReady.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS runtime_traffic_hourly(
    machine_id INTEGER NOT NULL, node_id INTEGER NOT NULL, hour INTEGER NOT NULL,
    upload_bytes INTEGER NOT NULL DEFAULT 0, download_bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(machine_id,node_id,hour));
CREATE INDEX IF NOT EXISTS runtime_traffic_hourly_time ON runtime_traffic_hourly(hour);`);
  hourlyReady.add(db);
}
/** Additive schema: no user_version bump, no change to archived rows. */
export function initializeTrafficPools(db: Database) {
  ensureHourlyTable(db);
  db.exec(`CREATE TABLE IF NOT EXISTS traffic_pools(
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK(kind IN ('entry','exit','node')),
    quota_bytes INTEGER NOT NULL CHECK(quota_bytes > 0),
    reset_day INTEGER NOT NULL CHECK(reset_day BETWEEN 1 AND 31),
    billing TEXT NOT NULL DEFAULT 'single' CHECK(billing IN ('single','double')),
    visible_to_users INTEGER NOT NULL DEFAULT 1 CHECK(visible_to_users IN (0,1)),
    calibration_bytes INTEGER, calibrated_at INTEGER,
    note TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS traffic_pool_members(
    pool_id INTEGER NOT NULL REFERENCES traffic_pools(id) ON DELETE CASCADE,
    member_type TEXT NOT NULL CHECK(member_type IN ('node','machine')),
    member_id INTEGER NOT NULL, PRIMARY KEY(pool_id,member_type,member_id));`);
  backfillHourly(db);
}

/** One-time copy of the reported hourly ledger, attributed to a machine where the binding is unambiguous. */
function backfillHourly(db: Database) {
  if (get(db, "SELECT 1 FROM runtime_metadata WHERE key='traffic-pools:backfill:v1'")) return;
  db.transaction(() => {
    if (get(db, "SELECT 1 FROM runtime_metadata WHERE key='traffic-pools:backfill:v1'")) return;
    if (get(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='traffic_report_hourly'")) {
      const parent = new Map(rows(db, 'SELECT id,parent_id FROM runtime_nodes').map(n => [Number(n.id), Number(n.parent_id) || 0]));
      const rootOf = (id: number) => {
        const seen = new Set<number>(); let current = id;
        while (parent.get(current)) { if (seen.has(current)) return current; seen.add(current); current = parent.get(current)!; }
        return current;
      };
      const machinesFor = new Map<number, Set<number>>();
      for (const binding of rows(db, 'SELECT node_id,machine_id FROM runtime_bindings')) {
        const node = Number(binding.node_id), machine = Number(binding.machine_id);
        for (const key of [node, rootOf(node)]) {
          const set = machinesFor.get(key) ?? new Set<number>();
          set.add(machine); machinesFor.set(key, set);
        }
      }
      const machineOf = (id: number) => {
        const set = new Set([...(machinesFor.get(rootOf(id)) ?? []), ...(machinesFor.get(id) ?? [])]);
        return set.size === 1 ? [...set][0]! : 0;
      };
      for (const row of rows(db, "SELECT node_id,hour,SUM(CAST(upload_bytes AS INTEGER)) up,SUM(CAST(download_bytes AS INTEGER)) down FROM traffic_report_hourly WHERE source='runtime' GROUP BY node_id,hour")) {
        const node = Number(row.node_id), hour = Number(row.hour);
        if (!Number.isSafeInteger(node) || !Number.isSafeInteger(hour) || node <= 0) continue;
        db.query('INSERT INTO runtime_traffic_hourly(machine_id,node_id,hour,upload_bytes,download_bytes) VALUES(?,?,?,?,?) ON CONFLICT(machine_id,node_id,hour) DO UPDATE SET upload_bytes=upload_bytes+excluded.upload_bytes,download_bytes=download_bytes+excluded.download_bytes')
          .run(machineOf(node), node, hour, Number(row.up) || 0, Number(row.down) || 0);
      }
    }
    db.query("INSERT INTO runtime_metadata VALUES('traffic-pools:backfill:v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
  }).immediate();
}

/** Called inside the node traffic transaction, so the hourly ledger shares batch idempotency. */
export function recordHourlyTraffic(db: Database, machineID: number, nodeID: number, upload: number, download: number, acceptedAt: Date) {
  if (![machineID, nodeID].every(value => Number.isSafeInteger(value) && value >= 0)) return;
  if (![upload, download].every(value => Number.isSafeInteger(value) && value >= 0)) return;
  if (!upload && !download) return;
  const hour = Math.floor(acceptedAt.getTime() / 3600000) * 3600;
  const write = () => db.query('INSERT INTO runtime_traffic_hourly(machine_id,node_id,hour,upload_bytes,download_bytes) VALUES(?,?,?,?,?) ON CONFLICT(machine_id,node_id,hour) DO UPDATE SET upload_bytes=upload_bytes+excluded.upload_bytes,download_bytes=download_bytes+excluded.download_bytes').run(machineID, nodeID, hour, upload, download);
  ensureHourlyTable(db);
  try { write(); }
  catch (error) {
    // A rolled-back request can drop a table that was created inside the same transaction.
    if (!String(error).includes('no such table')) throw error;
    hourlyReady.delete(db); ensureHourlyTable(db); write();
  }
}

function poolMembers(db: Database, poolID: number): PoolMember[] {
  const nodes = new Map(runtimeNodeViews(db).map(node => [node.id, node.name]));
  const machines = new Map(runtimeMachineViews(db).map(machine => [machine.id, machine.name]));
  return rows(db, 'SELECT member_type,member_id FROM traffic_pool_members WHERE pool_id=? ORDER BY member_type,member_id', poolID)
    .map(row => ({ type: String(row.member_type) as 'node' | 'machine', id: Number(row.member_id), name: (row.member_type === 'node' ? nodes.get(Number(row.member_id)) : machines.get(Number(row.member_id))) ?? `#${row.member_id}` }));
}

export type PoolUsage = {
  used_bytes: number; quota_bytes: number; remaining_bytes: number; percent: number;
  upload_bytes: number; download_bytes: number;
  cycle_start: string; cycle_end: string; days_left: number;
  projected_bytes: number | null; calibrated: boolean;
  status: 'ok' | 'warning' | 'exceeded'; warnings: PoolWarning[];
};

export function poolUsage(db: Database, pool: Row, now: Date): PoolUsage {
  const members = rows(db, 'SELECT member_type,member_id FROM traffic_pool_members WHERE pool_id=?', pool.id);
  const nodeIDs = members.filter(m => m.member_type === 'node').map(m => Number(m.member_id));
  const machineIDs = members.filter(m => m.member_type === 'machine').map(m => Number(m.member_id));
  const cycle = poolCycle(now, Number(pool.reset_day));
  // The hourly ledger stores unix seconds; cycle bounds are milliseconds.
  const startSecond = Math.floor(cycle.start / 1000), endSecond = Math.floor(cycle.end / 1000);
  const quota = Number(pool.quota_bytes);
  const factor = pool.billing === 'double' ? 2 : 1;
  const clauses: string[] = [], args: any[] = [];
  if (nodeIDs.length) { clauses.push(`node_id IN (${nodeIDs.map(() => '?').join(',')})`); args.push(...nodeIDs); }
  if (machineIDs.length) { clauses.push(`machine_id IN (${machineIDs.map(() => '?').join(',')})`); args.push(...machineIDs); }
  let upload = 0, download = 0, afterCalibration = 0;
  if (clauses.length) {
    const filter = `hour>=? AND hour<? AND (${clauses.join(' OR ')})`;
    const total = get(db, `SELECT COALESCE(SUM(upload_bytes),0) up,COALESCE(SUM(download_bytes),0) down FROM runtime_traffic_hourly WHERE ${filter}`, startSecond, endSecond, ...args);
    upload = Number(total?.up) || 0; download = Number(total?.down) || 0;
    const calibration = pool.calibration_bytes, calibratedAt = pool.calibrated_at;
    if (calibration != null && calibratedAt != null && Number(calibratedAt) >= cycle.start && Number(calibratedAt) < cycle.end) {
      const hour = Math.floor(Number(calibratedAt) / 3600000) * 3600;
      const rest = get(db, `SELECT COALESCE(SUM(upload_bytes),0) up,COALESCE(SUM(download_bytes),0) down FROM runtime_traffic_hourly WHERE ${filter} AND hour>?`, startSecond, endSecond, ...args, hour);
      afterCalibration = (Number(rest?.up) || 0) + (Number(rest?.down) || 0);
    }
  }
  const measured = upload + download;
  const calibratedNow = pool.calibration_bytes != null && pool.calibrated_at != null && Number(pool.calibrated_at) >= cycle.start && Number(pool.calibrated_at) < cycle.end;
  const used = calibratedNow ? Number(pool.calibration_bytes) + factor * afterCalibration : factor * measured;
  const remaining = Math.max(0, quota - used);
  const percent = quota > 0 ? Math.round((used / quota) * 10000) / 100 : 0;
  const elapsed = Math.max(0, now.getTime() - cycle.start), length = cycle.end - cycle.start;
  const projected = elapsed >= DAY && length > 0 ? Math.round(used / Math.min(1, elapsed / length)) : null;
  const warnings: PoolWarning[] = [];
  const earliest = get(db, 'SELECT MIN(hour) hour FROM runtime_traffic_hourly');
  if (!calibratedNow && earliest?.hour != null && Number(earliest.hour) > startSecond) {
    warnings.push({ code: 'partial-history', message: `周期从 ${cycle.start_date} 开始，小时记录从 ${localDate(Number(earliest.hour) * 1000)} 才有，可填写校准值补齐。` });
  }
  if (machineIDs.length && nodeIDs.length === 0) {
    const bound = rows(db, `SELECT node_id FROM runtime_bindings WHERE machine_id IN (${machineIDs.map(() => '?').join(',')})`, ...machineIDs).map(r => Number(r.node_id));
    if (bound.length) {
      const lost = get(db, `SELECT COALESCE(SUM(upload_bytes+download_bytes),0) total FROM runtime_traffic_hourly WHERE hour>=? AND hour<? AND machine_id=0 AND node_id IN (${bound.map(() => '?').join(',')})`, startSecond, endSecond, ...bound);
      if (Number(lost?.total) > 0) warnings.push({ code: 'unattributed-machine-traffic', message: '有流量来自同时接入多台机器的节点，按机器归集时算不到具体机器，可改为直接选择节点。' });
    }
  }
  const status = used >= quota ? 'exceeded' : (percent >= 80 || (projected != null && projected > quota)) ? 'warning' : 'ok';
  return { used_bytes: used, quota_bytes: quota, remaining_bytes: remaining, percent, upload_bytes: upload, download_bytes: download, cycle_start: cycle.start_date, cycle_end: cycle.end_date, days_left: Math.max(0, Math.ceil((cycle.end - now.getTime()) / DAY)), projected_bytes: projected, calibrated: calibratedNow, status, warnings };
}

function poolView(db: Database, pool: Row, now: Date) { return { id: Number(pool.id), name: pool.name, kind: pool.kind as PoolKind, quota_bytes: Number(pool.quota_bytes), reset_day: Number(pool.reset_day), billing: pool.billing as PoolBilling, visible_to_users: !!pool.visible_to_users, note: pool.note, sort: Number(pool.sort), calibration_bytes: pool.calibration_bytes == null ? null : Number(pool.calibration_bytes), calibrated_at: pool.calibrated_at == null ? null : Number(pool.calibrated_at), created_at: pool.created_at, members: poolMembers(db, Number(pool.id)), usage: poolUsage(db, pool, now) }; }

export function listPools(db: Database, now: Date) {
  return rows(db, 'SELECT * FROM traffic_pools ORDER BY sort,id').map(pool => poolView(db, pool, now));
}

const clampText = (value: unknown, max: number, label: string) => {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max || /[\x00-\x1f\x7f]/.test(text)) bad(`请填写 ${label}`);
  return text;
};
export type PoolInput = { name?: unknown; kind?: unknown; quota_bytes?: unknown; reset_day?: unknown; billing?: unknown; visible_to_users?: unknown; note?: unknown; sort?: unknown; calibration_bytes?: unknown; members?: unknown };

export function savePool(db: Database, input: PoolInput, now: Date, id?: number) {
  const existing = id ? get(db, 'SELECT * FROM traffic_pools WHERE id=?', id) : null;
  if (id && !existing) throw new PoolError('NOT_FOUND', '请检查这个流量池');
  const name = input.name === undefined && existing ? existing.name : clampText(input.name, 60, '流量池名称');
  if (get(db, 'SELECT id FROM traffic_pools WHERE name=? AND id<>?', name, id ?? 0)) bad('已经有同名流量池，请换一个名称');
  const kind = input.kind === undefined && existing ? existing.kind : String(input.kind);
  if (!(POOL_KINDS as readonly string[]).includes(kind)) bad('请选择入口池、出口池或独立节点');
  const quota = input.quota_bytes === undefined && existing ? Number(existing.quota_bytes) : Number(input.quota_bytes);
  if (!Number.isSafeInteger(quota) || quota <= 0) bad('请填写大于 0 的流量额度');
  const resetDay = input.reset_day === undefined && existing ? Number(existing.reset_day) : Number(input.reset_day);
  if (!Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) bad('重置日请填写 1 到 31 之间的数字');
  const billing = input.billing === undefined && existing ? existing.billing : String(input.billing ?? 'single');
  if (!(POOL_BILLINGS as readonly string[]).includes(billing)) bad('请选择单向或双向计费');
  const visible = input.visible_to_users === undefined ? (existing ? !!existing.visible_to_users : true) : input.visible_to_users === true || input.visible_to_users === 1;
  const note = input.note === undefined ? (existing?.note ?? '') : (typeof input.note === 'string' ? input.note.slice(0, 500) : bad('请填写备注'));
  const sort = input.sort === undefined ? (existing ? Number(existing.sort) : 0) : Number(input.sort);
  if (!Number.isFinite(sort)) bad('请填写排序数字');
  let calibration: number | null = existing?.calibration_bytes ?? null, calibratedAt: number | null = existing?.calibrated_at ?? null;
  if (input.calibration_bytes !== undefined) {
    if (input.calibration_bytes === null) { calibration = null; calibratedAt = null; }
    else {
      const value = Number(input.calibration_bytes);
      if (!Number.isSafeInteger(value) || value < 0) bad('请填写本周期已经用掉的流量');
      calibration = value; calibratedAt = now.getTime();
    }
  }
  const rawMembers: unknown = input.members;
  let members: { type: 'node' | 'machine'; id: number }[] | null = null;
  if (rawMembers !== undefined) {
    if (!Array.isArray(rawMembers)) bad('请选择 1 到 200 个成员');
    const list = rawMembers as any[];
    if (list.length < 1 || list.length > 200) bad('请选择 1 到 200 个成员');
    const seen = new Set<string>(); members = [];
    for (const member of list) {
      const type = member?.type, memberID = Number(member?.id);
      if (!['node', 'machine'].includes(type) || !Number.isSafeInteger(memberID) || memberID <= 0) bad('请选择服务器或节点作为成员');
      const key = `${type}:${memberID}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Runtime tables carry per-node traffic. Legacy rows stay selectable so a
      // panel that still shows them keeps one consistent list; they bill zero.
      const runtimeTable = type === 'node' ? 'runtime_nodes' : 'runtime_machines';
      const legacyTable = type === 'node' ? 'nodes' : 'machines';
      if (!get(db, `SELECT id FROM ${runtimeTable} WHERE id=?`, memberID) && !get(db, `SELECT id FROM ${legacyTable} WHERE id=?`, memberID)) bad('请选择已有的服务器或节点');
      members.push({ type, id: memberID });
    }
    if (!members.length) bad('请选择 1 到 200 个成员');
  } else if (!existing) bad('请选择 1 到 200 个成员');
  return db.transaction(() => {
    let savedID = id ?? 0;
    if (id) db.query('UPDATE traffic_pools SET name=?,kind=?,quota_bytes=?,reset_day=?,billing=?,visible_to_users=?,calibration_bytes=?,calibrated_at=?,note=?,sort=? WHERE id=?').run(name, kind, quota, resetDay, billing, Number(visible), calibration, calibratedAt, note, sort, id);
    else savedID = Number(db.query('INSERT INTO traffic_pools(name,kind,quota_bytes,reset_day,billing,visible_to_users,calibration_bytes,calibrated_at,note,sort,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(name, kind, quota, resetDay, billing, Number(visible), calibration, calibratedAt, note, sort, now.toISOString()).lastInsertRowid);
    if (members) {
      db.query('DELETE FROM traffic_pool_members WHERE pool_id=?').run(savedID);
      for (const member of members) db.query('INSERT INTO traffic_pool_members VALUES(?,?,?)').run(savedID, member.type, member.id);
    }
    return poolView(db, get(db, 'SELECT * FROM traffic_pools WHERE id=?', savedID)!, now);
  }).immediate();
}

export function deletePool(db: Database, id: number) {
  if (!get(db, 'SELECT id FROM traffic_pools WHERE id=?', id)) throw new PoolError('NOT_FOUND', '请检查这个流量池');
  db.transaction(() => {
    db.query('DELETE FROM traffic_pool_members WHERE pool_id=?').run(id);
    db.query('DELETE FROM traffic_pools WHERE id=?').run(id);
  }).immediate();
}

/** UTC date range used by the daily ledger and the trend chart. */
export function dateRange(days: number, now: Date) {
  const start = new Date(now.getTime() - (days - 1) * DAY).toISOString().slice(0, 10);
  const end = now.toISOString().slice(0, 10);
  return { start, end };
}
export function dailyTotals(db: Database, start: string, end: string) {
  const row = get(db, 'SELECT COALESCE(SUM(upload_bytes),0) up,COALESCE(SUM(download_bytes),0) down FROM traffic_daily WHERE date>=? AND date<=?', start, end);
  return { upload_bytes: Number(row?.up) || 0, download_bytes: Number(row?.down) || 0 };
}
export function activeUsers(db: Database, start: string, end: string) {
  return Number(get(db, 'SELECT COUNT(DISTINCT user_id) count FROM traffic_daily WHERE date>=? AND date<=? AND upload_bytes+download_bytes>0', start, end)?.count) || 0;
}
export function nodeTrafficTotals(db: Database, start: string, end: string) {
  return rows(db, 'SELECT node_id,SUM(upload_bytes) up,SUM(download_bytes) down,COUNT(DISTINCT user_id) users FROM runtime_node_traffic WHERE date>=? AND date<=? GROUP BY node_id', start, end)
    .map(row => ({ node_id: Number(row.node_id), upload_bytes: Number(row.up) || 0, download_bytes: Number(row.down) || 0, users: Number(row.users) || 0 }));
}
export function userTrafficTotals(db: Database, start: string, end: string, limit = 10) {
  return rows(db, 'SELECT user_id,SUM(upload_bytes) up,SUM(download_bytes) down FROM traffic_daily WHERE date>=? AND date<=? GROUP BY user_id HAVING up+down>0 ORDER BY up+down DESC LIMIT ?', start, end, limit)
    .map(row => ({ user_id: Number(row.user_id), upload_bytes: Number(row.up) || 0, download_bytes: Number(row.down) || 0 }));
}
/** Pools a user can see: those covering any of their available nodes. Bytes stay private. */
export function userPoolStatus(db: Database, nodeIDs: number[], now: Date) {
  // Child entries inherit the root machine binding, so a machine-wide pool covers them too.
  const machinesOf = new Map<number, Set<number>>();
  for (const node of runtimeNodeViews(db)) machinesOf.set(node.id, new Set(node.machine_ids.map(Number)));
  const visibleNodes = new Set(nodeIDs);
  const visibleMachines = new Set<number>();
  for (const node of visibleNodes) for (const machine of machinesOf.get(node) ?? []) visibleMachines.add(machine);
  const result: { id: number; name: string; kind: PoolKind; remaining_percent: number; status: PoolUsage['status']; cycle_end: string; days_left: number }[] = [];
  for (const pool of rows(db, 'SELECT * FROM traffic_pools WHERE visible_to_users=1 ORDER BY sort,id')) {
    const members = rows(db, 'SELECT member_type,member_id FROM traffic_pool_members WHERE pool_id=?', pool.id);
    const covers = members.some(member => member.member_type === 'node' ? visibleNodes.has(Number(member.member_id)) : visibleMachines.has(Number(member.member_id)));
    if (!covers) continue;
    const usage = poolUsage(db, pool, now);
    result.push({ id: Number(pool.id), name: pool.name, kind: pool.kind as PoolKind, remaining_percent: Math.max(0, Math.round((usage.remaining_bytes / usage.quota_bytes) * 100)), status: usage.status, cycle_end: usage.cycle_end, days_left: usage.days_left });
  }
  return result;
}
/** Node totals for one user: every node they used, plus available nodes without traffic. */
export function nodeUsage(db: Database, userID: number, days: number, now: Date, available: { id: number; name: string; available?: boolean }[]) {
  const { start, end } = dateRange(days, now);
  const totals = new Map(rows(db, 'SELECT node_id,SUM(upload_bytes) up,SUM(download_bytes) down,MAX(date) last FROM runtime_node_traffic WHERE user_id=? AND date>=? AND date<=? GROUP BY node_id', userID, start, end)
    .map(row => [Number(row.node_id), { up: Number(row.up) || 0, down: Number(row.down) || 0, last: String(row.last) }]));
  const names = new Map(runtimeNodeViews(db).map(node => [node.id, node.name]));
  const poolNames = new Map<number, string[]>();
  for (const pool of rows(db, 'SELECT id,name FROM traffic_pools ORDER BY sort,id')) {
    for (const member of rows(db, 'SELECT member_type,member_id FROM traffic_pool_members WHERE pool_id=?', pool.id)) {
      if (member.member_type !== 'node') continue;
      const node = Number(member.member_id);
      poolNames.set(node, [...(poolNames.get(node) ?? []), String(pool.name)]);
    }
  }
  const ids = new Set<number>([...available.map(node => node.id), ...totals.keys()]);
  const list = [...ids].map(id => {
    const total = totals.get(id);
    const granted = available.find(node => node.id === id);
    return { id, name: names.get(id) ?? granted?.name ?? `节点 #${id}`, upload_bytes: total?.up ?? 0, download_bytes: total?.down ?? 0, total_bytes: (total?.up ?? 0) + (total?.down ?? 0), last_used_date: total?.last ?? null, available: granted !== undefined && granted.available !== false, pool_names: poolNames.get(id) ?? [] };
  });
  const all = list.reduce((sum, node) => sum + node.total_bytes, 0);
  return list.map(node => ({ ...node, share: all > 0 ? node.total_bytes / all : 0 })).sort((a, b) => b.total_bytes - a.total_bytes || Number(b.available) - Number(a.available) || a.name.localeCompare(b.name));
}


export function userDailyTotals(db: Database, userID: number, start: string, end: string) {
  const row = get(db, 'SELECT COALESCE(SUM(upload_bytes),0) up,COALESCE(SUM(download_bytes),0) down FROM traffic_daily WHERE user_id=? AND date>=? AND date<=?', userID, start, end);
  return { upload_bytes: Number(row?.up) || 0, download_bytes: Number(row?.down) || 0 };
}
export function userNodeTraffic(db: Database, userID: number, start: string, end: string) {
  return rows(db, 'SELECT node_id,SUM(upload_bytes) up,SUM(download_bytes) down FROM runtime_node_traffic WHERE user_id=? AND date>=? AND date<=? GROUP BY node_id', userID, start, end)
    .map(row => ({ node_id: Number(row.node_id), upload_bytes: Number(row.up) || 0, download_bytes: Number(row.down) || 0 }));
}

