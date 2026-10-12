# Staged Xboard migration: records first, nodes one by one

The dedicated [importer](../scripts/import-archive.ts) preserves original account passwords and administrator roles. It imports users and groups into the new SQLite core. Every source row is also archived in `legacy_records`, including all node protocols, machine credentials, bindings, Reality settings, parent/child links, route profiles, templates, unknown tables, and encrypted settings.

**Archived nodes and machines are pending records, not live runtime configurations.** Import does not create rows in `nodes` or `machines`. Old agents cannot authenticate to the new backend. No old protocol is silently converted to a basic VLESS, Trojan, or Shadowsocks configuration. Node support must be reviewed and implemented before each machine is enrolled. This import is not a traffic cutover.

## Private export contract

Create the export on the source host from one consistent snapshot, including every discovered source table. Keep it remote and private. Never attach the complete archive to chat, a public Git repository, a web download endpoint, or a support ticket.

```json
{
  "format": "mboard-staged-import-v1",
  "tables": {
    "v2_user": [],
    "v2_server_group": [],
    "v2_server": [],
    "v2_server_machine": [],
    "v2_server_machine_binding": [],
    "v2_server_route_profile": [],
    "v2_server_outbound_template": [],
    "v2_server_route_template": []
  }
}
```

The first four table arrays are required, even when empty. Other table names must match `[A-Za-z_][A-Za-z0-9_]{0,127}`. Every table value is an array of raw row objects. Preserve every column, including password hashes, salts, original tokens, protocol JSON strings, private keys, encrypted values, and columns unknown to the new backend. Do not decrypt encrypted settings. JSON serializing/deserializing retains their values, although JSON formatting is not retained. Columns containing SQL binary values need a lossless exporter encoding (for example, a tagged base64 value) in the raw payload; core user fields must remain strings, numbers, booleans, or null as described below.

Large SQL integers should be decimal strings rather than rounded JSON numbers. Accounting and primary IDs must fit JavaScript's safe integer range (`0..9007199254740991`); the importer refuses larger values rather than rounding. Table rows with missing/null IDs, duplicate IDs in unknown tables, or composite keys receive ordinal `legacy_records.id` keys (`@row:0`, etc.). Their original row values remain inside `payload`. Visible users/groups/nodes/machines require distinct positive integer IDs. The exporter should preserve source order for tables without a primary ID.

Required user columns:

- `id`, `email`, `password`, `banned`, `is_admin`, `access_enabled`, `group_id`, `transfer_enable`, `expired_at`, `created_at`.
- `u` and `d` are copied in bytes. Null/missing counters represent zero in core accounting; the raw row is retained unchanged.
- `created_at` and nonnull `expired_at` are Unix seconds, including numeric strings. `expired_at: 0` becomes `1970-01-01T00:00:00.000Z` and stays expired. Only `expired_at: null` means no expiry.
- `password_algo` can be absent, null, empty, or `bcrypt`. Bcrypt `$2a$`, `$2b$`, and PHP `$2y$` with cost `04..16` are accepted unchanged. Other hashes/algorithms fail validation without printing their values. This cost limit bounds login CPU work. Review incompatible accounts separately before importing.
- `group_id: null` means no grant. A nonnull ID must refer to an exported group. Grants use only the account's own group and only when `access_enabled` is true. Parent account access is not silently inherited.
- SQL boolean fields can be `true`/`false`, `1`/`0`, or strings `"1"`/`"0"`.
- Account login is enabled exactly when `banned` is false. `access_enabled` controls proxy grants, not login. `is_admin` retains the administrator role even for a banned account.

Groups require `id` and `name`. Node/machine records require `id`; their complete configurations are archived without requiring the new runtime to support their protocols.

## Account and quota semantics

Original bcrypt hashes are not reset. Login and password-change verification use PHP-compatible 72-byte UTF-8 truncation for bcrypt. This is necessary because Bun otherwise prehashes long bcrypt inputs, which would reject some original passwords. New/reset passwords continue to use Argon2id.

The source Xboard checkout explicitly treats `transfer_enable` equal to zero/null as unlimited: `Helper::subscriptionTransferEnable()` and `CheckTrafficExceeded`'s positive-quota condition document this. The importer maps those values to `quota_bytes: 0`, the same unlimited convention in mboard. Nonzero quotas remain exact bytes and still block an account whose `u + d` meets/exceeds the limit. No quota multiplication or synthetic daily traffic is performed. The complete source snapshots retain exact raw `u`/`d` values.

User IDs, email spelling, quotas, expiry, usage, admin roles, and grants survive the import. Node credentials and subscription tokens rotate internally. Original UUIDs/tokens remain only in the private archive. There is no generated password file and no durable import acknowledgement pairing. Sessions are not imported. Users log in again with their original password, then use their new subscription URL once nodes have been enrolled.

If any imported administrator is enabled, `setup_complete` becomes `1`, so the public setup flow cannot create a competing administrator. If no administrator is enabled, setup stays available for recovery. Banned administrators retain their role but cannot log in.

## Run on the destination host

Use a fresh private directory and SQLite database. The new service must be stopped while applying. The old service can keep running while the records-first destination is staged; do not change its database or node endpoints during this step.

```sh
install -d -m 700 /opt/mboard/private
chmod 600 /opt/mboard/private/archive.json
bun scripts/import-archive.ts --input /opt/mboard/private/archive.json --db /opt/mboard/private/mboard.sqlite --dry-run
# The default is also dry-run when neither flag is provided.
bun scripts/import-archive.ts --input /opt/mboard/private/archive.json --db /opt/mboard/private/mboard.sqlite --apply
```

`--input` and `--db` are required. `--apply` and `--dry-run` conflict. The importer reads a regular private input file (owner-only permissions, normally `0600`) in an owner-only directory (`0700`). Input/destination symlinks are refused. The destination parent must also be private. Successful apply sets the SQLite file to `0600`. SQLite WAL/SHM files are temporary sensitive data too; keep their directory private and back up a stopped database or use a consistent SQLite backup.

Dry-run validates the complete export, reports counts only, and does not create a destination, credentials, or runtime secrets. The schema/SQLite file is created only by explicit apply. A schema-initialized database containing no records and exactly the untouched default settings is also acceptable. Any account, archive, import history, other table row, autoincrement history, or modified setting causes refusal. Duplicate apply is refused; it does not merge, overwrite, append, or rotate existing records.

Account/group insertion, complete archive insertion, provenance, and setup flag changes commit in one immediate transaction. Validation happens before opening a writable destination. The `import_runs` row records the exact input-file SHA-256, import timestamp, counts, and format. Console output contains aggregate counts, never row payloads or credentials. Keep remote shell logs private too.

If validation fails, correct the private export on the source host and rerun dry-run. If apply fails before its transaction commits, the destination can contain an empty initialized schema but no partial import. Check that the destination is fresh before retrying. Never delete an imported database to rerun blindly. To undo a records-first staging before cutover, stop the new service and restore its pre-import backup (or replace its fresh staging database). The old service is unchanged by this importer.

## Admin pending inventory

`GET /api/v1/admin/imports` requires an enabled logged-in administrator. Unauthenticated requests receive `401`; ordinary accounts receive `403`. It uses the normal API envelope:

```json
{
  "data": {
    "summary": { "users": 46, "nodes": 28, "machines": 21, "groups": 3, "imported_at": "2026-01-01T00:00:00.000Z" },
    "nodes": [{ "id": 30, "name": "Legacy node", "protocol": "vless", "host": "edge.example.com", "port": 443, "parent_id": null, "machine_id": 50, "group_ids": [3], "state": "pending", "note": "原配置已经归档。逐台接入后可恢复这个节点。" }],
    "machines": [{ "id": 50, "name": "Machine 50", "state": "pending" }]
  }
}
```

The endpoint builds an explicit display allowlist. It returns no raw payload, password hash, private key, settings, credentials, or old/new token. Non-simple archived port values appear as `null` rather than being coerced into a live listener. Archived bindings/custom routes stay private in `legacy_records`; they are not flattened into live config. Counts refer to the imported source records, even if an administrator later edits live users/groups. No import means zero counts and `imported_at: null`. There is no raw archive API.

Pending records are absent from user node lists, subscription outbounds, and agent runtime configs. The pending inventory has no activation endpoint yet; future enrollment must consciously support the archived protocol and routing semantics.

## Local verification

[Staged migration tests](../tests/backend-staged-migration.test.ts) use synthetic data with the reported source inventory (46 users, 28 nodes, 3 groups, 21 machines, 21 bindings, 5 route profiles, 7 outbound templates, 1 route template) plus an unknown sensitive table. They check exact raw row preservation, IDs/admin/grants/accounting, original bcrypt login, long UTF-8 password compatibility, admin authorization, allowlisted output, pending subscriptions, zero/null quota semantics, epoch expiry, duplicate refusal, unsupported hashes, and private file permissions. Production credentials are not needed for these tests.

```sh
bun test tests/backend-staged-migration.test.ts
bun test tests/backend*.test.ts
bunx tsc --noEmit
```

These tests verify the code and synthetic fixtures. The real remote export still needs its own dry-run counts before apply, followed by an original-password admin login check on the destination host. Node runtime behavior is outside this records-only migration and must be tested for each enrollment.
