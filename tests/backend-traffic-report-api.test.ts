import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/server/app';
import { hash } from '../src/server/database';
import { initializeRuntime, provisionMachineToken, restoreRuntime } from '../src/server/runtime';
import { initializeTrafficReports } from '../src/server/traffic-reports';

// Synthetic archives only. Seed before the report initializer, with no files or remote service.
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.close(); });
const root = '/api/v1/admin/traffic-reports';
const panel = 'https://panel.example.test';
const seedAt = new Date('2026-10-13T04:00:00Z');
const trafficAt = new Date('2026-10-13T08:00:00Z');
const reportAt = new Date('2026-10-13T16:00:00Z');
const future = '2099-01-01T00:00:00.000Z';
const sourceEmail = 'private-account@example.test';
const hook = 'https://report.example.invalid/private-hook-path?token=SYNTHETIC-QUERY-SECRET';
const auth = ' Exact SYNTHETIC-AUTH-SECRET ';
const profile = '12345678-1234-4123-8123-123456789abc';
const foreignProfile = '22345678-1234-4123-8123-123456789abc';
const restrictedProfile = '32345678-1234-4123-8123-123456789abc';
const routes = [
  ['settings', 'GET', undefined], ['settings', 'PATCH', { top_limit: 4 }],
  ['runs', 'GET', undefined], ['preview', 'POST', { kind: 'daily' }],
  ['send', 'POST', { kind: 'daily', idempotency_key: 'scope-send' }],
  ['test', 'POST', { idempotency_key: 'scope-test' }],
] as const;

function fixture(options: { baseline?: boolean } = {}) {
  let clock = seedAt;
  const app = createApp({ initializeRuntime: false, now: () => clock, publicOrigin: panel, subscriptionOrigin: 'https://sub.example.test' });
  apps.push(app);
  const db = app.db;
  const archive = (kind: string, id: number | string, payload: Record<string, unknown>) => db.query('INSERT INTO legacy_records VALUES(?,?,?,?)').run(kind, String(id), JSON.stringify(payload), seedAt.toISOString());
  for (const [id, email, role, credential] of [
    [1, sourceEmail, 'user', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
    [2, 'admin@example.test', 'admin', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
  ] as const) {
    db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,quota_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, email, role, role, 'synthetic-hash', credential, String(id).repeat(64), 100000, future, seedAt.toISOString());
    archive('v2_user', id, { id, email, uuid: credential });
  }
  db.exec("INSERT INTO groups(id,name) VALUES(1,'Granted'),(2,'Denied'); INSERT INTO user_groups VALUES(1,1);");
  const userCookie = `mboard_session=${'c'.repeat(64)}`, adminCookie = `mboard_session=${'d'.repeat(64)}`;
  db.query('INSERT INTO sessions VALUES(?,?,?)').run(hash('c'.repeat(64)), 1, future);
  db.query('INSERT INTO sessions VALUES(?,?,?)').run(hash('d'.repeat(64)), 2, future);
  archive('v2_plugins', 1, { code: 'traffic_report', is_enabled: '1', config: JSON.stringify({ webhook_url: hook, authorization_header: auth, top_limit: 5 }) });
  const server = (id: number, parent_id = 0) => archive('v2_server', id, { id, name: `Synthetic SS ${id}`, parent_id, type: 'shadowsocks', host: `ss-${id}.example.test`, port: 443, server_port: 8000 + id, enabled: 1, show: 1, group_ids: [1], created_at: '1700000000', protocol_settings: { cipher: '2022-blake3-aes-128-gcm' } });
  server(10); server(11, 10); server(20);
  archive('v2_server_machine', 2, { id: 2, name: 'Synthetic Machine', host: 'runtime.example.test' });
  archive('v2_server_machine_binding', 1, { id: 1, machine_id: 2, server_id: 10 });
  archive('v2_server_machine_binding', 2, { id: 2, machine_id: 2, server_id: 11 });
  archive('v2_outbound_template', 1, { id: 1, name: 'Synthetic exit', type: 'socks', enabled: 1, settings: { server: 'exit.example.invalid', server_port: 1080, username: 'SYNTHETIC-EXIT-USER', password: 'SYNTHETIC-EXIT-SECRET' } });
  archive('v2_server_outbound_template', 1, { id: 1, server_id: 10, outbound_template_id: 1, tag: 'synthetic-exit', enabled: 1 });
  archive('v2_server_route_profile', 1, { id: 1, server_id: 10, uuid: profile, name: 'Synthetic profile', enabled: 1, entry_server_ids: [10, 11], outbound_template_id: 1 });
  archive('v2_server_route_profile', 2, { id: 2, server_id: 20, uuid: foreignProfile, name: 'Foreign root profile', enabled: 1, entry_server_ids: [20] });
  archive('v2_server_route_profile', 3, { id: 3, server_id: 10, uuid: restrictedProfile, name: 'Sibling-only profile', enabled: 1, entry_server_ids: [11], outbound_template_id: 1 });
  initializeRuntime(db);
  restoreRuntime(db);
  db.exec(`CREATE TABLE runtime_traffic_batches(machine_id INTEGER NOT NULL,batch_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(machine_id,batch_id));
    CREATE TABLE runtime_node_traffic(node_id INTEGER NOT NULL,user_id INTEGER NOT NULL,date TEXT NOT NULL,upload_bytes INTEGER NOT NULL DEFAULT 0,download_bytes INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(node_id,user_id,date));`);
  if (options.baseline) {
    db.query('INSERT INTO traffic_daily VALUES(?,?,?,?)').run(1, '2026-10-13', 50, 10);
    db.query('INSERT INTO runtime_node_traffic VALUES(?,?,?,?,?)').run(10, 1, '2026-10-13', 50, 10);
    const record_at = Date.parse('2026-10-13T00:00:00+08:00') / 1000;
    archive('v2_stat_server', 'history-node', { server_id: 10, record_type: 'd', record_at, u: '40', d: '0' });
    archive('v2_stat_user', 'history-user', { user_id: 1, record_type: 'd', record_at, u: '40', d: '0' });
    archive('v2_user_node_traffic', 'history-user-node', { user_id: 1, server_id: 10, record_type: 'd', record_at, profile_uuid: '', u: '40', d: '0' });
  }
  initializeTrafficReports(db, { now: seedAt });
  const token = provisionMachineToken(db, 2);
  async function request(path: string, method = 'GET', data?: unknown, cookie?: string, extra?: HeadersInit) {
    const headers = new Headers(extra);
    headers.set('host', headers.get('host') ?? 'panel.example.test');
    if (cookie) headers.set('cookie', cookie);
    if (!['GET', 'HEAD'].includes(method) && !path.startsWith('/api/node/')) headers.set('origin', headers.get('origin') ?? panel);
    if (data !== undefined) headers.set('content-type', 'application/json');
    const response = await app.fetch(new Request(`${panel}${path}`, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }));
    const text = await response.text();
    let body: any; try { body = JSON.parse(text); } catch { body = text; }
    return { response, status: response.status, text, body, data: body?.data };
  }
  const admin = (suffix: string, method = 'GET', data?: unknown) => request(`${root}/${suffix}`, method, data, adminCookie);
  const record = (patch: Record<string, unknown> = {}) => ({ user_id: 1, node_id: 10, upload_bytes: 100, download_bytes: 0, ...patch });
  const traffic = (batch_id: string, records: unknown[]) => request('/api/node/v1/traffic', 'POST', { batch_id, records }, undefined, { authorization: `Bearer ${token}` });
  const countJobs = () => (db.query('SELECT COUNT(*) n FROM traffic_report_runs').get() as { n: number }).n;
  const ledgers = () => ({
    users: db.query('SELECT id,upload_bytes,download_bytes FROM users ORDER BY id').all(),
    daily: db.query('SELECT * FROM traffic_daily ORDER BY user_id,date').all(),
    nodes: db.query('SELECT * FROM runtime_node_traffic ORDER BY node_id,user_id,date').all(),
    hourly: db.query('SELECT * FROM traffic_report_hourly ORDER BY source,user_id,node_id,profile_id,hour').all(),
    batches: db.query('SELECT * FROM runtime_traffic_batches ORDER BY machine_id,batch_id').all(),
  });
  return { app, db, request, admin, archive, traffic, record, token, userCookie, adminCookie, countJobs, ledgers, setNow: (at: Date) => { clock = at; } };
}

function safe(text: string) {
  for (const value of [hook, 'private-hook-path', 'SYNTHETIC-QUERY-SECRET', 'SYNTHETIC-AUTH-SECRET', 'SYNTHETIC-EXIT-SECRET']) expect(text).not.toContain(value);
}

describe('traffic report HTTP authorization and safe DTOs', () => {
  test('every report route requires a browser session, not a runtime bearer', async () => {
    const f = fixture();
    for (const [suffix, method, data] of routes) {
      expect((await f.request(`${root}/${suffix}`, method, data)).status).toBe(401);
      const bearer = await f.request(`${root}/${suffix}`, method, data, undefined, { authorization: `Bearer ${f.token}` });
      expect(bearer.status).toBe(401); safe(bearer.text); expect(bearer.text).not.toContain(sourceEmail);
    }
    expect(f.countJobs()).toBe(0);
  });
  test('ordinary users cannot read settings, runs, private previews or enqueue', async () => {
    const f = fixture();
    for (const [suffix, method, data] of routes) {
      const r = await f.request(`${root}/${suffix}`, method, data, f.userCookie);
      expect(r.status).toBe(403); expect(r.body.error.code).toBe('ADMIN_REQUIRED'); safe(r.text); expect(r.text).not.toContain(sourceEmail);
    }
    expect(f.countJobs()).toBe(0);
  });
  test('foreign Origin blocks all report mutations before any writes', async () => {
    const f = fixture(), before = (await f.admin('settings')).data;
    for (const [suffix, method, data] of routes.filter(([, method]) => method !== 'GET')) {
      expect((await f.request(`${root}/${suffix}`, method, data, f.adminCookie, { origin: 'https://foreign.example.test' })).status).toBe(403);
    }
    expect((await f.admin('settings')).data).toEqual(before); expect(f.countJobs()).toBe(0);
    expect(f.db.query('SELECT * FROM audit').all()).toEqual([]);
  });
  test('subscription Host hides every report GET and POST route', async () => {
    const f = fixture();
    for (const [suffix, method, data] of routes) expect((await f.request(`${root}/${suffix}`, method, data, f.adminCookie, { host: 'sub.example.test' })).status).toBe(404);
    expect(f.countJobs()).toBe(0);
  });
  test('archive config seeds safe settings once and edits survive repeated initialization', async () => {
    const f = fixture(), r = await f.admin('settings');
    expect(r.status).toBe(200);
    expect(r.data).toMatchObject({ enabled: true, webhook_configured: true, authorization_configured: true, url_display: 'report.example.invalid', top_limit: 5, timezone: 'Asia/Shanghai', revision: 1 });
    expect(Object.keys(r.data).sort()).toEqual(['authorization_configured', 'enabled', 'revision', 'schedule', 'timezone', 'top_limit', 'url_display', 'webhook_configured']);
    safe(r.text); expect(r.text).not.toContain(sourceEmail);
    const snapshot = (f.db.query('SELECT legacy_snapshot FROM traffic_report_seed').get() as any).legacy_snapshot;
    expect(JSON.parse(JSON.parse(snapshot).plugin.config).authorization_header).toBe(auth);
    expect((await f.admin('settings', 'PATCH', { top_limit: 7, enabled: false })).status).toBe(200);
    initializeTrafficReports(f.db, { now: reportAt });
    expect((await f.admin('settings')).data).toMatchObject({ top_limit: 7, enabled: false });
    expect((f.db.query('SELECT legacy_snapshot FROM traffic_report_seed').get() as any).legacy_snapshot).toBe(snapshot);
  });
  test('PATCH omitted secrets and null auth keep exact stored strings', async () => {
    const f = fixture();
    for (const patch of [{ top_limit: 8 }, { authorization_header: null }, {}]) {
      const r = await f.admin('settings', 'PATCH', patch); expect(r.status).toBe(200); safe(r.text);
      expect(f.db.query('SELECT webhook_url,authorization_header FROM traffic_report_settings').get()).toEqual({ webhook_url: hook, authorization_header: auth });
    }
  });
  test('PATCH null URL clears only the URL, empty auth clears authorization', async () => {
    const f = fixture();
    const clearedURL = await f.admin('settings', 'PATCH', { webhook_url: null, authorization_header: null });
    expect(clearedURL.data).toMatchObject({ webhook_configured: false, url_display: null, authorization_configured: true });
    expect(f.db.query('SELECT webhook_url,authorization_header FROM traffic_report_settings').get()).toEqual({ webhook_url: '', authorization_header: auth });
    const clearedAuth = await f.admin('settings', 'PATCH', { authorization_header: '' });
    expect(clearedAuth.data.authorization_configured).toBe(false); safe(clearedAuth.text);
  });
  test('PATCH accepts top-limit endpoints 1 and 100 and rejects invalid ranges/types atomically', async () => {
    const f = fixture();
    for (const top_limit of [1, 100]) expect((await f.admin('settings', 'PATCH', { top_limit })).data.top_limit).toBe(top_limit);
    const before = (await f.admin('settings')).data, audits = f.db.query('SELECT * FROM audit').all();
    for (const patch of [{ top_limit: 0 }, { top_limit: 101 }, { top_limit: 1.5 }, { top_limit: '5' }, { enabled: 1 }, { timezone: 'UTC' }, { allowPrivate: true }]) {
      const r = await f.admin('settings', 'PATCH', patch); expect(r.status).toBe(400); safe(r.text);
      expect((await f.admin('settings')).data).toEqual(before);
    }
    expect(f.db.query('SELECT * FROM audit').all()).toEqual(audits);
  });
  test('ReportError becomes a Chinese API error without reflecting submitted secret/body', async () => {
    const f = fixture(), before = (await f.admin('settings')).data;
    for (const patch of [{ webhook_url: 'http://invalid.example.test/SYNTHETIC-BODY-SECRET' }, { authorization_header: 'SYNTHETIC-BODY-SECRET\r\nInjected: value' }]) {
      const r = await f.admin('settings', 'PATCH', patch);
      expect(r.status).toBe(400); expect(r.body.error.code).toBe('INVALID_CONFIG'); expect(r.body.error.message).toMatch(/[\u4e00-\u9fff]/);
      expect(r.text).not.toContain('SYNTHETIC-BODY-SECRET'); expect(r.text).not.toContain('Injected'); safe(r.text);
    }
    expect((await f.admin('settings')).data).toEqual(before); expect(f.countJobs()).toBe(0);
  });
  test('HEAD and wrong methods do not alias preview or enqueue routes', async () => {
    const f = fixture();
    for (const suffix of ['preview', 'send', 'test']) {
      expect((await f.admin(suffix)).status).toBe(404);
      expect((await f.request(`${root}/${suffix}`, 'HEAD', undefined, f.adminCookie)).status).toBe(404);
    }
    expect((await f.admin('settings', 'POST', { enabled: false })).status).toBe(404); expect(f.countJobs()).toBe(0);
  });
});

describe('traffic report preview and durable enqueue HTTP contract', () => {
  test('authorized preview exposes account email only in its private report, without enqueue', async () => {
    const f = fixture(); f.setNow(trafficAt);
    expect((await f.traffic('preview-data', [f.record()])).status).toBe(200); f.setNow(reportAt);
    const r = await f.admin('preview', 'POST', { kind: 'daily' });
    expect(r.status).toBe(200); expect(r.data).toMatchObject({ kind: 'daily', start_date: '2026-10-13', end_date: '2026-10-13', timezone: 'Asia/Shanghai' });
    expect(r.data.users[0]).toMatchObject({ label: sourceEmail, bytes: '100' }); expect(r.data.message).toContain(sourceEmail); safe(r.text); expect(f.countJobs()).toBe(0);
  });
  test('all preview kinds use the fixed Shanghai calendar, test kind is synthetic', async () => {
    const f = fixture(); f.setNow(reportAt);
    for (const [kind, start_date, end_date] of [['daily', '2026-10-13', '2026-10-13'], ['weekly', '2026-10-07', '2026-10-13'], ['monthly', '2026-09-01', '2026-09-30']]) {
      const r = await f.admin('preview', 'POST', { kind }); expect(r.status).toBe(200); expect(r.data).toMatchObject({ kind, start_date, end_date, timezone: 'Asia/Shanghai' });
    }
    const r = await f.admin('preview', 'POST', { kind: 'test' }); expect(r.status).toBe(200); expect(r.data.users).toEqual([]); expect(r.data.message).toContain('真实发送'); expect(r.text).not.toContain(sourceEmail); expect(f.countJobs()).toBe(0);
  });
  test('mixed archived history, UTC baseline and post-hook traffic retain warnings and all bytes', async () => {
    const f = fixture({ baseline: true }); f.setNow(trafficAt);
    expect((await f.traffic('post-hook', [f.record({ upload_bytes: 20 })])).status).toBe(200);
    f.db.exec('UPDATE traffic_daily SET upload_bytes=9999; UPDATE runtime_node_traffic SET upload_bytes=9999');
    f.setNow(reportAt);
    const r = await f.admin('preview', 'POST', { kind: 'daily' }); expect(r.status).toBe(200);
    expect(r.data.users[0].bytes).toBe('120'); expect(r.data.nodes[0].bytes).toBe('120');
    for (const warning of ['missing-history-boundary_warning', 'intersecting-utc-day-included-whole', 'pre-upgrade-profiles-merged-into-entry-node', 'baseline_rows:users=1,node_users=1', 'baseline_utc_dates:2026-10-13', 'utc-day-attributed-to-same-calendar-label']) expect(r.data.warnings).toContain(warning);
    expect(r.data.message).toContain('历史口径'); expect(f.countJobs()).toBe(0);
  });
  test('send returns 202 safe queued DTO and never processes the job during HTTP handling', async () => {
    const f = fixture(); f.setNow(trafficAt); await f.traffic('queued-data', [f.record()]); f.setNow(reportAt);
    const r = await f.admin('send', 'POST', { kind: 'daily', idempotency_key: 'daily-send' });
    expect(r.status).toBe(202); expect(r.data).toMatchObject({ kind: 'daily', status: 'queued', attempts: 0, http_status: null, error_code: null });
    expect(Object.keys(r.data).sort()).toEqual(['attempts', 'created_at', 'end_date', 'error_code', 'http_status', 'id', 'kind', 'next_attempt_at', 'period_key', 'start_date', 'status', 'timezone']);
    safe(r.text); expect(r.text).not.toContain(sourceEmail); expect(r.data.message).toBeUndefined();
    const job = f.db.query('SELECT message,status,attempts FROM traffic_report_runs WHERE id=?').get(r.data.id) as any;
    expect(job.status).toBe('queued'); expect(job.attempts).toBe(0); expect(job.message).toContain(sourceEmail);
    const list = await f.admin('runs'); expect(list.status).toBe(200); expect(list.data).toEqual([r.data]); safe(list.text); expect(list.text).not.toContain(sourceEmail); expect(list.text).not.toContain('message');
  });
  test('test enqueue saves a synthetic labeled message rather than any source account email', async () => {
    const f = fixture(); f.setNow(trafficAt); await f.traffic('test-data', [f.record()]); f.setNow(reportAt);
    const r = await f.admin('test', 'POST', { idempotency_key: 'synthetic-test' });
    expect(r.status).toBe(202); expect(r.data).toMatchObject({ kind: 'test', status: 'queued', attempts: 0 }); safe(r.text); expect(r.text).not.toContain(sourceEmail);
    const job = f.db.query('SELECT message FROM traffic_report_runs WHERE id=?').get(r.data.id) as any;
    expect(job.message).toContain('真实发送'); expect(job.message).not.toContain(sourceEmail); expect(job.message).not.toContain('@');
  });
  test('same idempotency key has one job, changing kind rejects without another write', async () => {
    const f = fixture(); f.setNow(reportAt);
    const a = await f.admin('send', 'POST', { kind: 'daily', idempotency_key: 'repeat-key' });
    const b = await f.admin('send', 'POST', { kind: 'daily', idempotency_key: 'repeat-key' });
    expect(a.status).toBe(202); expect(b.status).toBe(202); expect(b.data).toEqual(a.data); expect(f.countJobs()).toBe(1);
    const audits = f.db.query('SELECT * FROM audit').all();
    const conflict = await f.admin('send', 'POST', { kind: 'weekly', idempotency_key: 'repeat-key' });
    expect(conflict.status).toBe(400); expect(conflict.body.error.code).toBe('INVALID_CONFIG'); safe(conflict.text); expect(f.countJobs()).toBe(1); expect(f.db.query('SELECT * FROM audit').all()).toEqual(audits);
    const t = await f.admin('test', 'POST', { idempotency_key: 'repeat-test' });
    expect((await f.admin('send', 'POST', { kind: 'test', idempotency_key: 'repeat-test' })).data.id).toBe(t.data.id); expect(f.countJobs()).toBe(2);
  });
  test('invalid kind, idempotency key, extra fields and oversized JSON cannot create jobs', async () => {
    const f = fixture();
    for (const [suffix, data] of [['preview', { kind: 'yearly' }], ['preview', { kind: 'daily', message: 'SYNTHETIC-BODY-SECRET' }], ['send', { kind: 'daily' }], ['send', { kind: 'daily', idempotency_key: 'bad key' }], ['send', { kind: 'daily', idempotency_key: 'x'.repeat(129) }], ['send', { kind: 'daily', idempotency_key: 'valid', webhook_url: hook }], ['test', { kind: 'daily', idempotency_key: 'invalid-test' }]]) {
      const r = await f.admin(suffix as string, 'POST', data); expect(r.status).toBe(400); safe(r.text); expect(r.text).not.toContain('SYNTHETIC-BODY-SECRET');
    }
    const huge = await f.admin('send', 'POST', { kind: 'daily', idempotency_key: 'huge', padding: 'x'.repeat(1048576) });
    expect(huge.status).toBe(413); expect(huge.body.error.code).toBe('BODY_LIMIT'); expect(f.countJobs()).toBe(0); expect(f.db.query('SELECT * FROM audit').all()).toEqual([]);
  });
  test('unconfigured webhook returns sanitized error instead of enqueueing', async () => {
    const f = fixture(); await f.admin('settings', 'PATCH', { webhook_url: null });
    for (const suffix of ['send', 'test']) {
      const r = await f.admin(suffix, 'POST', suffix === 'send' ? { kind: 'daily', idempotency_key: 'no-hook-send' } : { idempotency_key: 'no-hook-test' });
      expect(r.status).toBe(400); expect(r.body.error.code).toBe('INVALID_CONFIG'); safe(r.text);
    }
    expect(f.countJobs()).toBe(0);
  });
  test.each(['settings', 'preview', 'test'])('delayed %s body rejects an administrator whose role changed', async suffix => {
    const f = fixture(); let writer!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
    const before = (await f.admin('settings')).data;
    const pending = f.app.fetch(new Request(`${panel}${root}/${suffix}`, { method: suffix === 'settings' ? 'PATCH' : 'POST', headers: { host: 'panel.example.test', origin: panel, cookie: f.adminCookie, 'content-type': 'application/json' }, body }));
    expect((await f.admin('settings')).status).toBe(200);
    f.db.exec("UPDATE users SET role='user' WHERE id=2");
    writer.enqueue(new TextEncoder().encode(JSON.stringify(suffix === 'settings' ? { top_limit: 9 } : suffix === 'preview' ? { kind: 'daily' } : { idempotency_key: 'late-test' }))); writer.close();
    const r = await pending; expect(r.status).toBe(403); expect(await r.text()).not.toContain(sourceEmail);
    expect(f.countJobs()).toBe(0); expect(f.db.query('SELECT * FROM audit').all()).toEqual([]);
    expect((f.db.query('SELECT top_limit FROM traffic_report_settings').get() as any).top_limit).toBe(before.top_limit);
  });
  test.each(['role', 'session'])('delayed body rechecks current administrator %s before enqueue', async mode => {
    const f = fixture(); let writer!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
    const pending = f.app.fetch(new Request(`${panel}${root}/send`, { method: 'POST', headers: { host: 'panel.example.test', origin: panel, cookie: f.adminCookie, 'content-type': 'application/json' }, body }));
    // A read request proves dispatch reached its first await before releasing the mutation body.
    expect((await f.admin('settings')).status).toBe(200);
    if (mode === 'role') f.db.exec("UPDATE users SET role='user' WHERE id=2"); else f.db.exec('DELETE FROM sessions WHERE user_id=2');
    writer.enqueue(new TextEncoder().encode(JSON.stringify({ kind: 'daily', idempotency_key: 'late-admin' }))); writer.close();
    expect((await pending).status).toBe(mode === 'role' ? 403 : 401); expect(f.countJobs()).toBe(0); expect(f.db.query('SELECT * FROM audit').all()).toEqual([]);
  });
});

describe('profile-aware runtime traffic HTTP ledger integration', () => {
  test('base 100 plus profile 20 bills 120 once while report partitions stay 100 and 20', async () => {
    const f = fixture(); f.setNow(trafficAt);
    const config = await f.request('/api/node/v1/config', 'GET', undefined, undefined, { authorization: `Bearer ${f.token}` });
    expect(config.status).toBe(200); expect(config.data.traffic_labels.some((v: any) => v.label === `mb:u:1:n:10:p:${profile}`)).toBe(true);
    const records = [f.record(), f.record({ profile_id: profile, upload_bytes: 20 })];
    expect((await f.traffic('partitioned', records)).status).toBe(200);
    const before = f.ledgers(); expect((await f.traffic('partitioned', records)).status).toBe(200); expect(f.ledgers()).toEqual(before);
    expect(f.db.query('SELECT upload_bytes,download_bytes FROM users WHERE id=1').get()).toEqual({ upload_bytes: 120, download_bytes: 0 });
    expect(f.db.query('SELECT upload_bytes,download_bytes FROM traffic_daily WHERE user_id=1').get()).toEqual({ upload_bytes: 120, download_bytes: 0 });
    expect(f.db.query('SELECT upload_bytes,download_bytes FROM runtime_node_traffic WHERE node_id=10').get()).toEqual({ upload_bytes: 120, download_bytes: 0 });
    expect(f.db.query('SELECT profile_id,upload_bytes,download_bytes FROM traffic_report_hourly ORDER BY profile_id').all()).toEqual([{ profile_id: '', upload_bytes: '100', download_bytes: '0' }, { profile_id: profile, upload_bytes: '20', download_bytes: '0' }]);
    f.setNow(reportAt); const p = await f.admin('preview', 'POST', { kind: 'daily' });
    expect(p.data.users[0].bytes).toBe('120'); expect(p.data.nodes.map((n: any) => n.bytes)).toEqual(['100', '20']);
  });
  test('canonical profile on an allowed child is attributed separately from its physical entry', async () => {
    const f = fixture(); f.setNow(trafficAt);
    expect((await f.traffic('child-profile', [f.record({ node_id: 11, profile_id: profile, upload_bytes: 20 })])).status).toBe(200);
    expect(f.db.query('SELECT node_id,profile_id,upload_bytes FROM traffic_report_hourly').get()).toEqual({ node_id: 11, profile_id: profile, upload_bytes: '20' });
    expect(f.db.query('SELECT node_id,upload_bytes FROM runtime_node_traffic').get()).toEqual({ node_id: 11, upload_bytes: 20 });
  });
  test('wrong root or forbidden sibling profile rolls back every ledger and the whole batch', async () => {
    const f = fixture(); f.setNow(trafficAt);
    for (const pid of [foreignProfile, restrictedProfile, 'unknown-profile']) {
      const before = f.ledgers(); const r = await f.traffic(`wrong-${pid}`, [f.record(), f.record({ profile_id: pid, upload_bytes: 20 })]);
      expect(r.status).toBe(403); expect(r.body.error.code).toBe('TRAFFIC_GRANT'); expect(f.ledgers()).toEqual(before); safe(r.text);
    }
  });
  test('omitted profile is accepted as empty base partition, malformed and reserved profiles reject atomically', async () => {
    const f = fixture(); f.setNow(trafficAt);
    expect((await f.traffic('zero-only', [f.record({ upload_bytes: 0, download_bytes: 0 })])).status).toBe(200);
    expect(f.db.query('SELECT COALESCE(SUM(CAST(upload_bytes AS INTEGER)),0) upload_bytes,COALESCE(SUM(CAST(download_bytes AS INTEGER)),0) download_bytes FROM traffic_report_hourly').get()).toEqual({ upload_bytes: 0, download_bytes: 0 });
    expect(f.db.query('SELECT upload_bytes,download_bytes FROM users WHERE id=1').get()).toEqual({ upload_bytes: 0, download_bytes: 0 });
    expect((await f.traffic('base-only', [f.record({ upload_bytes: 1 })])).status).toBe(200);
    expect((f.db.query('SELECT profile_id FROM traffic_report_hourly').get() as any).profile_id).toBe('');
    for (const profile_id of ['0', '', null, 1, {}, '出口', 'bad\nprofile', 'x'.repeat(65)]) {
      const before = f.ledgers(); const r = await f.traffic(`bad-${String(profile_id)}`, [f.record(), f.record({ profile_id })]);
      expect(r.status).toBe(400); expect(f.ledgers()).toEqual(before);
    }
  });
  test('revoked group grant rejects profile traffic without touching account, node or report ledgers', async () => {
    const f = fixture(); f.setNow(trafficAt); f.db.exec('DELETE FROM user_groups WHERE user_id=1');
    const before = f.ledgers(), r = await f.traffic('revoked-profile', [f.record({ profile_id: profile })]);
    expect(r.status).toBe(403); expect(f.ledgers()).toEqual(before);
  });
  test('basic and runtime sources with colliding node and batch IDs retain independent hourly partitions', async () => {
    const f = fixture(); f.setNow(trafficAt); const legacyToken = 'e'.repeat(64);
    f.db.query('INSERT INTO machines(id,name,host,token_hash) VALUES(?,?,?,?)').run(2, 'Synthetic basic machine', 'basic.example.test', hash(legacyToken));
    f.db.query('INSERT INTO nodes(id,name,host,port,protocol,machine_id,tls,created_at) VALUES(?,?,?,?,?,?,?,?)').run(10, 'Synthetic basic node', 'basic.example.test', 443, 'shadowsocks', 2, 0, seedAt.toISOString());
    f.db.exec('INSERT INTO node_groups VALUES(10,1)');
    const basic = () => f.request('/api/node/v1/traffic', 'POST', { batch_id: 'same-source-id', records: [f.record({ upload_bytes: 7 })] }, undefined, { authorization: `Bearer ${legacyToken}` });
    expect((await basic()).status).toBe(200); expect((await basic()).status).toBe(200);
    expect((await f.traffic('same-source-id', [f.record()])).status).toBe(200);
    expect((await f.traffic('same-source-id', [f.record()])).status).toBe(200);
    expect(f.db.query('SELECT source,profile_id,upload_bytes FROM traffic_report_hourly ORDER BY source').all()).toEqual([{ source: 'basic', profile_id: '', upload_bytes: '7' }, { source: 'runtime', profile_id: '', upload_bytes: '100' }]);
    expect(f.db.query('SELECT upload_bytes,download_bytes FROM users WHERE id=1').get()).toEqual({ upload_bytes: 107, download_bytes: 0 });
    expect(f.db.query('SELECT batch_id FROM traffic_batches').all()).toEqual([{ batch_id: 'same-source-id' }]);
    expect(f.db.query('SELECT batch_id FROM runtime_traffic_batches').all()).toEqual([{ batch_id: 'same-source-id' }]);
  });
  test('unsafe counter fails before any profile report row or batch is committed', async () => {
    const f = fixture(); f.setNow(trafficAt); const before = f.ledgers();
    for (const upload_bytes of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await f.traffic('bad-counter', [f.record({ profile_id: profile, upload_bytes })])).status).toBe(400); expect(f.ledgers()).toEqual(before);
    }
  });
});
