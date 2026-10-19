import { Database } from 'bun:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const existed = path === ':memory:' || existsSync(path);
  const db = new Database(path, { create: true, strict: true });
  if (!existed) chmodSync(path, 0o600);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;`);
  // Numbered, transactionally applied schema migrations. No fixtures or default accounts.
  const version = (db.query('PRAGMA user_version').get() as any).user_version;
  if (version > 4) throw new Error('Database schema is newer than this server');
  if (version < 1) db.transaction(() => {
    if ((db.query('PRAGMA user_version').get() as any).user_version >= 1) return;
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','user')) DEFAULT 'user',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), password_hash TEXT NOT NULL,
        credential TEXT NOT NULL UNIQUE, subscription_token TEXT NOT NULL UNIQUE,
        upload_bytes INTEGER NOT NULL DEFAULT 0, download_bytes INTEGER NOT NULL DEFAULT 0,
        quota_bytes INTEGER NOT NULL DEFAULT 0, expires_at TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
      CREATE INDEX sessions_user ON sessions(user_id);
      CREATE TABLE groups (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
      CREATE TABLE user_groups (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT, PRIMARY KEY(user_id,group_id));
      CREATE TABLE machines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, token_hash TEXT NOT NULL UNIQUE, last_seen_at TEXT, version TEXT, config_revision INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE nodes (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, host TEXT NOT NULL, port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535), protocol TEXT NOT NULL CHECK(protocol IN ('vless','trojan','shadowsocks')), enabled INTEGER NOT NULL DEFAULT 1, machine_id INTEGER REFERENCES machines(id) ON DELETE RESTRICT, tls INTEGER NOT NULL DEFAULT 1, server_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, UNIQUE(machine_id,port));
      CREATE TABLE node_groups (node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE, group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT, PRIMARY KEY(node_id,group_id));
      CREATE TABLE notices (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE guides (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, body TEXT NOT NULL, category TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE tickets (id INTEGER PRIMARY KEY AUTOINCREMENT, subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')), user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, body TEXT NOT NULL, author_role TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE traffic_batches (machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE, batch_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(machine_id,batch_id));
      CREATE TABLE traffic_daily (user_id INTEGER NOT NULL, date TEXT NOT NULL, upload_bytes INTEGER NOT NULL DEFAULT 0, download_bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(user_id,date));
      CREATE TABLE audit (id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO settings VALUES ('site_name','mboard'),('site_description','欢迎使用您的连接面板'),('setup_complete','0');
      PRAGMA user_version=1;
    `);
  }).immediate();
  if (version < 2) db.transaction(() => {
    if ((db.query('PRAGMA user_version').get() as any).user_version >= 2) return;
    db.exec(`
      CREATE TABLE legacy_records (
        kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(kind,id)
      );
      CREATE TABLE import_runs (
        id TEXT PRIMARY KEY, format TEXT NOT NULL, archive_sha256 TEXT NOT NULL,
        summary TEXT NOT NULL, created_at TEXT NOT NULL
      );
      PRAGMA user_version=2;
    `);
  }).immediate();
  if (version < 3) db.transaction(() => {
    if ((db.query('PRAGMA user_version').get() as any).user_version >= 3) return;
    if (!db.query("SELECT 1 FROM pragma_table_info('nodes') WHERE name='entry_ips'").get()) db.exec(`ALTER TABLE nodes ADD COLUMN entry_ips TEXT NOT NULL DEFAULT '[]'`);
    db.exec(`PRAGMA user_version=3`);
  }).immediate();
  if (version < 4) db.transaction(() => {
    if ((db.query('PRAGMA user_version').get() as any).user_version >= 4) return;
    if (!db.query("SELECT 1 FROM pragma_table_info('nodes') WHERE name='entry_strategy'").get()) db.exec(`ALTER TABLE nodes ADD COLUMN entry_strategy TEXT NOT NULL DEFAULT 'round-robin'`);
    db.exec(`PRAGMA user_version=4`);
  }).immediate();
  return db;
}
export const secret = () => crypto.randomUUID().replaceAll('-', '') + crypto.randomUUID().replaceAll('-', '');
export const hash = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
