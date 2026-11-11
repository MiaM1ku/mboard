import type { Database } from 'bun:sqlite';

// Housekeeping for the two unbounded ledgers a panel accumulates: the per-machine
// traffic batch idempotency ledger and the legacy basic-track ledger. Both only
// need to cover a node replaying a batch it could not confirm, so a bounded
// window keeps idempotency while the file stops growing forever.
// Everything here is additive and independent of the numbered schema migrations.
type Row = Record<string, any>;
const get = (db: Database, sql: string, ...args: any[]) => db.query(sql).get(...args) as Row | null;
const INTERVAL_SECONDS = 3600;
// A node confirms and deletes each batch within seconds of the acknowledgment.
// Thirty days covers a long outage and a spool replay with a wide margin.
export const TRAFFIC_LEDGER_RETENTION_DAYS = 30;
const state = new WeakSet<Database>();

function ensureState(db: Database) {
  if (state.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS panel_maintenance(id INTEGER PRIMARY KEY CHECK(id=1),ran_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS runtime_traffic_batches_created ON runtime_traffic_batches(created_at);
CREATE INDEX IF NOT EXISTS traffic_batches_created ON traffic_batches(created_at);`);
  state.add(db);
}

/** One hourly pass at most. Call outside the caller's transaction: the delete is bounded but not free. */
export function maintainPanel(db: Database, now: Date, intervalSeconds = INTERVAL_SECONDS) {
  ensureState(db);
  const stamp = Math.floor(now.getTime() / 1000);
  const prior = get(db, 'SELECT ran_at FROM panel_maintenance WHERE id=1');
  if (prior && stamp - Number(prior.ran_at) < intervalSeconds) return;
  const cutoff = new Date(now.getTime() - TRAFFIC_LEDGER_RETENTION_DAYS * 86400000).toISOString();
  db.transaction(() => {
    // Re-check inside the transaction: two concurrent requests may both pass.
    const current = get(db, 'SELECT ran_at FROM panel_maintenance WHERE id=1');
    if (current && stamp - Number(current.ran_at) < intervalSeconds) return;
    db.query('DELETE FROM runtime_traffic_batches WHERE created_at < ?').run(cutoff);
    db.query('DELETE FROM traffic_batches WHERE created_at < ?').run(cutoff);
    db.query('INSERT INTO panel_maintenance(id,ran_at) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET ran_at=excluded.ran_at').run(stamp);
  }).immediate();
}
