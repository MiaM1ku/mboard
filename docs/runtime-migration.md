# Independent runtime migration

This module compiles native sing-box configuration from archived source rows. Importing records **does not activate a host**. A bad or incomplete configuration must leave the old process running. The deployment owner must validate the compiled bundle with the pinned core, provision files on the same host, replace the service, verify its heartbeat, and only then call `activateMachine`.

## Additive database model

`initializeRuntime(db)` creates these tables without changing core tables, their CHECK constraints, `user_version`, or `legacy_records`:

- `runtime_nodes`: original ID, parent ID, protocol, enabled/show flags, private source payload.
- `runtime_machines`: original ID, pending/active/disabled state, activation flag, fresh token hash, applied numeric revision, last seen/version, core/telemetry readiness, core version, private source payload.
- `runtime_bindings`: many-to-many machine/root or entry binding, original binding payload.
- `runtime_identity_credentials`: `(user_id,node_id,profile_id)` and persistent protocol credential. Node ID zero stores the original user UUID independently from core logical credentials.
- `runtime_source_records`: private enriched copies of archived rows, including decrypted template settings supplied by the deployment owner.
- `runtime_metadata`: per-machine content digest and monotonically increasing safe-integer configuration revision.

The private payload tables are not public API models. Never return them, certificate material, native server configurations, or deployment bundles to administrators' list APIs or subscription responses. `runtimeMachineViews` and `runtimeNodeViews` return safe display metadata. Physical hosts and logical entries are separate counts.

## Integration functions

```ts
initializeRuntime(db);
restoreRuntime(db, {
  coreVersion: '1.14', // or explicitly pinned '1.12'
  supplements: [{kind: 'v2_outbound_template', id: 5, payload: {settings: {/* plaintext */}}}],
});
const token = provisionMachineToken(db, machineID); // return once through a private deployment channel
const compiled = compileMachine(db, machineID);
// {revision:number, config:object, traffic_labels:[{label,user_id,node_id}], files, warnings}
const machineIDOrNull = authenticateRuntimeMachine(db, bearerToken);
const health = heartbeatRuntimeMachine(db, machineID, {
  applied_revision: compiled.revision, version: 'mboard-node/core',
  core_ready: true, telemetry_ready: true,
});
activateMachine(db, machineID, {
  verified: true, appliedRevision: compiled.revision,
  coreReady: true, telemetryReady: true,
});
const endpoints = authorizedEndpoints(db, userID);
```

Token authentication works for a provisioned pending machine, so initial config fetch cannot deadlock on activation. Disabled machines must not be authorized by the central API. Activation recompiles and requires the exact current revision, a fresh persisted token hash, a verified probe, and both readiness flags. Heartbeats only mark readiness when the applied revision matches the compiled revision. A heartbeat does not automatically activate a host.

Use `deactivateMachine` for rollback or disable public runtime entries until a verified replacement is ready. Core users/group grants are authoritative for enabled status, expiry, quota, and access isolation. The deployment owner must invoke `restoreRuntime` after introducing new core users or source profiles so their persistent runtime identities exist. Existing subscription tokens, passwords, logical user identity, and archival rows are never rewritten by runtime restoration.

`authorizedEndpoints` returns `{id,name,protocol,host,port,credential,settings}`. Settings are native client-side sing-box fields, not legacy numeric TLS modes. Profiles use composite entry IDs. Server-only keys and certificate paths are stripped. Subscription adapters must use endpoint credential as VLESS UUID or Trojan/AnyTLS password. Shadowsocks settings include `method`, and credential is `serverPSK:userPSK`.

## Source supplements

The archived `legacy_records.kind` is the original table name, such as `v2_server`, `v2_user`, `v2_server_machine_binding`, `v2_server_route_profile`, `v2_outbound_template`, `v2_server_outbound_template`, `v2_route_template`, `v2_server_route_template`, `v2_rule_set`, or `v2_server_route`. Payloads are raw JSON row objects. Numeric MySQL IDs and timestamps may be strings.

Supplements are an array of `{kind,id,payload}`. They merge into a private runtime source copy and never replace the archive. Typical supplements:

```json
[
  {"kind":"v2_outbound_template","id":5,"payload":{"settings":{"server":"synthetic.invalid","server_port":443,"method":"2022-blake3-aes-128-gcm","password":"SYNTHETIC"}}},
  {"kind":"v2_server","id":10,"payload":{"server_psk":"MTIzNDU2Nzg5MDEyMzQ1Ng=="}},
  {"kind":"v2_server_machine","id":2,"payload":{"tls_material":{"180":{"certificate_path":"/etc/mboard-node/tls/180.crt","private_key_path":"/etc/mboard-node/tls/180.key","verified":true}}}}
]
```

The owner extracts decrypted outbound settings through the isolated old PHP model, without importing old runtime code. Source Shadowsocks `server_psk` should also come from that model if `created_at` is formatted as a SQL date instead of unambiguous Unix seconds. For Unix source timestamps, compatibility derivation is base64 of the first 16 or 32 **ASCII characters** of the timestamp's MD5 hex digest. User PSKs likewise encode the first 16 or 32 ASCII UUID characters, not decoded UUID bytes.

Original root UUIDs come from `v2_user.uuid`. Child identity is a compatibility HMAC-derived UUID keyed by the base UUID bytes. Route-profile identity derives first from the original root UUID and profile UUID, then derives the child UUID when needed. The resulting credentials are inserted once and reused. Existing plaintext supplements are not overwritten by their original encrypted template string on repeated restoration.

Unmatched bindings are returned in the restoration summary. They do not produce an inbound. Explicit bindings take priority; a source `machine_id` supplements a missing equivalent binding. Add a missing binding only after host identity has been independently verified.

## TLS and certificate provisioning

Reality uses source private/public keys, SNI, short IDs, handshake destination and port. Private keys only occur in the compiled server config. Public client settings contain the public key and one short ID.

For TLS `content` mode, `cert_config.cert_content` and `key_content` produce `files` entries with relative canonical filenames, mode 0600, and paths beneath `/etc/mboard-node/tls/`. `cert`, `certificate`, `key`, and `private_key` aliases are accepted in an explicit `tls_material` supplement. The deployment owner writes these files before starting the core.

For `file`, `self`, `dns`, or `http` source modes, keep PEMs on the source host. Copy the verified existing material on that same host to canonical paths, then supply a verified path declaration. `tls_material` can sit on a root or be keyed by root ID in each machine payload, which supports distinct certificates for several hosts sharing a Trojan root. Paths outside `/etc/mboard-node/tls/` or containing `..` are rejected. A verified declaration is a deployment-owner attestation, not a remote file probe performed by this module.

Missing material throws a sanitized `RuntimeCompileError`. The compiler never silently turns TLS off and never generates replacement certificates. `files` and native configs must only travel through private deployment channels. `writePrivateMachineBundle` enforces directory 0700 and bundle 0600.

## Native compilation and telemetry

A physical root has one inbound per listen port on each bound host. Root and child entries contribute separately authorized users to that inbound, even when client ports differ from server ports. Original enabled, show, group and parent fields remain in private source payloads. A hidden entry is omitted from new subscriptions but can still authenticate existing clients when authorized.

VLESS TCP/Reality/TLS/flow, Shadowsocks 2022 multi-user, Trojan TLS, and AnyTLS users/password compile independently. AnyTLS requires the 1.14 target. Unsupported inbound protocols, VLESS encryption, plugins/obfuscation, unsupported meaningful protocol settings, incomplete Reality/TLS, unresolved route targets, malformed port collisions, and missing decrypted settings fail closed.

Outbound template tags are scoped per root to prevent multi-inbound collisions. Profile IDs and entry filters survive. Template match selectors preserve the source's OR semantics. Structured template routes precede raw source custom routes, then private-IP guards and legacy destination rules, then authenticated profile fallback. Native machine `route.rules` precede generated routes and `rules_after` follows them. Domain/rule-set routing enables sniffing. Unresolved geo selectors require a rule-set supplement rather than being weakened to a catch-all.

WireGuard legacy peers or single-peer outbounds are translated to current 1.14 endpoint fields. The compiler reports a warning and the pinned core must validate it. An explicit 1.12 target retains deprecated outbound syntax and reports its compatibility requirement. Other native static machine settings can be supplied through `v2_server_machine.payload.native_config` with outbounds, endpoints, route, dns, and experimental sections. Native supplemental inbounds must be normalized into runtime records rather than bypassing identities and labels.

Telemetry config includes `experimental.v2ray_api` listening only on `127.0.0.1:19090` with the authorized `users` list. Each opaque label is `mb:u:UID:n:ENTRY_ID:p:PROFILE_UUID` (profile zero for base identity). `traffic_labels` is outside `config` and maps each label to the logical user and entry. Traffic ingestion sums user-label counters only, never inbound totals plus user totals. The node's durable cumulative-counter cursor and batch journal are owned by the telemetry worker.

## CLI and cutover sequence

```sh
bun scripts/restore-runtime.ts --db /private/mboard.sqlite --supplements /private/runtime-supplements.json --core-version 1.14
bun scripts/restore-runtime.ts --db /private/mboard.sqlite --machine 2 --bundle /private/deploy/machine-2.json --new-token
```

Supplement files must be 0600 or stricter. The CLI prints sanitized counts, revisions and warnings, never configurations or tokens. `--new-token` writes a separate private token file next to the bundle. The CLI never activates a machine or stops an old service.

1. Backup existing service/config and record verified host-to-machine binding.
2. Restore pending runtime records and provide the necessary private supplements.
3. Compile a private bundle. Provision its `files` or verify preprovisioned canonical TLS paths.
4. Run the pinned core's native `check` command on that host. A failed check stops cutover here.
5. Provision the fresh token and start the new agent/core while retaining a recoverable old service/config backup.
6. Require a matching revision and both readiness flags. Verify real protocol connectivity, then call `activateMachine`.
7. Only after that verified handover uninstall the old node installation. Roll back the service and call `deactivateMachine` if verification fails.

## Verification limits

`bun test tests/backend-runtime.test.ts` uses synthetic archives and credentials. It checks additive/idempotent import, credential matching, parent/child aliases, scoped profile identities, authorization isolation, expiry/quota, multi-machine binding, health gates and sanitized fail-closed behavior. These tests do not prove a specific host's certificate exists, its network port is reachable, or its pinned native core accepts the production config. Those are mandatory per-host cutover checks.

References: [Bun SQLite transaction modes](https://bun.sh/docs/api/sqlite), [sing-box migration guide](https://sing-box.sagernet.org/migration/), [WireGuard endpoint](https://sing-box.sagernet.org/configuration/endpoint/wireguard/).
