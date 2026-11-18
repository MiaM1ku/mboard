import { afterEach, describe, expect, test } from 'bun:test';
import { openDatabase } from '../src/server/database';
import { DOMAIN_RETENTION_SECONDS, initializeDomainTraffic, listDomainTraffic, purgeUserDomainTraffic, recordDomainTraffic, topDomainByUser, validateDomainTrafficBatch } from '../src/server/domain-traffic';

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
const now = new Date('2026-11-11T04:30:00Z');
const hour = Math.floor(now.getTime() / 3600000) * 3600;

function fixture() {
  const db = openDatabase(); dbs.push(db);
  for (const id of [1, 2]) db.query('INSERT INTO users(id,email,name,role,password_hash,credential,subscription_token,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id, `u${id}@example.test`, `U${id}`, 'user', 'x', `c${id}`, `t${id}`, '2026-01-01T00:00:00Z');
  initializeDomainTraffic(db);
  return db;
}
const rec = (patch: Record<string, any> = {}) => ({ user_id: 1, node_id: 10, hour, domain: 'example.com', upload_bytes: 100, download_bytes: 900, ...patch });
const record = (db: any, records: any[], batch = 'b1') => recordDomainTraffic(db, { source: 'runtime', machine_id: 2, batch_id: batch, records, now, allowed_nodes: new Set([10]) });

describe('domain traffic validation', () => {
  test('normalizes domains and rejects malformed input', () => {
    expect(validateDomainTrafficBatch({ batch_id: 'a', records: [rec({ domain: ' Example.COM ' })] }).records[0]!.domain).toBe('example.com');
    for (const bad of [{ domain: '' }, { domain: 'a b.com' }, { upload_bytes: 0, download_bytes: 0 }, { upload_bytes: -1 }, { hour: hour + 1 }, { user_id: 0 }, { extra: 1 }])
      expect(() => validateDomainTrafficBatch({ batch_id: 'a', records: [rec(bad)] })).toThrow();
    expect(() => validateDomainTrafficBatch({ batch_id: 'bad id', records: [rec()] })).toThrow();
    expect(() => validateDomainTrafficBatch({ batch_id: 'a', records: [] })).toThrow();
  });
});

describe('domain traffic storage', () => {
  test('merges rows, ignores replays and skips foreign records', () => {
    const db = fixture();
    expect(record(db, [rec(), rec({ upload_bytes: 1, download_bytes: 2 })])).toMatchObject({ stored: 2, skipped: 0, reused: false });
    expect(record(db, [rec()])).toMatchObject({ reused: true, stored: 0 });
    const result = record(db, [rec({ node_id: 99 }), rec({ user_id: 9 }), rec({ hour: hour - DOMAIN_RETENTION_SECONDS - 3600 })], 'b2');
    expect(result).toMatchObject({ stored: 0, skipped: 3 });
    const row = db.query('SELECT upload_bytes,download_bytes FROM domain_traffic').get() as any;
    expect(row).toEqual({ upload_bytes: 101, download_bytes: 902 });
  });
  test('lists by domain with filters and purges a deleted user', () => {
    const db = fixture();
    record(db, [rec(), rec({ domain: 'video.test', upload_bytes: 10, download_bytes: 5000 }), rec({ user_id: 2, upload_bytes: 5, download_bytes: 5 })]);
    const page = listDomainTraffic(db, {}, now);
    expect(page.rows.map(r => r.domain)).toEqual(['video.test', 'example.com']);
    expect(page.rows[1]).toMatchObject({ upload_bytes: 105, download_bytes: 905, users: 2 });
    expect(listDomainTraffic(db, { user_id: 2 }, now).rows).toHaveLength(1);
    expect(listDomainTraffic(db, { query: 'VID' }, now).rows.map(r => r.domain)).toEqual(['video.test']);
    expect(listDomainTraffic(db, { query: '%' }, now).rows).toHaveLength(0);
    purgeUserDomainTraffic(db, 2);
    expect(listDomainTraffic(db, { user_id: 2 }, now).rows).toHaveLength(0);
  });
  test('top domain per user respects the window and breaks ties by name', () => {
    const db = fixture();
    record(db, [rec({ domain: 'b.test', upload_bytes: 5, download_bytes: 5 }), rec({ domain: 'a.test', upload_bytes: 5, download_bytes: 5 }), rec({ hour: hour - 7200, domain: 'old.test', upload_bytes: 9999, download_bytes: 0 })]);
    const top = topDomainByUser(db, [1, 2], hour, hour + 3599);
    expect(top.get(1)).toEqual({ domain: 'a.test', bytes: 10n });
    expect(top.has(2)).toBe(false);
  });
});
