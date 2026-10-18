# Subscription templates

## Integration contract

Runtime dependency: **`yaml@^2.8.1`**. The module is `src/server/subscriptions.ts`; it has no PHP runtime dependency and does not perform network requests.

```ts
initializeSubscriptionTemplates(db: Database): void
listTemplates(db: Database): SubscriptionTemplate[]
getTemplate(db: Database, name: string): SubscriptionTemplate | null
saveTemplate(db: Database, name: string, content: string): SubscriptionTemplate
validateTemplate(name: string, content: string): TemplateValidation
selectSubscriptionFormat(
  userAgent: string | null | undefined,
  query?: URLSearchParams | Record<string, string | undefined>
): TemplateName | 'shadowrocket' | 'quantumultx' | 'loon'
renderSubscription(
  template: Pick<SubscriptionTemplate, 'name' | 'content'>,
  endpoints: SubscriptionEndpoint[],
  options?: { userAgent?: string; clientVersion?: string }
): SubscriptionRender
```

Stored template names are exactly `singbox`, `clash`, `clashmeta`, `stash`, `surge`, `surfboard`. Template names are not normalized during archive import. Shadowrocket, Quantumult X (`quantumultx`, `quanx`) and Loon are selected by User-Agent or `flag`, then rendered as share links. They have no template row. Template records contain `{ id, name, content, created_at, updated_at, source }`. `source` is `archive`, `builtin` or `custom`. List and get include the original content, so route authentication must protect these admin operations.

`TemplateValidation` is `{ valid, errors: [{ message, line?, column? }], warnings }`. Validation failures throw `TemplateValidationError` from save/render/selection, with `status = 400` and safe Chinese messages. Return `issues` to the administrator without exposing parser errors or stack traces. JSON parser positions are supplied only when the runtime exposes a numeric offset. YAML and INI errors include positive line/column positions when available.

`SubscriptionRender` is `{ template_name, content_type, content, node_count, warnings }`. The subscription handler sends **`result.content` as the raw response body**, with `result.content_type`, not the preview JSON envelope. The admin preview returns the whole result object. It calls the same renderer with synthetic endpoints such as `preview.invalid` and dummy credentials, never an actual user's credentials. `node_count` counts accepted dynamic endpoints, not static policies, groups, or chain hops.

The application owner is responsible for authentication, admin-only access, allowed user endpoints, HTTP errors, schema version management, quota/expiry gating, subscription headers and frontend wiring. The renderer never queries nodes or users. Pass only the authenticated subscriber's authorized endpoints.

## Restore the written templates before defaults

Call `initializeSubscriptionTemplates(db)` after a legacy import and during normal database startup. Its transaction creates `subscription_templates`, reads `legacy_records` whose `kind` is exactly `v2_subscribe_templates`, and copies the original raw `{ id, name, content, created_at, updated_at }` fields into the new table. Only absent names receive minimal builtins afterwards.

The imported database has **six records**, even though the user describes five custom templates. The known names are the five client-specific templates plus `singbox`. Expected archived content character lengths are `4095 / 21513 / 8133 / 3603 / 19296 / 18319` in the name order above. These lengths are inventory evidence, not acceptance criteria or truncation limits. The actual content remains in the remote SQLite archive. No production template content is embedded in this repository or the tests.

Initialization does not parse/reformat content. Comments, CRLF, whitespace, custom DNS, rules and URLs survive byte-for-byte in storage. Existing imported or edited content is never overwritten during restart. A later legacy import can replace a still-unedited minimal builtin. Builtins use negative IDs, leaving positive legacy IDs free. Corrupt known archive fields abort the whole transaction instead of silently substituting defaults. Rendering an invalid archived template returns a validation error, allowing an administrator to repair it explicitly.

Saving validates first, then atomically updates content/source/timestamp. Content is stored exactly as submitted, including leading/trailing whitespace. The maximum save/render content size is **512 KiB of UTF-8 bytes**. Initialization does not truncate an archived record.

## Endpoint normalization

```ts
interface SubscriptionEndpoint {
  id: number | string;
  name: string;
  protocol: string; // vless, shadowsocks (ss alias), trojan, anytls
  host: string;
  port: number;
  credential: string; // UUID or protocol-ready password/key; SS2022 composite key from compiler
  settings?: Record<string, any>; // native sing-box outbound protocol details
  native_outbounds?: Record<string, any>[];
}
```

`settings` uses native sing-box fields, for example:

```ts
{
  method: '2022-blake3-aes-128-gcm', // Shadowsocks only
  flow: 'xtls-rprx-vision',         // VLESS only
  tls: {
    enabled: true,
    server_name: 'tls.example',
    insecure: false,
    utls: { enabled: true, fingerprint: 'chrome' },
    reality: { enabled: true, public_key: 'PUBLIC_KEY', short_id: 'abcd' }
  },
  transport: { type: 'ws', path: '/proxy', headers: { Host: 'tls.example' } }
}
```

The runtime/compiler must supply actual Reality public keys, short IDs, flow, SS method, protocol-ready user credentials and TLS settings. Do not derive protocol parameters from user display names. Identity, protocol, host, port and UUID/password in generated sing-box output come from the endpoint, never an overriding field in `settings`.

Optional `native_outbounds` is for trusted compiler-built sing-box chains. Its **last element is the public endpoint**. Earlier elements are private chain hops. Tags and internal detours are renamed per endpoint. The last element's host/port/UUID/password are pinned to endpoint identity. The compiler remains responsible for chain validity and any auxiliary-hop credentials. Do not populate this field directly from an untrusted HTTP request. Other client formats use `settings`; they do not translate compiled chains.

Node names are disambiguated against static policies/groups and other generated nodes. Control characters and invalid ports are skipped with generic warnings. Warnings never contain credentials, hostnames, user regex text or parser snippets.

## Rendering and client capability

| Format | Native body | Dynamic injection |
| --- | --- | --- |
| singbox | JSON | Append native outbounds. Fill selector/urltest members. |
| clash, clashmeta, stash | YAML | Append proxies. Fill proxy-group members. |
| surge, surfboard | INI | Append `[Proxy]` policies. Fill `[Proxy Group]` memberships. |

The original PHP protocols and helper were read for injection behavior. They are not loaded at runtime.

For sing-box groups, `include` filters authorized names, `exclude` removes matches, and `fallback` resolves the first nonempty candidate (exact authorized name, another template tag, or name-pattern matches). Existing members stay in order. These template-only helper fields are removed from the response, not from storage.

For YAML groups, PHP-style delimited regex members such as `/HK|香港/i` expand to matching authorized names. Saved `filter` selects generated members, `exclude-filter` removes generated matches, and `exclude-type` excludes listed types case-insensitively (including `ss`/`Shadowsocks` aliases). These constraints apply before marker/regex/default expansion because native Mihomo provider filters alone do not filter a materialized explicit `proxies` list. Explicit static/nested references retain order; explicit proxy types still honor `exclude-type`. Invalid exclusion expressions exclude generated members rather than silently broadening the group. A group without regex members receives all compatible endpoints that pass its constraints. Provider-backed groups remain present. YAML's document AST changes dynamic memberships while preserving other configuration values and exact stored template text.

Production recheck after the group fix: 46 eligible account subscriptions had zero HK members in `大流量下载`. Public `clash.meta/1.19.0` fetch returned 200. The sampled bulk group contains 12 proxies, and `🇭🇰自动` contains the seven HK entries. The saved ClashMeta template remains byte-for-byte equal to its original archive. Existing client copies need a subscription refresh.

For INI groups, `policy-regex-filter` filters appended names. Nested groups and options stay present. Members are inserted before options. `[Rule]`, other unrelated sections, comments, line order and newline style are not reserialized. Old `$proxies` and `$proxy_group` injection tokens are supported when present but are not required. Subscription link/info token replacement belongs to the application layer if a future template uses it; the six archived templates do not contain those tokens.

INI values/names containing delimiters, quotes or backslashes are double-quoted and escaped. Newlines cannot become injected sections. Surge's modern quoted-value escaping is documented for iOS 5.21.0+ and Mac 6.8.0+: older clients may not accept complex quoted credentials. The runtime owner should use compatible client versions for such credentials.

Supported conversion is conservative:

- Classic Clash accepts classic Shadowsocks and Trojan, skipping VLESS, AnyTLS and SS2022.
- Sing-box accepts normalized VLESS (including Reality), Shadowsocks/SS2022, Trojan and AnyTLS. Known versions below 1.6 skip Reality; below 1.12 skip AnyTLS.
- Clash Meta accepts those four protocols. Known versions below 1.19.1 skip AnyTLS.
- Stash accepts the four protocols. Known versions below 3.0 skip SS2022; below 3.1 skip Reality; below 3.3 skip AnyTLS. Trojan Reality and HTTPUpgrade are skipped.
- Surge/Surfboard skip VLESS. They accept compatible Shadowsocks/SS2022, Trojan and current AnyTLS. Surge skips the SS2022 ChaCha variant. Surfboard AnyTLS uses a positional password, whereas Surge uses `password=`.
- Unknown protocols, XHTTP, untranslatable plugins, multiplex/ECH/custom certificate requirements in cross-format conversions are skipped with warnings. The module does not emit an invented protocol type or silently reduce these requirements.

A supplied `clientVersion` takes priority over a recognizable version in `userAgent`. With no known version, the current format's capability is assumed. Version-specific adaptation of old DNS/routing schemas is not performed: the user's advanced sing-box template is preserved for the core it targets.

## Safety and validation boundaries

YAML uses the [`yaml` core schema](https://github.com/eemeli/yaml/blob/main/docs/03_options.md), strict unique keys, no custom tags and a bounded alias count of 100. All parser warnings (including unresolved tags) fail validation. Multiple documents fail. No JavaScript evaluation, filesystem includes or remote-provider fetching occurs.

INI validation parses sections and quoted fields. It checks required `[Proxy]`, `[Proxy Group]`, `[Rule]` sections and basic key/value syntax in applicable sections. It does not download rulesets or execute `[Script]` sections. User-authored remote provider/script URLs stay text in output; clients may subsequently fetch them according to their own behavior.

Group regex support is a bounded JavaScript-compatible subset of old PHP patterns. Backreferences, lookaround, quantified groups, huge repetitions and overly long expressions are rejected with safe warnings. After redundant outer `.*` wildcards are removed, at most one repetition is allowed, which also rejects overlapping patterns such as `a*a*a*b`. This protects public rendering requests, but means some advanced PCRE expressions need rewriting to basic alternation, character classes and anchors.

Validation checks syntax/basic structure, not complete client schema semantics, route cycles, cryptographic correctness, remote resources or protocol availability on a live server. An optional **actual `sing-box check`** can be run by the application/deployment owner against a safely isolated preview file and the matching core version. This module never starts a core process or performs that check implicitly.

## Regression tests

Run `bun test tests/backend-subscriptions.test.ts`. Fixtures are synthetic, not the actual archived user templates. Tests cover six-record exact restoration, later import, restart/save preservation, immutable source after rendering, custom DNS/rules/providers, caller-supplied endpoint subsets, format selection, malformed JSON/YAML/INI, YAML tags/aliases, nested groups, safe generic errors, INI delimiter escaping, Reality/SS2022/AnyTLS capability filtering and compiled sing-box chains.
