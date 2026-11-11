import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/server/app';
import { hash } from '../src/server/database';

// Synthetic rows only. Every app owns its own in-memory database and closes after the test.
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.close(); });
const future = '2099-01-01T00:00:00.000Z';
const origin = 'https://panel.example.test';

function fixture() {
  let clock = new Date('2026-11-11T04:00:00Z');
  const runtimeToken = 'f'.repeat(64), basicToken = 'e'.repeat(64);
  const app = createApp({ now: () => clock, publicOrigin: origin });
  apps.push(app);
  const db = app.db;
  db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,quota_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(1, 'reader@example.test', 'Reader', 'user', 'synthetic', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a'.repeat(64), 0, future, future);
  db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,created_at) VALUES(?,?,?,?,?,?,?,?)').run(2, 'admin@example.test', 'Admin', 'admin', 'synthetic', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b'.repeat(64), future);
  db.exec("INSERT INTO groups(id,name) VALUES(1,'Shared'); INSERT INTO user_groups VALUES(1,1);");
  for (const [uid, value] of [[1, 'c'.repeat(64)], [2, 'd'.repeat(64)]] as const) db.query('INSERT INTO sessions VALUES(?,?,?)').run(hash(value), uid, future);
  db.query('INSERT INTO runtime_machines(id,state,active,token_hash,core_ready,telemetry_ready,core_version,payload) VALUES(?,?,?,?,?,?,?,?)').run(2, 'active', 1, hash(runtimeToken), 1, 1, '1.14', JSON.stringify({ id: 2, name: 'HK IX', host: 'hk.example.test' }));
  db.query('INSERT INTO runtime_nodes VALUES(?,?,?,?,?,?)').run(10, null, 'vless', 1, 1, JSON.stringify({ id: 10, name: 'HK Reality', parent_id: 0, host: 'hk.example.test', port: 443, server_port: 443, type: 'vless', enabled: 1, show: 1, group_ids: [1], created_at: '1700000000' }));
  db.query('INSERT INTO runtime_bindings VALUES(?,?,?)').run(2, 10, '{}');
  db.query('INSERT INTO machines(id,name,host,enabled,token_hash,config_revision) VALUES(?,?,?,?,?,?)').run(5, 'Legacy', 'legacy.example.test', 1, hash(basicToken), 1);
  db.query('INSERT INTO nodes(id,name,host,port,protocol,enabled,machine_id,tls,server_name,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(20, 'Legacy Node', 'legacy.example.test', 8443, 'vless', 1, 5, 1, 'legacy.example.test', future);
  const userCookie = `mboard_session=${'c'.repeat(64)}`, adminCookie = `mboard_session=${'d'.repeat(64)}`;
  async function request(path: string, method = 'GET', data?: unknown, cookie?: string, extra?: HeadersInit) {
    const headers = new Headers(extra);
    headers.set('host', 'panel.example.test');
    if (cookie) headers.set('cookie', cookie);
    if (!['GET', 'HEAD'].includes(method) && !path.startsWith('/api/node/')) headers.set('origin', origin);
    if (data !== undefined) headers.set('content-type', 'application/json');
    const response = await app.fetch(new Request(origin + path, { method, headers, body: data === undefined ? undefined : JSON.stringify(data) }));
    const text = await response.text(); let body: any; try { body = JSON.parse(text); } catch { body = text; }
    return { status: response.status, text, body, data: body?.data };
  }
  const seconds = () => Math.floor(clock.getTime() / 1000);
  const hour = (offset = -60) => Math.floor((seconds() + offset) / 3600) * 3600;
  const record = (patch: Record<string, any> = {}) => ({ user_id: 1, node_id: 10, hour: hour(), target: 'example.com:443', source_ip: '203.0.113.9', network: 'tcp', count: 1, first_at: hour() + 5, last_at: hour() + 50, ...patch });
  const report = (records: unknown[], batch = 'batch-1', token = runtimeToken) => request('/api/node/v1/connections', 'POST', { batch_id: batch, records }, undefined, { authorization: `Bearer ${token}` });
  const adminList = (query = '') => request(`/api/v1/admin/connections${query}`, 'GET', undefined, adminCookie);
  return { app, db, request, report, adminList, record, hour, seconds, setNow: (at: Date) => { clock = at; }, userCookie, adminCookie, runtimeToken, basicToken };
}

describe('connection report ingest', () => {
  test('stores aggregated rows and answers the node with counts', async () => {
    const f = fixture();
    const result = await f.report([f.record({ count: 3 })]);
    expect(result.status).toBe(200);
    expect(result.data).toEqual({ accepted: true, stored: 1, skipped: 0, reused: false });
    const page = await f.adminList();
    expect(page.status).toBe(200);
    expect(page.data).toMatchObject({ total: 1, connections: 3, targets: 1, sources: 1, hours: 24, retention_days: 7 });
    expect(page.data.rows[0]).toMatchObject({ target: 'example.com:443', source_ip: '203.0.113.9', network: 'tcp', count: 3, user_id: 1, node_id: 10, source: 'runtime' });
    expect(page.data.rows[0].user).toEqual({ id: 1, name: 'Reader', email: 'reader@example.test' });
    expect(page.data.rows[0].node).toEqual({ id: 10, name: 'HK Reality', source: 'runtime' });
  });

  test('replaying a batch id never counts twice', async () => {
    const f = fixture();
    await f.report([f.record({ count: 4 })], 'replay');
    const again = await f.report([f.record({ count: 4 })], 'replay');
    expect(again.data).toEqual({ accepted: true, stored: 0, skipped: 0, reused: true });
    expect((await f.adminList()).data.connections).toBe(4);
  });

  test('the same target in the same hour keeps one row and widens its span', async () => {
    const f = fixture();
    await f.report([f.record({ count: 2, first_at: f.hour() + 10, last_at: f.hour() + 20 })], 'one');
    await f.report([f.record({ count: 5, first_at: f.hour() + 2, last_at: f.hour() + 40 })], 'two');
    const page = await f.adminList();
    expect(page.data.total).toBe(1);
    expect(page.data.rows[0].count).toBe(7);
    expect(Date.parse(page.data.rows[0].first_at)).toBe((f.hour() + 2) * 1000);
    expect(Date.parse(page.data.rows[0].last_at)).toBe((f.hour() + 40) * 1000);
  });

  test('a deleted user and an unbound node are skipped while the batch is accepted', async () => {
    const f = fixture();
    const result = await f.report([f.record({ user_id: 99 }), f.record({ node_id: 77 }), f.record()]);
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ accepted: true, stored: 1, skipped: 2 });
  });

  test('out-of-window hours are skipped instead of stored', async () => {
    const f = fixture();
    const result = await f.report([f.record({ hour: f.hour(-8 * 86400) }), f.record({ hour: f.hour(3 * 3600), last_at: f.hour(3 * 3600) + 1, first_at: f.hour(3 * 3600) + 1 })]);
    expect(result.data).toMatchObject({ stored: 0, skipped: 2 });
  });

  test('shape and type problems reject the whole batch', async () => {
    const f = fixture();
    const cases: unknown[] = [
      { batch_id: 'bad batch!', records: [f.record()] },
      { batch_id: 'b', records: [] },
      { batch_id: 'b', records: Array.from({ length: 2001 }, () => f.record()) },
      { batch_id: 'b', records: [f.record({ target: 'example.com' })] },
      { batch_id: 'b', records: [f.record({ target: 'example.com:99999' })] },
      { batch_id: 'b', records: [f.record({ network: 'icmp' })] },
      { batch_id: 'b', records: [f.record({ count: 0 })] },
      { batch_id: 'b', records: [f.record({ hour: f.hour() + 60 })] },
      { batch_id: 'b', records: [f.record({ source_ip: 'not-an-ip' })] },
      { batch_id: 'b', records: [f.record({ user_id: 0 })] },
      { batch_id: 'b', records: [{ ...f.record(), extra: 1 }] },
      { batch_id: 'b', records: [f.record()], extra: 1 },
    ];
    for (const body of cases) {
      const response = await f.request('/api/node/v1/connections', 'POST', body, undefined, { authorization: `Bearer ${f.runtimeToken}` });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION');
    }
  });

  test('IPv6 targets and empty source addresses are accepted', async () => {
    const f = fixture();
    const result = await f.report([f.record({ target: '[2001:db8::1]:8443', source_ip: '', network: 'udp' })]);
    expect(result.data).toMatchObject({ stored: 1 });
    expect((await f.adminList()).data.rows[0]).toMatchObject({ target: '[2001:db8::1]:8443', source_ip: '', network: 'udp' });
  });

  test('a basic machine reports through its own node ownership', async () => {
    const f = fixture();
    const accepted = await f.report([f.record({ node_id: 20, target: 'basic.example.com:443' })], 'basic-1', f.basicToken);
    expect(accepted.data).toMatchObject({ stored: 1 });
    const rejected = await f.report([f.record({ node_id: 10 })], 'basic-2', f.basicToken);
    expect(rejected.data).toMatchObject({ stored: 0, skipped: 1 });
    const page = await f.adminList('?node_id=20&node_source=basic');
    expect(page.data.total).toBe(1);
    expect(page.data.rows[0]).toMatchObject({ source: 'basic', node: { id: 20, name: 'Legacy Node', source: 'basic' } });
  });
});

describe('last active stamps', () => {
  test('connections and traffic both move the user and node stamps', async () => {
    const f = fixture();
    await f.report([f.record({ last_at: f.hour() + 50 })], 'connections-1');
    const users = (await f.request('/api/v1/admin/users', 'GET', undefined, f.adminCookie)).data;
    const nodes = (await f.request('/api/v1/admin/nodes', 'GET', undefined, f.adminCookie)).data;
    expect(users.find((user: any) => user.id === 1).last_active_at).toBe(new Date((f.hour() + 50) * 1000).toISOString());
    expect(users.find((user: any) => user.id === 1).last_active_node).toBe('HK Reality');
    expect(nodes.find((node: any) => node.id === 10).last_active_at).toBe(new Date((f.hour() + 50) * 1000).toISOString());
    expect(nodes.find((node: any) => node.id === 10).last_active_user).toBe('Reader');

    f.setNow(new Date('2026-11-11T06:30:00Z'));
    const traffic = await f.request('/api/node/v1/traffic', 'POST', { batch_id: 'traffic-1', records: [{ user_id: 1, node_id: 10, upload_bytes: 10, download_bytes: 20 }] }, undefined, { authorization: `Bearer ${f.runtimeToken}` });
    expect(traffic.status).toBe(200);
    const later = (await f.request('/api/v1/admin/users', 'GET', undefined, f.adminCookie)).data;
    expect(later.find((user: any) => user.id === 1).last_active_at).toBe('2026-11-11T06:30:00.000Z');
  });

  test('a zero-byte traffic batch leaves the stamp alone', async () => {
    const f = fixture();
    await f.request('/api/node/v1/traffic', 'POST', { batch_id: 'empty', records: [{ user_id: 1, node_id: 10, upload_bytes: 0, download_bytes: 0 }] }, undefined, { authorization: `Bearer ${f.runtimeToken}` });
    const users = (await f.request('/api/v1/admin/users', 'GET', undefined, f.adminCookie)).data;
    expect(users.find((user: any) => user.id === 1).last_active_at).toBeNull();
    expect(users.find((user: any) => user.id === 1).last_active_node).toBeNull();
  });

  test('user-facing payloads keep their existing shape', async () => {
    const f = fixture();
    await f.report([f.record()], 'shape-1');
    const me = (await f.request('/api/v1/me', 'GET', undefined, f.userCookie)).data;
    const nodes = (await f.request('/api/v1/nodes', 'GET', undefined, f.userCookie)).data;
    expect(me).not.toHaveProperty('last_active_at');
    expect(nodes.every((node: any) => !('last_active_at' in node))).toBe(true);
  });
});

describe('connection log browsing', () => {
  test('the range filter uses the last activity time', async () => {
    const f = fixture();
    await f.report([f.record({ hour: f.hour(-3 * 3600), first_at: f.hour(-3 * 3600) + 1, last_at: f.hour(-3 * 3600) + 2 })], 'old');
    expect((await f.adminList()).data.total).toBe(1);
    expect((await f.adminList('?hours=1')).data.total).toBe(0);
    expect((await f.adminList('?hours=168')).data.total).toBe(1);
  });

  test('search matches the target and the source address', async () => {
    const f = fixture();
    await f.report([f.record({ target: 'video.example.com:443' }), f.record({ target: 'api.example.net:8443', source_ip: '198.51.100.7' })], 'search');
    expect((await f.adminList('?q=video')).data.total).toBe(1);
    expect((await f.adminList('?q=198.51.100')).data.total).toBe(1);
    // A typed wildcard stays a literal character.
    expect((await f.adminList('?q=%25')).data.total).toBe(0);
  });

  test('filters by user and pages through rows', async () => {
    const f = fixture();
    const records = Array.from({ length: 5 }, (_, index) => f.record({ target: `site${index}.example.com:443`, last_at: f.hour() + 60 + index }));
    await f.report(records, 'paging');
    const first = await f.adminList('?user_id=1&limit=2');
    expect(first.data.total).toBe(5);
    expect(first.data.rows).toHaveLength(2);
    const second = await f.adminList('?user_id=1&limit=2&offset=2');
    expect(second.data.rows).toHaveLength(2);
    expect(second.data.rows[0].target).not.toBe(first.data.rows[0].target);
    expect((await f.adminList('?user_id=2')).data.total).toBe(0);
  });

  test('deleting a user removes their rows and later reports skip them', async () => {
    const f = fixture();
    await f.report([f.record()], 'before-delete');
    const removed = await f.request('/api/v1/admin/users/1', 'DELETE', undefined, f.adminCookie);
    expect(removed.status).toBe(200);
    expect((await f.adminList()).data.total).toBe(0);
    const after = await f.report([f.record()], 'after-delete');
    expect(after.data).toMatchObject({ stored: 0, skipped: 1 });
    const nodes = (await f.request('/api/v1/admin/nodes', 'GET', undefined, f.adminCookie)).data;
    expect(nodes.find((node: any) => node.id === 10).last_active_at).not.toBeNull();
  });

  test('only administrators read the log', async () => {
    const f = fixture();
    const denied = await f.request('/api/v1/admin/connections', 'GET', undefined, f.userCookie);
    expect(denied.status).toBe(403);
    const anonymousNode = await f.request('/api/node/v1/connections', 'POST', { batch_id: 'x', records: [f.record()] });
    expect(anonymousNode.status).toBe(401);
  });

  test('bad query parameters explain the valid choices', async () => {
    const f = fixture();
    expect((await f.adminList('?hours=12')).status).toBe(400);
    expect((await f.adminList('?node_id=10')).status).toBe(400);
    expect((await f.adminList('?user_id=abc')).status).toBe(400);
    expect((await f.adminList('?limit=500')).status).toBe(400);
    expect((await f.adminList('?offset=-1')).status).toBe(400);
  });

  test('rows outside the retention window disappear on the next purge', async () => {
    const f = fixture();
    await f.report([f.record()], 'retained');
    expect((await f.adminList('?hours=168')).data.total).toBe(1);
    // Jump past the retention boundary; the next report triggers the hourly purge.
    f.setNow(new Date('2026-11-20T04:00:00Z'));
    const later = f.hour();
    await f.report([f.record({ hour: later, first_at: later + 1, last_at: later + 2 })], 'fresh');
    const page = await f.adminList('?hours=168');
    expect(page.data.total).toBe(1);
    expect(page.data.rows[0].target).toBe('example.com:443');
  });
});
