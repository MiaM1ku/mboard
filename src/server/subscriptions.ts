import type { Database } from 'bun:sqlite';
import { isAlias, isMap, isScalar, isSeq, parseDocument, visit, type Document } from 'yaml';

export const TEMPLATE_NAMES = ['singbox', 'clash', 'clashmeta', 'stash', 'surge', 'surfboard'] as const;
export type TemplateName = typeof TEMPLATE_NAMES[number];
export const MAX_TEMPLATE_BYTES = 512 * 1024;
export interface SubscriptionTemplate {
  id: number; name: TemplateName; content: string; created_at: string; updated_at: string;
  source: 'archive' | 'builtin' | 'custom';
}
export interface SubscriptionEndpoint {
  id: number | string; name: string; protocol: string; host: string; port: number; credential: string;
  /** Native sing-box outbound details, excluding identity/address/credential fields. */
  settings?: Record<string, any>;
  /** Optional compiled sing-box chain. Its last element is the public outbound. */
  native_outbounds?: Record<string, any>[];
}
export interface TemplateIssue { message: string; line?: number; column?: number }
export interface TemplateValidation { valid: boolean; errors: TemplateIssue[]; warnings: string[] }
export interface RenderOptions {
  userAgent?: string; clientVersion?: string;
  /** Supplied by the caller; rendering never derives user metadata or reads it from the DB. */
  metadata?: { app_name?: string; subs_link?: string; subs_domain?: string; subscribe_info?: string };
}
export interface SubscriptionRender {
  template_name: TemplateName; content_type: string; content: string; node_count: number; warnings: string[];
}
export class TemplateValidationError extends Error {
  readonly status = 400;
  constructor(public readonly issues: TemplateIssue[]) { super(issues[0]?.message || '请检查模板内容后重试。'); this.name = 'TemplateValidationError'; }
}
const defaults: Record<TemplateName, string> = {
  singbox: JSON.stringify({ outbounds: [{ type: 'selector', tag: '节点选择', outbounds: ['direct'] }, { type: 'direct', tag: 'direct' }], route: { final: '节点选择' } }, null, 2),
  clash: 'proxies: []\nproxy-groups:\n  - name: 节点选择\n    type: select\n    proxies: [DIRECT]\nrules:\n  - MATCH,节点选择\n',
  clashmeta: 'proxies: []\nproxy-groups:\n  - name: 节点选择\n    type: select\n    proxies: [DIRECT]\nrules:\n  - MATCH,节点选择\n',
  stash: 'proxies: []\nproxy-groups:\n  - name: 节点选择\n    type: select\n    proxies: [DIRECT]\nrules:\n  - MATCH,节点选择\n',
  surge: '[General]\n[Proxy]\n[Proxy Group]\n节点选择 = select, DIRECT\n[Rule]\nFINAL,节点选择\n',
  surfboard: '[General]\n[Proxy]\n[Proxy Group]\n节点选择 = select, DIRECT\n[Rule]\nFINAL,节点选择\n',
};
function templateName(name: string): TemplateName {
  if (!TEMPLATE_NAMES.includes(name as TemplateName)) throw new TemplateValidationError([{ message: '请选择支持的订阅模板。' }]);
  return name as TemplateName;
}
/** Call at startup, after legacy archive import. Original content is never parsed or rewritten here. */
export function initializeSubscriptionTemplates(db: Database): void {
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS subscription_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE CHECK(name IN ('singbox','clash','clashmeta','stash','surge','surfboard')),
      content TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('archive','builtin','custom'))
    );`);
    const hasLegacy = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='legacy_records'").get();
    if (hasLegacy) {
      const records = db.query("SELECT payload FROM legacy_records WHERE kind='v2_subscribe_templates' ORDER BY id").all() as { payload: string }[];
      for (const record of records) {
        let row: any;
        try { row = JSON.parse(record.payload); } catch { throw new TemplateValidationError([{ message: '请检查归档模板 JSON 格式，再重试导入。' }]); }
        if (!TEMPLATE_NAMES.includes(row?.name)) continue;
        if (!Number.isSafeInteger(Number(row.id)) || Number(row.id) <= 0 || typeof row.content !== 'string') {
          throw new TemplateValidationError([{ message: '请补齐归档模板字段后重试导入。' }]);
        }
        // A later archive import may replace a minimal builtin, but never an edited or already imported template.
        const existing = getTemplate(db, row.name);
        if (existing && existing.source !== 'builtin') continue;
        if (existing) db.query('DELETE FROM subscription_templates WHERE name=? AND source=\'builtin\'').run(row.name);
        db.query('INSERT INTO subscription_templates (id,name,content,created_at,updated_at,source) VALUES (?,?,?,?,?,\'archive\')')
          .run(Number(row.id), row.name, row.content, String(row.created_at ?? ''), String(row.updated_at ?? ''));
      }
    }
    const now = new Date().toISOString();
    for (const [index, name] of TEMPLATE_NAMES.entries()) db.query("INSERT OR IGNORE INTO subscription_templates (id,name,content,created_at,updated_at,source) VALUES (?,?,?,?,?,'builtin')")
      .run(-(index + 1), name, defaults[name], now, now);
  }).immediate();
}
export function listTemplates(db: Database): SubscriptionTemplate[] {
  return db.query('SELECT id,name,content,created_at,updated_at,source FROM subscription_templates ORDER BY id').all() as SubscriptionTemplate[];
}
export function getTemplate(db: Database, name: string): SubscriptionTemplate | null {
  templateName(name);
  return db.query('SELECT id,name,content,created_at,updated_at,source FROM subscription_templates WHERE name=?').get(name) as SubscriptionTemplate | null;
}
export function saveTemplate(db: Database, name: string, content: string): SubscriptionTemplate {
  const validation = validateTemplate(name, content);
  if (!validation.valid) throw new TemplateValidationError(validation.errors);
  return db.transaction(() => {
    const result = db.query("UPDATE subscription_templates SET content=?,updated_at=?,source='custom' WHERE name=?").run(content, new Date().toISOString(), name);
    if (!result.changes) throw new TemplateValidationError([{ message: '请刷新模板列表后重试。' }]);
    return getTemplate(db, name)!;
  }).immediate();
}
function object(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function issue(message: string, line?: number, column?: number): TemplateValidationError {
  return new TemplateValidationError([{ message, ...(line ? { line } : {}), ...(column ? { column } : {}) }]);
}
function position(content: string, offset: number) {
  const prefix = content.slice(0, Math.max(0, offset));
  return { line: prefix.split('\n').length, column: prefix.length - prefix.lastIndexOf('\n') };
}
function clashMetaDialer(root: Record<string, any>, name: TemplateName): { name: string; groups: Set<string>; relayGroup?: string; provider?: string } | null {
  const configured=root['x-mboard-dialer-proxy'];
  if(configured===undefined)return null;
  const separate=object(configured),target=separate?configured.front:configured;
  const validName=(v:unknown):v is string=>typeof v==='string'&&!!v&&v.length<=200&&!/[\r\n\0]/.test(v);
  if(name!=='clashmeta'||!validName(target)||separate&&(Object.keys(configured).some(k=>!['front','group','provider'].includes(k))||!validName(configured.group)||!validName(configured.provider)))throw issue('请在 Clash Meta 模板中指定有效的前置和出口选择组。');
  const groups=new Map<string,any>(root['proxy-groups'].map((g:any)=>[g.name,g])),proxies=new Map<string,any>(root.proxies.map((p:any)=>[p.name,p]));
  if(!groups.has(target)||proxies.has(target))throw issue('请为前置拨号指定独立的代理选择组。');
  const visited=new Set<string>(),active=new Set<string>();
  const visit=(key:string)=>{
    if(active.has(key))throw issue('请调整前置分组，形成指向静态前置节点的单向链路。');
    if(visited.has(key))return;
    const g=groups.get(key);if(!g||g.type!=='select'||!g.proxies.length)throw issue('前置分组需要使用 select 和明确的成员列表。');
    active.add(key);
    for(const member of g.proxies){
      if(member==='DIRECT')continue;
      if(groups.has(member)){visit(member);continue;}
      const p=proxies.get(member);if(!p||p['dialer-proxy']&&p['dialer-proxy']!=='DIRECT')throw issue('请使用模板中的独立静态节点作为前置成员。');
      if(p.type==='http'&&p.headers!==undefined&&(!object(p.headers)||Object.entries(p.headers).some(([k,v])=>! /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)||typeof v!=='string'||v.length>4096||/[\r\n\0]/.test(v))))throw issue('请将前置请求头填写为单行名称和值。');
    }
    active.delete(key);visited.add(key);
  };
  visit(target);
  if(separate){
    const relay=groups.get(configured.group);
    if(!relay||relay.type!=='select'||visited.has(configured.group)||relay.proxies.length||!Array.isArray(relay.use)||relay.use.length!==1||relay.use[0]!==configured.provider||root['proxy-providers']&&(!object(root['proxy-providers'])||Object.hasOwn(root['proxy-providers'],configured.provider)))throw issue('请用独立出口组引用专用 CN 中转 provider。');
    visited.add(configured.group);
    return{name:target,groups:visited,relayGroup:configured.group,provider:configured.provider};
  }
  return{name:target,groups:visited};
}
function checkRoot(root: any, name: TemplateName): void {
  if (!object(root)) throw issue('模板顶层需要是一个配置对象。');
  if (name !== 'singbox') {
    // Legacy YAML uses an empty/null array or an exact scalar/sequence injection marker.
    if (root.proxies == null || root.proxies === '$proxies') root.proxies = [];
    if (Array.isArray(root.proxies)) root.proxies = root.proxies.filter((node: unknown) => node !== '$proxies');
  }
  const nodes = name === 'singbox' ? root.outbounds : root.proxies;
  const groups = name === 'singbox' ? root.outbounds : root['proxy-groups'];
  if (!Array.isArray(nodes) || !Array.isArray(groups)) throw issue(name === 'singbox' ? '请提供 outbounds 数组。' : '请提供 proxies 和 proxy-groups 数组。');
  for (const node of nodes) {
    if (!object(node) || typeof (name === 'singbox' ? node.type : node.name) !== 'string') throw issue('节点配置需要包含类型或名称。');
    if (name === 'singbox' && typeof node.tag !== 'string') throw issue('每个出站需要有 tag 名称。');
  }
  for (const group of groups) {
    if (!object(group)) throw issue('分组配置需要是对象。');
    if (name === 'singbox' && !['selector', 'urltest'].includes(group.type)) continue;
    if (name !== 'singbox') {
      if (group.proxies == null) group.proxies = [];
      else if (group.proxies === '$proxy_group') group.proxies = ['$proxy_group'];
    }
    const members = name === 'singbox' ? group.outbounds : group.proxies;
    if (typeof (name === 'singbox' ? group.tag : group.name) !== 'string' || !Array.isArray(members) || members.some((v: any) => typeof v !== 'string')) throw issue('分组需要有名称和字符串成员数组。');
  }
  if(name!=='singbox')clashMetaDialer(root,name);
}
function jsonConfig(content: string): Record<string, any> {
  try { return JSON.parse(content); } catch (error) {
    // Only extract numeric position, never return parser snippets (they may contain passwords).
    const offset = String((error as Error).message).match(/position (\d+)/)?.[1];
    const p = offset ? position(content, Number(offset)) : undefined;
    throw issue('JSON 格式有误，请检查逗号、引号和括号。', p?.line, p?.column);
  }
}
function assertConfigGraph(value: unknown, active = new WeakSet<object>(), depth = 0, budget = { remaining: 100_000 }): void {
  if (--budget.remaining < 0 || depth > 64) throw issue('模板结构过于复杂，请简化嵌套配置。');
  if (!value || typeof value !== 'object') return;
  if (active.has(value)) throw issue('请展开 YAML 循环引用，再检查锚点。');
  active.add(value);
  for (const child of Object.values(value)) assertConfigGraph(child, active, depth + 1, budget);
  active.delete(value);
}
function yamlConfig(content: string): { root: Record<string, any>; doc: Document } {
  const doc = parseDocument(content, { schema: 'core', version: '1.2', strict: true, uniqueKeys: true, customTags: [] });
  const problem = doc.errors[0] || doc.warnings[0];
  if (problem) {
    const p = problem.linePos?.[0] || position(content, problem.pos?.[0] || 0);
    throw issue('请按标准 YAML 标签、缩进和字段格式调整模板。', p.line, 'col' in p ? p.col : p.column);
  }
  let root: Record<string, any>;
  try { root = doc.toJS({ maxAliasCount: 100 }) as Record<string, any>; }
  catch { throw issue('YAML 引用过多或引用无效，请简化锚点。'); }
  assertConfigGraph(root);
  return { root, doc: doc as Document };
}
interface IniSection { name: string; header: string; lines: string[]; line: number }
interface IniConfig { preamble: string[]; sections: IniSection[]; eol: string; trailing: boolean }
function iniConfig(content: string): IniConfig {
  const lines = content.split(/\r?\n/); const trailing = /\r?\n$/.test(content); if (trailing) lines.pop();
  const result: IniConfig = { preamble: [], sections: [], eol: content.includes('\r\n') ? '\r\n' : '\n', trailing };
  let section: IniSection | undefined;
  const seen = new Set<string>();
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (/^\[/.test(trimmed)) {
      const match = trimmed.match(/^\[([^\]\r\n]+)\]\s*(?:(?:#|;|\/\/).*)?$/);
      if (!match) throw issue('INI 分节标题有误，请使用 [节名]。', index + 1, 1);
      const name = match[1]!.toLowerCase();
      if (seen.has(name)) throw issue('INI 分节名称重复，请合并相同分节。', index + 1, 1);
      seen.add(name); section = { name, header: line, lines: [], line: index + 1 }; result.sections.push(section); return;
    }
    if (!section) {
      if (trimmed && !/^(#|;|\/\/)/.test(trimmed)) throw issue('请把 INI 配置放在分节标题下面。', index + 1, 1);
      result.preamble.push(line); return;
    }
    if (trimmed && !/^(#|;|\/\/)/.test(trimmed) && ['general', 'proxy', 'proxy group', 'host', 'mitm'].includes(section.name)) {
      // Only a complete proxy-section line injects node definitions.
      if (!(section.name === 'proxy' && trimmed === '$proxies')) {
        const pair = iniPair(line);
        if (!pair || !pair.key.trim() || !pair.value.trim()) throw issue('INI 字段需要写成 名称 = 值。', index + 1, 1);
        try { splitIni(pair.value); } catch { throw issue('请补齐这一行的 INI 引号后重试。', index + 1, 1); }
      }
    }
    section.lines.push(line);
  });
  if (!seen.has('proxy') || !seen.has('proxy group') || !seen.has('rule')) throw issue('INI 模板需要包含 [Proxy]、[Proxy Group] 和 [Rule]。');
  return result;
}
export function validateTemplate(name: string, content: string): TemplateValidation {
  try {
    const format = templateName(name);
    if (typeof content !== 'string' || !content.trim()) throw issue('请输入模板内容。');
    if (new TextEncoder().encode(content).length > MAX_TEMPLATE_BYTES) throw issue('模板内容请控制在 512 KiB 以内，缩小后重试。');
    if (content.includes('\0')) throw issue('请清理模板中的空字符后重试。');
    const warnings: string[] = [];
    if (format === 'singbox') {
      const root = jsonConfig(content); checkRoot(root, format);
      // Syntax validation is not a core check. Show unsupported migrations before a modern client requests them.
      try { migrateSingboxRendered(structuredClone(root), '1.14.0', warnings); }
      catch { warnings.push('请按目标 sing-box 客户端版本手动调整这些字段，再校验模板。'); }
    }
    else if (['clash', 'clashmeta', 'stash'].includes(format)) checkRoot(yamlConfig(content).root, format);
    else iniConfig(content);
    return { valid: true, errors: [], warnings };
  } catch (error) {
    return { valid: false, errors: error instanceof TemplateValidationError ? error.issues : [{ message: '请检查模板格式后重试解析。' }], warnings: [] };
  }
}
const aliases: Record<string, TemplateName> = { singbox: 'singbox', 'sing-box': 'singbox', json: 'singbox', clash: 'clash', clashmeta: 'clashmeta', 'clash-meta': 'clashmeta', meta: 'clashmeta', mihomo: 'clashmeta', stash: 'stash', surge: 'surge', surfboard: 'surfboard' };
export function selectSubscriptionFormat(userAgent: string | null | undefined, query: URLSearchParams | Record<string, string | undefined> = {}): TemplateName {
  const get = (key: string) => query instanceof URLSearchParams ? query.get(key) : query[key];
  // format is the most explicit option. Invalid explicit values never silently choose another format.
  const explicit = get('format') || get('target') || get('flag');
  if (explicit) { const selected = aliases[explicit.toLowerCase()]; if (!selected) throw issue('请选择支持的订阅格式。'); return selected; }
  const ua = userAgent || '';
  if (/surfboard/i.test(ua)) return 'surfboard';
  if (/surge/i.test(ua)) return 'surge';
  if (/stash/i.test(ua)) return 'stash';
  if (/sing[- ]?box|hiddify|\bsfm\b/i.test(ua)) return 'singbox';
  if (/mihomo|clash(?:x)?[\s._-]*meta|verge|flclash|nekobox|nekoray/i.test(ua)) return 'clashmeta';
  if (/clash/i.test(ua)) return 'clash';
  return 'singbox';
}
function version(options: RenderOptions, name: TemplateName): string | undefined {
  if (name === 'singbox') {
    if (options.clientVersion) return /^\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?$/.test(options.clientVersion) ? options.clientVersion : undefined;
    // SFA/SFI/SFM report the bundled core version. Do not infer versions from unrelated app names.
    return (options.userAgent || '').match(/(?:\bsing[- ]?box|\bSFA|\bSFI|\bSFM)[/ ]v?(\d+\.\d+(?:\.\d+)?)/i)?.[1];
  }
  if (options.clientVersion) return options.clientVersion;
  const ua = options.userAgent || '';
  const prefix = name === 'clashmeta' ? '(?:mihomo|clash.?meta)' : name;
  return ua.match(new RegExp(`${prefix}[\\s/v-]*v?(\\d+\\.\\d+(?:\\.\\d+)?)`, 'i'))?.[1];
}
function older(actual: string | undefined, required: string): boolean {
  if (!actual) return false; const a = actual.split('.').map(Number), b = required.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) < (b[i] || 0); } return false;
}
const classicSS = ['aes-128-gcm', 'aes-192-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', 'xchacha20-ietf-poly1305'];
const ss2022 = ['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305'];
function eligible(e: SubscriptionEndpoint, name: TemplateName, options: RenderOptions): boolean {
  const s = e.settings || {}, p = e.protocol === 'ss' ? 'shadowsocks' : e.protocol;
  const v = version(options, name), transport = s.transport?.type;
  if (e.native_outbounds?.length && name !== 'singbox') return false;
  if (e.native_outbounds?.length && (!e.native_outbounds.every(object) || e.native_outbounds.at(-1)?.type !== p)) return false;
  if (!['shadowsocks', 'vless', 'trojan', 'anytls'].includes(p)) return false;
  if (!e.name || !e.host || !e.credential || !Number.isInteger(e.port) || e.port < 1 || e.port > 65535) return false;
  if ([e.name, e.host, e.credential].some(value => typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value))) return false;
  if (p === 'vless' && ['clash', 'surge', 'surfboard'].includes(name)) return false;
  if (p === 'anytls' && (name === 'clash' || older(v, name === 'singbox' ? '1.12.0' : name === 'clashmeta' ? '1.19.1' : name === 'stash' ? '3.3.0' : '0.0.0'))) return false;
  if (p === 'shadowsocks') {
    if (![...classicSS, ...ss2022].includes(s.method)) return false;
    if (name === 'clash' && s.method === 'xchacha20-ietf-poly1305') return false;
    if (ss2022.includes(s.method) && (name === 'clash' || (name === 'surge' && s.method === '2022-blake3-chacha20-poly1305') || (name === 'stash' && older(v, '3.0.0')))) return false;
    // Plugin conversion is not lossless. Native sing-box plugin fields are passed through only there.
    if (name !== 'singbox' && (s.plugin || s.plugin_opts)) return false;
  }
  if (s.tls?.reality?.enabled) {
    if (p !== 'vless' && name !== 'singbox' && name !== 'clashmeta') return false;
    if (!s.tls.reality.public_key || typeof s.tls.reality.short_id !== 'string') return false;
    if (name === 'clash' || name === 'surge' || name === 'surfboard' || (name === 'stash' && older(v, '3.1.0')) || (name === 'singbox' && older(v, '1.6.0'))) return false;
  }
  if (transport && !['tcp', 'ws', 'grpc', 'http', 'httpupgrade'].includes(transport)) return false;
  if (name === 'clash' && transport && !['tcp', 'ws'].includes(transport)) return false;
  if (name === 'stash' && transport === 'httpupgrade') return false;
  if (['surge', 'surfboard'].includes(name) && transport && transport !== 'tcp') return false;
  // Do not silently drop ECH, multiplex or custom certificate requirements in format conversion.
  if (name !== 'singbox' && (s.tls?.ech?.enabled || s.multiplex?.enabled || s.tls?.certificate || s.tls?.certificate_path || s.tls?.client_certificate || s.tls?.client_key)) return false;
  return true;
}
function singboxOutbound(e: SubscriptionEndpoint): Record<string, any> {
  const protocol = e.protocol === 'ss' ? 'shadowsocks' : e.protocol;
  const result = { ...structuredClone(e.settings || {}), type: protocol, tag: e.name, server: e.host, server_port: e.port } as Record<string, any>;
  // Caller may not smuggle a second user's credentials through settings.
  delete result.uuid; delete result.password;
  result[protocol === 'vless' ? 'uuid' : 'password'] = e.credential;
  return result;
}
function yamlOutbound(e: SubscriptionEndpoint): Record<string, any> {
  const s = e.settings || {}, tls = s.tls || {}, p = e.protocol === 'ss' ? 'shadowsocks' : e.protocol;
  const result: Record<string, any> = { name: e.name, type: p === 'shadowsocks' ? 'ss' : p, server: e.host, port: e.port, udp: true };
  if (p === 'shadowsocks') { result.cipher = s.method; result.password = e.credential; }
  else if (p === 'vless') { result.uuid = e.credential; if (s.flow) result.flow = s.flow; result.tls = !!tls.enabled; }
  else result.password = e.credential;
  if (tls.server_name) result[p === 'vless' ? 'servername' : 'sni'] = tls.server_name;
  if (tls.insecure !== undefined) result['skip-cert-verify'] = !!tls.insecure;
  if (tls.alpn) result.alpn = structuredClone(tls.alpn);
  if (tls.utls?.enabled && tls.utls.fingerprint) result['client-fingerprint'] = tls.utls.fingerprint;
  if (tls.reality?.enabled) result['reality-opts'] = { 'public-key': tls.reality.public_key, 'short-id': tls.reality.short_id };
  const t = s.transport;
  if (t && t.type !== 'tcp') {
    result.network = t.type;
    if (t.type === 'ws') result['ws-opts'] = { ...(t.path ? { path: t.path } : {}), ...(t.headers ? { headers: structuredClone(t.headers) } : {}), ...(t.max_early_data ? { 'max-early-data': t.max_early_data } : {}), ...(t.early_data_header_name ? { 'early-data-header-name': t.early_data_header_name } : {}) };
    if (t.type === 'httpupgrade') { result.network = 'ws'; result['ws-opts'] = { 'v2ray-http-upgrade': true, ...(t.path ? { path: t.path } : {}), ...(t.host ? { headers: { Host: t.host } } : {}) }; }
    if (t.type === 'grpc') result['grpc-opts'] = { 'grpc-service-name': t.service_name || '' };
    if (t.type === 'http') { result.network = 'h2'; result['h2-opts'] = { ...(t.path ? { path: t.path } : {}), ...(t.host ? { host: Array.isArray(t.host) ? t.host : [t.host] } : {}) }; }
  }
  return result;
}
/** Quote INI tokens, including commas, equals signs and backslashes; never interpolate raw line breaks. */
function iniToken(value: string): string {
  if (/[\r\n\0]/.test(value)) throw issue('请将节点字段中的换行改为单行文本。');
  return /[,=\\"#;]|^\s|\s$|^\[|^\/\//.test(value) ? `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"` : value;
}
function iniOutbound(e: SubscriptionEndpoint, name: TemplateName): string {
  const s = e.settings || {}, tls = s.tls || {}, protocol = e.protocol === 'ss' ? 'shadowsocks' : e.protocol;
  const args = [protocol === 'shadowsocks' ? 'ss' : protocol, iniToken(e.host), String(e.port)];
  if (protocol === 'shadowsocks') args.push(`encrypt-method=${iniToken(s.method)}`);
  // Surfboard's AnyTLS grammar uses a positional password, unlike Surge.
  args.push(protocol === 'anytls' && name === 'surfboard' ? iniToken(e.credential) : `password=${iniToken(e.credential)}`);
  if (tls.server_name) args.push(`sni=${iniToken(tls.server_name)}`);
  if (tls.insecure !== undefined) args.push(`skip-cert-verify=${tls.insecure ? 'true' : 'false'}`);
  args.push('udp-relay=true');
  return `${iniToken(e.name)} = ${args.join(', ')}`;
}
function warn(warnings: string[], message: string) { if (!warnings.includes(message)) warnings.push(message); }
function patternMatcher(pattern: string, warnings: string[], delimitedOnly = false, invalidMatch = false): ((text: string) => boolean) | null {
  let source = pattern, flags = 'iu';
  const match = pattern.match(/^([/#~@%])(.*)\1([a-z]*)$/s);
  if (match) { source = match[2]!; flags = (match[3] || '').replace(/[uxs]/g, '') + 'u'; }
  else if (delimitedOnly) return null;
  if (source.startsWith('(?i)')) { flags += 'i'; source = source.slice(4); }
  // test() already searches anywhere; remove redundant outer wildcards before counting repetitions.
  source = source.replace(/^\^?\.\*/, '').replace(/\.\*\$?$/, '');
  const lexical = source.replace(/\\./g, '').replace(/\[(?:\\.|[^\]\\])*\]/g, '').replace(/\(\?:/g, '(');
  const repeats = lexical.match(/[+*?]|\{\d+(?:,\d*)?\}/g) || [];
  // At most one repetition ensures there are no overlapping repeat paths in the public renderer.
  if (source.length > 256 || repeats.length > 1 || /\\[1-9]|\(\?[=!<]|\)(?:[+*?]|\{)|\{\d{3,}/.test(source)) {
    warn(warnings, '分组筛选表达式过于复杂，请简化后重试。'); return () => invalidMatch;
  }
  try { const re = new RegExp(source, [...new Set(flags.replace(/[gy]/g, ''))].join('')); return text => re.test(text.slice(0, 256)); }
  catch { warn(warnings, '请修正分组筛选表达式后重试。'); return () => invalidMatch; }
}
/** Render-time subset of https://sing-box.sagernet.org/migration/ (available since 1.12).
 * Work on the parsed render copy only. Unsupported semantics fail closed instead of deleting user rules.
 */
function migrateSingboxRendered(root: Record<string, any>, clientVersion: string | undefined, warnings: string[] = []): void {
  if (!clientVersion || older(clientVersion, '1.12.0')) return;
  const unsupported = () => { throw issue('请按目标 sing-box 客户端版本提供兼容模板后重试。'); };
  const rootKeys = new Set(['log', 'dns', 'ntp', 'inbounds', 'outbounds', 'endpoints', 'route', 'experimental', 'certificate_providers', 'services', 'network_namespaces', 'http_clients']);
  if (Object.keys(root).some(key => !rootKeys.has(key))) unsupported();
  const route = root.route ?? {}, dns = root.dns;
  if (!object(route) || (dns !== undefined && !object(dns)) || (root.inbounds !== undefined && (!Array.isArray(root.inbounds) || root.inbounds.some((inbound: any) => !object(inbound))))) unsupported();
  if (route.geoip !== undefined || route.geosite !== undefined || dns?.fakeip !== undefined) unsupported();
  let routeChanged = false;
  const eachRule = (rules: any, fn: (rule: Record<string, any>) => void) => {
    if (rules === undefined) return;
    if (!Array.isArray(rules)) unsupported();
    const walk = (rule: any) => {
      if (!object(rule) || rule.geoip !== undefined || rule.geosite !== undefined || rule.source_geoip !== undefined) unsupported();
      fn(rule);
      if (rule.rules !== undefined) { if (!Array.isArray(rule.rules)) unsupported(); rule.rules.forEach(walk); }
    };
    rules.forEach(walk);
  };
  // An outbound:any DNS matcher describes internal dial resolution, NOT all incoming DNS queries.
  // Making it an unconditional DNS route would erase the clash-mode/rule-set routing below it.
  if (dns?.rules !== undefined) {
    if (!Array.isArray(dns.rules)) unsupported();
    dns.rules = dns.rules.filter((rule: any, index: number) => {
      if (!object(rule) || rule.outbound === undefined) return true;
      const outbound = Array.isArray(rule.outbound) ? rule.outbound : [rule.outbound];
      const keys = ['outbound', 'server', 'action', 'strategy', 'disable_cache', 'rewrite_ttl', 'client_subnet'];
      if (index !== 0 || outbound.length !== 1 || outbound[0] !== 'any' || typeof rule.server !== 'string' || (rule.action && rule.action !== 'route') || Object.keys(rule).some(key => !keys.includes(key))) unsupported();
      if (route.default_domain_resolver !== undefined) unsupported();
      const { outbound: _outbound, action: _action, ...resolver } = rule;
      route.default_domain_resolver = Object.keys(resolver).length === 1 ? resolver.server : resolver;
      routeChanged = true; return false;
    });
    eachRule(dns.rules, rule => { if (rule.outbound !== undefined) unsupported(); });
  }
  const rcodeTags = new Map<string, string>();
  if (dns?.servers !== undefined) {
    if (!Array.isArray(dns.servers)) unsupported();
    const implicitDnsFinal = dns.servers[0]?.tag;
    dns.servers = dns.servers.flatMap((server: any) => {
      if (!object(server)) unsupported();
      if (server.address === undefined) return [server];
      if (server.type !== undefined || typeof server.address !== 'string') unsupported();
      // Per-server query strategy/subnet cannot be moved without changing rule precedence.
      const keys = ['tag', 'address', 'detour', 'address_resolver', 'address_strategy'];
      if (Object.keys(server).some(key => !keys.includes(key))) unsupported();
      if (server.address.startsWith('rcode://')) {
        const codes: Record<string, string> = { success: 'NOERROR', format_error: 'FORMERR', server_failure: 'SERVFAIL', name_error: 'NXDOMAIN', not_implemented: 'NOTIMP', refused: 'REFUSED' };
        const code = codes[server.address.slice(8)];
        if (!code || typeof server.tag !== 'string' || Object.keys(server).some(key => !['tag', 'address'].includes(key))) unsupported();
        rcodeTags.set(server.tag, code); return [];
      }
      const { address, address_resolver, address_strategy, detour, ...converted } = server;
      if (address === 'local') {
        if (address_resolver || address_strategy || detour) unsupported();
        converted.type = 'local';
      } else {
        let url: URL;
        try { url = new URL(address.includes('://') ? address : `udp://${address}`); } catch { return unsupported(); }
        const type = url.protocol.slice(0, -1);
        if (!['https', 'h3', 'tcp', 'udp', 'tls', 'quic'].includes(type) || !url.hostname || url.username || url.password || url.hash || url.search) unsupported();
        if (!['https', 'h3'].includes(type) && url.pathname && url.pathname !== '/') unsupported();
        converted.type = type; converted.server = url.hostname.replace(/^\[|\]$/g, '');
        if (url.port) converted.server_port = Number(url.port);
        if (['https', 'h3'].includes(type)) {
          const explicitPath = address.slice(address.indexOf('://') + 3).includes('/');
          if (explicitPath) converted.path = url.pathname;
        }
        if (address_resolver) converted.domain_resolver = address_strategy ? { server: address_resolver, strategy: address_strategy } : address_resolver;
        else if (address_strategy) unsupported();
        // New DNS servers dial directly by default. Old empty detour used the default outbound.
        const target = detour || route.final || root.outbounds[0]?.tag;
        const direct = root.outbounds.find((outbound: any) => outbound.tag === target && outbound.type === 'direct');
        if (direct && Object.keys(direct).every(key => ['tag', 'type'].includes(key))) { /* empty direct dialer */ }
        else if (target) converted.detour = target;
        else unsupported();
      }
      return [converted];
    });
    if (rcodeTags.has(dns.final || implicitDnsFinal) || rcodeTags.has(typeof route.default_domain_resolver === 'string' ? route.default_domain_resolver : route.default_domain_resolver?.server)) unsupported();
    eachRule(dns.rules, rule => {
      if (!rcodeTags.has(rule.server)) return;
      if ((rule.action && rule.action !== 'route') || Object.keys(rule).some(key => ['strategy', 'disable_cache', 'rewrite_ttl', 'client_subnet'].includes(key))) unsupported();
      rule.rcode = rcodeTags.get(rule.server); rule.action = 'predefined'; delete rule.server;
    });
  }
  const special = new Map<string, string>();
  for (const outbound of root.outbounds) {
    if (outbound.type === 'wireguard' || outbound.override_address !== undefined || outbound.override_port !== undefined) unsupported();
    if (!['block', 'dns'].includes(outbound.type)) continue;
    if (Object.keys(outbound).some(key => !['type', 'tag'].includes(key))) unsupported();
    special.set(outbound.tag, outbound.type === 'block' ? 'reject' : 'hijack-dns');
  }
  if (!route.final && special.has(root.outbounds[0]?.tag)) unsupported();
  eachRule(route.rules, rule => {
    if (!special.has(rule.outbound)) return;
    if (rule.action && rule.action !== 'route') unsupported();
    rule.action = special.get(rule.outbound); delete rule.outbound;
  });
  // Special outbounds cannot be represented as selector members, detours or final/default targets.
  const checkReferences = (value: any) => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['outbound', 'outbounds', 'detour', 'download_detour', 'final', 'default'].includes(key)) {
        const refs = Array.isArray(child) ? child : [child];
        if (refs.some(ref => typeof ref === 'string' && special.has(ref))) unsupported();
      }
      if (['domain_resolver', 'default_domain_resolver'].includes(key) && rcodeTags.has(typeof child === 'string' ? child : (child as any)?.server)) unsupported();
      checkReferences(child);
    }
  };
  // DNS server names occupy a separate namespace from outbound tags.
  checkReferences({ ...root, dns: undefined, outbounds: root.outbounds.filter((outbound: any) => !special.has(outbound.tag)) });
  if (dns?.servers?.some((server: any) => special.has(server.detour) || rcodeTags.has(typeof server.domain_resolver === 'string' ? server.domain_resolver : server.domain_resolver?.server))) unsupported();
  root.outbounds = root.outbounds.filter((outbound: any) => !special.has(outbound.tag));
  const prefix: Record<string, any>[] = [];
  const inboundTags = new Set((root.inbounds || []).map((inbound: any) => inbound.tag));
  for (const [index, inbound] of (root.inbounds || []).entries()) {
    if (!object(inbound)) unsupported();
    if (['inet4_address', 'inet6_address', 'inet4_route_address', 'inet6_route_address', 'inet4_route_exclude_address', 'inet6_route_exclude_address'].some(key => inbound[key] !== undefined)) unsupported();
    if (inbound.type === 'tun') { delete inbound.endpoint_independent_nat; delete inbound.gso; }
    if (inbound.sniff === true || (inbound.domain_strategy && inbound.domain_strategy !== 'as_is') || inbound.udp_disable_domain_unmapping) {
      if (!inbound.tag) {
        const base = `mboard-in-${index + 1}`; let tag = base, suffix = 2;
        while (inboundTags.has(tag)) tag = `${base}-${suffix++}`;
        inbound.tag = tag; inboundTags.add(tag);
      }
      if (inbound.domain_strategy && inbound.domain_strategy !== 'as_is') prefix.push({ inbound: [inbound.tag], action: 'resolve', strategy: inbound.domain_strategy });
      if (inbound.sniff === true) {
        prefix.push({ inbound: [inbound.tag], action: 'sniff', ...(inbound.sniff_timeout ? { timeout: inbound.sniff_timeout } : {}) });
        // Modern sniff actions classify the domain but cannot reproduce the removed destination override.
        if (inbound.sniff_override_destination === true) warn(warnings, '新版 sing-box 的 sniff 按识别域名匹配路由，连接使用原始目标；旧版 sniff_override_destination 的目标覆盖需求请按客户端版本调整模板。');
      }
      if (inbound.udp_disable_domain_unmapping) prefix.push({ inbound: [inbound.tag], action: 'route-options', udp_disable_domain_unmapping: true });
    }
    for (const key of ['sniff', 'sniff_override_destination', 'sniff_timeout', 'domain_strategy', 'udp_disable_domain_unmapping']) delete inbound[key];
  }
  if (prefix.length) { route.rules = [...prefix, ...(route.rules || [])]; routeChanged = true; }
  for (const outbound of root.outbounds) {
    if (outbound.domain_strategy === undefined) continue;
    if (outbound.domain_strategy && outbound.domain_strategy !== 'as_is') {
      const resolver = outbound.domain_resolver ?? route.default_domain_resolver;
      if (!resolver) unsupported();
      outbound.domain_resolver = { ...(typeof resolver === 'string' ? { server: resolver } : resolver), strategy: outbound.domain_strategy };
    }
    delete outbound.domain_strategy;
  }
  if (routeChanged) root.route = route;
}
function fillSingbox(root: Record<string, any>, generated: Record<string, any>[], names: string[], warnings: string[]) {
  const tags = new Set<string>(root.outbounds.map((v: any) => v.tag));
  for (const group of root.outbounds) {
    if (!['selector', 'urltest'].includes(group.type)) continue;
    let chosen = names;
    if (typeof group.include === 'string' && group.include) chosen = chosen.filter(patternMatcher(group.include, warnings)!);
    if (typeof group.exclude === 'string' && group.exclude) { const exclude = patternMatcher(group.exclude, warnings)!; chosen = chosen.filter(n => !exclude(n)); }
    if (!chosen.length && group.fallback != null) {
      for (const candidate of Array.isArray(group.fallback) ? group.fallback : [group.fallback]) {
        if (typeof candidate !== 'string' || !candidate || candidate === group.tag) continue;
        chosen = tags.has(candidate) || names.includes(candidate) ? [candidate] : names.filter(patternMatcher(candidate, warnings)!);
        if (chosen.length) break;
      }
    }
    delete group.include; delete group.exclude; delete group.fallback;
    group.outbounds = [...new Set([...group.outbounds, ...chosen])].filter(v => v !== group.tag);
    if (!group.outbounds.length) warn(warnings, '请调整出站分组筛选或 fallback，让分组匹配可用节点。');
  }
  root.outbounds.push(...generated);
}
function fillYaml(root: Record<string, any>, generated: Record<string, any>[], names: string[], warnings: string[], fixedGroups: Set<string> = new Set()) {
  root.proxies.push(...generated);
  const canonicalType = (type: unknown) => {
    const value = String(type || '').toLowerCase().replace(/[-_\s]/g, '');
    return ({ ss: 'shadowsocks', ssr: 'shadowsocksr', socks5: 'socks' } as Record<string, string>)[value] || value;
  };
  const types = new Map<string, string>(root.proxies.map((proxy: any) => [proxy.name, canonicalType(proxy.type)]));
  for (const group of root['proxy-groups']) {
    if(fixedGroups.has(group.name))continue;
    let chosen = names;
    // We materialize generated names into proxies; native provider filters alone
    // do not filter this explicit list. Apply the saved selector before expansion.
    if (typeof group.filter === 'string' && group.filter) chosen = chosen.filter(patternMatcher(group.filter, warnings)!);
    if (typeof group['exclude-filter'] === 'string' && group['exclude-filter']) {
      const excluded = patternMatcher(group['exclude-filter'], warnings, false, true)!;
      chosen = chosen.filter(name => !excluded(name));
    }
    const excludedTypes = new Set(typeof group['exclude-type'] === 'string' ? group['exclude-type'].split('|').map(canonicalType) : []);
    if (excludedTypes.size) chosen = chosen.filter(name => !excludedTypes.has(types.get(name) || ''));
    let filtered = false;
    const members: string[] = [];
    for (const member of group.proxies) {
      if (member === '$proxy_group') { filtered = true; members.push(...chosen); continue; }
      const matcher = patternMatcher(member, warnings, true);
      if (matcher) { filtered = true; members.push(...chosen.filter(matcher)); } else members.push(member);
    }
    if (!filtered) members.push(...chosen);
    group.proxies = [...new Set(members)].filter(n => n !== group.name && (!types.has(n) || !excludedTypes.has(types.get(n)!)));
    if (!group.proxies.length && !(Array.isArray(group.use) && group.use.length)) warn(warnings, '请调整代理分组筛选，让分组匹配可用节点。');
  }
  // Keep empty provider-backed groups and nested group references; deleting them can invalidate user rules.
}
function splitIni(value: string): string[] {
  const parts: string[] = []; let part = '', quoted = false, escaped = false;
  for (const char of value) {
    if (escaped) { part += char; escaped = false; continue; }
    if (quoted && char === '\\') { part += char; escaped = true; continue; }
    if (char === '"') { quoted = !quoted; part += char; continue; }
    if (char === ',' && !quoted) { parts.push(part.trim()); part = ''; } else part += char;
  }
  if (quoted || escaped) throw issue('请补齐 INI 字段的闭合引号后重试。');
  parts.push(part.trim()); return parts;
}
function iniPair(line: string): { key: string; value: string } | null {
  let quoted = false, escaped = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (escaped) { escaped = false; continue; }
    if (quoted && char === '\\') { escaped = true; continue; }
    if (char === '"') quoted = !quoted;
    if (char === '=' && !quoted) return { key: line.slice(0, i).trim(), value: line.slice(i + 1).trim() };
  }
  return null;
}
function unquote(value: string): string { return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1).replace(/\\([\\"])/g, '$1') : value; }
function fillIni(config: IniConfig, generated: string[], names: string[], warnings: string[]): string {
  const proxy = config.sections.find(s => s.name === 'proxy')!;
  let injected = false;
  proxy.lines = proxy.lines.flatMap(line => {
    if (line.trim() !== '$proxies') return [line];
    if (injected) return [];
    injected = true; return generated;
  });
  if (!injected) proxy.lines.push(...generated);
  const groups = config.sections.find(s => s.name === 'proxy group')!;
  groups.lines = groups.lines.map(line => {
    if (!line.trim() || /^(#|;|\/\/)/.test(line.trim())) return line;
    const pair = iniPair(line); if (!pair) return line;
    const parts = splitIni(pair.value); const rawType = parts.shift(), type = rawType?.toLowerCase();
    if (!type || !['select', 'url-test', 'fallback', 'load-balance', 'smart'].includes(type)) return line;
    const firstOption = parts.findIndex(v => iniPair(v) !== null);
    const members = parts.slice(0, firstOption < 0 ? parts.length : firstOption);
    const options = firstOption < 0 ? [] : parts.slice(firstOption);
    const hasPlaceholder = members.some(v => unquote(v) === '$proxy_group');
    const filter = options.find(v => /^policy-regex-filter\s*=/.test(v));
    let chosen = names.filter(n => n !== unquote(pair.key));
    if (filter && !hasPlaceholder) { const raw = filter.slice(filter.indexOf('=') + 1).trim(); chosen = chosen.filter(patternMatcher(unquote(raw), warnings)!); }
    // Keep existing nested policies in their original order and spelling. Exact markers expand
    // at their position, while repeated markers/members never duplicate an authorized policy.
    const seen = new Set(members.filter(v => unquote(v) !== '$proxy_group').map(unquote));
    const additions = chosen.filter(n => !seen.has(n));
    let expanded = false;
    const filled = members.flatMap(member => {
      if (unquote(member) !== '$proxy_group') return [member];
      if (expanded) return [];
      expanded = true; return additions.map(iniToken);
    });
    if (!hasPlaceholder) filled.push(...additions.map(iniToken));
    if (!hasPlaceholder && !additions.length) return line;
    return `${pair.key} = ${rawType}, ${[...filled, ...options].join(', ')}`;
  });
  return [...config.preamble, ...config.sections.flatMap(s => [s.header, ...s.lines])].join(config.eol) + (config.trailing ? config.eol : '');
}
function metadataText(text: string, metadata: RenderOptions['metadata'], keys: string[]): string {
  return text.replace(/\$(app_name|subs_link|subs_domain|subscribe_info)(?![A-Za-z0-9_])/g, (marker, key: keyof NonNullable<RenderOptions['metadata']>) => {
    const value = metadata?.[key];
    // Single-pass replacement prevents caller data from becoming another template expression.
    return keys.includes(key) && typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ') : marker;
  });
}
/** Render ONLY caller-authorized endpoints. No DB lookups, executable templates or provider network requests. */
export function renderSubscription(template: Pick<SubscriptionTemplate, 'name' | 'content'>, endpoints: SubscriptionEndpoint[], options: RenderOptions = {}): SubscriptionRender {
  const name = templateName(template.name), validation = validateTemplate(name, template.content);
  if (!validation.valid) throw new TemplateValidationError(validation.errors);
  const warnings: string[] = []; const permitted: SubscriptionEndpoint[] = [];
  const reserved = new Set<string>();
  let root: Record<string, any> | undefined, doc: Document | undefined, ini: IniConfig | undefined;
  if (name === 'singbox') { root = jsonConfig(template.content); for (const outbound of root.outbounds) reserved.add(outbound.tag); }
  else if (['clash', 'clashmeta', 'stash'].includes(name)) {
    const parsed = yamlConfig(template.content); doc = parsed.doc;
    if (options.metadata?.app_name !== undefined) {
      visit(doc, { Scalar(_key, scalar) {
        if (typeof scalar.value === 'string') scalar.value = metadataText(scalar.value, options.metadata, ['app_name']);
      } });
    }
    root = doc.toJS({ maxAliasCount: 100 }) as Record<string, any>; checkRoot(root, name);
    for (const item of [...root.proxies, ...root['proxy-groups']]) reserved.add(item.name);
    reserved.add('DIRECT'); reserved.add('REJECT');
  } else {
    ini = iniConfig(template.content);
    if (options.metadata) {
      const replace = (line: string) => metadataText(line, options.metadata, ['subs_link', 'subs_domain', 'subscribe_info']);
      ini.preamble = ini.preamble.map(replace);
      for (const section of ini.sections) { section.header = replace(section.header); section.lines = section.lines.map(replace); }
    }
    for (const section of ini.sections.filter(s => ['proxy', 'proxy group'].includes(s.name))) for (const line of section.lines) { const pair = iniPair(line); if (pair) reserved.add(unquote(pair.key)); }
    reserved.add('DIRECT'); reserved.add('REJECT');
  }
  for (const endpoint of endpoints) {
    if (!eligible(endpoint, name, options)) { warn(warnings, '请按目标客户端版本和协议参数配置节点，再刷新输出。'); continue; }
    let nodeName = endpoint.name; let n = 2;
    while (reserved.has(nodeName)) nodeName = `${endpoint.name} (${n++})`;
    reserved.add(nodeName); permitted.push({ ...endpoint, name: nodeName });
  }
  const names = permitted.map(e => e.name); let content: string;
  if (name === 'singbox') {
    const generated: Record<string, any>[] = [];
    for (const endpoint of permitted) {
      if (!endpoint.native_outbounds?.length) { generated.push(singboxOutbound(endpoint)); continue; }
      // A compiled chain is trusted protocol data, not a source of additional authorized endpoints.
      // Pin the public outbound's identity and rename chain tags/detours to avoid collisions.
      const chain = structuredClone(endpoint.native_outbounds), tags = new Map<string, string>();
      const chainTags = chain.map((_entry, index) => {
        if (index === chain.length - 1) return endpoint.name;
        const base = `${endpoint.name} · ${index + 1}`; let tag = base, suffix = 2;
        while (reserved.has(tag)) tag = `${base} (${suffix++})`;
        reserved.add(tag); return tag;
      });
      chain.forEach((entry, index) => { if (typeof entry.tag === 'string') tags.set(entry.tag, chainTags[index]!); });
      for (let i = 0; i < chain.length; i++) {
        const entry = chain[i]!; entry.tag = chainTags[i];
        if (entry.detour && tags.has(entry.detour)) entry.detour = tags.get(entry.detour);
        if (i === chain.length - 1) { entry.server = endpoint.host; entry.server_port = endpoint.port; delete entry.uuid; delete entry.password; entry[endpoint.protocol === 'vless' ? 'uuid' : 'password'] = endpoint.credential; }
        generated.push(entry);
      }
    }
    fillSingbox(root!, generated, names, warnings);
    migrateSingboxRendered(root!, version(options, 'singbox'), warnings);
    content = JSON.stringify(root, null, 2) + '\n';
  } else if (root && doc) {
    const generated = permitted.map(yamlOutbound);
    const dialer=clashMetaDialer(root,name);
    if(dialer){
      if(dialer.provider){
        const provider={type:'inline',override:{'dialer-proxy':dialer.name},payload:structuredClone(generated)};
        root['proxy-providers']={...(root['proxy-providers']||{}),[dialer.provider]:provider};
        let providersNode=doc.get('proxy-providers',true);if(isAlias(providersNode))providersNode=providersNode.resolve(doc);
        if(isMap(providersNode))providersNode.set(dialer.provider,doc.createNode(provider));else doc.set('proxy-providers',doc.createNode(root['proxy-providers']));
      }else for(const proxy of generated)proxy['dialer-proxy']=dialer.name;
      delete root['x-mboard-dialer-proxy'];doc.delete('x-mboard-dialer-proxy');
    }
    fillYaml(root, generated, names, warnings, dialer?.groups);
    // Mutate dynamic arrays in place: replacing their parent key would orphan user aliases.
    const removedAnchors = new Map<string, unknown>();
    const replaceSequence = (parent: Document | ReturnType<Document['createNode']>, key: string, oldNode: unknown, values: unknown[]) => {
      const node = doc!.createNode(values);
      if (isScalar(oldNode) && isSeq(node)) {
        node.anchor = oldNode.anchor; node.comment = oldNode.comment; node.commentBefore = oldNode.commentBefore; node.spaceBefore = oldNode.spaceBefore;
      }
      if (isScalar(oldNode) && oldNode.anchor) visit(doc!, { Scalar(_key, scalar) { if (scalar === oldNode) return node; } });
      else if (isMap(parent)) parent.set(key, node);
      else doc!.set(key, node);
    };
    let proxiesNode = doc.get('proxies', true);
    if (isAlias(proxiesNode)) proxiesNode = proxiesNode.resolve(doc);
    if (isSeq(proxiesNode)) {
      proxiesNode.items = proxiesNode.items.filter(item => {
        const value = isAlias(item) ? item.resolve(doc!) : item;
        if (!isScalar(value) || value.value !== '$proxies') return true;
        if (value.anchor) removedAnchors.set(value.anchor, value.value);
        return false;
      });
      for (const outbound of generated) proxiesNode.add(doc.createNode(outbound));
    } else replaceSequence(doc, 'proxies', proxiesNode, root.proxies);
    let groupsNode = doc.get('proxy-groups', true);
    if (isAlias(groupsNode)) groupsNode = groupsNode.resolve(doc);
    if (!isSeq(groupsNode)) throw issue('YAML 代理分组需要是数组。');
    for (let i = 0; i < root['proxy-groups'].length; i++) {
      let groupNode = groupsNode.items[i];
      if (isAlias(groupNode)) groupNode = groupNode.resolve(doc);
      if (!isMap(groupNode)) throw issue('YAML 代理分组需要是对象。');
      let membersNode: unknown = groupNode.get('proxies', true);
      if (isAlias(membersNode)) membersNode = membersNode.resolve(doc);
      if (isSeq(membersNode)) {
        const oldItems = [...membersNode.items];
        membersNode.items = root['proxy-groups'][i].proxies.map((member: string) => {
          const index = oldItems.findIndex(item => isScalar(item) && item.value === member);
          return index < 0 ? doc!.createNode(member) : oldItems.splice(index, 1)[0];
        });
        for (const item of oldItems) if (isScalar(item) && item.anchor) removedAnchors.set(item.anchor, item.value);
      } else replaceSequence(groupNode, 'proxies', membersNode, root['proxy-groups'][i].proxies);
    }
    // A regex token can be anchored and referenced in an unrelated section. Keep that section's value
    // when the token is removed from proxy memberships, rather than leaving an unresolved alias.
    if (removedAnchors.size) visit(doc, { Alias(_key, node) {
      if (removedAnchors.has(node.source)) return doc!.createNode(removedAnchors.get(node.source));
    } });
    try { content = String(doc); } catch { throw issue('请检查 YAML 动态分组锚点，再重试解析。'); }
  } else content = fillIni(ini!, permitted.map(e => iniOutbound(e, name)), names, warnings);
  return { template_name: name, content_type: name === 'singbox' ? 'application/json; charset=utf-8' : root ? 'text/yaml; charset=utf-8' : 'text/plain; charset=utf-8', content, node_count: permitted.length, warnings };
}
