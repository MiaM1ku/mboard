import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/server/app';
import { hash } from '../src/server/database';
import { runtimeNodeViews } from '../src/server/runtime';
import { poolCycle } from '../src/server/traffic-pools';

// Synthetic rows only. Every app owns its own in-memory database and closes after the test.
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.close(); });
const future = '2099-01-01T00:00:00.000Z';
const origin = 'https://panel.example.test';
const GiB = 1024 ** 3;

function fixture() {
  let clock = new Date('2026-10-20T04:00:00Z');
  const token = 'f'.repeat(64);
  const app = createApp({ now: () => clock, publicOrigin: origin });
  apps.push(app);
  const db = app.db;
  db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,quota_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(1, 'reader@example.test', 'Reader', 'user', 'synthetic', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a'.repeat(64), 0, future, future);
  db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,created_at) VALUES(?,?,?,?,?,?,?,?)').run(2, 'admin@example.test', 'Admin', 'admin', 'synthetic', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b'.repeat(64), future);
  db.exec("INSERT INTO groups(id,name) VALUES(1,'Pool'),(2,'Other'); INSERT INTO user_groups VALUES(1,1);");
  for (const [uid, value] of [[1, 'c'.repeat(64)],[2, 'd'.repeat(64)]] as const) db.query('INSERT INTO sessions VALUES(?,?,?)').run(hash(value), uid, future);
  db.query('INSERT INTO runtime_machines(id,state,active,token_hash,core_ready,telemetry_ready,core_version,payload) VALUES(?,?,?,?,?,?,?,?)').run(2, 'active', 1, hash(token), 1, 1, '1.14', JSON.stringify({ id: 2, name: 'HK IX', host: 'hk.example.test' }));
  db.query('INSERT INTO runtime_machines(id,state,active,token_hash,core_ready,telemetry_ready,core_version,payload) VALUES(?,?,?,?,?,?,?,?)').run(3, 'active', 1, hash('e'.repeat(64)), 1, 1, '1.14', JSON.stringify({ id: 3, name: 'Bage HK', host: 'bage.example.test' }));
  const node = (id: number, name: string, parent: number, port: number) => db.query('INSERT INTO runtime_nodes VALUES(?,?,?,?,?,?)').run(id, parent || null, 'shadowsocks', 1, 1, JSON.stringify({ id, name, parent_id: parent || 0, host: name + '.example.test', port, server_port: port, type: 'shadowsocks', enabled: 1, show: 1, group_ids: [1], created_at: '1700000000', rate: 1 }));
  node(10, 'Tencent IX', 0, 8000);
  node(11, 'Tencent IX entry', 10, 8001);
  node(12, 'Bage HK', 0, 8002);
  db.query('INSERT INTO runtime_nodes VALUES(?,?,?,?,?,?)').run(13, null, 'vless', 1, 1, JSON.stringify({ id: 13, name: 'Other group', parent_id: 0, host: 'other.example.test', port: 8003, server_port: 8003, type: 'vless', enabled: 1, show: 1, group_ids: [2], created_at: '1700000000' }));
  db.query('INSERT INTO runtime_bindings VALUES(?,?,?)').run(3, 13, '{}');
  db.query('INSERT INTO runtime_bindings VALUES(?,?,?)').run(2, 10, '{}');
  db.query('INSERT INTO runtime_bindings VALUES(?,?,?)').run(3, 12, '{}');
  const userCookie = `mboard_session=${'c'.repeat(64)}`, adminCookie = `mboard_session=${'d'.repeat(64)}`;
  async function request(path: string, method = 'GET', data?: unknown, cookie?: string, extra?: HeadersInit) {
    const headers = new Headers(extra);
    headers.set('host', 'panel.example.test');
    if (cookie) headers.set('cookie', cookie);
    if (!['GET','HEAD'].includes(method) && !path.startsWith('/api/node/')) headers.set('origin', origin);
    if (data !== undefined) headers.set('content-type','application/json');
    const response = await app.fetch(new Request(origin + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }));
    const text = await response.text(); let body: any; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, text, body, data: body?.data };
  }
  const traffic = (batch: string, records: unknown[]) => request('/api/node/v1/traffic', 'POST', { batch_id: batch, records }, undefined, { authorization: `Bearer ${token}` });
  const record = (patch: Record<string, any> = {}) => ({ user_id: 1, node_id: 10, upload_bytes: 5, download_bytes: 7, ...patch });
  const pool = (patch: Record<string, any> = {}) => ({ name: 'Tencent IX', kind: 'entry', quota_bytes: 3 * 1024 * GiB, reset_day: 1, billing: 'single', visible_to_users: true, members: [{ type: 'node', id: 10 }], ...patch });
  const createPool = (patch: Record<string, any> = {}) => request('/api/v1/admin/traffic-pools', 'POST', pool(patch), adminCookie);
  const usage = async (id: number) => (await request('/api/v1/admin/traffic-pools', 'GET', undefined, adminCookie)).data.find((item: any) => item.id === id).usage;
  return { app, db, request, traffic, record, pool, createPool, usage, userCookie, adminCookie, setNow: (at: Date) => { clock = at; }, hash };
}

describe('pool cycles', () => {
  test('reset day follows Shanghai time and clamps to the end of short months', () => {
    const beforeMidnight = new Date('2026-02-28T15:59:59Z');
    expect(poolCycle(beforeMidnight, 1)).toMatchObject({ start_date: '2026-02-01', end_date: '2026-03-01' });
    expect(poolCycle(new Date('2026-03-01T04:00:00Z'), 1)).toMatchObject({ start_date: '2026-03-01', end_date: '2026-04-01' });
    expect(poolCycle(new Date('2026-02-15T04:00:00Z'), 31)).toMatchObject({ start_date: '2026-01-31', end_date: '2026-02-28' });
    expect(poolCycle(new Date('2026-03-31T04:00:00Z'), 31)).toMatchObject({ start_date: '2026-03-31', end_date: '2026-04-30' });
  });
});

describe('traffic pool administration', () => {
  test('pools save with members and reject duplicates, bad limits and foreign accounts', async () => {
    const f = fixture();
    expect((await f.request('/api/v1/admin/traffic-pools', 'POST', f.pool(), f.userCookie)).status).toBe(403);
    const created = await f.createPool({ members: [{ type: 'node', id: 10 }, { type: 'machine', id: 2 }] });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ name: 'Tencent IX', kind: 'entry', reset_day: 1, billing: 'single', visible_to_users: true });
    expect(created.data.members.map((member: any) => `${member.type}:${member.id}`)).toEqual(['machine:2','node:10']);
    expect(created.data.usage.quota_bytes).toBe(3 * 1024 * GiB);
    expect((await f.createPool()).status).toBe(400);
    for (const patch of [{ quota_bytes: 0 }, { reset_day: 32 }, { kind: 'billing' }, { members: [] }, { members: [{ type: 'node', id: 99 }] }, { name: '' }]) {
      const r = await f.createPool({ name: 'Other pool', ...patch });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION');
    }
    expect((await f.request('/api/v1/admin/traffic-pools', 'PATCH', { quota_bytes: 2 * 1024 * GiB }, f.adminCookie)).status).toBe(404);
    expect((await f.request(`/api/v1/admin/traffic-pools/${created.data.id}`, 'PATCH', { reset_day: 10, billing: 'double' }, f.adminCookie)).data).toMatchObject({ reset_day: 10, billing: 'double' });
    expect((await f.request(`/api/v1/admin/traffic-pools/${created.data.id}`, 'DELETE', undefined, f.adminCookie)).status).toBe(200);
    expect((await f.request('/api/v1/admin/traffic-pools', 'GET', undefined, f.adminCookie)).data).toEqual([]);
  });
  test('node ingest writes hourly rows once per batch and is attributed to the reporting machine', async () => {
    const f = fixture();
    expect((await f.traffic('first', [f.record()])).status).toBe(200);
    expect((await f.traffic('first', [f.record()])).status).toBe(200);
    expect(f.db.query('SELECT machine_id,node_id,upload_bytes,download_bytes FROM runtime_traffic_hourly').all()).toEqual([{ machine_id: 2, node_id: 10, upload_bytes: 5, download_bytes: 7 }]);
  });
  test('a node and its machine count once, and double billing doubles the measured bytes', async () => {
    const f = fixture();
    expect((await f.traffic('once', [f.record({ upload_bytes: 100, download_bytes: 50 })])).status).toBe(200);
    const both = await f.createPool({ members: [{ type: 'node', id: 10 }, { type: 'machine', id: 2 }] });
    expect(both.data.usage).toMatchObject({ used_bytes: 150, upload_bytes: 100, download_bytes: 50, status: 'ok' });
    const doubled = await f.createPool({ name: 'Tencent IX doubled', billing: 'double' });
    expect(doubled.data.usage.used_bytes).toBe(300);
  });
  test('calibration adds the provider figure inside the cycle and stops at the next one', async () => {
    const f = fixture();
    await f.traffic('before-calibration', [f.record({ upload_bytes: 100, download_bytes: 0 })]);
    const created = await f.createPool({ calibration_bytes: 5000 });
    expect(created.data.usage).toMatchObject({ used_bytes: 5000, calibrated: true });
    f.setNow(new Date('2026-10-20T05:30:00Z'));
    await f.traffic('after-calibration', [f.record({ upload_bytes: 40, download_bytes: 10 })]);
    expect(await f.usage(created.data.id)).toMatchObject({ used_bytes: 5050, calibrated: true });
    f.setNow(new Date('2026-11-05T04:00:00Z'));
    expect(await f.usage(created.data.id)).toMatchObject({ used_bytes: 0, calibrated: false });
  });
  test('machine-wide pools flag traffic that belongs to a shared entry node', async () => {
    const f = fixture();
    f.db.query('INSERT INTO runtime_bindings VALUES(?,?,?)').run(3, 10, '{}');
    f.db.query('INSERT INTO runtime_traffic_hourly(machine_id,node_id,hour,upload_bytes,download_bytes) VALUES(?,?,?,?,?)').run(0, 10, Math.floor(Date.parse('2026-10-20T02:00:00Z') / 1000), 700, 300);
    const pool = await f.createPool({ name: 'Bage HK pool', members: [{ type: 'machine', id: 3 }] });
    expect(pool.data.usage.warnings.map((warning: any) => warning.code)).toContain('unattributed-machine-traffic');
    const partial = await f.createPool({ name: 'Fresh pool', members: [{ type: 'node', id: 11 }] });
    expect(partial.data.usage.warnings.map((warning: any) => warning.code)).toContain('partial-history');
  });
});

describe('user-facing flow', () => {
  test('user overview exposes only pool percentages for their own nodes', async () => {
    const f = fixture();
    await f.traffic('user-bytes', [f.record({ upload_bytes: 300, download_bytes: 200 })]);
    await f.createPool({ name: 'Tencent IX', members: [{ type: 'node', id: 10 }] });
    await f.createPool({ name: 'Bage HK pool', members: [{ type: 'machine', id: 2 }] });
    await f.createPool({ name: 'Hidden pool', members: [{ type: 'machine', id: 3 }], visible_to_users: false });
    await f.createPool({ name: 'Unrelated pool', members: [{ type: 'node', id: 13 }], visible_to_users: true });
    const overview = await f.request('/api/v1/overview', 'GET', undefined, f.userCookie);
    expect(overview.status).toBe(200);
    expect(overview.data.pools.map((item: any) => item.name)).toEqual(['Tencent IX', 'Bage HK pool']);
    expect(overview.data.pools[0]).toMatchObject({ kind: 'entry', status: 'ok' });
    expect(JSON.stringify(overview.data.pools)).not.toContain('quota_bytes');
    expect(JSON.stringify(overview.data.pools)).not.toContain('used_bytes');
    expect(overview.data.top_nodes[0]).toMatchObject({ id: 10, bytes: 500 });
    expect(overview.data.today_bytes).toMatchObject({ upload_bytes: 300, download_bytes: 200 });
  });
  test('node usage lists only this account, without connection details', async () => {
    const f = fixture();
    await f.traffic('mine', [f.record({ upload_bytes: 40, download_bytes: 60 })]);
    f.db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,created_at) VALUES(?,?,?,?,?,?,?,?)').run(4, 'other@example.test', 'Other', 'user', 'synthetic', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'e'.repeat(64), future);
    f.db.query('INSERT INTO user_groups VALUES(?,?)').run(4, 1);
    f.db.query('UPDATE runtime_node_traffic SET upload_bytes=9999 WHERE user_id=1').run();
    f.db.query('INSERT INTO runtime_node_traffic(node_id,user_id,date,upload_bytes,download_bytes) VALUES(?,?,?,?,?)').run(10, 4, '2026-10-20', 888, 888);
    const usage = await f.request('/api/v1/me/node-usage?days=7', 'GET', undefined, f.userCookie);
    expect(usage.status).toBe(200);
    const mine = usage.data.find((item: any) => item.id === 10);
    expect(mine).toMatchObject({ upload_bytes: 9999, download_bytes: 60, name: 'Tencent IX', last_used_date: '2026-10-20', available: false });
    expect(usage.data.map((item: any) => item.id).sort()).toEqual([10, 11, 12]);
    expect(usage.data.filter((item: any) => item.id !== 10).every((item: any) => item.total_bytes === 0)).toBe(true);
    expect(usage.text).not.toContain('888');
    for (const item of usage.data) for (const key of ['host', 'port', 'protocol', 'credential']) expect(item[key]).toBeUndefined();
    expect((await f.request('/api/v1/me/node-usage?days=5', 'GET', undefined, f.userCookie)).status).toBe(400);
  });
});
