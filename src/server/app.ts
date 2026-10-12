import { openDatabase, hash, secret } from './database';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';

type Row = Record<string, any>;
export interface AppOptions { dbPath?: string; distDir?: string; now?: () => Date; sessionSeconds?: number; loginLimit?: number; peerLoginLimit?: number; trustProxy?: boolean; initializeRuntime?: boolean; publicOrigin?: string }
class ApiError extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
function fail(status: number, code: string, message: string): never { throw new ApiError(status, code, message); }
const string = (v: unknown, label: string, max = 200, min = 1): string => {
  if (typeof v !== 'string' || v.trim().length < min || v.length > max || v.includes('\0')) fail(400, 'VALIDATION', `请填写有效的${label}`);
  return v as string;
};
const integer = (v: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number => {
  if (!Number.isSafeInteger(v) || (v as number) < min || (v as number) > max) fail(400, 'VALIDATION', `请填写有效的${label}`);
  return v as number;
};
const boolean = (v: unknown, label: string): number => { if (typeof v !== 'boolean') fail(400, 'VALIDATION', `请选择${label}`); return v ? 1 : 0; };
const email = (v: unknown) => { const s = string(v, '邮箱', 254).trim().toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) fail(400, 'VALIDATION', '请填写有效的邮箱'); return s; };
const password = (v: unknown) => string(v, '至少 12 个字符的密码', 1024, 12);
const expiry = (v: unknown) => { if (v === null) return null; const s = string(v, '到期时间', 40); if (!/^\d{4}-\d{2}-\d{2}T/.test(s) || !Number.isFinite(Date.parse(s))) fail(400, 'VALIDATION', '请填写 ISO 格式的到期时间'); return new Date(s).toISOString(); };
const endpoint = (v: unknown) => { const s = string(v, '主机名', 253).trim(); if (!/^[a-zA-Z0-9.:[\]_-]+$/.test(s)) fail(400, 'VALIDATION', '请填写有效的主机名或 IP 地址'); return s; };
const own = (o: Row, k: string) => Object.prototype.hasOwnProperty.call(o, k);
// PHP bcrypt truncates at 72 bytes. Bun otherwise prehashes long inputs, which would
// reject the original password of an imported account. New hashes use argon2id.
const verifyPassword = (plain: string, digest: string) => Bun.password.verify(
  /^\$2[aby]\$/.test(digest) ? new TextEncoder().encode(plain).subarray(0, 72) : plain, digest,
);
const pick = (body: Row, fields: string[]) => { for (const k of Object.keys(body)) if (!fields.includes(k)) fail(400, 'VALIDATION', `请检查字段：${k.slice(0, 40)}`); };

export function createApp(options: AppOptions = {}) {
  let publicOrigin: string | undefined;
  if (options.publicOrigin !== undefined) {
    const origin = new URL(options.publicOrigin);
    if (!['http:','https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('MBOARD_PUBLIC_ORIGIN must be one HTTP(S) origin without credentials, path, query or fragment');
    publicOrigin = origin.origin;
  }
  const accountLimit = options.loginLimit ?? 10, peerLimit = options.peerLoginLimit ?? 200;
  for (const value of [accountLimit,peerLimit]) if (!Number.isSafeInteger(value) || value < 1 || value > 1000000) throw new Error('Login limits must be integers from 1 to 1000000');
  const db = openDatabase(options.dbPath);
  const now = options.now ?? (() => new Date());
  const stamp = () => now().toISOString();
  const get = (sql: string, ...args: any[]): Row | null => db.query(sql).get(...args) as Row | null;
  const all = (sql: string, ...args: any[]): Row[] => db.query(sql).all(...args) as Row[];
  const run = (sql: string, ...args: any[]) => db.query(sql).run(...args);
  const atomic = <T>(f: () => T): T => db.transaction(f).immediate();
  const bump = () => run('UPDATE machines SET config_revision=config_revision+1');
  const audit = (actor: Row, action: string, target: string | number) => run('INSERT INTO audit(actor,action,target,created_at) VALUES(?,?,?,?)', actor.email, action, String(target), stamp());
  const json = (data: any, status = 200, headers?: HeadersInit) => Response.json({ data }, { status, headers });
  const requireRow = (table: string, id: number) => get(`SELECT * FROM ${table} WHERE id=?`, id) ?? fail(404, 'NOT_FOUND', '请确认这条记录是否还在');
  const groupsFor = (type: 'user' | 'node', id: number) => all(`SELECT group_id FROM ${type}_groups WHERE ${type}_id=? ORDER BY group_id`, id).map(r => r.group_id);
  const userView = (u: Row, admin = false): Row => {
    const v: Row = { id: u.id, email: u.email, name: u.name, role: u.role, enabled: !!u.enabled, created_at: u.created_at, upload_bytes: u.upload_bytes, download_bytes: u.download_bytes, quota_bytes: u.quota_bytes, expires_at: u.expires_at, subscription_token: admin ? '' : u.subscription_token };
    if (admin) v.group_ids = groupsFor('user', u.id);
    return v;
  };
  const online = (m: Row | null) => !!m?.enabled && !!m.last_seen_at && now().getTime() - Date.parse(m.last_seen_at) < 90_000;
  const machineView = (m: Row) => ({ id: m.id, name: m.name, host: m.host, enabled: !!m.enabled, last_seen_at: m.last_seen_at, version: m.version, online: online(m), config_revision: m.config_revision });
  const nodeView = (n: Row) => ({ id: n.id, name: n.name, host: n.host, port: n.port, protocol: n.protocol, enabled: !!n.enabled, machine_id: n.machine_id, group_ids: groupsFor('node', n.id), tls: !!n.tls, server_name: n.server_name, online: !!n.enabled && online(n.machine_id ? get('SELECT * FROM machines WHERE id=?', n.machine_id) : null), created_at: n.created_at });
  const active = (u: Row) => !!u.enabled && (!u.expires_at || Date.parse(u.expires_at) > now().getTime()) && (!u.quota_bytes || u.upload_bytes + u.download_bytes < u.quota_bytes);
  const granted = (uid: number, nid: number) => !!get('SELECT 1 FROM user_groups ug JOIN node_groups ng ON ug.group_id=ng.group_id WHERE ug.user_id=? AND ng.node_id=? LIMIT 1', uid, nid);
  const authorizedNodes = (u: Row) => active(u) ? all(`SELECT DISTINCT n.* FROM nodes n JOIN node_groups ng ON ng.node_id=n.id JOIN user_groups ug ON ug.group_id=ng.group_id LEFT JOIN machines m ON m.id=n.machine_id WHERE ug.user_id=? AND n.enabled=1 AND (n.machine_id IS NULL OR m.enabled=1) ORDER BY n.id`, u.id) : [];
  const setGroups = (kind: 'user' | 'node', id: number, ids: number[]) => { run(`DELETE FROM ${kind}_groups WHERE ${kind}_id=?`, id); for (const gid of ids) run(`INSERT INTO ${kind}_groups(${kind}_id,group_id) VALUES(?,?)`, id, gid); };
  const validGroups = (v: unknown): number[] => {
    if (!Array.isArray(v) || v.length > 1000) fail(400, 'VALIDATION', '请选择有效的分组');
    const ids = [...new Set((v as any[]).map(x => integer(x, '分组 ID', 1)))];
    for (const id of ids) if (!get('SELECT id FROM groups WHERE id=?', id)) fail(400, 'VALIDATION', '请选择已有的分组');
    return ids;
  };
  const sessionCookie = (req: Request, token: string, age: number) => `mboard_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(publicOrigin ?? req.url).protocol === 'https:' ? '; Secure' : ''}`;
  const sessionSeconds = options.sessionSeconds ?? 604800;
  const newSession = (req: Request, uid: number) => {
    const token = secret();
    run('DELETE FROM sessions WHERE expires_at<=?', stamp());
    run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', hash(token), uid, new Date(now().getTime() + sessionSeconds * 1000).toISOString());
    return { 'Set-Cookie': sessionCookie(req, token, sessionSeconds) };
  };
  const sessionHash = (req: Request) => { const token = req.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith('mboard_session='))?.slice(15); return token && /^[a-f0-9]{64}$/.test(token) ? hash(token) : ''; };
  const authenticated = (req: Request, required = true) => {
    const u = get('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires_at>? AND u.enabled=1', sessionHash(req), stamp());
    if (!u && required) fail(401, 'AUTH_REQUIRED', '请先登录');
    return u;
  };
  const limits = new Map<string, { count: number; until: number }>();
  const limit = (req: Request, ip?: string, account = '$setup') => {
    const peer = (options.trustProxy ? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? ip ?? 'local' : ip ?? 'local').slice(0,128);
    const timestamp = now().getTime();
    const hit = (key: string, ceiling: number) => {
      let bucket = limits.get(key);
      if (!bucket || bucket.until <= timestamp) {
        if (!limits.has(key) && limits.size >= 10000) {
          for (const [k,b] of limits) if (b.until <= timestamp) limits.delete(k);
          while (limits.size >= 10000) limits.delete(limits.keys().next().value!);
        }
        bucket = { count: 0, until: timestamp + 900000 }; limits.set(key,bucket);
      }
      if (bucket.count >= ceiling) fail(429,'RATE_LIMIT','尝试次数较多，请稍后再登录');
      bucket.count++;
    };
    hit(JSON.stringify(['peer',peer]),peerLimit);
    hit(JSON.stringify(['account',peer,account]),accountLimit);
  };
  async function body(req: Request): Promise<Row> {
    const length = req.headers.get('content-length');
    if (length && Number(length) > 1048576) { await req.body?.cancel(); fail(413,'BODY_LIMIT','请将请求内容控制在 1 MiB 内'); }
    if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') fail(415, 'CONTENT_TYPE', '请发送 JSON 格式的数据');
    const reader = req.body?.getReader();
    if (!reader) fail(400, 'VALIDATION', '请填写请求内容');
    let size = 0; const chunks: Uint8Array[] = [];
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 1048576) { await reader.cancel(); fail(413, 'BODY_LIMIT', '请将请求内容控制在 1 MiB 内'); } chunks.push(value); }
    const bytes = new Uint8Array(size); let offset = 0; for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
    let parsed: any; try { parsed = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, 'VALIDATION', '请检查 JSON 内容'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(400, 'VALIDATION', '请发送 JSON 对象');
    const route = new URL(req.url).pathname;
    if (route.startsWith('/api/v1/') && !route.startsWith('/api/v1/auth/')) authenticated(req);
    return parsed;
  }
  const traffic = (uid: number | null, days = 30) => {
    const start = new Date(now().getTime() - (days - 1) * 86400000).toISOString().slice(0, 10);
    return uid === null ? all('SELECT date,SUM(upload_bytes) upload_bytes,SUM(download_bytes) download_bytes FROM traffic_daily WHERE date>=? GROUP BY date ORDER BY date', start) : all('SELECT date,upload_bytes,download_bytes FROM traffic_daily WHERE user_id=? AND date>=? ORDER BY date', uid, start);
  };
  const ticketView = (t: Row) => ({ id: t.id, subject: t.subject, status: t.status, user_id: t.user_id, user_name: requireRow('users', t.user_id).name, created_at: t.created_at, messages: all('SELECT id,body,author_role,created_at FROM messages WHERE ticket_id=? ORDER BY id', t.id) });
  const settings = () => ({ site_name: get("SELECT value FROM settings WHERE key='site_name'")!.value, site_description: get("SELECT value FROM settings WHERE key='site_description'")!.value });
  function outbound(n: Row, u: Row) {
    const result: Row = { type: n.protocol, tag: `node-${n.id}`, server: n.host, server_port: n.port };
    if (n.protocol === 'vless') result.uuid = u.credential;
    else { result.password = u.credential; if (n.protocol === 'shadowsocks') result.method = 'aes-128-gcm'; }
    if (n.tls) result.tls = { enabled: true, server_name: n.server_name || n.host };
    return result;
  }
  function clientConfig(u: Row) {
    const nodes = authorizedNodes(u);
    const tags = nodes.map(n => `node-${n.id}`);
    return { log: { level: 'warn' }, inbounds: [{ type: 'mixed', tag: 'mixed-in', listen: '127.0.0.1', listen_port: 2080 }], outbounds: [{ type: 'selector', tag: 'proxy', outbounds: ['auto', ...tags, 'direct'], default: tags.length ? 'auto' : 'direct' }, { type: 'urltest', tag: 'auto', outbounds: tags.length ? tags : ['direct'], url: 'https://www.gstatic.com/generate_204', interval: '5m' }, ...nodes.map(n => outbound(n, u)), { type: 'direct', tag: 'direct' }], route: { final: 'proxy' } };
  }
  function serverConfig(m: Row) {
    const nodes = all('SELECT * FROM nodes WHERE machine_id=? AND enabled=1 ORDER BY id', m.id);
    const users = all('SELECT * FROM users WHERE enabled=1 ORDER BY id').filter(active);
    return { log: { level: 'info' }, inbounds: nodes.map(n => {
      const allowed = users.filter(u => granted(u.id, n.id));
      const inbound: Row = { type: n.protocol, tag: `node-${n.id}`, listen: '::', listen_port: n.port };
      if (n.protocol === 'shadowsocks') { inbound.method = 'aes-128-gcm'; if (!allowed.length) inbound.managed = true; inbound.users = allowed.map(u => ({ name: String(u.id), password: u.credential })); }
      else inbound.users = allowed.map(u => ({ name: String(u.id), ...(n.protocol === 'vless' ? { uuid: u.credential } : { password: u.credential }) }));
      if (n.tls) inbound.tls = { enabled: true, certificate_path: `/etc/mboard-node/tls/${n.id}.crt`, key_path: `/etc/mboard-node/tls/${n.id}.key` };
      return inbound;
    }), outbounds: [{ type: 'direct', tag: 'direct' }], route: { final: 'direct' } };
  }

  async function dispatch(req: Request, ip?: string): Promise<Response> {
    const url = new URL(req.url), path = url.pathname, method = req.method.toUpperCase();
    const nodePath = path.startsWith('/api/node/');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !nodePath) {
      const origin = req.headers.get('origin');
      if (origin !== (publicOrigin ?? url.origin) || req.headers.get('sec-fetch-site') === 'cross-site') fail(403, 'ORIGIN', '请从本面板页面提交操作');
    }
    if (nodePath) {
      if (req.headers.get('cookie')?.includes('mboard_session=')) fail(401, 'NODE_AUTH', '请使用机器令牌连接');
      const bearer = req.headers.get('authorization');
      if (!bearer || !/^Bearer [a-f0-9]{64}$/.test(bearer)) fail(401, 'NODE_AUTH', '请使用有效的机器令牌');
      const m = get('SELECT * FROM machines WHERE token_hash=? AND enabled=1', hash(bearer.slice(7)));
      if (!m) fail(401, 'NODE_AUTH', '请确认机器令牌和启用状态');
      if (path === '/api/node/v1/config' && method === 'GET') return json({ revision: m.config_revision, config: serverConfig(m) });
      if (path === '/api/node/v1/heartbeat' && method === 'POST') {
        const b = await body(req); pick(b, ['version','uptime_seconds','config_revision']);
        if (!get('SELECT 1 FROM machines WHERE id=? AND token_hash=? AND enabled=1', m.id, hash(bearer.slice(7)))) fail(401, 'NODE_AUTH', '机器设置有更新，请重新连接');
        const version = string(b.version, '节点版本', 100); integer(b.uptime_seconds, '运行秒数'); integer(b.config_revision, '配置版本');
        run('UPDATE machines SET last_seen_at=?,version=? WHERE id=?', stamp(), version, m.id);
        return json({ server_time: stamp(), config_revision: requireRow('machines', m.id).config_revision });
      }
      if (path === '/api/node/v1/traffic' && method === 'POST') {
        const b = await body(req); pick(b, ['batch_id','records']); const batch = string(b.batch_id, '批次 ID', 128);
        if (!Array.isArray(b.records) || b.records.length > 10000) fail(400, 'VALIDATION', '请发送有效的流量记录');
        atomic(() => {
          if (!get('SELECT 1 FROM machines WHERE id=? AND token_hash=? AND enabled=1', m.id, hash(bearer.slice(7)))) fail(401, 'NODE_AUTH', '机器设置有更新，请重新连接');
          if (get('SELECT 1 FROM traffic_batches WHERE machine_id=? AND batch_id=?', m.id, batch)) return false;
          const sums = new Map<number, { up: number; down: number }>();
          for (const r of b.records) {
            if (!r || typeof r !== 'object' || Array.isArray(r)) fail(400, 'VALIDATION', '请检查流量记录');
            pick(r, ['user_id','node_id','upload_bytes','download_bytes']);
            const uid = integer(r.user_id, '用户 ID', 1), nid = integer(r.node_id, '节点 ID', 1), up = integer(r.upload_bytes, '上传字节'), down = integer(r.download_bytes, '下载字节');
            const n = get('SELECT * FROM nodes WHERE id=? AND machine_id=?', nid, m.id), u = get('SELECT * FROM users WHERE id=?', uid);
            // Delayed accounting is accepted for existing grants even if the user just expired or hit quota.
            if (!n || !u || !granted(uid, nid)) fail(403, 'TRAFFIC_GRANT', '请确认流量记录属于本机器和授权用户');
            const s = sums.get(uid) ?? { up: 0, down: 0 }; s.up += up; s.down += down;
            if (![s.up, s.down, s.up+s.down, u.upload_bytes+s.up, u.download_bytes+s.down, u.upload_bytes+u.download_bytes+s.up+s.down].every(Number.isSafeInteger)) fail(400, 'VALIDATION', '流量总数超出安全整数范围，请拆分并检查计数');
            sums.set(uid, s);
          }
          const totals = get('SELECT COALESCE(SUM(upload_bytes),0) up,COALESCE(SUM(download_bytes),0) down FROM users')!;
          let totalUp = totals.up, totalDown = totals.down;
          for (const s of sums.values()) { totalUp += s.up; totalDown += s.down; }
          if (![totalUp,totalDown,totalUp+totalDown].every(Number.isSafeInteger)) fail(400, 'VALIDATION', '全站流量总数超出安全整数范围，请检查计数');
          let eligibilityChanged = false;
          for (const [uid, s] of sums) {
            const before = requireRow('users', uid);
            const daily = get('SELECT * FROM traffic_daily WHERE user_id=? AND date=?', uid, stamp().slice(0,10));
            if (daily && ![daily.upload_bytes+s.up,daily.download_bytes+s.down,daily.upload_bytes+daily.download_bytes+s.up+s.down].every(Number.isSafeInteger)) fail(400, 'VALIDATION', '当天流量总数超出安全整数范围');
            run('UPDATE users SET upload_bytes=upload_bytes+?,download_bytes=download_bytes+? WHERE id=?', s.up, s.down, uid);
            run('INSERT INTO traffic_daily(user_id,date,upload_bytes,download_bytes) VALUES(?,?,?,?) ON CONFLICT(user_id,date) DO UPDATE SET upload_bytes=upload_bytes+excluded.upload_bytes,download_bytes=download_bytes+excluded.download_bytes', uid, stamp().slice(0,10), s.up, s.down);
            if (active(before) !== active(requireRow('users', uid))) eligibilityChanged = true;
          }
          run('INSERT INTO traffic_batches(machine_id,batch_id,created_at) VALUES(?,?,?)', m.id, batch, stamp());
          if (eligibilityChanged) bump();
          return true;
        });
        return json({ accepted: true });
      }
      fail(404, 'NOT_FOUND', '请检查节点接口地址');
    }
    if (path === '/api/v1/site' && method === 'GET') return json(settings());
    if (path === '/api/v1/auth/status' && method === 'GET') return json({ setup_required: get("SELECT value FROM settings WHERE key='setup_complete'")!.value === '0', user: authenticated(req, false) ? userView(authenticated(req, false)!) : null });
    if (path === '/api/v1/auth/setup' && method === 'POST') {
      limit(req, ip); const b = await body(req); pick(b, ['email','password','name']);
      const addr = email(b.email), name = string(b.name, '姓名', 100).trim(), pass = password(b.password);
      if (get("SELECT value FROM settings WHERE key='setup_complete'")!.value !== '0') fail(409, 'SETUP_COMPLETE', '面板已初始化，请登录管理员账号');
      const digest = await Bun.password.hash(pass, { algorithm: 'argon2id' });
      const uid = atomic(() => {
        if (get("SELECT value FROM settings WHERE key='setup_complete'")!.value !== '0') fail(409, 'SETUP_COMPLETE', '面板已初始化，请登录管理员账号');
        const id = Number(run('INSERT INTO users(email,name,role,password_hash,credential,subscription_token,created_at) VALUES(?,?,?,?,?,?,?)', addr, name, 'admin', digest, crypto.randomUUID(), secret(), stamp()).lastInsertRowid);
        run("UPDATE settings SET value='1' WHERE key='setup_complete'"); bump(); audit({ email: addr }, 'setup', id); return id;
      });
      return json(userView(requireRow('users', uid)), 201, newSession(req, uid));
    }
    if (path === '/api/v1/auth/login' && method === 'POST') {
      const b = await body(req); pick(b, ['email','password']); const addr = email(b.email), pass = string(b.password, '密码', 1024); limit(req, ip, addr);
      const u = get('SELECT * FROM users WHERE email=?', addr);
      const match = u ? await verifyPassword(pass, u.password_hash) : await Bun.password.verify(pass, dummyHash);
      if (!match || !u?.enabled) fail(401, 'LOGIN_FAILED', '请检查邮箱、密码和账号启用状态');
      // Re-read after the async hash check: password reset/disable must invalidate an in-flight login.
      const fresh = requireRow('users', u.id);
      if (!fresh.enabled || fresh.password_hash !== u.password_hash) fail(401, 'LOGIN_FAILED', '账号设置有更新，请重新登录');
      return json(userView(fresh), 200, newSession(req, u.id));
    }
    if (path === '/api/v1/auth/logout' && method === 'POST') { run('DELETE FROM sessions WHERE token_hash=?', sessionHash(req)); return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(req, '', 0) }); }
    if (path.startsWith('/s/') && method === 'GET') {
      const token = path.slice(3); const u = /^[a-f0-9]{64}$/.test(token) ? get('SELECT * FROM users WHERE subscription_token=?', token) : null;
      if (!u) fail(404, 'NOT_FOUND', '请确认订阅链接');
      if (!active(u)) fail(403, 'SUBSCRIPTION_UNAVAILABLE', '订阅待恢复，请确认账号状态、到期时间和流量额度');
      return Response.json(clientConfig(u));
    }
    if (!path.startsWith('/api/')) return staticResponse(req, options.distDir);
    const u = authenticated(req)!;
    if (path === '/api/v1/me' && method === 'GET') return json(userView(u));
    if (path === '/api/v1/me/password' && method === 'PATCH') {
      const b = await body(req); pick(b, ['current_password','new_password']); const pass = password(b.new_password);
      if (!await verifyPassword(string(b.current_password, '原密码', 1024), u.password_hash)) fail(400, 'PASSWORD', '请检查原密码');
      const digest = await Bun.password.hash(pass, { algorithm: 'argon2id' });
      atomic(() => {
        const fresh = requireRow('users', u.id);
        if (fresh.password_hash !== u.password_hash || !fresh.enabled || !get('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?',sessionHash(req),u.id,stamp())) fail(401, 'AUTH_REQUIRED', '账号设置有更新，请重新登录');
        run('UPDATE users SET password_hash=? WHERE id=?', digest, u.id); run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', u.id, sessionHash(req)); audit(u, 'password.change', u.id);
      });
      return json({ ok: true });
    }
    if (path === '/api/v1/me/subscription/rotate' && method === 'POST') {
      const token = secret(); atomic(() => { run('UPDATE users SET subscription_token=?,credential=? WHERE id=?', token, crypto.randomUUID(), u.id); bump(); audit(u, 'subscription.rotate', u.id); }); return json({ subscription_token: token });
    }
    if (path === '/api/v1/nodes' && method === 'GET') return json(authorizedNodes(u).map(nodeView));
    if (path === '/api/v1/traffic' && method === 'GET') { const raw = url.searchParams.get('days') ?? '30'; if (!/^\d+$/.test(raw)) fail(400, 'VALIDATION', '请填写 1 到 366 天的范围'); return json(traffic(u.id, integer(Number(raw), '天数', 1, 366))); }
    if (path === '/api/v1/overview' && method === 'GET') return json({ user: userView(u), nodes: authorizedNodes(u).map(nodeView), traffic: traffic(u.id), notices: all('SELECT * FROM notices ORDER BY id DESC') });
    if (['/api/v1/notices','/api/v1/guides'].includes(path) && method === 'GET') return json(all(`SELECT * FROM ${path.endsWith('notices') ? 'notices' : 'guides'} ORDER BY id DESC`));
    if (path === '/api/v1/tickets' && method === 'GET') return json(all('SELECT * FROM tickets WHERE user_id=? ORDER BY id DESC', u.id).map(ticketView));
    if (path === '/api/v1/tickets' && method === 'POST') {
      const b = await body(req); pick(b, ['subject','body']); const subject = string(b.subject, '工单标题', 200), text = string(b.body, '工单内容', 20000);
      const id = atomic(() => { const id = Number(run('INSERT INTO tickets(subject,user_id,created_at) VALUES(?,?,?)', subject, u.id, stamp()).lastInsertRowid); run('INSERT INTO messages(ticket_id,body,author_role,created_at) VALUES(?,?,?,?)', id, text, u.role, stamp()); audit(u, 'ticket.create', id); return id; });
      return json(ticketView(requireRow('tickets', id)), 201);
    }
    const ticketMatch = path.match(/^\/api\/v1\/tickets\/(\d+)(\/messages)?$/);
    if (ticketMatch) {
      const id = integer(Number(ticketMatch[1]), '工单 ID', 1), t = requireRow('tickets', id);
      if (t.user_id !== u.id && u.role !== 'admin') fail(404, 'NOT_FOUND', '请确认工单地址');
      if (method === 'POST' && ticketMatch[2]) {
        const b = await body(req); pick(b, ['body']); const text = string(b.body, '回复内容', 20000);
        if (t.status === 'closed') fail(409, 'TICKET_CLOSED', '工单已关闭，可创建新的工单');
        atomic(() => { run('INSERT INTO messages(ticket_id,body,author_role,created_at) VALUES(?,?,?,?)', id, text, u.role, stamp()); audit(u, 'ticket.reply', id); }); return json(ticketView(t));
      }
      if (method === 'PATCH' && !ticketMatch[2]) { const b = await body(req); pick(b, ['status']); if (b.status !== 'closed') fail(400, 'VALIDATION', '可将工单状态改为关闭'); atomic(() => { run("UPDATE tickets SET status='closed' WHERE id=?", id); audit(u, 'ticket.close', id); }); return json(ticketView(requireRow('tickets', id))); }
    }
    if (path.startsWith('/api/v1/admin/')) {
      if (u.role !== 'admin') fail(403, 'ADMIN_REQUIRED', '请使用管理员账号');
      if (path === '/api/v1/admin/imports' && method === 'GET') {
        // Explicit display allowlist: never return payloads, protocol_settings,
        // encrypted settings, password hashes, keys, or old/new credentials.
        const records = (kind: string) => all('SELECT id,payload FROM legacy_records WHERE kind=? ORDER BY id', kind).map(r => ({ archiveId: r.id, row: JSON.parse(r.payload) as Row }));
        const safeId = (v: unknown): number | null => /^(?:[1-9]\d*)$/.test(String(v)) && Number.isSafeInteger(Number(v)) ? Number(v) : null;
        const display = (v: unknown, fallback: string, max = 253) => typeof v === 'string' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v) ? v : fallback;
        const nodes = records('v2_server').map(({ archiveId, row: r }) => {
          let gids: unknown = r.group_ids;
          if (typeof gids === 'string') { try { gids = JSON.parse(gids); } catch { gids = []; } }
          const protocol = display(r.type ?? r.protocol, 'unknown', 40);
          const host = display(r.host, '');
          return { id: safeId(r.id) ?? archiveId, name: display(r.name, `节点 ${archiveId}`, 200),
            protocol: /^[a-z0-9_-]+$/.test(protocol) ? protocol : 'unknown',
            host: /^[a-zA-Z0-9.:[\]_-]+$/.test(host) ? host : '',
            port: safeId(r.port) && Number(r.port) <= 65535 ? Number(r.port) : null,
            parent_id: safeId(r.parent_id), machine_id: safeId(r.machine_id),
            group_ids: Array.isArray(gids) ? [...new Set(gids.map(safeId).filter((id): id is number => id !== null))] : [],
            state: 'pending', note: '原配置已经归档。逐台接入后可恢复这个节点。' };
        });
        const machines = records('v2_server_machine').map(({ archiveId, row: r }) => ({ id: safeId(r.id) ?? archiveId, name: display(r.name, `机器 ${archiveId}`, 200), state: 'pending' }));
        const imported = get('SELECT created_at FROM import_runs ORDER BY created_at DESC LIMIT 1');
        const count = (kind: string) => get('SELECT COUNT(*) count FROM legacy_records WHERE kind=?', kind)!.count;
        return json({ summary: { users: count('v2_user'), nodes: nodes.length, machines: machines.length, groups: count('v2_server_group'), imported_at: imported?.created_at ?? null }, nodes, machines });
      }
      if (path === '/api/v1/admin/overview' && method === 'GET') {
        const machines = all('SELECT * FROM machines ORDER BY last_seen_at DESC,id DESC');
        const nodes = all('SELECT * FROM nodes');
        const totals = get('SELECT COUNT(*) users,COALESCE(SUM(enabled),0) enabled_users,COALESCE(SUM(upload_bytes),0) upload_bytes,COALESCE(SUM(download_bytes),0) download_bytes FROM users')!;
        return json({ ...totals, nodes: nodes.length, online_nodes: nodes.map(nodeView).filter(n => n.online).length, machines: machines.length, online_machines: machines.filter(online).length, traffic: traffic(null), recent_machines: machines.slice(0, 10).map(machineView) });
      }
      if (path === '/api/v1/admin/audit' && method === 'GET') return json(all('SELECT * FROM audit ORDER BY id DESC LIMIT 100'));
      if (path === '/api/v1/admin/tickets' && method === 'GET') return json(all('SELECT * FROM tickets ORDER BY id DESC').map(ticketView));
      if (path === '/api/v1/admin/settings') {
        if (method === 'GET') return json(settings());
        if (method === 'PATCH') { const b = await body(req); pick(b, ['site_name','site_description']); const entries = Object.entries(b).map(([k,v]) => [k,string(v, k === 'site_name' ? '站点名称' : '站点介绍', k === 'site_name' ? 100 : 2000, k === 'site_name' ? 1 : 0)]); atomic(() => { for (const [k,v] of entries) run('UPDATE settings SET value=? WHERE key=?', v, k); audit(u, 'settings.update', 'site'); }); return json(settings()); }
      }
      const match = path.match(/^\/api\/v1\/admin\/(users|groups|nodes|machines|notices|guides)(?:\/(\d+))?(\/token)?$/);
      if (match) {
        const table = match[1], id = match[2] ? integer(Number(match[2]), '记录 ID', 1) : null;
        const view = (row: Row) => table === 'users' ? userView(row, true) : table === 'nodes' ? nodeView(row) : table === 'machines' ? machineView(row) : row;
        if (!id && method === 'GET') return json(all(`SELECT * FROM ${table} ORDER BY id`).map(view));
        if (id && table === 'machines' && match[3] && method === 'POST') {
          requireRow(table, id); const token = secret(); atomic(() => { run('UPDATE machines SET token_hash=?,last_seen_at=NULL,config_revision=config_revision+1 WHERE id=?', hash(token), id); audit(u, 'machine.token.rotate', id); }); return json({ token });
        }
        if (match[3]) fail(404, 'NOT_FOUND', '请检查接口地址');
        if (id && method === 'DELETE') {
          const row = requireRow(table, id);
          atomic(() => {
            if (table === 'users' && row.role === 'admin' && row.enabled && get("SELECT COUNT(*) count FROM users WHERE role='admin' AND enabled=1")!.count <= 1) fail(409, 'LAST_ADMIN', '请保留至少一个启用的管理员账号');
            if (table === 'machines' && get('SELECT id FROM nodes WHERE machine_id=? LIMIT 1', id)) fail(409, 'IN_USE', '请先转移或删除这台机器上的节点');
            if (table === 'groups' && (get('SELECT 1 FROM user_groups WHERE group_id=?', id) || get('SELECT 1 FROM node_groups WHERE group_id=?', id))) fail(409, 'IN_USE', '请先移除这个分组的用户和节点授权');
            run(`DELETE FROM ${table} WHERE id=?`, id); if (['users','groups','nodes','machines'].includes(table)) bump(); audit(u, `${table}.delete`, id);
          }); return json({ ok: true });
        }
        if ((!id && method === 'POST') || (id && method === 'PATCH')) {
          const b = await body(req), old = id ? requireRow(table, id) : null, fields: Row = {};
          let gids: number[] | undefined, digest: string | undefined, token: string | undefined;
          const take = (key: string, fn: (v: any) => any, fallback?: any) => { if (own(b,key)) fields[key] = fn(b[key]); else if (!old && fallback !== undefined) fields[key] = fallback; else if (!old) fail(400, 'VALIDATION', `请填写${key}`); };
          if (table === 'users') {
            pick(b,['email','name','password','enabled','quota_bytes','expires_at','group_ids']);
            take('email',email); take('name',v => string(v,'姓名',100)); take('enabled',v => boolean(v,'启用状态'),1); take('quota_bytes',v => integer(v,'流量额度'),0); take('expires_at',expiry,null);
            if (own(b,'group_ids')) gids = validGroups(b.group_ids); else if (!old) gids = [];
            if (own(b,'password') || !old) digest = await Bun.password.hash(password(b.password), { algorithm:'argon2id' });
            if (digest) fields.password_hash = digest;
            if (!old) Object.assign(fields,{role:'user',credential:crypto.randomUUID(),subscription_token:secret(),created_at:stamp()});
          } else if (table === 'nodes') {
            pick(b,['name','host','port','protocol','enabled','machine_id','group_ids','tls','server_name']);
            take('name',v => string(v,'节点名称',100)); take('host',endpoint); take('port',v => integer(v,'端口',1,65535)); take('protocol',v => { if (!['vless','trojan','shadowsocks'].includes(v)) fail(400,'VALIDATION','请选择支持的协议'); return v; });
            take('enabled',v => boolean(v,'启用状态'),1); take('machine_id',v => { if (v === null) return null; const mid = integer(v,'机器 ID',1); if (!get('SELECT id FROM machines WHERE id=?',mid)) fail(400,'VALIDATION','请选择已有的机器'); return mid; },null);
            take('tls',v => boolean(v,'TLS 状态'),1); take('server_name',v => v === '' ? '' : endpoint(v),'');
            if (own(b,'group_ids')) gids = validGroups(b.group_ids); else if (!old) gids = [];
            const effective = { ...old,...fields };
            if (effective.protocol === 'shadowsocks' && effective.tls) fail(400,'VALIDATION','Shadowsocks 请关闭 TLS，协议本身提供加密');
            if (effective.protocol === 'trojan' && !effective.tls) fail(400,'VALIDATION','Trojan 请开启 TLS 并配置节点证书');
            if (!old) fields.created_at = stamp();
          } else if (table === 'machines') {
            pick(b,['name','host','enabled']); take('name',v => string(v,'机器名称',100)); take('host',endpoint); take('enabled',v => boolean(v,'启用状态'),1);
            if (!old) { token = secret(); fields.token_hash = hash(token); }
          } else if (table === 'groups') { pick(b,['name']); take('name',v => string(v,'分组名称',100)); }
          else {
            pick(b,table === 'guides' ? ['title','body','category'] : ['title','body']); take('title',v => string(v,'标题',200)); take('body',v => string(v,'正文',100000)); if (table === 'guides') take('category',v => string(v,'分类',100,0),''); if (!old) fields.created_at = stamp();
          }
          const saved = atomic(() => {
            // Recheck RBAC inside transaction after any async password hash.
            const actor = requireRow('users',u.id);
            if (!actor.enabled || actor.role !== 'admin' || !get('SELECT 1 FROM sessions WHERE token_hash=? AND user_id=? AND expires_at>?', sessionHash(req),u.id,stamp())) fail(401,'AUTH_REQUIRED','账号设置有更新，请重新登录');
            if (old?.role === 'admin' && fields.enabled === 0 && get("SELECT COUNT(*) count FROM users WHERE role='admin' AND enabled=1")!.count <= 1) fail(409,'LAST_ADMIN','请保留至少一个启用的管理员账号');
            const keys = Object.keys(fields); let savedId = id;
            if (id) { if (keys.length) run(`UPDATE ${table} SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`, ...keys.map(k => fields[k]),id); }
            else savedId = Number(run(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`, ...keys.map(k => fields[k])).lastInsertRowid);
            if (gids) setGroups(table === 'users' ? 'user' : 'node',savedId!,gids);
            if (table === 'users' && id && (digest || fields.enabled === 0)) run('DELETE FROM sessions WHERE user_id=?',id);
            if (['users','groups','nodes','machines'].includes(table)) bump(); audit(u,`${table}.${id ? 'update' : 'create'}`,savedId!);
            return requireRow(table,savedId!);
          });
          return json(table === 'machines' && token ? { machine: machineView(saved),token } : view(saved),id ? 200 : 201);
        }
      }
    }
    fail(404, 'NOT_FOUND', '请检查接口地址和请求方式');
  }
  // A fixed dummy hash prevents the easy missing-account timing branch without expensive per-login rehashes.
  const dummyHash = Bun.password.hashSync(secret(), { algorithm: 'argon2id' });
  let lastExpiryScan = now().getTime();
  async function fetch(req: Request, context?: { requestIP?: (req: Request) => { address: string } | null } | string) {
    let response: Response;
    try {
      // Expiry changes time-dependent membership even when no writes occur. Advance revisions once per newly crossed expiry.
      const current = now().getTime();
      if (current > lastExpiryScan) {
        if (get('SELECT 1 FROM users WHERE enabled=1 AND expires_at>? AND expires_at<=? LIMIT 1',new Date(lastExpiryScan).toISOString(),new Date(current).toISOString())) bump();
        lastExpiryScan = current;
      }
      response = await dispatch(req, typeof context === 'string' ? context : context?.requestIP?.(req)?.address);
    } catch (error) {
      if (error instanceof ApiError) response = Response.json({error:{code:error.code,message:error.message}},{status:error.status});
      else if (String(error).includes('UNIQUE constraint failed')) response = Response.json({error:{code:'CONFLICT',message:'这条记录或端口已存在，请选择其他值'}},{status:409});
      else if (String(error).includes('FOREIGN KEY constraint failed')) response = Response.json({error:{code:'IN_USE',message:'这条记录还有关联内容，请先处理关联'}},{status:409});
      else { console.error('mboard request failure:', error instanceof Error ? error.name : 'UnknownError'); response = Response.json({error:{code:'INTERNAL',message:'操作待完成，请稍后重试'}},{status:500}); }
    }
    if (response.status === 413) response.headers.set('Connection','close');
    response.headers.set('Cache-Control','no-store');
    response.headers.set('X-Content-Type-Options','nosniff');
    response.headers.set('Referrer-Policy','no-referrer');
    response.headers.set('X-Frame-Options','DENY');
    response.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    return response;
  }
  if (options.initializeRuntime !== false) bump();
  return { db, fetch, close: () => db.close() };
}

function staticResponse(req: Request, distDir?: string): Response {
  if (!['GET','HEAD'].includes(req.method)) fail(404,'NOT_FOUND','请检查页面地址');
  if (!distDir || !existsSync(distDir)) fail(404,'NOT_FOUND','页面待构建，请先构建前端');
  const root = realpathSync(distDir); let path: string;
  try { path = decodeURIComponent(new URL(req.url).pathname); } catch { fail(400,'VALIDATION','请检查页面地址'); }
  if (path!.includes('\0') || path!.includes('\\') || path!.split('/').some(x => x === '..' || x.startsWith('.'))) fail(404,'NOT_FOUND','请检查页面地址');
  let file = resolve(root,'.' + path!);
  if (path! === '/' || !existsSync(file)) { if (extname(path!)) fail(404,'NOT_FOUND','请检查文件地址'); file = resolve(root,'index.html'); }
  if (!existsSync(file)) fail(404,'NOT_FOUND','页面待构建');
  file = realpathSync(file);
  if (!file.startsWith(root + sep) || !statSync(file).isFile()) fail(404,'NOT_FOUND','请检查文件地址');
  const asset = Bun.file(file);
  return new Response(req.method === 'HEAD' ? null : asset, { headers: { 'Content-Type':asset.type } });
}
