import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, validateExport } from '../scripts/migrate-xboard';
import { createApp } from '../src/server/app';
import { hash } from '../src/server/database';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const empty = () => ({ users: [], groups: [], nodes: [], machines: [] });
const fixture = () => ({
  users: [{id:10,email:'member@example.com',role:'admin',password_hash:'OLD-HASH',subscription_token:'OLD-TOKEN',credential:'OLD-UUID',group_ids:[3],upload_bytes:100,download_bytes:200,quota_bytes:1000}],
  groups: [{id:3,name:'Standard'}],
  machines: [{id:20,name:'Edge',host:'edge.example.com',token:'OLD-MACHINE'}],
  nodes: [{id:30,name:'VLESS',host:'edge.example.com',port:443,protocol:'vless',tls:true,machine_id:20,group_ids:[3]}],
});
function files(data: unknown = fixture()) {
  const dir = mkdtempSync(join(tmpdir(), 'mboard-migration-test-')); dirs.push(dir);
  const input = join(dir,'input.json'), db = join(dir,'db.sqlite'), credentials = join(dir,'credentials.json');
  writeFileSync(input, JSON.stringify(data));
  return {dir,input,db,credentials,args:['--input',input,'--apply','--db',db,'--credentials-out',credentials]};
}

test('migration normalized validation requires explicit grants and references', () => {
  const p = validateExport(fixture());
  expect(p.users[0]?.group_ids).toEqual([3]);
  expect(p.nodes[0]?.machine_id).toBe(20);
  for (const data of [
    { ...empty(), users:[{id:1,email:'x@example.com',group_ids:[99]}] },
    { ...empty(), users:[{id:1,email:'x@example.com'}] },
    { ...empty(), users:[{id:1,email:'x@example.com',group_id:3,group_ids:[]}] },
    { ...empty(), users:[{id:1,email:'x@example.com',group_ids:[]},{id:2,email:'X@example.com',group_ids:[]}] },
    { ...empty(), users:[{id:1,email:'x@example.com',group_ids:[],upload_bytes:Number.MAX_SAFE_INTEGER,download_bytes:1}] },
    { ...empty(), users:[{id:1,email:'x@example.com',group_ids:[],upload_bytes:Number.MAX_SAFE_INTEGER},{id:2,email:'y@example.com',group_ids:[],download_bytes:1}] },
    { ...empty(), users:[{id:1,email:'x@example.com',group_ids:[],quota_bytes:-1}] },
    { ...empty(), users:[{id:1,email:'x@example.com',group_ids:[],expires_at:'2026-02-31T00:00:00Z'}] },
    { ...empty(), nodes:[{id:1,name:'x',host:'x',port:443,protocol:'vmess',tls:true,machine_id:null,group_ids:[]}] },
    { ...empty(), nodes:[{id:1,name:'x',host:'x',port:443,protocol:'vless',tls:true,machine_id:999,group_ids:[]}] },
    { ...empty(), machines:[{id:1,name:'x',host:'https://example.com'}] },
  ]) expect(() => validateExport(data)).toThrow();
});

test('migration legacy mapping validates units, access gates and unsupported templates', () => {
  const data = {v2_user:[{id:'1',email:'legacy@example.com',banned:'0',access_enabled:1,u:'12',d:23,transfer_enable:1024,expired_at:null,group_id:'2',created_at:1700000000}],v2_server_group:[{id:2,name:'Legacy'}],v2_server_trojan:[{id:3,name:'Trojan',host:'x.example.com',port:'443',show:1,tls:1,machine_id:null,group_ids:'[2]',created_at:1700000000}]};
  const p = validateExport(data);
  expect(p.users[0]).toMatchObject({enabled:true,upload_bytes:12,quota_bytes:1024,created_at:'2023-11-14T22:13:20.000Z'});
  expect(p.nodes[0]?.protocol).toBe('trojan');
  expect(() => validateExport({...data,v2_user:[{...data.v2_user[0],transfer_enable:0}]})).toThrow('unlimited');
  expect(() => validateExport({...data,v2_user:[{...data.v2_user[0],access_enabled:undefined}]})).toThrow('access_enabled');
  expect(() => validateExport({...data,v2_server_trojan:[{...data.v2_server_trojan[0],protocol_settings:{network:'ws'}}]})).toThrow('unsupported configuration');
  expect(() => validateExport({...data,v2_server_trojan:[{...data.v2_server_trojan[0],reality_template_id:1}]})).toThrow('unsupported configuration');
  expect(() => validateExport({...data,v2_server_outbound_template:[{id:1}]})).toThrow('unsupported table');
});

test('migration default dry-run never creates destination or credentials', async () => {
  const f = files();
  await main(['--input',f.input,'--db',f.db,'--credentials-out',f.credentials]);
  expect(existsSync(f.db)).toBe(false); expect(existsSync(f.credentials)).toBe(false);
  await expect(main(['--input',f.input,'--apply','--db',f.db])).rejects.toThrow('--credentials-out');
  await expect(main(['--input',f.input,'--apply','--dry-run','--db',f.db,'--credentials-out',f.credentials])).rejects.toThrow('conflicts');
  expect(existsSync(f.db)).toBe(false);
});

test('migration applies rotated secrets, mode 0600, exact IDs/grants and leaves setup available', async () => {
  const f = files(); await main(f.args);
  const credentials = JSON.parse(readFileSync(f.credentials,'utf8'));
  expect(statSync(f.credentials).mode & 0o777).toBe(0o600);
  const db = new Database(f.db,{readonly:true});
  try {
    const u = db.query('SELECT * FROM users').get() as any, m = db.query('SELECT * FROM machines').get() as any;
    expect(u).toMatchObject({id:10,role:'user',upload_bytes:100,download_bytes:200,quota_bytes:1000});
    expect(u.password_hash).toStartWith('$argon2id$');
    expect(await Bun.password.verify(credentials.users[0].password,u.password_hash)).toBe(true);
    expect(await Bun.password.verify('OLD-HASH',u.password_hash)).toBe(false);
    expect(u.credential).toBe(credentials.users[0].credential); expect(u.credential).not.toBe('OLD-UUID');
    expect(u.subscription_token).toBe(credentials.users[0].subscription_token); expect(u.subscription_token).not.toBe('OLD-TOKEN');
    expect(m).toMatchObject({id:20,token_hash:hash(credentials.machines[0].token),last_seen_at:null,version:null,config_revision:1});
    const secrets = [credentials.users[0].password,u.credential,u.subscription_token,credentials.machines[0].token];
    expect(new Set(secrets).size).toBe(4);
    expect(u.credential).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(u.subscription_token).toMatch(/^[a-f0-9]{64}$/); expect(credentials.machines[0].token).toMatch(/^[a-f0-9]{64}$/);
    expect(db.query('SELECT * FROM user_groups').all()).toEqual([{user_id:10,group_id:3}]);
    expect(db.query('SELECT * FROM node_groups').all()).toEqual([{node_id:30,group_id:3}]);
    expect(db.query("SELECT value FROM settings WHERE key='setup_complete'").get()).toEqual({value:'0'});
  } finally { db.close(); }
  const app = createApp({dbPath:f.db});
  try {
    const status = await app.fetch(new Request('http://local/api/v1/auth/status'));
    expect((await status.json() as any).data.setup_required).toBe(true);
    const config = await app.fetch(new Request('http://local/api/node/v1/config',{headers:{authorization:`Bearer ${credentials.machines[0].token}`}}));
    expect(config.status).toBe(200);
    expect((await config.json() as any).data.config.inbounds[0].users[0].uuid).toBe(credentials.users[0].credential);
    const setup = await app.fetch(new Request('http://local/api/v1/auth/setup',{method:'POST',headers:{origin:'http://local','content-type':'application/json'},body:JSON.stringify({email:'admin@example.com',name:'Admin',password:'secure-setup-password'})}));
    expect(setup.status).toBeLessThan(300);
    expect(app.db.query("SELECT COUNT(*) count FROM users WHERE role='admin'").get()).toEqual({count:1});
  } finally { app.close(); }
});

test('migration refuses nonempty destination without changing revisions or retaining credentials', async () => {
  const f = files(); await main(f.args);
  const before = new Database(f.db,{readonly:true}); const revision = (before.query('SELECT config_revision FROM machines').get() as any).config_revision; before.close();
  const output = join(f.dir,'rejected.json');
  await expect(main(['--input',f.input,'--apply','--db',f.db,'--credentials-out',output])).rejects.toThrow('not empty');
  expect(existsSync(output)).toBe(false);
  const after = new Database(f.db,{readonly:true});
  try { expect(after.query('SELECT config_revision FROM machines').get()).toEqual({config_revision:revision}); expect(after.query('SELECT COUNT(*) count FROM users').get()).toEqual({count:1}); }
  finally { after.close(); }
});

test('migration refuses existing output and symlinks without opening destination', async () => {
  const f = files(); writeFileSync(f.credentials,'DO NOT OVERWRITE');
  await expect(main(f.args)).rejects.toThrow('exclusively create');
  expect(readFileSync(f.credentials,'utf8')).toBe('DO NOT OVERWRITE'); expect(existsSync(f.db)).toBe(false);
  const link = join(f.dir,'symlink.json'); symlinkSync(f.credentials,link);
  await expect(main(['--input',f.input,'--apply','--db',f.db,'--credentials-out',link])).rejects.toThrow('exclusively create');
  expect(readFileSync(f.credentials,'utf8')).toBe('DO NOT OVERWRITE'); expect(existsSync(f.db)).toBe(false);
});

test('migration rejects invalid complete source before writing any destination file', async () => {
  const f = files({...empty(),users:[{id:1,email:'bad@example.com',group_ids:[999]}]});
  await expect(main(f.args)).rejects.toThrow('unknown group');
  expect(existsSync(f.db)).toBe(false); expect(existsSync(f.credentials)).toBe(false);
});
