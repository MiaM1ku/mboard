# Offline Xboard migration

The importer reads **one offline JSON file**, not a live Xboard database or an API. Run it with Bun from the `mboard` directory. Dry-run is the default and does not open the destination database, initialize the application, generate credentials, or write files.

```sh
bun scripts/migrate-xboard.ts --input /private/export.json
# --dry-run can make that default explicit.
bun scripts/migrate-xboard.ts --input /private/export.json --dry-run
```

A valid dry-run prints counts of users, groups, nodes, machines and grants, plus warnings. A validation failure exits with code 1. It never prints source passwords or tokens. Review warnings before applying: they describe deliberately omitted fields, reset secrets and nodes without a machine or grants. A dry-run validates the source; it does not prove the destination is empty or that an endpoint/certificate works.

## Before exporting

1. Back up the old database, configuration and application key in your existing secure backup system. Freeze account/grant/node changes while making the export. Reconcile traffic at cutover so traffic arriving after the snapshot is not lost.
2. Export only the documented data shape below. Raw SQL dumps and phpMyAdmin table-envelope JSON are not accepted. JSON must be UTF-8 without a BOM. Keep exports and generated credentials outside the public web root, source control and shared logs.
3. Review features that mboard does not implement. Plans, balances, orders, coupons, commissions, staff/admin rights, child-account semantics, scheduled resets, rate multipliers, speed/device limits, historical daily traffic, tickets, notices and guides do not automatically migrate. Totals are snapshots; they do not recreate billing or reset schedules.
4. Decode encrypted outbound, routing and Reality templates **in an isolated old-Xboard staging environment**, using that deployment's own `APP_KEY` if needed. This script does not take an application key, decrypt Laravel data, or run old application code. Decryption alone does not make the resulting configuration compatible: mboard supports only the simple node fields below. Review and rebuild unsupported nodes deliberately rather than discarding configuration that changes routing or grants.

## Recommended normalized export

All four arrays are required, even when empty. IDs are positive JavaScript safe integers. They are preserved. References must exist inside the export. Duplicate IDs, emails (case-insensitive), group names, group entries and machine/port pairs fail. Unknown fields in normalized rows fail so a misspelled grant or security field cannot disappear unnoticed.

```json
{
  "users": [{
    "id": 10,
    "email": "member@example.com",
    "name": "Member",
    "enabled": true,
    "upload_bytes": 1024,
    "download_bytes": 2048,
    "quota_bytes": 107374182400,
    "expires_at": "2027-01-01T00:00:00Z",
    "created_at": "2026-01-01T00:00:00Z",
    "group_ids": [3]
  }],
  "groups": [{"id": 3, "name": "Standard"}],
  "machines": [{
    "id": 20, "name": "Edge", "host": "edge.example.com", "enabled": true
  }],
  "nodes": [{
    "id": 30,
    "name": "TLS VLESS",
    "host": "edge.example.com",
    "port": 443,
    "protocol": "vless",
    "enabled": true,
    "machine_id": 20,
    "group_ids": [3],
    "tls": true,
    "server_name": "edge.example.com",
    "created_at": "2026-01-01T00:00:00Z"
  }]
}
```

### Normalized fields and defaults

- Users: `id`, `email` and `group_ids` are required. `name` defaults to email. `enabled` defaults to true. Counters and quota default to zero. `expires_at` defaults to null. `created_at` defaults to migration validation time. Counters, each user's combined traffic and combined traffic across all imported users must be nonnegative safe integers. **`quota_bytes: 0` means unlimited**, not zero remaining traffic. Review this explicitly when converting old entitlements.
- Groups: `id` and `name` are required. Names are unique and at most 120 characters.
- Machines: `id`, `name` and `host` are required. `enabled` defaults to true. Source `token`, `token_hash`, `last_seen_at`, `version` and `config_revision` are accepted but never reused. Tokens rotate, heartbeat/version reset to null, and revision starts at 1.
- Nodes: `id`, `name`, `host`, `port`, `protocol`, `machine_id`, `tls` and `group_ids` are required. `enabled` defaults to true. `server_name` defaults to an empty string. `created_at` defaults to migration validation time. `machine_id: null` deliberately leaves a node unassigned. There is no host-based machine inference.
- `group_ids: []` is an explicit empty grant. It never means all groups. User/node access is determined by matching group membership, enabled state, quota and expiry. Missing or unknown group IDs fail rather than widening access.
- Booleans must be JSON booleans. Times must be valid UTC ISO 8601 strings with `Z`, or null for expiry. Hosts must be plain IP addresses or hostnames, not URLs. Ports are integers from 1 to 65535.
- Protocols: `vless`, `trojan`, `shadowsocks` only. Transport is plain TCP. Trojan requires TLS. Shadowsocks requires `tls: false` and uses `aes-128-gcm`. There is no VMess, Hysteria, TUIC, AnyTLS, Reality, WebSocket, gRPC, VLESS flow, custom routing or alternate cipher mapping. Unsupported protocol/configuration fails; it is never silently skipped.
- Source user `role` (`user` or `admin`), `password`, `password_hash`, `credential` and `subscription_token` are accepted only to ease normalization. They are discarded. **Every imported user becomes `role: user`**. There is no `is_admin` privilege import switch.

## Recognized Xboard table-key export

A limited alternative is a JSON object containing table-name keys and raw row arrays:

```json
{
  "v2_user": [],
  "v2_server_group": [],
  "v2_server": [],
  "v2_server_machine": []
}
```

`v2_user` selects this format. `v2_server_group` is required. Choose either unified `v2_server` rows with `type`, or the per-protocol tables `v2_server_vless`, `v2_server_trojan`, `v2_server_shadowsocks`. Do not mix both forms. IDs must be globally unique across all imported node tables; normalize/remap IDs and references offline if old per-protocol tables reuse IDs. Missing node/machine tables mean explicitly no records. Unknown empty tables produce inventory warnings. Unknown nonempty tables fail; remove or convert them deliberately offline.

| Source | Destination / rule |
| --- | --- |
| `v2_user.id,email,name` | Same fields; missing `name` uses email |
| `v2_user.banned,access_enabled` | Both flags required; enabled only when not banned and access is enabled |
| `v2_user.u,d,transfer_enable` | Upload/download/quota integer **bytes**, no unit guessing or automatic multiplication |
| `v2_user.expired_at,created_at` | Unix seconds become ISO UTC; expiry may be null |
| `v2_user.group_id` | Required; null becomes `[]`, otherwise one existing group ID |
| `v2_user.is_admin,is_staff,password,password_algo,password_salt,uuid,token` | Not reused; roles and all authentication secrets reset |
| `v2_server_group.id,name` | Same fields |
| Unified `v2_server.type` | Supported protocol exactly, without alias guessing |
| Per-protocol table name | Explicit protocol from the documented table name |
| Node `show,enabled` | `show` required; when supplied, `enabled` must also be true |
| Node `id,name,host,port,tls,server_name,group_ids,machine_id` | Same semantic fields; `tls`, grants and machine assignment must be explicit |
| Node `created_at` | Unix seconds become ISO UTC |
| `v2_server_machine.id,name,host,is_active` | Same identity/endpoint; `is_active` maps to enabled |

Legacy numeric strings containing nonnegative integer digits and flags `0`/`1` are accepted. Group arrays can be JSON-encoded strings. The exact Xboard version's byte units must be checked before export; convert known different units offline into normalized byte fields. `transfer_enable: 0` is rejected in the legacy format because its entitlement semantics must not silently become unlimited access. Produce an explicit normalized quota/enabled decision instead. Positive speed/device limits, child accounts, non-unit traffic rates and different `server_port` versus `port` also require deliberate normalization.

Many Xboard machine exports lack `host`, and older node exports lack a direct `machine_id`. Add verified values offline or use normalized export. The importer does not infer machine bindings, consume many-to-many binding tables or guess from hostnames. Flattening `protocol_settings` is not automatic: nonempty protocol settings, Reality, transport settings, encrypted outbound/template fields, custom routes, route IDs, certificate configuration and insecure TLS settings are rejected. Rebuild these nodes in the normalized format after deciding which features can safely be removed or replaced.

Other legacy row fields are listed by field name in warnings without printing values. They are not copied. Review that inventory for your specific Xboard version before applying, especially new access controls that this limited mapper does not understand. If a security/grant rule differs from the table above, use a reviewed normalized export instead.

## Regression checks

```sh
bun test tests/backend-migration.test.ts
```

These tests use disposable databases and check validation failures, dry-run behavior, secret rotation, credential permissions, exact grants, first-admin setup, machine authentication, nonempty destination refusal without revision changes, and existing-file/symlink refusal. They do not test the old deployment's export consistency, production endpoint reachability or certificate provisioning.

## Apply to a fresh destination

Stop the destination web server and node agents before applying. Use a private existing directory for the credential file. The file must not exist: the importer refuses overwrite and symlinks. Explicit `--apply`, `--db` and `--credentials-out` are all required.

```sh
mkdir -m 700 /private/mboard-migration
bun scripts/migrate-xboard.ts \
  --input /private/export.json \
  --apply \
  --db /private/mboard.sqlite \
  --credentials-out /private/mboard-migration/credentials.json
```

The complete source and its references are validated before any destination is opened. Passwords are then independently generated and hashed with Argon2id. Apply imports `createApp` from `../src/server/app.ts` with `initializeRuntime: false` (so opening a rejected destination does not advance its machine revisions) and writes through `app.db` (`bun:sqlite`) using an immediate transaction. Under the write lock, it requires `users` count zero, every other application data table empty, and `settings.setup_complete` equal to `0`. A destination with even one existing user or a completed setup is rejected. This is a one-shot fresh-database importer, not a merge/upsert tool.

The importer uses prepared statements, keeps explicit IDs and grants, and leaves the `setup_complete` setting untouched. No imported administrator can bypass first-admin setup. Do **not** run setup before import. After import, run the application's normal first-admin setup with a new email address distinct from the imported users. Secure initial setup from public access until the administrator is created.

### Credentials and cutover

The output is a JSON document with `format: mboard-migration-credentials-v1`, a timestamp, a user list (`id,email,password,credential,subscription_token`) and a machine list (`id,token`). It is created with exclusive creation and forced mode **0600**. The containing directory must also be private. No secret is printed to stdout or audit logs.

Each user gets a unique random UUID bootstrap password, a new UUID node credential and a new subscription token. Subscription and machine bearer tokens use the backend's `secret()` generator: two fresh UUIDs without hyphens concatenated into 64 hexadecimal characters. Only the machine token's SHA-256 hash is stored in SQLite. Old password hashes have no compatibility path. Old passwords, UUIDs, subscription links and machine tokens will stop working against mboard. Distribute the new subscription links privately, replace machine-agent tokens, then ask each user to change the bootstrap password after their first login.

**“One-time output” does not mean a forced one-time login.** The contract has no forced-password-change gate, so bootstrap passwords remain usable until users change them. Send each user only their own bootstrap password/link, not the full output file. Keep the output under your secret-handling policy and remove it after safe distribution/backup.

Provision TLS certificates and keys on each node at `/etc/mboard-node/tls/<node_id>.crt` and `/etc/mboard-node/tls/<node_id>.key`. Verify DNS/endpoints, group authorization, expiry, quota, subscription output, agent heartbeat, configuration revision and traffic attribution with test users before switching production traffic. Agents and clients need reconfiguration, so plan a cutover window rather than assuming old connections survive.

## Start the independent backend after import

Build the browser frontend into `dist` with the project's build command, then start Bun from the `mboard` directory:

```sh
MBOARD_HOST=127.0.0.1 MBOARD_PORT=8787 \
MBOARD_DATA_DIR=/private/mboard-data \
MBOARD_PUBLIC_ORIGIN=https://panel.example.com \
bun src/server/server.ts
```

The destination above is `/private/mboard-data/mboard.sqlite`, so import into that exact path when using this startup example. Defaults are host `127.0.0.1`, port `8787`, and data directory `./data`. The backend serves `dist` from the same origin with SPA fallback and blocks traversal, hidden files and symlink escapes. A fresh database has no users, nodes or demo records. SQLite migrations are transactional and numbered with `PRAGMA user_version`; new database files have mode `0600`.

Set `MBOARD_PUBLIC_ORIGIN` to the single external HTTP or HTTPS origin, without a path or credentials. This allows a TLS reverse proxy to forward internal HTTP requests while the backend validates the browser's HTTPS origin and sets Secure cookies. Forwarded-origin headers never decide the canonical origin. For the development Vite proxy, use `MBOARD_PUBLIC_ORIGIN=http://127.0.0.1:5180`. Keep the backend bound to loopback or a private network behind your reverse proxy.

Login/setup requests use 15-minute in-memory rate-limit windows. `MBOARD_LOGIN_LIMIT` defaults to `10` attempts per account and actual TCP peer combination. `MBOARD_PEER_LOGIN_LIMIT` defaults to `200` total attempts per peer, so users behind one reverse proxy have separate account buckets but share that wider ceiling. Both limits can be set explicitly to positive integers. The cache has a hard 10,000-entry cap. The server does not trust `X-Forwarded-For` by default, and rate-limit memory resets when the process restarts. Enforce any additional public-edge limits at your trusted proxy.

The handler reads JSON bodies incrementally and rejects data beyond 1 MiB with the API error envelope. TLS-enabled VLESS and Trojan nodes still need the certificate files described above on the node machine; setting a public panel origin does not provision node certificates.

### Failure and rollback

Rows are transactional. The credential document is written and fsynced before commit, so an ordinary write failure rolls back all imported rows and removes this run's output. Existing output files are never deleted. Schema initialization may leave an empty database file after a failed apply.

SQLite and the filesystem cannot share a crash-atomic transaction. A process/OS crash between credential-file creation and database commit can leave an output file with an empty database. Inspect the destination before retrying. Only remove that failed run's file after confirming the destination is empty. Never delete a credential file belonging to a successful import: its secrets are not recoverable from password/token hashes. Preserve both the database and its matching credential document in your secure cutover backup. Treat ambiguous commit errors as requiring inspection, not a blind retry.

To undo a successful import, stop the destination and restore its pre-import backup (or discard the newly created database including SQLite WAL/SHM sidecars, after connections close). Revert clients/agents to the old deployment and old credentials if that deployment is still intact. There is no in-place delete/unimport operation, and new traffic written after cutover must be reconciled separately before rollback.
