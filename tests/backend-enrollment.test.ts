import { afterEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';
import { createApp } from '../src/server/app';
import { hash } from '../src/server/database';
import { compileMachine, provisionMachineToken, restoreRuntime, shadowsocksServerPSK } from '../src/server/runtime';

type Row = Record<string, any>;
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.close(); });
const future = '2099-01-01T00:00:00.000Z';
const publicOrigin = 'https://panel.example.test';
const oldToken = 'e'.repeat(64);
const otherOldToken = 'f'.repeat(64);
const certificate = '-----BEGIN CERTIFICATE-----\nSYNTHETIC CERTIFICATE\n-----END CERTIFICATE-----';
const privateKey = '-----BEGIN PRIVATE KEY-----\nSYNTHETIC PRIVATE KEY\n-----END PRIVATE KEY-----';

// No production files, remote services or shared fixture-test imports. Each test owns its SQLite :memory: DB.
function fixture() {
  const app = createApp({ publicOrigin, subscriptionOrigin: 'https://sub.example.test' });
  apps.push(app);
  const db = app.db;
  const insertUser = db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,quota_bytes,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
  insertUser.run(1, 'user@example.test', 'Granted user', 'user', 'synthetic-hash', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a'.repeat(64), 1000, future, future);
  insertUser.run(2, 'admin@example.test', 'Admin', 'admin', 'synthetic-hash', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b'.repeat(64), 1000, future, future);
  insertUser.run(3, 'foreign@example.test', 'Ungrantable user', 'user', 'synthetic-hash', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'c'.repeat(64), 1000, future, future);
  db.exec("INSERT INTO groups(id,name) VALUES(1,'Granted'),(2,'Foreign'); INSERT INTO user_groups VALUES(1,1),(3,2);");
  const userCookie = `mboard_session=${'1'.repeat(64)}`;
  const adminCookie = `mboard_session=${'2'.repeat(64)}`;
  const foreignCookie = `mboard_session=${'3'.repeat(64)}`;
  for (const [uid, token] of [[1, '1'.repeat(64)], [2, '2'.repeat(64)], [3, '3'.repeat(64)]] as const) db.query('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), uid, future);
  const archive = (kind: string, id: number, payload: Row) => db.query('INSERT OR REPLACE INTO legacy_records VALUES(?,?,?,?)').run(kind, String(id), JSON.stringify(payload), future);
  archive('v2_user', 1, { id: 1, uuid: '12345678-1234-4123-8123-123456789abc' });
  const sourceNode = { id: 10, name: 'Synthetic SS2022', type: 'shadowsocks', host: 'ss.example.test', port: 443, server_port: 8443, parent_id: 0, enabled: 1, show: 1, group_ids: [1], created_at: 1700000000, protocol_settings: { cipher: '2022-blake3-aes-128-gcm' } };
  archive('v2_server', 10, sourceNode);
  archive('v2_server', 20, { ...sourceNode, id: 20, host: 'foreign.example.test', server_port: 8444, group_ids: [2] });
  archive('v2_server_machine', 10, { id: 10, name: 'Synthetic machine', host: 'machine.example.test', enabled: 1, token: oldToken });
  archive('v2_server_machine', 20, { id: 20, name: 'Other synthetic machine', host: 'other.example.test', enabled: 1, token: otherOldToken });
  archive('v2_server_machine_binding', 1, { id: 1, machine_id: 10, server_id: 10 });
  archive('v2_server_machine_binding', 2, { id: 2, machine_id: 20, server_id: 20 });
  restoreRuntime(db);
  async function raw(path: string, method: string, text?: string, extra?: HeadersInit) {
    const headers = new Headers({ host: 'panel.example.test', ...Object.fromEntries(new Headers(extra)) });
    const response = await app.fetch(new Request(`${publicOrigin}${path}`, { method, headers, body: text }));
    const result = await response.text();
    let body: any; try { body = JSON.parse(result); } catch { body = result; }
    return { response, status: response.status, text: result, body, data: body?.data };
  }
  const request = (path: string, method = 'GET', data?: unknown, extra?: HeadersInit) => raw(path, method, data === undefined ? undefined : JSON.stringify(data), { ...(data === undefined ? {} : { 'content-type': 'application/json' }), ...Object.fromEntries(new Headers(extra)) });
  const node = (path: string, data: unknown, bearer = oldToken, extra?: HeadersInit, method = 'POST') => request(`/api/node/v1/${path}`, method, data, { authorization: `Bearer ${bearer}`, ...Object.fromEntries(new Headers(extra)) });
  const enroll = (bearer = oldToken, machineID = 10) => node('enroll', { machine_id: machineID }, bearer);
  const machine = (id = 10) => db.query('SELECT * FROM runtime_machines WHERE id=?').get(id) as Row;
  const snapshot = () => Object.fromEntries(['runtime_machines', 'runtime_metadata', 'runtime_bindings', 'runtime_nodes', 'runtime_identity_credentials', 'runtime_traffic_batches', 'runtime_node_traffic', 'traffic_daily', 'users', 'sessions', 'audit'].map(table => [table, db.query(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const heartbeat = (token: string, revision: number, coreReady = true, telemetryReady = true) => node('heartbeat', { version: 'synthetic-core/1.14', uptime_seconds: 60, config_revision: revision, core_ready: coreReady, telemetry_ready: telemetryReady }, token);
  const summary = () => request('/api/v1/admin/overview', 'GET', undefined, { cookie: adminCookie });
  const addTLS = () => {
    archive('v2_server', 11, { id: 11, name: 'Synthetic TLS', type: 'trojan', host: 'tls.example.test', port: 444, server_port: 8445, parent_id: 0, enabled: 1, show: 1, group_ids: [1], protocol_settings: { tls: 1 }, tls_material: { certificate, private_key: privateKey } });
    archive('v2_server_machine_binding', 3, { id: 3, machine_id: 10, server_id: 11 });
    restoreRuntime(db);
  };
  return { app, db, archive, sourceNode, raw, request, node, enroll, machine, snapshot, heartbeat, summary, addTLS, userCookie, adminCookie, foreignCookie };
}

test('legacy 32-hex credentials are accepted only by one-time enrollment',async()=>{const f=fixture(),old='mBoardLegacyNode'.repeat(2);f.archive('v2_server_machine',10,{id:10,name:'Legacy 32-bit-format machine',token:old,is_active:1});const enrolled=await f.enroll(old);expect(enrolled.status).toBe(200);expect(enrolled.data.token).toMatch(/^[a-f0-9]{64}$/);expect((await f.node('config',undefined,old,undefined,'GET')).status).toBe(401);expect((await f.enroll(old)).data.token).toBe(enrolled.data.token)});

function expectPrivateError(result: { text: string; body: any }, secrets: string[] = []) {
  expect(result.body.error).toBeDefined();
  for (const value of [oldToken, otherOldToken, privateKey, certificate, ...secrets]) expect(result.text).not.toContain(value);
  expect(result.text).not.toMatch(/SELECT |UPDATE |SQLite|stack|SYNTHETIC PRIVATE KEY/);
}

describe('one-time node enrollment security', () => {
  test('raw archived old credential returns exact native config, labels and TLS files with only a token hash in machine columns', async () => {
    const f = fixture(); f.addTLS();
    const expected = compileMachine(f.db, 10);
    const r = await f.enroll();
    expect(r.status).toBe(200);
    expect(Object.keys(r.data).sort()).toEqual(['config', 'files', 'revision', 'token', 'traffic_labels']);
    expect(r.data).toEqual({ token: r.data.token, revision: expected.revision, config: expected.config, files: expected.files, traffic_labels: expected.traffic_labels });
    expect(r.data.token).toMatch(/^[a-f0-9]{64}$/);
    expect(r.data.token).not.toBe(oldToken);
    expect(r.data.config.inbounds[0]).toMatchObject({ tag: 'mb:n:10', listen_port: 8443, method: '2022-blake3-aes-128-gcm', password: shadowsocksServerPSK(f.sourceNode, '2022-blake3-aes-128-gcm') });
    expect(r.data.traffic_labels).toEqual([{ label: 'mb:u:1:n:10:p:0', user_id: 1, node_id: 10 }, { label: 'mb:u:1:n:11:p:0', user_id: 1, node_id: 11 }]);
    expect(r.data.files).toEqual([{ path_under_mboard_tls: '11.crt', content: certificate, mode: 0o600 }, { path_under_mboard_tls: '11.key', content: privateKey, mode: 0o600 }]);
    expect(f.machine()).toMatchObject({ state: 'pending', active: 0, token_hash: hash(r.data.token) });
    expect(JSON.stringify(f.db.query('SELECT * FROM runtime_machines').all())).not.toContain(r.data.token);
    const metadata = f.db.query('SELECT key,value FROM runtime_metadata').all() as Row[];
    const secret = metadata.find(row => row.key === 'enrollment:secret')!.value;
    expect(r.data.token).toBe(createHmac('sha256', secret).update(`mboard-node-enrollment:v1:10:${oldToken}`).digest('hex'));
    expect(JSON.stringify(metadata)).not.toContain(r.data.token);
    expect(r.response.headers.get('cache-control')).toBe('no-store');
    expect(r.response.headers.get('set-cookie')).toBeNull();
  });

  test('old and new bearer retries return a stable token and do not add or rotate rows', async () => {
    const f = fixture(); const first = await f.enroll(); expect(first.status).toBe(200);
    const before = f.snapshot();
    for (const bearer of [oldToken, first.data.token, oldToken]) expect((await f.enroll(bearer)).data).toEqual(first.data);
    expect(f.snapshot()).toEqual(before);
    expect((await f.request('/api/node/v1/config', 'GET', undefined, { authorization: `Bearer ${first.data.token}` })).data).toEqual({ revision: first.data.revision, config: first.data.config, traffic_labels: first.data.traffic_labels });
    expect((await f.request('/api/v1/nodes', 'GET', undefined, { cookie: f.userCookie })).data).toEqual([]);
  });

  test('simultaneous source credential retries issue one deterministic token', async () => {
    const f = fixture(); const results = await Promise.all(Array.from({ length: 8 }, () => f.enroll()));
    for (const result of results) expect(result.status).toBe(200);
    expect(new Set(results.map(result => result.data.token)).size).toBe(1);
    expect(f.machine().token_hash).toBe(hash(results[0].data.token));
    expect(f.db.query("SELECT key FROM runtime_metadata WHERE key='machine:10:enrollment'").all()).toHaveLength(1);
  });

  test('credential lookup uses the raw archive, not a replaced runtime source payload', async () => {
    const f = fixture(); const forged = '9'.repeat(64);
    f.db.query('UPDATE runtime_source_records SET payload=? WHERE kind=? AND id=?').run(JSON.stringify({ id: 10, enabled: 1, token: forged }), 'v2_server_machine', '10');
    f.db.query('UPDATE runtime_machines SET payload=? WHERE id=10').run(JSON.stringify({ id: 10, enabled: 1, token: forged }));
    const before = f.snapshot(); const denied = await f.enroll(forged);
    expect(denied.status).toBe(401); expectPrivateError(denied, [forged]); expect(f.snapshot()).toEqual(before);
    expect((await f.enroll()).status).toBe(200);
  });

  test('machine IDs bind old and current credentials and never transfer another machine token', async () => {
    const f = fixture(); const first = await f.enroll(); const other = provisionMachineToken(f.db, 20); const before = f.snapshot();
    for (const [bearer, mid] of [[oldToken, 20], [first.data.token, 20], [other, 10], [otherOldToken, 10], [oldToken, 999]] as const) {
      const r = await f.enroll(bearer, mid); expect(r.status).toBe(401); expectPrivateError(r, [first.data.token, other]); expect(f.snapshot()).toEqual(before);
    }
    expect((await f.enroll(other, 20)).data.token).toBe(other);
    expect(f.machine(20).token_hash).toBe(hash(other));
  });

  test('a later panel token rotation stops old source replay while the new current bearer can repair', async () => {
    const f = fixture(); const first = await f.enroll(); const next = provisionMachineToken(f.db, 10); const before = f.snapshot();
    const old = await f.enroll(); expect(old.status).toBe(409); expect(old.body.error.code).toBe('NODE_CREDENTIAL_CHANGED'); expectPrivateError(old, [first.data.token, next]);
    expect((await f.enroll(first.data.token)).status).toBe(401); expect(f.snapshot()).toEqual(before);
    const repair = await f.enroll(next); expect(repair.status).toBe(200); expect(repair.data.token).toBe(next); expect(f.snapshot()).toEqual(before);
  });

  test('disabled machines reject the old credential without enabling or issuing a token', async () => {
    const f = fixture(); const current = provisionMachineToken(f.db, 10); f.db.exec("UPDATE runtime_machines SET state='disabled',active=0 WHERE id=10");
    const before = f.snapshot();
    const old = await f.enroll(); expect(old.status).toBe(409); expectPrivateError(old, [current]);
    expect((await f.enroll(current)).status).toBe(401);
    expect((await f.node('activate', { config_revision: 1 }, current)).status).toBe(401);
    expect(f.snapshot()).toEqual(before); expect(f.machine().state).toBe('disabled');
  });

  test('missing, malformed and cookie credentials cannot issue enrollment rows', async () => {
    const f = fixture(); const before = f.snapshot();
    const headers: HeadersInit[] = [{}, { authorization: `Basic ${oldToken}` }, { authorization: `Bearer ${oldToken.toUpperCase()}` }, { authorization: 'Bearer bad' }, { cookie: f.adminCookie }, { cookie: f.userCookie, authorization: `Bearer ${oldToken}` }, { cookie: f.adminCookie, authorization: `Bearer ${oldToken}` }];
    for (const extra of headers) { const r = await f.request('/api/node/v1/enroll', 'POST', { machine_id: 10 }, extra); expect(r.status).toBe(401); expectPrivateError(r); expect(f.snapshot()).toEqual(before); }
  });

  test('strict malformed bodies and content limits cannot enroll or reissue a token', async () => {
    const f = fixture();
    const malformed: unknown[] = [{}, null, [], 10, { machine_id: '10' }, { machine_id: 0 }, { machine_id: -1 }, { machine_id: 1.5 }, { machine_id: Number.MAX_SAFE_INTEGER + 1 }, { machine_id: 10, token: 'SYNTHETIC-DO-NOT-ECHO' }];
    for (const issued of [false, true]) {
      const bearer = issued ? (await f.enroll()).data.token : oldToken;
      const before = f.snapshot();
      for (const data of malformed) { const r = await f.node('enroll', data, bearer); expect(r.status).toBe(400); expectPrivateError(r, [bearer]); expect(f.snapshot()).toEqual(before); }
      for (const [text, extra, status] of [['{"machine_id":', { 'content-type': 'application/json' }, 400], ['{"machine_id":10}', { 'content-type': 'text/plain' }, 415], ['{"machine_id":10}', { 'content-type': 'application/json', 'content-length': '1048577' }, 413], [JSON.stringify({ machine_id: 10, padding: 'x'.repeat(1048576) }), { 'content-type': 'application/json' }, 413]] as const) {
        const r = await f.raw('/api/node/v1/enroll', 'POST', text, { authorization: `Bearer ${bearer}`, ...extra });
        expect(r.status).toBe(status); expectPrivateError(r, [bearer]); expect(f.snapshot()).toEqual(before);
        if (status === 413) expect(r.response.headers.get('connection')).toBe('close');
      }
    }
  });

  test('subscription, foreign and malformed Host or wrong methods cannot mutate enrollment or activation', async () => {
    const f = fixture(); const current = provisionMachineToken(f.db, 10); const before = f.snapshot();
    for (const path of ['enroll', 'activate']) {
      const data = path === 'enroll' ? { machine_id: 10 } : { config_revision: 1 };
      for (const host of ['sub.example.test', 'evil.example.test', 'panel.example.test@evil.example.test', 'panel.example.test:0', 'panel.example.test/path']) {
        const r = await f.node(path, data, path === 'enroll' ? oldToken : current, { host }); expect(r.status).toBe(404); expectPrivateError(r, [current]); expect(f.snapshot()).toEqual(before);
      }
      for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        const r = await f.request(`/api/node/v1/${path}`, method, ['GET', 'HEAD'].includes(method) ? undefined : data, { authorization: `Bearer ${current}` });
        expect(r.status).toBe(404); expect(f.snapshot()).toEqual(before);
      }
    }
  });

  test('node credentials grant neither an admin session nor foreign users, nodes or revoked groups', async () => {
    const f = fixture(); const r = await f.enroll(); const token = r.data.token;
    for (const path of ['/api/v1/admin/overview', '/api/v1/admin/machines', '/api/v1/users', '/api/v1/nodes']) expect((await f.request(path, 'GET', undefined, { authorization: `Bearer ${token}` })).status).toBe(401);
    for (const record of [{ user_id: 1, node_id: 20, upload_bytes: 1, download_bytes: 1 }, { user_id: 3, node_id: 10, upload_bytes: 1, download_bytes: 1 }]) {
      const before = f.snapshot(); const denied = await f.node('traffic', { batch_id: 'foreign', records: [record] }, token); expect(denied.status).toBe(403); expectPrivateError(denied, [token]); expect(f.snapshot()).toEqual(before);
    }
    f.db.exec('DELETE FROM user_groups WHERE user_id=1'); const before = f.snapshot();
    const denied = await f.node('traffic', { batch_id: 'revoked', records: [{ user_id: 1, node_id: 10, upload_bytes: 1, download_bytes: 1 }] }, token);
    expect(denied.status).toBe(403); expectPrivateError(denied, [token]); expect(f.snapshot()).toEqual(before);
    expect((await f.enroll(token)).data.traffic_labels).toEqual([]);
  });

  test('rotating a token during delayed enroll or activate bodies cannot restore a revoked credential', async () => {
    const f = fixture(); const issued = await f.enroll(); const { token, revision } = issued.data;
    await f.heartbeat(token, revision);
    const delayed = (path: string, bearer: string, data: Row) => {
      let writer!: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({ start(controller) { writer = controller; } });
      const response = f.app.fetch(new Request(`${publicOrigin}/api/node/v1/${path}`, { method: 'POST', headers: { host: 'panel.example.test', authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: stream }));
      return { response, finish: () => { writer.enqueue(new TextEncoder().encode(JSON.stringify(data))); writer.close(); } };
    };
    const requests = [delayed('enroll', oldToken, { machine_id: 10 }), delayed('enroll', token, { machine_id: 10 }), delayed('activate', token, { config_revision: revision })];
    const next = provisionMachineToken(f.db, 10); const before = f.snapshot();
    for (const request of requests) request.finish();
    const responses = await Promise.all(requests.map(request => request.response));
    expect(responses.map(response => response.status)).toEqual([409, 401, 401]);
    for (const response of responses) { const text = await response.text(); expectPrivateError({ text, body: JSON.parse(text) }, [token, next]); }
    expect(f.snapshot()).toEqual(before); expect(f.machine()).toMatchObject({ state: 'pending', active: 0, token_hash: hash(next) });
    expect((await f.enroll(next)).data.token).toBe(next);
  });

  test('failed config compilation rolls back enrollment credential and metadata writes', async () => {
    const f = fixture(); const current = provisionMachineToken(f.db, 10);
    // Restore succeeds, but native SS2022 compilation rejects an ambiguous source PSK timestamp.
    f.archive('v2_server', 10, { ...f.sourceNode, created_at: 'SYNTHETIC-SECRET-TIMESTAMP' }); restoreRuntime(f.db);
    const before = f.snapshot(); const r = await f.enroll();
    expect(r.status).toBe(409); expectPrivateError(r, [current, 'SYNTHETIC-SECRET-TIMESTAMP']);
    expect(f.snapshot()).toEqual(before);
  });
});

describe('runtime-only node activation security', () => {
  test('old source credentials and session cookies cannot activate a pending machine', async () => {
    const f = fixture(); const r = await f.enroll(); const before = f.snapshot();
    const headers: HeadersInit[] = [{ authorization: `Bearer ${oldToken}` }, { cookie: f.adminCookie }, { cookie: f.adminCookie, authorization: `Bearer ${r.data.token}` }];
    for (const extra of headers) {
      const denied = await f.request('/api/node/v1/activate', 'POST', { config_revision: r.data.revision }, extra); expect(denied.status).toBe(401); expectPrivateError(denied, [r.data.token]); expect(f.snapshot()).toEqual(before);
    }
  });

  test('activation rejects missing or partial readiness and stale or mismatching telemetry', async () => {
    const f = fixture(); const r = await f.enroll(); const { token, revision } = r.data;
    const blocked = async () => { const before = f.snapshot(); const denied = await f.node('activate', { config_revision: revision }, token); expect(denied.status).toBe(409); expectPrivateError(denied, [token]); expect(f.snapshot()).toEqual(before); expect(f.machine().state).toBe('pending'); };
    await blocked();
    for (const [core, telemetry] of [[false, false], [false, true], [true, false]] as const) { expect((await f.heartbeat(token, revision, core, telemetry)).status).toBe(200); await blocked(); }
    expect((await f.heartbeat(token, revision + 1)).status).toBe(200); await blocked();
    await f.heartbeat(token, revision); f.db.query('UPDATE runtime_machines SET last_seen_at=? WHERE id=10').run(new Date(Date.now() - 91000).toISOString()); await blocked();
    await f.heartbeat(token, revision); const before = f.snapshot(); const mismatch = await f.node('activate', { config_revision: revision + 1 }, token); expect(mismatch.status).toBe(409); expectPrivateError(mismatch, [token]); expect(f.snapshot()).toEqual(before);
  });

  test('activation validates every body before changing state', async () => {
    const f = fixture(); const r = await f.enroll(); await f.heartbeat(r.data.token, r.data.revision); const before = f.snapshot();
    for (const data of [{}, { config_revision: 0 }, { config_revision: -1 }, { config_revision: '1' }, { config_revision: 1.5 }, { config_revision: Number.MAX_SAFE_INTEGER + 1 }, { config_revision: r.data.revision, machine_id: 20 }, [], null]) {
      const denied = await f.node('activate', data, r.data.token); expect(denied.status).toBe(400); expectPrivateError(denied, [r.data.token]); expect(f.snapshot()).toEqual(before);
    }
  });

  test('fresh matching heartbeat activates only its machine, publishes live counts and closes old credential access', async () => {
    const f = fixture(); const r = await f.enroll(); const { token, revision } = r.data;
    expect((await f.summary()).data).toMatchObject({ nodes: 2, machines: 2, online_nodes: 0, online_machines: 0 });
    expect((await f.heartbeat(token, revision)).status).toBe(200);
    const activated = await f.node('activate', { config_revision: revision }, token); expect(activated.status).toBe(200); expect(activated.data).toEqual({ activated: true, machine_id: 10, config_revision: revision });
    expect(f.machine()).toMatchObject({ state: 'active', active: 1, applied_revision: revision, core_ready: 1, telemetry_ready: 1 }); expect(f.machine(20)).toMatchObject({ state: 'pending', active: 0, token_hash: null });
    const overview = await f.summary(); expect(overview.data).toMatchObject({ nodes: 2, machines: 2, online_nodes: 1, online_machines: 1 });
    expect(overview.data.recent_machines.find((machine: Row) => machine.id === 10)).toMatchObject({ state: 'active', runtime: true, active: true, online: true, config_revision: revision, applied_revision: revision });
    expect((await f.request('/api/v1/nodes', 'GET', undefined, { cookie: f.userCookie })).data.map((node: Row) => node.id)).toEqual([10]);
    expect((await f.request('/api/v1/nodes', 'GET', undefined, { cookie: f.foreignCookie })).data).toEqual([]);
    const subscription = await f.request(`/s/${'a'.repeat(64)}`, 'GET', undefined, { host: 'sub.example.test' }); expect(subscription.status).toBe(200); expect(subscription.text).toContain('ss.example.test'); expect(subscription.text).not.toContain('foreign.example.test');
    for (const text of [overview.text, subscription.text]) for (const secret of [oldToken, otherOldToken, token, privateKey]) expect(text).not.toContain(secret);
    const before = f.snapshot(); const old = await f.enroll(); expect(old.status).toBe(409); expect(old.body.error.code).toBe('NODE_ENROLLED'); expectPrivateError(old, [token]); expect(f.snapshot()).toEqual(before);
    expect((await f.enroll(token)).data).toEqual(r.data); expect(f.snapshot()).toEqual(before);
    expect((await f.node('activate', { config_revision: revision }, token)).data).toEqual(activated.data);
  });

  test('a newly compiled config prevents activation of previously ready old revision', async () => {
    const f = fixture(); const r = await f.enroll(); await f.heartbeat(r.data.token, r.data.revision);
    f.db.exec('INSERT INTO user_groups VALUES(2,1)'); const c = compileMachine(f.db, 10); expect(c.revision).toBeGreaterThan(r.data.revision);
    const before = f.snapshot(); const denied = await f.node('activate', { config_revision: r.data.revision }, r.data.token);
    expect(denied.status).toBe(409); expectPrivateError(denied, [r.data.token]); expect(f.snapshot()).toEqual(before); expect(f.machine().state).toBe('pending');
    await f.heartbeat(r.data.token, c.revision); expect((await f.node('activate', { config_revision: c.revision }, r.data.token)).status).toBe(200);
  });
});
