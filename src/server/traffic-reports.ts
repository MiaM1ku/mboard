import type { Database } from 'bun:sqlite';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';

/** Callers must authorize as admin before preview, settings, enqueue and run listing. */
export type ReportKind = 'daily' | 'weekly' | 'monthly' | 'test';
type Row = Record<string, any>;
export const REPORT_TIMEZONE = 'Asia/Shanghai';
const DAY = 86400000, OFFSET = 8 * 3600000, MAX_PAYLOAD = 256 * 1024;
const MAX_ATTEMPTS = 3, LEASE_MS = 60000, REQUEST_MS = 10000;
export type ReportErrorCode = 'INVALID_CONFIG' | 'DNS_FAILED' | 'PRIVATE_ADDRESS' | 'TIMEOUT' | 'NETWORK_ERROR' | 'HTTP_ERROR' | 'RESPONSE_TOO_LARGE';
export class ReportError extends Error {
  readonly status = 400;
  constructor(readonly code: ReportErrorCode) { super(code); }
}
const reject = (): never => { throw new ReportError('INVALID_CONFIG'); };
const tableExists = (db: Database, name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const parse = (value: unknown): Row => { try { const p = typeof value === 'string' ? JSON.parse(value) : value; return p && typeof p === 'object' && !Array.isArray(p) ? p : {}; } catch { return {}; } };
const rows = (db: Database, sql: string, ...args: any[]) => db.query(sql).all(...args) as Row[];
const get = (db: Database, sql: string, ...args: any[]) => db.query(sql).get(...args) as Row | null;
const localDay = (now: Date) => new Date(now.getTime() + OFFSET).toISOString().slice(0, 10);
const dayMs = (day: string) => Date.parse(day + 'T00:00:00+08:00');
const shiftDay = (day: string, n: number) => new Date(Date.parse(day + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const validDate = (now: Date) => { if (!(now instanceof Date) || !Number.isFinite(now.getTime())) reject(); return now; };
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): number { if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) reject(); return v as number; }
function bytes(v: unknown): bigint {
  if (typeof v === 'bigint' && v >= 0n) return v;
  if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  return reject();
}
function header(v: unknown): string { if (typeof v !== 'string' || Buffer.byteLength(v) > 4096 || /[\x00-\x1f\x7f]/.test(v)) reject(); return v as string; }
/** Shape only: seed/PATCH never query DNS. Every send validates all addresses again. */
export function validateReportURL(value: unknown): URL {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x20\x7f\\]/.test(value) || /%0[ad]/i.test(value) || value.includes('#')) return reject();
  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (!authority || authority.includes('@')) reject();
  let url: URL; try { url = new URL(value); } catch { return reject(); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) reject();
  return url;
}
export function isPublicReportAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const p = address.split('.').map(Number), a = p[0]!, b = p[1]!, c = p[2]!;
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return false;
    if ((a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
    return true;
  }
  if (family !== 6) return false;
  // Only conservative global unicast. Deny mapped IPv4, ULA, link-local,
  // loopback, multicast, transition, translation and documentation prefixes.
  let n: string; try { n = new URL('https://[' + address + ']').hostname.slice(1, -1).toLowerCase(); } catch { return false; }
  const parts=n.split(':'),first=parseInt(parts[0]!,16),second=parts[1]?parseInt(parts[1],16):0;
  return first>=0x2000 && first<0x3ffe && first!==0x2002 && !(first===0x2001&&(second<0x200||second===0xdb8));
}
export type ReportSettingsDTO = { enabled: boolean; webhook_configured: boolean; url_display: string | null; authorization_configured: boolean; top_limit: number; timezone: string; schedule: { daily: string; weekly: string; monthly: string }; revision: number };
export type ReportSettingsPatch = { enabled?: boolean; webhook_url?: string | null; authorization_header?: string | null; top_limit?: number };
function settings(db: Database): Row { const s = get(db, 'SELECT * FROM traffic_report_settings WHERE id=1'); return s ?? reject(); }
export function getReportSettings(db: Database): ReportSettingsDTO {
  const s = settings(db); let host: string | null = null;
  try { if (s.webhook_url) host = validateReportURL(s.webhook_url).hostname; } catch { /* do not disclose malformed source */ }
  return { enabled: !!s.enabled, webhook_configured: !!s.webhook_url, url_display: host, authorization_configured: !!s.authorization_header, top_limit: s.top_limit, timezone: REPORT_TIMEZONE, schedule: { daily: '00:00', weekly: 'Sunday 00:00', monthly: '1st 00:00' }, revision: s.revision };
}
export function saveReportSettings(db: Database, patch: ReportSettingsPatch): ReportSettingsDTO {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(k => !['enabled','webhook_url','authorization_header','top_limit'].includes(k))) reject();
  if (patch.enabled !== undefined && typeof patch.enabled !== 'boolean') reject();
  if (patch.top_limit !== undefined) integer(patch.top_limit, 1, 100);
  if (patch.webhook_url !== undefined && patch.webhook_url !== null && patch.webhook_url !== '') validateReportURL(patch.webhook_url);
  if (patch.authorization_header !== undefined && patch.authorization_header !== null) header(patch.authorization_header);
  return db.transaction(() => {
    const s = settings(db), url = patch.webhook_url === undefined ? s.webhook_url : patch.webhook_url ?? '';
    const auth = patch.authorization_header === undefined || patch.authorization_header === null ? s.authorization_header : patch.authorization_header;
    const enabled = patch.enabled === undefined ? s.enabled : Number(patch.enabled), top = patch.top_limit ?? s.top_limit;
    if (url !== s.webhook_url || auth !== s.authorization_header || enabled !== s.enabled || top !== s.top_limit) {
      db.query('UPDATE traffic_report_settings SET enabled=?,webhook_url=?,authorization_header=?,top_limit=?,revision=revision+1 WHERE id=1').run(enabled,url,auth,top);
      db.query("UPDATE traffic_report_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL WHERE status IN ('queued','processing')").run();
    }
    return getReportSettings(db);
  }).immediate();
}
function legacyConfig(db: Database) {
  const plugins = tableExists(db,'legacy_records') ? rows(db,"SELECT payload FROM legacy_records WHERE kind='v2_plugins' AND json_extract(payload,'$.code')='traffic_report' ORDER BY id") : [];
  const plugin = plugins.length ? parse(plugins[0]!.payload) : null;
  const cfg = parse(plugin?.config), active = plugin?.is_enabled === '1' || plugin?.is_enabled === 1 || plugin?.is_enabled === true;
  const fallback: Row = {};
  if (tableExists(db,'legacy_records')) for (const r of rows(db,"SELECT payload FROM legacy_records WHERE kind='v2_settings' AND json_extract(payload,'$.name') IN ('daily_report_url','daily_report_header_authorization') ORDER BY id")) { const p = parse(r.payload); fallback[p.name] = p.value; }
  const filled = (v: unknown) => v !== undefined && v !== null && (typeof v !== 'string' || v.trim() !== '');
  const url = active && filled(cfg.webhook_url) ? cfg.webhook_url : fallback.daily_report_url ?? '';
  const auth = active && filled(cfg.authorization_header) ? cfg.authorization_header : fallback.daily_report_header_authorization ?? '';
  const top = Number((active ? cfg.top_limit : undefined) ?? 5);
  return { snapshot: JSON.stringify({ plugin, plugin_payloads: plugins.map(r=>r.payload), fallback }), enabled: Number(active), webhook_url: url, authorization_header: auth, top_limit: Number.isInteger(top) ? Math.max(1,Math.min(100,top)) : 5 };
}
/** AFTER archive/runtime restore, BEFORE traffic. Additive schema, repeat-safe, no network. */
export function initializeTrafficReports(db: Database, options: { now?: Date } = {}) {
  const now = validDate(options.now ?? new Date());
  db.exec(`CREATE TABLE IF NOT EXISTS traffic_report_settings(id INTEGER PRIMARY KEY CHECK(id=1),enabled INTEGER NOT NULL,webhook_url TEXT NOT NULL,authorization_header TEXT NOT NULL,top_limit INTEGER NOT NULL CHECK(top_limit BETWEEN 1 AND 100),revision INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS traffic_report_seed(id INTEGER PRIMARY KEY CHECK(id=1),legacy_snapshot TEXT NOT NULL,hook_started_at INTEGER NOT NULL,scheduler_day TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS traffic_report_hourly(source TEXT NOT NULL,user_id INTEGER NOT NULL,node_id INTEGER NOT NULL,profile_id TEXT NOT NULL,hour INTEGER NOT NULL,upload_bytes TEXT NOT NULL,download_bytes TEXT NOT NULL,PRIMARY KEY(source,user_id,node_id,profile_id,hour));
CREATE INDEX IF NOT EXISTS traffic_report_hourly_time ON traffic_report_hourly(hour);
CREATE TABLE IF NOT EXISTS traffic_report_baseline(scope TEXT NOT NULL,user_id INTEGER NOT NULL,node_id INTEGER NOT NULL,date TEXT NOT NULL,upload_bytes TEXT NOT NULL,download_bytes TEXT NOT NULL,PRIMARY KEY(scope,user_id,node_id,date));
CREATE TABLE IF NOT EXISTS traffic_report_runs(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('daily','weekly','monthly','test')),period_key TEXT NOT NULL,start_date TEXT NOT NULL,end_date TEXT NOT NULL,source_start INTEGER NOT NULL,source_end INTEGER NOT NULL,timezone TEXT NOT NULL,message TEXT NOT NULL,manual INTEGER NOT NULL,request_key TEXT UNIQUE,attempts INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL CHECK(status IN ('queued','processing','sent','failed','cancelled')),next_attempt_at INTEGER NOT NULL,lease_token TEXT,lease_expires_at INTEGER,settings_revision INTEGER NOT NULL,created_at INTEGER NOT NULL,http_status INTEGER,error_code TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS traffic_report_scheduled_period ON traffic_report_runs(kind,source_start,source_end,timezone) WHERE manual=0;
CREATE INDEX IF NOT EXISTS traffic_report_due ON traffic_report_runs(status,next_attempt_at);`);
  db.transaction(() => {
    if (get(db,'SELECT id FROM traffic_report_seed WHERE id=1')) return;
    const c = legacyConfig(db);
    // Exact config snapshot precedes normalization; private table, never a DTO.
    db.query('INSERT INTO traffic_report_seed VALUES(1,?,?,?)').run(c.snapshot,now.getTime(),localDay(now));
    let url = '', auth = '', valid = true;
    try { if (c.webhook_url) { validateReportURL(c.webhook_url); url = c.webhook_url; } auth = header(c.authorization_header); } catch { valid = false; }
    db.query('INSERT OR IGNORE INTO traffic_report_settings VALUES(1,?,?,?,?,1)').run(valid ? c.enabled : 0,url,auth,c.top_limit);
    if (tableExists(db,'traffic_daily')) for (const r of rows(db,'SELECT user_id,date,CAST(upload_bytes AS TEXT) up,CAST(download_bytes AS TEXT) down FROM traffic_daily')) db.query('INSERT OR IGNORE INTO traffic_report_baseline VALUES(?,?,?,?,?,?)').run('user',r.user_id,0,r.date,bytes(r.up).toString(),bytes(r.down).toString());
    if (tableExists(db,'runtime_node_traffic')) for (const r of rows(db,'SELECT node_id,user_id,date,CAST(upload_bytes AS TEXT) up,CAST(download_bytes AS TEXT) down FROM runtime_node_traffic')) db.query('INSERT OR IGNORE INTO traffic_report_baseline VALUES(?,?,?,?,?,?)').run('node',r.user_id,r.node_id,r.date,bytes(r.up).toString(),bytes(r.down).toString());
  }).immediate();
  return getReportSettings(db);
}
export type RecordReportTrafficInput = { source: 'runtime' | 'basic'; user_id: number; node_id: number; profile_id?: string; upload_bytes: number | bigint; download_bytes: number | bigint; accepted_at: Date };
/** Synchronous, inside caller's traffic transaction. New partitions never subtract profiles. */
export function recordReportTraffic(db: Database, input: RecordReportTrafficInput) {
  if (!input || !['runtime','basic'].includes(input.source)) reject();
  const uid = integer(input.user_id,1), nid = integer(input.node_id,1), profile = input.profile_id ?? '';
  if (typeof profile !== 'string' || !/^[A-Za-z0-9-]{0,64}$/.test(profile)) reject();
  const hour = Math.floor(validDate(input.accepted_at).getTime() / 3600000) * 3600, up = bytes(input.upload_bytes), down = bytes(input.download_bytes);
  if (up === 0n && down === 0n) return;
  const prior = get(db,'SELECT upload_bytes,download_bytes FROM traffic_report_hourly WHERE source=? AND user_id=? AND node_id=? AND profile_id=? AND hour=?',input.source,uid,nid,profile,hour);
  db.query('INSERT INTO traffic_report_hourly VALUES(?,?,?,?,?,?,?) ON CONFLICT(source,user_id,node_id,profile_id,hour) DO UPDATE SET upload_bytes=excluded.upload_bytes,download_bytes=excluded.download_bytes').run(input.source,uid,nid,profile,hour,(up + bytes(prior?.upload_bytes ?? 0)).toString(),(down + bytes(prior?.download_bytes ?? 0)).toString());
}
export function reportPeriod(kind: ReportKind, now: Date) {
  validDate(now); if (!['daily','weekly','monthly','test'].includes(kind)) reject();
  const today = localDay(now), yesterday = shiftDay(today,-1);
  let start = yesterday, end = yesterday;
  if (kind === 'weekly') start = shiftDay(yesterday,-6);
  if (kind === 'monthly') { const first = today.slice(0,7) + '-01'; end = shiftDay(first,-1); start = end.slice(0,7) + '-01'; }
  return { start_date: start, end_date: end, source_start: Math.floor(dayMs(start)/1000), source_end: Math.floor((dayMs(end)+DAY)/1000)-1, timezone: REPORT_TIMEZONE };
}
export function formatReportBytes(value: bigint): string {
  const b = value < 0n ? 0n : value, names = ['B','KB','MB','GB','TB']; let power = 0, divisor = 1n;
  while (power < 4 && b >= divisor * 1024n) { divisor *= 1024n; power++; }
  const scaled = (b * 100n + divisor / 2n) / divisor, whole = scaled / 100n, fraction = String(scaled % 100n).padStart(2,'0').replace(/0+$/,'');
  return `${whole}${fraction ? '.'+fraction : ''} ${names[power]}`;
}
const markdown = (s: string) => s.replace(/[\\`*_\[\]]/g,'\\$&').replace(/[\r\n\x00-\x1f\x7f]/g,' ');
export type ReportPreview = { kind: ReportKind; title: string; start_date: string; end_date: string; timezone: string; message: string; nodes: { label: string; bytes: string }[]; users: { label: string; bytes: string; topNode?: { label: string; bytes: string } }[]; warnings: string[] };
function labels(db: Database) {
  const nodes = new Map<string, Row>(), profiles = new Map<string, Row>(), emails = new Map<string,string>(),basicNames=new Map<string,string>();
  if (tableExists(db,'legacy_records')) for (const r of rows(db,"SELECT kind,payload FROM legacy_records WHERE kind IN ('v2_server','v2_server_route_profile','v2_user')")) { const p = parse(r.payload); if (r.kind === 'v2_server') nodes.set(String(p.id),p); else if (r.kind === 'v2_server_route_profile') { profiles.set(String(p.id),p); if(p.uuid)profiles.set(String(p.uuid),p); } else emails.set(String(p.id),String(p.email || `Unknown User (${p.id})`)); }
  if (tableExists(db,'nodes')) for (const r of rows(db,'SELECT id,name FROM nodes')) {basicNames.set(String(r.id),String(r.name));if(!nodes.has(String(r.id)))nodes.set(String(r.id),r);}
  if (tableExists(db,'runtime_nodes')) for (const r of rows(db,'SELECT id,parent_id,payload FROM runtime_nodes')) nodes.set(String(r.id),{...parse(r.payload),parent_id:r.parent_id});
  if (tableExists(db,'runtime_source_records')) for (const r of rows(db,"SELECT payload FROM runtime_source_records WHERE kind='v2_server_route_profile'")) { const p=parse(r.payload);profiles.set(String(p.id),p);if(p.uuid)profiles.set(String(p.uuid),p); }
  if (tableExists(db,'users')) for(const r of rows(db,'SELECT id,email FROM users')) emails.set(String(r.id),String(r.email));
  // Matches the PHP's immediate-parent physical ID normalization.
  const root = (id: string) => { const parent = Number(nodes.get(id)?.parent_id); return parent > 0 ? String(parent) : id; };
  const nodeName = (id: string) => String(nodes.get(id)?.name || `Unknown Server (${id})`);
  const profileName = (pid: string,nid: string) => profiles.get(pid) ? String(profiles.get(pid)!.name || `Unknown Profile (${profiles.get(pid)!.id})`) : pid ? `Unknown Profile (${pid})` : nodeName(nid);
  const basicName=(id:string)=>basicNames.get(id)||`Unknown Server (${id})`;
  return {profiles,emails,root,nodeName,basicName,profileName};
}
function add(map: Map<string,bigint>, key: string, amount: bigint) { map.set(key,(map.get(key) ?? 0n)+amount); }
function archiveStats(db: Database, kind: string, start: number, end: number): Row[] {
  if (!tableExists(db,'legacy_records')) return [];
  // Kind/date/type bounded SQL; exact per-row TEXT integers, never SQL SUM.
  return rows(db,"SELECT payload,CAST(json_extract(payload,'$.u') AS TEXT) up,CAST(json_extract(payload,'$.d') AS TEXT) down FROM legacy_records WHERE kind=? AND json_extract(payload,'$.record_type')='d' AND CAST(json_extract(payload,'$.record_at') AS INTEGER) BETWEEN ? AND ?",kind,start,end).map(r => ({...parse(r.payload),amount:bytes(r.up ?? '0')+bytes(r.down ?? '0')}));
}
export function buildPreview(db: Database, kind: ReportKind, now = new Date()): ReportPreview {
  const p = reportPeriod(kind,now), s=settings(db);
  if(kind==='test') {
    const title='# mboard Webhook 迁移测试（真实发送）';
    return {kind,title,start_date:p.start_date,end_date:p.end_date,timezone:p.timezone,message:title+'\n\n这是一条迁移连接测试消息，内容仅含测试标记和报告时区。\n时区：Asia/Shanghai',nodes:[],users:[],warnings:[]};
  }
  const l=labels(db), warnings = new Set<string>(), nodeTotals = new Map<string,bigint>(), userTotals = new Map<string,bigint>(), userNodes = new Map<string,Map<string,bigint>>(), names = new Map<string,string>();
  const nodeKey = (nid: string) => { const key='node:'+nid; names.set(key,l.nodeName(nid)); return key; };
  const basicNodeKey=(nid:string)=>{const key='basic-node:'+nid;names.set(key,l.basicName(nid));return key;};
  const profileKey = (pid: string,nid: string) => { const canonical = String(l.profiles.get(pid)?.uuid || pid),key='profile:'+nid+':'+canonical; names.set(key,l.profileName(pid,nid)); return key; };
  const byUser = (uid: string) => { if(!userNodes.has(uid))userNodes.set(uid,new Map());return userNodes.get(uid)!; };
  const oldNodes=archiveStats(db,'v2_stat_server',p.source_start,p.source_end), oldUsers=archiveStats(db,'v2_stat_user',p.source_start,p.source_end), oldUN=archiveStats(db,'v2_user_node_traffic',p.source_start,p.source_end);
  const physicalProfiles = new Map<string,bigint>(), userPhysicalProfiles = new Map<string,bigint>();
  for(const r of oldUN) if(String(r.profile_uuid ?? '') !== '') { const nid=String(r.server_id),pid=Number(r.route_profile_id)>0?String(r.route_profile_id):'',key=profileKey(pid,nid);add(nodeTotals,key,r.amount);add(physicalProfiles,l.root(nid),r.amount);add(byUser(String(r.user_id)),key,r.amount);add(userPhysicalProfiles,String(r.user_id)+':'+l.root(nid),r.amount); }
  for(const r of oldNodes) add(nodeTotals,nodeKey(String(r.server_id)),r.amount);
  for(const [nid,amount] of physicalProfiles) { const key=nodeKey(nid),total=nodeTotals.get(key) ?? 0n;nodeTotals.set(key,total>amount?total-amount:0n);if(amount>total)warnings.add('legacy-profile-total-exceeds-physical-total'); }
  for(const r of oldUsers) add(userTotals,String(r.user_id),r.amount);
  for(const r of oldUN) if(String(r.profile_uuid ?? '') === '') add(byUser(String(r.user_id)),nodeKey(String(r.server_id)),r.amount);
  for(const [key,amount] of userPhysicalProfiles) { const colon=key.indexOf(':'),uid=key.slice(0,colon),nid=key.slice(colon+1),map=byUser(uid),nk=nodeKey(nid),total=map.get(nk)??0n;map.set(nk,total>amount?total-amount:0n); }
  // Assign each unallocated UTC bucket to its SAME calendar-date label. It
  // intersects Shanghai's window but must not appear again the following day.
  // Preserve whole known volume, disclose approximation and lost profiles.
  let baselineUsers=0,baselineNodes=0;
  const baselineDates=new Set<string>();
  for(const r of rows(db,'SELECT * FROM traffic_report_baseline WHERE date BETWEEN ? AND ?',p.start_date,p.end_date)) {
    const begin=Date.parse(r.date+'T00:00:00Z')/1000,end=begin+86400-1;if(end<p.source_start||begin>p.source_end)continue;
    baselineDates.add(r.date);
    const amount=bytes(r.upload_bytes)+bytes(r.download_bytes);
    warnings.add('missing-history-boundary_warning');warnings.add('pre-hook-utc-daily-unallocated');warnings.add('pre-upgrade-profiles-merged-into-entry-node');
    if(begin<p.source_start||end>p.source_end)warnings.add('intersecting-utc-day-included-whole');
    if(r.scope==='user'){baselineUsers++;add(userTotals,String(r.user_id),amount);}
    else {baselineNodes++;const key=nodeKey(String(r.node_id));add(nodeTotals,key,amount);add(byUser(String(r.user_id)),key,amount);}
  }
  if(baselineUsers||baselineNodes){warnings.add(`baseline_rows:users=${baselineUsers},node_users=${baselineNodes}`);warnings.add('utc-day-attributed-to-same-calendar-label');warnings.add('baseline_utc_dates:'+[...baselineDates].sort().join(','));}
  for(const r of rows(db,'SELECT * FROM traffic_report_hourly WHERE hour BETWEEN ? AND ?',p.source_start,p.source_end)) {
    const amount=bytes(r.upload_bytes)+bytes(r.download_bytes),uid=String(r.user_id),nid=String(r.node_id),key=r.profile_id?profileKey(r.profile_id,nid):r.source==='basic'?basicNodeKey(nid):nodeKey(nid);add(nodeTotals,key,amount);add(userTotals,uid,amount);add(byUser(uid),key,amount);
  }
  const hook=get(db,'SELECT hook_started_at FROM traffic_report_seed WHERE id=1')?.hook_started_at;
  if(hook && p.source_start*1000<hook && (p.source_end*1000>=dayMs(localDay(new Date(hook))) || (!oldNodes.length&&!oldUsers.length&&!oldUN.length))) {warnings.add('missing-history-boundary_warning');warnings.add('sources:legacy-shanghai-daily,pre-hook-utc-daily,post-hook-epoch-hourly');}
  const sorted=(map: Map<string,bigint>) => [...map].filter(([,b])=>b>0n).sort((a,b)=>a[1]===b[1]?a[0].localeCompare(b[0]):a[1]>b[1]?-1:1);
  const nodes=sorted(nodeTotals).slice(0,s.top_limit).map(([key,b])=>({label:names.get(key)!,bytes:b.toString()}));
  const users=sorted(userTotals).slice(0,s.top_limit).map(([uid,b])=>{const top=sorted(byUser(uid))[0];return {label:l.emails.get(uid)||`Unknown User (${uid})`,bytes:b.toString(),...(top?{topNode:{label:names.get(top[0])!,bytes:top[1].toString()}}:{})};});
  const title=`# ${kind==='daily'?'每日':kind==='weekly'?'每周':'每月'}流量报告\n日期：${p.start_date}${p.start_date===p.end_date?'':' ~ '+p.end_date}`;
  const nodeLines=nodes.length?nodes.map((n,i)=>`${i+1}. ${markdown(n.label)}: ${formatReportBytes(BigInt(n.bytes))}`).join('\n'):'- 等待本周期流量记录';
  const userLines=users.length?users.map((u,i)=>`${i+1}. ${markdown(u.label)}: ${formatReportBytes(BigInt(u.bytes))}${u.topNode?` · 最高节点 ${markdown(u.topNode.label)} ${formatReportBytes(BigInt(u.topNode.bytes))}`:''}`).join('\n'):'- 等待本周期流量记录';
  const message=`${title}\n\n## 节点流量排行 (Top ${s.top_limit})\n${nodeLines}\n\n## 用户流量排行 (Top ${s.top_limit})\n${userLines}${warnings.size?'\n\n历史口径：旧记录按上海自然日，接入前 UTC 整日记录归入同名日期一次，接入后按小时。接入前出口流量合并在入口节点，保留整桶流量。':''}`;
  if(Buffer.byteLength(JSON.stringify({message}))>MAX_PAYLOAD)reject();
  return {kind,title,start_date:p.start_date,end_date:p.end_date,timezone:p.timezone,message,nodes,users,warnings:[...warnings]};
}
export type ReportRunDTO = { id: string; kind: ReportKind; status: string; period_key: string; start_date: string; end_date: string; timezone: string; attempts: number; http_status: number | null; error_code: ReportErrorCode | null; created_at: number; next_attempt_at: number };
const runDTO = (r: Row): ReportRunDTO => ({id:r.id,kind:r.kind,status:r.status,period_key:r.period_key,start_date:r.start_date,end_date:r.end_date,timezone:r.timezone,attempts:r.attempts,http_status:r.http_status,error_code:r.error_code,created_at:r.created_at,next_attempt_at:r.next_attempt_at});
export function listReportRuns(db: Database, limit=50): ReportRunDTO[] { integer(limit,1,100);return rows(db,'SELECT id,kind,status,period_key,start_date,end_date,timezone,attempts,http_status,error_code,created_at,next_attempt_at FROM traffic_report_runs ORDER BY created_at DESC,id LIMIT ?',limit).map(runDTO); }
export function getReportRun(db: Database, id: string): ReportRunDTO | null {const r=get(db,'SELECT id,kind,status,period_key,start_date,end_date,timezone,attempts,http_status,error_code,created_at,next_attempt_at FROM traffic_report_runs WHERE id=?',id);return r?runDTO(r):null;}
export function enqueueReport(db: Database, kind: ReportKind, now = new Date(), options: { manual?: boolean; idempotencyKey?: string } = {}): ReportRunDTO | null {
  const p=reportPeriod(kind,now),manual=kind==='test'||!!options.manual,key=options.idempotencyKey;
  if(key!==undefined && (typeof key!=='string'||!/^[A-Za-z0-9._:-]{1,128}$/.test(key)))reject();
  return db.transaction(()=>{
    if(key){const prior=get(db,'SELECT * FROM traffic_report_runs WHERE request_key=?',key);if(prior){if(prior.kind!==kind||prior.manual!==Number(manual))reject();return runDTO(prior);}}
    const s=settings(db);if(!manual && !s.enabled)return null;
    if(!manual){const prior=get(db,'SELECT * FROM traffic_report_runs WHERE manual=0 AND kind=? AND source_start=? AND source_end=? AND timezone=?',kind,p.source_start,p.source_end,p.timezone);if(prior)return runDTO(prior);}
    if(!s.webhook_url)reject();validateReportURL(s.webhook_url);header(s.authorization_header);
    const preview=buildPreview(db,kind,now),id=crypto.randomUUID();
    db.query("INSERT INTO traffic_report_runs(id,kind,period_key,start_date,end_date,source_start,source_end,timezone,message,manual,request_key,status,next_attempt_at,settings_revision,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)").run(id,kind,p.start_date+':'+p.end_date,p.start_date,p.end_date,p.source_start,p.source_end,p.timezone,preview.message,Number(manual),key??null,now.getTime(),s.revision,now.getTime());
    return getReportRun(db,id);
  }).immediate();
}
/** First call arms today, only next local calendar midnight (120s grace), no startup backlog. */
export function tickReportSchedule(db: Database, now = new Date()): ReportRunDTO[] {
  validDate(now);
  return db.transaction(()=>{
    const today=localDay(now),state=get(db,'SELECT scheduler_day FROM traffic_report_seed WHERE id=1');if(!state)reject();
    if(state!.scheduler_day===today)return [];
    db.query('UPDATE traffic_report_seed SET scheduler_day=? WHERE id=1').run(today);
    if(now.getTime()-dayMs(today)>120000 || today!==shiftDay(state!.scheduler_day,1))return [];
    const s=settings(db);if(!s.enabled||!s.webhook_url)return [];
    const kinds: ReportKind[]=['daily'];if(new Date(today+'T00:00:00Z').getUTCDay()===0)kinds.push('weekly');if(today.endsWith('-01'))kinds.push('monthly');
    return kinds.map(k=>enqueueReport(db,k,now)).filter((r):r is ReportRunDTO=>!!r);
  }).immediate();
}
export type VerifiedAddress = { address: string; family: number };
export type ReportTransportInput = { url: URL; address: VerifiedAddress; headers: Record<string,string>; body: string; timeoutMs: number; maxResponseBytes: number };
export type ReportWorkerOptions = { now?: Date; maxJobs?: number; resolve?: (hostname: string) => Promise<VerifiedAddress[]>; transport?: (input: ReportTransportInput) => Promise<{ status: number }> };
/** Pin verified IP; original hostname retains TLS/SNI. No redirect, no pooled socket. */
export function pinnedReportTransport(input: ReportTransportInput, requestImpl: typeof request = request): Promise<{status:number}> {
  return new Promise((resolve,rejectPromise)=>{
    let settled=false, timer: ReturnType<typeof setTimeout>;
    const finish=(err?:ReportError,status?:number)=>{if(settled)return;settled=true;clearTimeout(timer);if(err)rejectPromise(err);else resolve({status:status!});};
    const host=input.url.hostname.replace(/^\[|\]$/g,'');
    const req=requestImpl(input.url,{method:'POST',agent:false,servername:isIP(host)?undefined:host,headers:input.headers,family:input.address.family,lookup:((_host:any,opts:any,cb:any)=>{if(opts?.all)cb(null,[input.address]);else cb(null,input.address.address,input.address.family);}) as any},res=>{
      let size=0;res.on('data',chunk=>{size+=chunk.length;if(size>input.maxResponseBytes){finish(new ReportError('RESPONSE_TOO_LARGE'));res.destroy();req.destroy();}});
      res.on('end',()=>finish(undefined,res.statusCode??0));res.on('error',()=>finish(new ReportError('NETWORK_ERROR')));
    });
    timer=setTimeout(()=>{finish(new ReportError('TIMEOUT'));req.destroy();},input.timeoutMs);
    req.on('error',()=>finish(new ReportError('NETWORK_ERROR')));req.end(input.body);
  });
}
async function resolvePublic(url: URL, resolver: NonNullable<ReportWorkerOptions['resolve']>): Promise<VerifiedAddress> {
  const host=url.hostname.replace(/^\[|\]$/g,'');let addresses:VerifiedAddress[];
  if(isIP(host))addresses=[{address:host,family:isIP(host)}];else {
    if(host.toLowerCase()==='localhost'||host.toLowerCase().endsWith('.localhost')||host.toLowerCase().endsWith('.local')||host.toLowerCase().endsWith('.internal'))throw new ReportError('PRIVATE_ADDRESS');
    try{addresses=await resolver(host);}catch{throw new ReportError('DNS_FAILED');}
  }
  if(!addresses.length)throw new ReportError('DNS_FAILED');
  if(addresses.some(a=>!isPublicReportAddress(a.address)||isIP(a.address)!==a.family))throw new ReportError('PRIVATE_ADDRESS');
  return addresses[0]!;
}
function claim(db: Database, now: number): Row | null {
  return db.transaction(()=>{
    // Crash after HTTP success can duplicate on reclaim: at-least-once.
    db.query("UPDATE traffic_report_runs SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'queued' END,lease_token=NULL,lease_expires_at=NULL,error_code='NETWORK_ERROR' WHERE status='processing' AND lease_expires_at<=?").run(MAX_ATTEMPTS,now);
    const s=settings(db);
    db.query("UPDATE traffic_report_runs SET status='cancelled',lease_token=NULL,lease_expires_at=NULL WHERE status='queued' AND (settings_revision<>? OR (manual=0 AND ?=0))").run(s.revision,s.enabled);
    const r=get(db,"SELECT * FROM traffic_report_runs WHERE status='queued' AND next_attempt_at<=? AND attempts<? ORDER BY next_attempt_at,created_at,id LIMIT 1",now,MAX_ATTEMPTS);if(!r)return null;
    const token=crypto.randomUUID();db.query("UPDATE traffic_report_runs SET status='processing',attempts=attempts+1,lease_token=?,lease_expires_at=? WHERE id=? AND status='queued'").run(token,now+LEASE_MS,r.id);
    return {...r,attempts:r.attempts+1,lease_token:token,settings:s};
  }).immediate();
}
export async function runReportWorker(db: Database, options: ReportWorkerOptions = {}): Promise<ReportRunDTO[]> {
  const max=integer(options.maxJobs??10,1,10),clock=()=>options.now?validDate(options.now).getTime():Date.now(),result:ReportRunDTO[]=[];
  const resolver=options.resolve??(async hostname=>await lookup(hostname,{all:true})),transport=options.transport??pinnedReportTransport;
  for(let i=0;i<max;i++){
    const r=claim(db,clock());if(!r)break;let status:number|null=null,err:ReportErrorCode|null=null;
    try{
      const url=validateReportURL(r.settings.webhook_url),auth=header(r.settings.authorization_header),body=JSON.stringify({message:r.message});if(Buffer.byteLength(body)>MAX_PAYLOAD)reject();
      const attemptStarted=Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const address=await Promise.race([resolvePublic(url,resolver),new Promise<never>((_,rejectP)=>{timer=setTimeout(()=>rejectP(new ReportError('TIMEOUT')),REQUEST_MS);})]).finally(()=>clearTimeout(timer));
      // PATCH while DNS awaited cancels the old claim rather than rerouting it.
      const current=get(db,'SELECT status,lease_token,settings_revision FROM traffic_report_runs WHERE id=?',r.id),cfg=settings(db);
      if(!current||current.status!=='processing'||current.lease_token!==r.lease_token||cfg.revision!==r.settings_revision) {const dto=getReportRun(db,r.id);if(dto)result.push(dto);continue;}
      const headers:Record<string,string>={'Content-Type':'application/json','Content-Length':String(Buffer.byteLength(body)),'X-Mboard-Delivery-ID':r.id};if(auth)headers.Authorization=auth;
      const remaining=REQUEST_MS-(Date.now()-attemptStarted);if(remaining<=0)throw new ReportError('TIMEOUT');
      const response=await transport({url,address,headers,body,timeoutMs:remaining,maxResponseBytes:65536});
      status=integer(response.status,100,599);if(status<200||status>=300)throw new ReportError('HTTP_ERROR');
    }catch(e){err=e instanceof ReportError?e.code:'NETWORK_ERROR';}
    db.transaction(()=>{
      const current=get(db,'SELECT status,lease_token FROM traffic_report_runs WHERE id=?',r.id);if(!current||current.status!=='processing'||current.lease_token!==r.lease_token)return;
      const finalStatus=err?(r.attempts>=MAX_ATTEMPTS?'failed':'queued'):'sent';
      db.query('UPDATE traffic_report_runs SET status=?,next_attempt_at=?,http_status=?,error_code=?,lease_token=NULL,lease_expires_at=NULL WHERE id=? AND lease_token=?').run(finalStatus,clock()+(err?60000*2**(r.attempts-1):0),status,err,r.id,r.lease_token);
    }).immediate();
    const dto=getReportRun(db,r.id);if(dto)result.push(dto);
  }
  return result;
}
