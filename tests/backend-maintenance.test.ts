import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../src/server/app';
import { hash } from '../src/server/database';
import { maintainPanel, TRAFFIC_LEDGER_RETENTION_DAYS } from '../src/server/maintenance';

// Synthetic rows only. Every app owns its own in-memory database and closes after the test.
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { for (const app of apps.splice(0)) app.close(); });

function fixture() {
  const clock = { at: new Date('2026-11-11T10:00:00Z') };
  const token = 'f'.repeat(64);
  const app = createApp({ now: () => clock.at, publicOrigin: 'https://panel.example.test' });
  apps.push(app);
  const db = app.db;
  db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,created_at) VALUES(?,?,?,?,?,?,?,?)').run(2, 'admin@example.test', 'Admin', 'admin', 'synthetic', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b'.repeat(64), '2026-01-01T00:00:00.000Z');
  db.query('INSERT INTO sessions VALUES(?,?,?)').run(hash('d'.repeat(64)), 2, '2099-01-01T00:00:00.000Z');
  db.query('INSERT INTO runtime_machines(id,state,active,token_hash,core_ready,telemetry_ready,core_version,payload) VALUES(?,?,?,?,?,?,?,?)').run(2, 'active', 1, hash(token), 1, 1, '1.14', JSON.stringify({ id: 2, name: 'HK IX', host: 'hk.example.test' }));
  db.query('INSERT INTO runtime_nodes VALUES(?,?,?,?,?,?)').run(10, null, 'vless', 1, 1, JSON.stringify({ id: 10, name: 'HK Reality', parent_id: 0, host: 'hk.example.test', port: 443, server_port: 443, type: 'vless', enabled: 1, show: 1, group_ids: [1], created_at: '1700000000' }));
  db.query('INSERT INTO runtime_bindings VALUES(?,?,?)').run(2, 10, '{}');
  // The traffic route authorizes the record against the user's groups.
  db.exec("INSERT INTO groups(id,name) VALUES(1,'Shared'); INSERT INTO user_groups VALUES(2,1);");
  const ledger = (batch: string, createdAt: string) => db.query('INSERT INTO runtime_traffic_batches(machine_id,batch_id,created_at) VALUES(?,?,?)').run(2, batch, createdAt);
  const adminCookie = `mboard_session=${'d'.repeat(64)}`;
  return { app, db, clock, token, ledger, adminCookie };
}

const daysAgo = (days: number) => new Date(Date.parse('2026-11-11T10:00:00Z') - days * 86400000).toISOString();

describe('panel maintenance', () => {
  test('prunes ledger rows past the retention window and keeps recent ones', () => {
    const f = fixture();
    f.ledger('old-1', daysAgo(TRAFFIC_LEDGER_RETENTION_DAYS + 5));
    f.ledger('old-2', daysAgo(TRAFFIC_LEDGER_RETENTION_DAYS + 1));
    f.ledger('keep-1', daysAgo(TRAFFIC_LEDGER_RETENTION_DAYS - 1));
    f.ledger('keep-2', daysAgo(0));
    // The app already ran a pass at startup; move the clock past the interval.
    f.clock.at = new Date('2026-11-11T12:00:00Z');
    maintainPanel(f.db, f.clock.at);
    const batches = (f.db.query('SELECT batch_id FROM runtime_traffic_batches ORDER BY batch_id').all() as { batch_id: string }[]).map(row => row.batch_id);
    expect(batches).toEqual(['keep-1', 'keep-2']);
  });

  test('runs at most once per interval between traffic batches', () => {
    const f = fixture();
    f.clock.at = new Date('2026-11-11T12:00:00Z');
    maintainPanel(f.db, f.clock.at);
    f.ledger('late-arrival', daysAgo(TRAFFIC_LEDGER_RETENTION_DAYS + 30));
    // Ten minutes later the hourly guard still holds the row in place.
    maintainPanel(f.db, new Date(f.clock.at.getTime() + 10 * 60000));
    expect((f.db.query('SELECT count(*) count FROM runtime_traffic_batches').get() as { count: number }).count).toBe(1);
    // The next hour prunes it.
    maintainPanel(f.db, new Date(f.clock.at.getTime() + 61 * 60000));
    expect((f.db.query('SELECT count(*) count FROM runtime_traffic_batches').get() as { count: number }).count).toBe(0);
  });

  test('a traffic batch is still acknowledged once the ledger pruned old rows', async () => {
    const f = fixture();
    f.clock.at = new Date('2026-11-11T12:30:00Z');
    const response = await f.app.fetch(new Request('https://panel.example.test/api/node/v1/traffic', {
      method: 'POST',
      headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json', host: 'panel.example.test' },
      body: JSON.stringify({ batch_id: 'fresh', records: [{ user_id: 2, node_id: 10, upload_bytes: 1, download_bytes: 2 }] }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { accepted: true } });
    expect((f.db.query('SELECT count(*) count FROM runtime_traffic_batches').get() as { count: number }).count).toBe(1);
  });
});
