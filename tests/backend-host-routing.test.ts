import { afterEach, describe, expect, test } from 'bun:test';
import { createApp, type AppOptions } from '../src/server/app';
import { startServer } from '../src/server/server';
import { hash } from '../src/server/database';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const panel = 'https://panel.example';
const sub = 'https://panelapifkgfw.example';
const panelHost = 'panel.example';
const subHost = 'panelapifkgfw.example';
const pass = 'host routing legitimate test password';
const passwordHash = Bun.password.hashSync(pass, { algorithm: 'argon2id' });
const adminSession = 'a'.repeat(64), userSession = 'b'.repeat(64);
const userToken = 'c'.repeat(64), adminToken = 'd'.repeat(64), machineToken = 'e'.repeat(64);
const credential = '12345678-1234-4234-8234-123456789abc';
const apps: ReturnType<typeof createApp>[] = [];
const dirs: string[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const app of apps.splice(0)) app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'mboard-host-routing-')); dirs.push(dir); return dir;
}
function fixture(options: AppOptions = {}) {
  const dir = directory(), dist = join(dir, 'dist'); mkdirSync(dist);
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Host routing panel</title>');
  mkdirSync(join(dist, 'assets')); writeFileSync(join(dist, 'assets', 'main.js'), 'window.panelReady = true;');
  const app = createApp({ dbPath: join(dir, 'mboard.sqlite'), distDir: dist, publicOrigin: panel, subscriptionOrigin: sub, ...options });
  apps.push(app);
  const stamp = '2026-01-01T00:00:00.000Z';
  const user = app.db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,created_at) VALUES(?,?,?,?,?,?,?,?)');
  user.run(1, 'admin@example.test', 'Test admin', 'admin', passwordHash, '87654321-1234-4234-8234-123456789abc', adminToken, stamp);
  user.run(2, 'owner@example.test', 'Test owner', 'user', passwordHash, credential, userToken, stamp);
  app.db.query("UPDATE settings SET value='1' WHERE key='setup_complete'").run();
  app.db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(adminSession), 1, '2099-01-01T00:00:00.000Z');
  app.db.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(userSession), 2, '2099-01-01T00:00:00.000Z');
  app.db.query('INSERT INTO groups(id,name) VALUES(1,?)').run('Granted test group');
  app.db.query('INSERT INTO machines(id,name,host,token_hash) VALUES(1,?,?,?)').run('Test machine', 'node.example.test', hash(machineToken));
  app.db.query('INSERT INTO nodes(id,name,host,port,protocol,machine_id,tls,server_name,created_at) VALUES(1,?,?,?,?,1,1,?,?)').run('Test VLESS', 'node.example.test', 443, 'vless', 'node.example.test', stamp);
  app.db.query('INSERT INTO user_groups(user_id,group_id) VALUES(2,1)').run();
  app.db.query('INSERT INTO node_groups(node_id,group_id) VALUES(1,1)').run();
  async function request(path: string, options: { host?: string | null; method?: string; cookie?: string; headers?: HeadersInit; body?: string; authority?: string } = {}) {
    const headers = new Headers(options.headers);
    if (options.host !== null) headers.set('Host', options.host ?? panelHost);
    if (options.cookie) headers.set('Cookie', options.cookie);
    const response = await app.fetch(new Request(`${options.authority ?? 'http://127.0.0.1:8791'}${path}`, { method: options.method ?? 'GET', headers, body: options.body }));
    return response;
  }
  return { app, request, admin: `mboard_session=${adminSession}`, owner: `mboard_session=${userSession}` };
}
const data = async (response: Response) => (await response.json() as any).data;

 describe('same-port subscription Host boundary', () => {
  test('normalizes actual Host case, ports and trailing dot while keeping panel, loopback and old links working', async () => {
    const f = fixture();
    for (const host of [panelHost, 'PaNeL.example', `${panelHost}:8791`, `${panelHost}.:443`]) {
      expect((await f.request('/', { host })).status).toBe(200);
      expect((await f.request('/assets/main.js', { host })).status).toBe(200);
      expect((await data(await f.request('/api/v1/me', { host, cookie: f.owner }))).email).toBe('owner@example.test');
      expect((await f.request('/api/v1/admin/users', { host, cookie: f.admin })).status).toBe(200);
      expect((await f.request(`/s/${userToken}`, { host })).status).toBe(200);
      expect((await f.request('/api/node/v1/config', { host, headers: { authorization: `Bearer ${machineToken}` } })).status).toBe(200);
    }
    for (const host of [subHost, 'PaNeLaPiFkGfW.example', `${subHost}:443`, `${subHost}.:8791`]) {
      expect((await f.request(`/s/${userToken}`, { host })).status).toBe(200);
      expect((await f.request('/', { host })).status).toBe(404);
    }
    for (const host of ['localhost', 'LOCALHOST.:8791', '127.0.0.1:8791', '[::1]:8791', '[0:0:0:0:0:0:0:1]:8791']) {
      expect((await f.request('/api/v1/site', { host })).status).toBe(200);
    }
    for (const authority of [panel, 'http://localhost:8791', 'http://127.0.0.1:8791', 'http://[::1]:8791']) {
      expect((await f.request('/api/v1/site', { host: null, authority })).status).toBe(200);
    }
    expect((await f.request(`/s/${userToken}`, { host: null, authority: sub })).status).toBe(200);
    for (const host of [`prefix.${panelHost}`, `${panelHost}.evil.test`, `prefix.${subHost}`, 'unknown.example.test']) {
      expect((await f.request('/api/v1/site', { host })).status).toBe(404);
    }
  });

  test('subdomain blocks every non-subscription surface before body, auth, CSRF and mutation even with valid cookies', async () => {
    let clock = new Date('2026-01-01T00:00:00Z');
    const f = fixture({ now: () => clock });
    f.app.db.query('UPDATE users SET expires_at=? WHERE id=2').run('2026-01-02T00:00:00.000Z');
    const revision = f.app.db.query('SELECT config_revision FROM machines WHERE id=1').get();
    clock = new Date('2026-01-03T00:00:00Z');
    const paths = ['/', '/admin', '/login', '/assets/main.js', '/favicon.ico', '/api/v1/site', '/api/v1/auth/status', '/api/v1/auth/login', '/api/v1/auth/setup', '/api/v1/auth/logout', '/api/v1/me', '/api/v1/overview', '/api/v1/admin/users', '/api/v1/admin/imports', '/api/v1/me/subscription/rotate', '/api/node/v1/config', '/api/node/v1/heartbeat', '/api/node/v1/traffic', '/s/', `/s/${userToken}/extra`, `/s/${'z'.repeat(64)}`];
    const message = '此地址提供订阅下载，请使用有效的订阅链接';
    for (const cookie of [undefined, f.admin, f.owner]) for (const path of paths) for (const method of ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await f.request(path, { host: subHost, method, cookie, headers: { authorization: `Bearer ${machineToken}` } });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('set-cookie')).toBeNull();
      if (method === 'HEAD') expect(await response.text()).toBe('');
      else expect(await response.json()).toEqual({ error: { code: 'NOT_FOUND', message } });
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) expect((await f.request(`/s/${userToken}`, { host: subHost, method, cookie: f.admin })).status).toBe(404);
    const blocked = new Request('http://127.0.0.1:8791/api/v1/admin/users', { method: 'POST', headers: { Host: subHost, Cookie: f.admin, 'Content-Type': 'application/json' }, body: '{not JSON' });
    expect((await f.app.fetch(blocked)).status).toBe(404);
    expect(blocked.bodyUsed).toBe(false);
    expect(f.app.db.query('SELECT config_revision FROM machines WHERE id=1').get()).toEqual(revision);
    expect(f.app.db.query('SELECT count(*) n FROM users').get()).toEqual({ n: 2 });
    expect(f.app.db.query('SELECT count(*) n FROM sessions').get()).toEqual({ n: 2 });
    expect(f.app.db.query('SELECT count(*) n FROM audit').get()).toEqual({ n: 0 });
    expect(f.app.db.query('SELECT subscription_token FROM users WHERE id=2').get()).toEqual({ subscription_token: userToken });
  });

  test('unknown and malformed Host values fail closed rather than becoming loopback or configured domains', async () => {
    const f = fixture();
    for (const host of ['', 'unknown.example.test', `${panelHost}@evil.test`, `user@${panelHost}`, `${panelHost}/path`, `${panelHost}\\path`, `${panelHost}?query`, `${panelHost}#fragment`, `${panelHost},${subHost}`, `${panelHost}:`, `${panelHost}:0`, `${panelHost}:65536`, `${panelHost}:abc`, `${panelHost}:80:90`, `${panelHost}..`, `bad label.${panelHost}`, `bad_label.${panelHost}`, `-bad.${panelHost}`, `${panelHost}%2e`, '[::1', '::1', '[not-ip]:8791', '[::1]suffix', '[::1%lo0]', '127.1', '127.000.000.001', '2130706433', '0x7f000001', 'localhost.evil.test']) {
      for (const method of ['GET', 'POST']) {
        const response = await f.request('/api/v1/site', { host, method, cookie: f.admin, headers: { origin: panel } });
        expect(response.status).toBe(404);
        expect((await response.json() as any).error.code).toBe('NOT_FOUND');
      }
    }
    // Public-origin CSRF stays unchanged for an allowed actual Host, including a proxy's local URL.
    expect((await f.request('/api/v1/admin/groups', { method: 'POST', cookie: f.admin, body: '{"name":"valid local proxy"}', headers: { origin: panel, 'content-type': 'application/json' } })).status).toBe(201);
    expect((await f.request('/api/v1/admin/groups', { method: 'POST', cookie: f.admin, body: '{}', headers: { origin: 'http://127.0.0.1:8791', 'content-type': 'application/json' } })).status).toBe(403);
  });

  test('actual Host wins over URL authority and forwarded Host spoofing never selects a domain', async () => {
    const f = fixture({ trustProxy: true });
    const spoof = { 'x-forwarded-host': panelHost, forwarded: `host=${panelHost};proto=https`, 'x-forwarded-proto': 'https' };
    expect((await f.request('/', { authority: sub, host: panelHost })).status).toBe(200);
    expect((await f.request('/', { authority: panel, host: subHost, headers: spoof, cookie: f.admin })).status).toBe(404);
    expect((await f.request(`/s/${userToken}`, { authority: 'http://127.0.0.1:8791', host: subHost, headers: spoof })).status).toBe(200);
    expect((await f.request('/api/v1/site', { authority: panel, host: 'unknown.example.test', headers: spoof })).status).toBe(404);
    expect((await f.request('/api/v1/site', { host: panelHost, headers: { 'x-forwarded-host': subHost, forwarded: `host=${subHost}` } })).status).toBe(200);
    expect((await f.request('/', { host: null, authority: sub, headers: spoof })).status).toBe(404);
    const me = await data(await f.request('/api/v1/me', { authority: 'https://attacker.example.test', host: panelHost, headers: { 'x-forwarded-host': 'attacker.example.test' }, cookie: f.owner }));
    expect(me.subscription_url).toBe(`${sub}/s/${userToken}`);
  });

  test('subscription GET and HEAD share authorization status and headers, including unavailable and missing-token cases', async () => {
    const f = fixture({ now: () => new Date('2026-01-01T00:00:00Z') });
    const get = await f.request(`/s/${userToken}`, { host: subHost });
    const configText = await get.text(), config = JSON.parse(configText);
    expect(get.status).toBe(200);
    expect(config.data).toBeUndefined();
    expect(config.outbounds.find((node: any) => node.tag === 'node-1')).toMatchObject({ type: 'vless', uuid: credential, server: 'node.example.test', server_port: 443 });
    const head = await f.request(`/s/${userToken}`, { host: subHost, method: 'HEAD', cookie: f.admin });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    for (const key of ['content-type', 'content-length', 'content-disposition', 'profile-title', 'cache-control', 'x-content-type-options']) expect(head.headers.get(key)).toBe(get.headers.get(key));
    expect(head.headers.get('content-length')).toBe(String(new TextEncoder().encode(configText).byteLength));
    expect(head.headers.get('content-disposition')).toBe('attachment; filename="mboard.json"; filename*=UTF-8\'\'mboard.json');
    expect(head.headers.get('profile-title')).toBe('base64:bWJvYXJk');
    f.app.db.query("UPDATE settings SET value=? WHERE key='site_name'").run('示例站点 "A/B"\r\n');
    const named = await f.request(`/s/${userToken}`, { host: subHost, headers: { 'user-agent': 'ClashMetaForAndroid/2.11.1' } });
    expect(named.status).toBe(200);
    expect(named.headers.get('content-type')).toContain('yaml');
    expect(named.headers.get('profile-title')).toBe(`base64:${Buffer.from('示例站点 "A/B"', 'utf8').toString('base64')}`);
    expect(named.headers.get('content-disposition')).toBe(`attachment; filename="subscription.yaml"; filename*=UTF-8''${encodeURIComponent('示例站点 A B.yaml')}`);
    expect(await (await f.request('/', { host: panelHost })).text()).toContain('<title>示例站点 &quot;A/B&quot;</title>');
    for (const host of [panelHost, subHost]) {
      for (const method of ['GET', 'HEAD']) {
        const missing = await f.request(`/s/${'f'.repeat(64)}`, { host, method });
        expect(missing.status).toBe(404);
        if (method === 'HEAD') { expect(await missing.text()).toBe(''); expect(Number(missing.headers.get('content-length'))).toBeGreaterThan(0); }
      }
    }
    for (const update of ['enabled=0', "enabled=1,expires_at='2025-12-31T00:00:00.000Z'", 'enabled=1,expires_at=NULL,quota_bytes=1,upload_bytes=1']) {
      f.app.db.exec(`UPDATE users SET ${update} WHERE id=2`);
      for (const method of ['GET', 'HEAD']) {
        const unavailable = await f.request(`/s/${userToken}`, { host: subHost, method, cookie: f.admin });
        expect(unavailable.status).toBe(403);
        if (method === 'HEAD') expect(await unavailable.text()).toBe('');
        else expect((await unavailable.json() as any).error.code).toBe('SUBSCRIPTION_UNAVAILABLE');
      }
    }
    // Existing no-authorized-node semantics remain a direct-only successful config.
    const ungranted = await f.request(`/s/${adminToken}`, { host: subHost });
    expect(ungranted.status).toBe(200);
    expect((await ungranted.json() as any).outbounds.filter((node: any) => ['vless', 'trojan', 'shadowsocks'].includes(node.type))).toEqual([]);
  });

  test('origin and environment validation reject malformed or same-host separation before opening a database', () => {
    const dir = directory(); let attempt = 0;
    const reject = (options: AppOptions) => {
      const dbPath = join(dir, `rejected-${attempt++}`, 'mboard.sqlite');
      expect(() => createApp({ dbPath, publicOrigin: panel, subscriptionOrigin: sub, ...options })).toThrow();
      expect(existsSync(dirname(dbPath))).toBe(false);
    };
    for (const value of ['', 'not a URL', '//sub.example.test', 'ftp://sub.example.test', 'https://user:pass@sub.example.test', 'https://sub.example.test/path', 'https://sub.example.test//', 'https://sub.example.test?x=1', 'https://sub.example.test?', 'https://sub.example.test#hash', 'https://sub.example.test#', ' https://sub.example.test', 'https://sub.example.test ', 'https://sub.example.test\\path', 'https://sub.example.test:65536', 'https://sub.example.test:0', 'https://sub.example.test,other.test', 'https://127.1', 'https://0x7f000001']) {
      reject({ subscriptionOrigin: value });
      reject({ publicOrigin: value });
    }
    reject({ publicOrigin: undefined });
    for (const value of ['http://panel.example:8791', 'https://PANEL.example.', 'https://panel.example:443/']) reject({ subscriptionOrigin: value });
    reject({ publicOrigin: 'http://[::1]:8791', subscriptionOrigin: 'https://[0:0:0:0:0:0:0:1]:443' });
    for (const value of ['https://panel.example:443', 'https://user@sub.example.test', '']) {
      const dataDir = join(dir, `bad-env-${attempt++}`);
      expect(() => startServer({ MBOARD_HOST: '127.0.0.1', MBOARD_PORT: '8791', MBOARD_DATA_DIR: dataDir, MBOARD_PUBLIC_ORIGIN: panel, MBOARD_SUBSCRIPTION_ORIGIN: value })).toThrow();
      expect(existsSync(dataDir)).toBe(false);
    }
    const dataDir = join(dir, 'missing-public-env');
    expect(() => startServer({ MBOARD_DATA_DIR: dataDir, MBOARD_SUBSCRIPTION_ORIGIN: sub })).toThrow('requires MBOARD_PUBLIC_ORIGIN');
    expect(existsSync(dataDir)).toBe(false);
  });

  test('owner metadata and new tokens use canonical configured URLs while admin views redact them and optional mode stays open', async () => {
    const f = fixture({ subscriptionOrigin: 'HTTPS://PanelApiFkGfW.example.:443/' });
    for (const path of ['/api/v1/me', '/api/v1/overview', '/api/v1/auth/status']) {
      const result = await data(await f.request(path, { cookie: f.owner }));
      expect((result.user ?? result).subscription_url).toBe(`${sub}/s/${userToken}`);
    }
    const mutation = { method: 'POST', cookie: f.admin, headers: { origin: panel, 'content-type': 'application/json' } };
    const created = await data(await f.request('/api/v1/admin/users', { ...mutation, body: JSON.stringify({ email: 'new@example.test', name: 'New owner', password: pass, enabled: true, group_ids: [1] }) }));
    expect(created.subscription_token).toBe(''); expect(created.subscription_url).toBeUndefined();
    const login = await f.request('/api/v1/auth/login', { ...mutation, cookie: undefined, body: JSON.stringify({ email: 'new@example.test', password: pass }) });
    expect(login.status).toBe(200);
    const ownerCookie = login.headers.get('set-cookie')!.split(';')[0], loggedIn = await data(login);
    expect(loggedIn.subscription_token).toMatch(/^[a-f0-9]{64}$/);
    expect(loggedIn.subscription_url).toBe(`${sub}/s/${loggedIn.subscription_token}`);
    const rotated = await data(await f.request('/api/v1/me/subscription/rotate', { ...mutation, cookie: ownerCookie }));
    expect(rotated.subscription_token).not.toBe(loggedIn.subscription_token);
    expect(rotated.subscription_url).toBe(`${sub}/s/${rotated.subscription_token}`);
    expect((await f.request(`/s/${rotated.subscription_token}`, { host: subHost })).status).toBe(200);
    expect((await f.request(`/s/${loggedIn.subscription_token}`, { host: subHost })).status).toBe(404);
    expect((await data(await f.request('/api/v1/me', { cookie: ownerCookie }))).subscription_url).toBe(rotated.subscription_url);
    const users = await data(await f.request('/api/v1/admin/users', { cookie: f.admin }));
    expect(users.every((user: any) => user.subscription_token === '' && user.subscription_url === undefined)).toBe(true);
    expect(JSON.stringify(users)).not.toContain(rotated.subscription_token);
    const mainOnly = fixture({ subscriptionOrigin: undefined });
    expect((await data(await mainOnly.request('/api/v1/me', { cookie: mainOnly.owner }))).subscription_url).toBe(`${panel}/s/${userToken}`);
    for (const host of [subHost, 'unknown.example.test', 'bad@host']) expect((await mainOnly.request('/api/v1/site', { host })).status).toBe(200);
    const legacy = fixture({ subscriptionOrigin: undefined, publicOrigin: undefined });
    const legacyMe = await data(await legacy.request('/api/v1/me', { cookie: legacy.owner }));
    expect(legacyMe.subscription_token).toBe(userToken); expect(legacyMe.subscription_url).toBeUndefined();
  });

  test('a real ephemeral Bun HTTP listener honors the transmitted Host on the same port', async () => {
    const f = fixture();
    const observed: { host: string | null; url: string }[] = [];
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req) { observed.push({ host: req.headers.get('host'), url: req.url }); return f.app.fetch(req); } });
    servers.push(server);
    const url = server.url.origin;
    const panelResponse = await fetch(`${url}/api/v1/me`, { headers: { Host: 'PaNeL.example:8791', Cookie: f.owner } });
    expect(panelResponse.status).toBe(200);
    expect((await panelResponse.json() as any).data.subscription_url).toBe(`${sub}/s/${userToken}`);
    const blocked = await fetch(`${url}/api/v1/admin/users`, { headers: { Host: subHost, Cookie: f.admin, 'X-Forwarded-Host': panelHost } });
    expect(blocked.status).toBe(404); await blocked.arrayBuffer();
    const config = await fetch(`${url}/s/${userToken}`, { headers: { Host: subHost } });
    expect(config.status).toBe(200);
    expect(config.headers.get('content-disposition')).toBe('attachment; filename="mboard.json"; filename*=UTF-8\'\'mboard.json');
    expect(config.headers.get('profile-title')).toBe('base64:bWJvYXJk');
    expect((await config.json() as any).outbounds.some((node: any) => node.uuid === credential)).toBe(true);
    const head = await fetch(`${url}/s/${userToken}`, { method: 'HEAD', headers: { Host: subHost } });
    expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).toBe(config.headers.get('content-length'));
    const unknown = await fetch(`${url}/api/v1/site`, { headers: { Host: 'unknown.example.test', 'X-Forwarded-Host': panelHost } });
    expect(unknown.status).toBe(404); await unknown.arrayBuffer();
    expect(observed[0].host).toBe('PaNeL.example:8791');
    expect(observed.some(request => request.host === subHost)).toBe(true);
    // Bun 1.3.14 rebuilds req.url from the transmitted Host. The direct Request test
    // above separately covers proxies/adapters where the URL authority differs.
    for (const request of observed) expect(new URL(request.url).host).toBe(new URL(`http://${request.host}`).host);
  });

  test('an extra panel origin serves the panel and only accepts its own mutation origin', async () => {
    const extra = 'https://panelb.example';
    const extraHost = 'panelb.example';
    const f = fixture({ panelOrigins: [extra] });
    expect((await f.request('/', { host: extraHost })).status).toBe(200);
    expect((await f.request('/', { host: 'PaNeLb.example:443' })).status).toBe(200);
    expect((await data(await f.request('/api/v1/me', { host: extraHost, cookie: f.owner }))).subscription_url).toBe(`${sub}/s/${userToken}`);
    expect((await f.request(`/s/${userToken}`, { host: extraHost })).status).toBe(200);
    expect((await f.request('/api/node/v1/config', { host: extraHost, headers: { authorization: `Bearer ${machineToken}` } })).status).toBe(200);
    const mutation = { host: extraHost, method: 'POST', cookie: f.admin, body: '{"name":"panel b group"}', headers: { origin: extra, 'content-type': 'application/json' } };
    expect((await f.request('/api/v1/admin/groups', mutation)).status).toBe(201);
    expect((await f.request('/api/v1/admin/groups', { ...mutation, headers: { origin: panel, 'content-type': 'application/json' } })).status).toBe(403);
    expect((await f.request('/api/v1/admin/groups', { method: 'POST', cookie: f.admin, body: '{"name":"canonical group"}', headers: { origin: extra, 'content-type': 'application/json' } })).status).toBe(403);
    expect((await f.request('/', { host: subHost })).status).toBe(404);
    const dir = directory();
    expect(() => createApp({ dbPath: join(dir, 'same-host.sqlite'), publicOrigin: panel, subscriptionOrigin: sub, panelOrigins: [panel] })).toThrow('different hostnames');
    expect(() => createApp({ dbPath: join(dir, 'sub-host.sqlite'), publicOrigin: panel, subscriptionOrigin: sub, panelOrigins: [sub] })).toThrow('different hostname');
    expect(() => createApp({ dbPath: join(dir, 'missing-public.sqlite'), panelOrigins: [extra] })).toThrow('requires MBOARD_PUBLIC_ORIGIN');
    expect(existsSync(join(dir, 'same-host.sqlite'))).toBe(false);
    expect(() => startServer({ MBOARD_HOST: '127.0.0.1', MBOARD_PORT: '8791', MBOARD_DATA_DIR: join(dir, 'empty-extra'), MBOARD_PUBLIC_ORIGIN: panel, MBOARD_SUBSCRIPTION_ORIGIN: sub, MBOARD_PANEL_ORIGINS: `${extra},` })).toThrow('empty origin');
    expect(existsSync(join(dir, 'empty-extra'))).toBe(false);
  });
});
