import { afterEach, describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { request as realHTTPSRequest } from 'node:https';
import { main as cliMain } from '../scripts/traffic-reports';
import { openDatabase } from '../src/server/database';
import { buildPreview, enqueueReport, formatReportBytes, getReportSettings, getReportRun, initializeTrafficReports, isPublicReportAddress, listReportRuns, pinnedReportTransport, recordReportTraffic, ReportError, reportPeriod, runReportWorker, saveReportSettings, tickReportSchedule, validateReportURL, type ReportTransportInput } from '../src/server/traffic-reports';

const dbs: ReturnType<typeof openDatabase>[]=[];
const tempDirs:string[]=[];
const temporary=()=>{const path=mkdtempSync(join(tmpdir(),'mboard-reports-'));tempDirs.push(path);return path;};
afterEach(()=>{for(const db of dbs.splice(0))db.close();for(const path of tempDirs.splice(0))rmSync(path,{recursive:true,force:true});});
const seedAt=new Date('2026-10-13T12:00:00+08:00'), reportAt=new Date('2026-10-14T00:00:00+08:00');
function archive(db: ReturnType<typeof openDatabase>,kind:string,id:string,payload:unknown) {db.query('INSERT INTO legacy_records VALUES(?,?,?,?)').run(kind,id,JSON.stringify(payload),seedAt.toISOString());}
function fixture(options:{plugin?:any;baseline?:boolean;seed?:Date}={}) {
  const db=openDatabase();dbs.push(db);
  archive(db,'v2_plugins','1',options.plugin??{code:'traffic_report',is_enabled:'1',config:{webhook_url:'https://report.example.invalid/hook?token=secret-value',authorization_header:'EXACT token-value',top_limit:5}});
  archive(db,'v2_server','190',{id:190,name:'Root *[190]',parent_id:0});
  archive(db,'v2_server','191',{id:191,name:'Child 191',parent_id:190});
  archive(db,'v2_server_route_profile','1',{id:1,uuid:'profile-uuid',server_id:190,name:'Exit _[one]'});
  archive(db,'v2_user','1',{id:1,email:'u_*[1]@example.invalid'});
  if(options.baseline) {
    db.query('INSERT INTO traffic_daily VALUES(?,?,?,?)').run(1,'2026-10-13',100,20);
    db.exec('CREATE TABLE runtime_node_traffic(node_id INTEGER,user_id INTEGER,date TEXT,upload_bytes INTEGER,download_bytes INTEGER)');
    db.query('INSERT INTO runtime_node_traffic VALUES(?,?,?,?,?)').run(190,1,'2026-10-13',100,20);
  }
  initializeTrafficReports(db,{now:options.seed??seedAt});return db;
}
const resolver=async()=>[{address:'8.8.8.8',family:4}];
const transport=async(_input:ReportTransportInput)=>({status:204});
const traffic=(db:ReturnType<typeof openDatabase>,up:number|bigint,profile='',at='2026-10-13T20:00:00+08:00',node=190)=>recordReportTraffic(db,{source:'runtime',user_id:1,node_id:node,profile_id:profile,upload_bytes:up,download_bytes:0,accepted_at:new Date(at)});

describe('TrafficReport migration settings',()=>{
  test('seeds config without DNS, preserves exact source, redacts secrets and reseed preserves edits',()=>{
    const db=fixture(),raw=db.query('SELECT legacy_snapshot FROM traffic_report_seed').get() as any;
    expect(JSON.parse(raw.legacy_snapshot).plugin.config.authorization_header).toBe('EXACT token-value');
    const dto=getReportSettings(db);expect(dto.url_display).toBe('report.example.invalid');expect(dto.top_limit).toBe(5);expect(dto.enabled).toBe(true);
    expect(JSON.stringify(dto)).not.toContain('secret-value');expect(JSON.stringify(dto)).not.toContain('token-value');
    saveReportSettings(db,{enabled:false,top_limit:9,authorization_header:' Edited EXACT '});
    initializeTrafficReports(db,{now:reportAt});expect(getReportSettings(db).top_limit).toBe(9);expect(getReportSettings(db).enabled).toBe(false);
    expect((db.query('SELECT authorization_header FROM traffic_report_settings').get() as any).authorization_header).toBe(' Edited EXACT ');
    expect((db.query('SELECT legacy_snapshot FROM traffic_report_seed').get() as any).legacy_snapshot).toBe(raw.legacy_snapshot);
  });
  test('daily-only fallbacks match PHP; weekly fallback fields are ignored',()=>{
    const db=openDatabase();dbs.push(db);
    archive(db,'v2_plugins','1',{code:'traffic_report',is_enabled:'1',config:JSON.stringify({webhook_url:'',authorization_header:null})});
    archive(db,'v2_settings','1',{name:'daily_report_url',value:'https://daily.example.invalid/secret'});
    archive(db,'v2_settings','2',{name:'daily_report_header_authorization',value:'literal Authorization'});
    archive(db,'v2_settings','3',{name:'weekly_report_url',value:'https://wrong.example.invalid'});
    initializeTrafficReports(db,{now:seedAt});expect(getReportSettings(db).url_display).toBe('daily.example.invalid');
    expect((db.query('SELECT authorization_header FROM traffic_report_settings').get() as any).authorization_header).toBe('literal Authorization');
  });
  test('disabled legacy plugin cannot turn timer on, invalid source keeps exact snapshot',()=>{
    const db=fixture({plugin:{code:'traffic_report',is_enabled:'0',config:{webhook_url:'https://ignored.invalid'}}});expect(getReportSettings(db).enabled).toBe(false);expect(getReportSettings(db).webhook_configured).toBe(false);
    const bad=fixture({plugin:{code:'traffic_report',is_enabled:'1',config:{webhook_url:'https://@bad.invalid',authorization_header:'secret\r\n'}}});expect(getReportSettings(bad).enabled).toBe(false);expect(getReportSettings(bad).webhook_configured).toBe(false);
    expect((bad.query('SELECT legacy_snapshot FROM traffic_report_seed').get() as any).legacy_snapshot).toContain('https://@bad.invalid');
  });
  test('PATCH omission and null skip auth; empty clears; top-limit and unknown fields strict',()=>{
    const db=fixture();saveReportSettings(db,{authorization_header:null});expect(getReportSettings(db).authorization_configured).toBe(true);
    saveReportSettings(db,{authorization_header:'',webhook_url:null});expect(getReportSettings(db).authorization_configured).toBe(false);expect(getReportSettings(db).webhook_configured).toBe(false);
    for(const patch of [{top_limit:0},{top_limit:101},{top_limit:1.1},{top_limit:'5'},{enabled:1},{timezone:'UTC'},{allowPrivate:true},{authorization_header:'x\nsecret'},{authorization_header:'x'.repeat(4097)}]) expect(()=>saveReportSettings(db,patch as any)).toThrow('INVALID_CONFIG');
    saveReportSettings(db,{top_limit:100});expect(getReportSettings(db).top_limit).toBe(100);
  });
});

describe('calendar windows and ledger',()=>{
  test('Shanghai yesterday, seven days ending yesterday, previous calendar month including Jan31 edge/leap',()=>{
    expect(reportPeriod('daily',new Date('2026-10-13T16:00:00Z')).start_date).toBe('2026-10-13');
    const weekly=reportPeriod('weekly',new Date('2026-10-18T00:00:00+08:00'));expect([weekly.start_date,weekly.end_date]).toEqual(['2026-10-11','2026-10-17']);
    expect([reportPeriod('monthly',new Date('2026-03-31T00:00:00+08:00')).start_date,reportPeriod('monthly',new Date('2026-03-31T00:00:00+08:00')).end_date]).toEqual(['2026-02-01','2026-02-28']);
    expect(reportPeriod('monthly',new Date('2024-03-31T00:00:00+08:00')).end_date).toBe('2024-02-29');
    expect(reportPeriod('monthly',new Date('2026-01-31T00:00:00+08:00')).start_date).toBe('2025-12-01');
  });
  test('BigInt per row, exact rank past JS/SQLite sum limits, 2TiB and trim rounding',()=>{
    const db=fixture();traffic(db,9223372036854775807n);traffic(db,9223372036854775807n);traffic(db,9223372036854775807n+1n,'profile-uuid');
    const preview=buildPreview(db,'daily',reportAt);expect(preview.nodes[0]!.bytes).toBe('18446744073709551614');expect(preview.users[0]!.bytes).toBe('27670116110564327422');
    expect(formatReportBytes(2n*1024n**4n)).toBe('2 TB');expect(formatReportBytes(1536n)).toBe('1.5 KB');expect(formatReportBytes(0n)).toBe('0 B');
  });
  test('old profile subset subtracts immediate physical root exactly once; billed user total stays separate',()=>{
    const db=fixture(),stamp=reportPeriod('daily',reportAt).source_start;
    archive(db,'v2_stat_server','s',{server_id:190,record_type:'d',record_at:stamp,u:'1000',d:'0'});
    archive(db,'v2_stat_user','u',{user_id:1,record_type:'d',record_at:stamp,u:'500',d:'0'});
    archive(db,'v2_user_node_traffic','r',{user_id:1,server_id:190,record_type:'d',record_at:stamp,profile_uuid:'',u:'1000',d:'0'});
    archive(db,'v2_user_node_traffic','p',{user_id:1,server_id:191,route_profile_id:1,record_type:'d',record_at:stamp,profile_uuid:'profile-uuid',u:'300',d:'0'});
    const p=buildPreview(db,'daily',reportAt);expect(p.nodes.map(n=>n.bytes)).toEqual(['700','300']);expect(p.users[0]!.bytes).toBe('500');expect(p.users[0]!.topNode!.bytes).toBe('700');
    expect(p.message).toContain('Root \\*\\[190\\]');expect(p.message).toContain('u\\_\\*\\[1\\]@example.invalid');expect(p.message).toContain('最高节点');
  });
  test('legacy numeric JSON integers are extracted exactly rather than rounded by JSON.parse',()=>{
    const db=fixture(),stamp=reportPeriod('daily',reportAt).source_start;
    db.query('INSERT INTO legacy_records VALUES(?,?,?,?)').run('v2_stat_server','numeric',`{"server_id":190,"record_type":"d","record_at":${stamp},"u":9007199254740993,"d":2}`,seedAt.toISOString());
    expect(buildPreview(db,'daily',reportAt).nodes[0]!.bytes).toBe('9007199254740995');
  });
  test('UTC pre-hook baseline snapshot plus post-hook partitions preserve all volume without re-reading live daily counters',()=>{
    const db=fixture({baseline:true});traffic(db,60,'profile-uuid');traffic(db,40);
    db.query('UPDATE traffic_daily SET upload_bytes=9999').run();initializeTrafficReports(db,{now:reportAt});
    const p=buildPreview(db,'daily',reportAt);expect(p.users[0]!.bytes).toBe('220');expect(p.nodes.map(n=>n.bytes)).toEqual(['160','60']);
    expect(p.warnings).toContain('missing-history-boundary_warning');expect(p.warnings).toContain('intersecting-utc-day-included-whole');expect(p.warnings).toContain('pre-upgrade-profiles-merged-into-entry-node');expect(p.warnings).toContain('baseline_rows:users=1,node_users=1');expect(p.warnings).toContain('baseline_utc_dates:2026-10-13');expect(p.warnings).toContain('utc-day-attributed-to-same-calendar-label');
    expect(buildPreview(db,'daily',new Date('2026-10-15T00:00:00+08:00')).users).toEqual([]);
  });
  test('new hourly Shanghai boundaries exclude next day; root and exit already partitioned',()=>{
    const db=fixture();traffic(db,10,'','2026-10-12T23:59:59+08:00');traffic(db,20,'','2026-10-13T00:00:00+08:00');traffic(db,30,'profile-uuid','2026-10-13T23:59:59+08:00');traffic(db,40,'','2026-10-14T00:00:00+08:00');
    const p=buildPreview(db,'daily',reportAt);expect(p.nodes.map(n=>n.bytes)).toEqual(['30','20']);expect(p.users[0]!.bytes).toBe('50');
    const rollback=()=>db.transaction(()=>{traffic(db,500);throw new Error('rollback');}).immediate();expect(rollback).toThrow('rollback');expect(buildPreview(db,'daily',reportAt).users[0]!.bytes).toBe('50');
  });
  test('basic and runtime nodes with identical IDs retain separate ranking labels and totals',()=>{
    const db=fixture();db.query('INSERT INTO nodes(id,name,host,port,protocol,created_at) VALUES(?,?,?,?,?,?)').run(190,'Basic 190','basic.example.invalid',443,'shadowsocks',seedAt.toISOString());
    traffic(db,30);recordReportTraffic(db,{source:'basic',user_id:1,node_id:190,upload_bytes:20,download_bytes:0,accepted_at:new Date('2026-10-13T20:00:00+08:00')});
    const p=buildPreview(db,'daily',reportAt);expect(p.nodes).toEqual([{label:'Root *[190]',bytes:'30'},{label:'Basic 190',bytes:'20'}]);expect(p.users[0]!.bytes).toBe('50');expect(p.users[0]!.topNode!.label).toBe('Root *[190]');
  });
  test('invalid ledger inputs reject without echoing data; empty/test messages positive and synthetic',()=>{
    const db=fixture();expect(()=>traffic(db,-1)).toThrow('INVALID_CONFIG');expect(()=>traffic(db,Number.MAX_SAFE_INTEGER+1)).toThrow('INVALID_CONFIG');expect(()=>traffic(db,1,'profile\nsecret')).toThrow('INVALID_CONFIG');
    expect(buildPreview(db,'daily',reportAt).message).toContain('等待本周期流量记录');const p=buildPreview(db,'test',reportAt);expect(p.message).toContain('真实发送');expect(p.users).toEqual([]);expect(p.message).not.toContain('@');
  });
});

describe('calendar scheduling and persistent outbox',()=>{
  test('startup does not backfill; following midnight only creates daily once',()=>{
    const db=fixture();expect(tickReportSchedule(db,seedAt)).toEqual([]);expect(listReportRuns(db)).toEqual([]);
    expect(tickReportSchedule(db,reportAt).map(j=>j.kind)).toEqual(['daily']);expect(tickReportSchedule(db,new Date(reportAt.getTime()+60000))).toEqual([]);expect(listReportRuns(db).length).toBe(1);
  });
  test('Sunday first-of-month creates daily/weekly/monthly, no missed-day catchup spam',()=>{
    const db=fixture({seed:new Date('2026-10-31T12:00:00+08:00')});expect(tickReportSchedule(db,new Date('2026-11-01T00:01:00+08:00')).map(j=>j.kind)).toEqual(['daily','weekly','monthly']);
    expect(tickReportSchedule(db,new Date('2026-11-04T00:00:00+08:00'))).toEqual([]);
    const late=fixture();expect(tickReportSchedule(late,new Date('2026-10-14T00:03:00+08:00'))).toEqual([]);
  });
  test('scheduled unique period; manual distinct unless request id repeats; message snapshot immutable',()=>{
    const db=fixture();traffic(db,10);const a=enqueueReport(db,'daily',reportAt)!,b=enqueueReport(db,'daily',reportAt)!;expect(a.id).toBe(b.id);
    const m=enqueueReport(db,'daily',reportAt,{manual:true,idempotencyKey:'request-1'})!;expect(enqueueReport(db,'daily',reportAt,{manual:true,idempotencyKey:'request-1'})!.id).toBe(m.id);
    expect(enqueueReport(db,'daily',reportAt,{manual:true})!.id).not.toBe(m.id);expect(()=>enqueueReport(db,'weekly',reportAt,{manual:true,idempotencyKey:'request-1'})).toThrow('INVALID_CONFIG');
    traffic(db,900);expect((db.query('SELECT message FROM traffic_report_runs WHERE id=?').get(a.id) as any).message).toContain('10 B');
    expect(JSON.stringify(listReportRuns(db))).not.toContain('message');expect(JSON.stringify(listReportRuns(db))).not.toContain('@');expect(JSON.stringify(listReportRuns(db))).not.toContain('secret-value');
  });
  test('revision cancels stale queued jobs; disabled allows explicit manual/test only',async()=>{
    const db=fixture(),job=enqueueReport(db,'daily',reportAt)!;saveReportSettings(db,{enabled:false});expect(getReportRun(db,job.id)!.status).toBe('cancelled');expect(enqueueReport(db,'daily',reportAt)).toBeNull();
    const testJob=enqueueReport(db,'test',reportAt)!;await runReportWorker(db,{now:reportAt,resolve:resolver,transport});expect(getReportRun(db,testJob.id)!.status).toBe('sent');
  });
  test('attempts max3 exponential delay and HTTP-only diagnostics, exact Authorization/delivery id',async()=>{
    const db=fixture(),job=enqueueReport(db,'test',reportAt)!,calls:ReportTransportInput[]=[];
    const bad=async(i:ReportTransportInput)=>{calls.push(i);return {status:503};};
    await runReportWorker(db,{now:reportAt,resolve:resolver,transport:bad});expect(getReportRun(db,job.id)!.next_attempt_at).toBe(reportAt.getTime()+60000);
    expect(await runReportWorker(db,{now:new Date(reportAt.getTime()+59000),resolve:resolver,transport:bad})).toEqual([]);
    await runReportWorker(db,{now:new Date(reportAt.getTime()+60000),resolve:resolver,transport:bad});expect(getReportRun(db,job.id)!.next_attempt_at).toBe(reportAt.getTime()+180000);
    await runReportWorker(db,{now:new Date(reportAt.getTime()+180000),resolve:resolver,transport:bad});expect(getReportRun(db,job.id)!.status).toBe('failed');expect(calls.length).toBe(3);
    expect(calls[0]!.headers.Authorization).toBe('EXACT token-value');expect(new Set(calls.map(c=>c.headers['X-Mboard-Delivery-ID'])).size).toBe(1);expect(calls[0]!.headers['X-Mboard-Delivery-ID']).toBe(job.id);expect(Object.keys(JSON.parse(calls[0]!.body))).toEqual(['message']);
    expect(getReportRun(db,job.id)!.http_status).toBe(503);expect(getReportRun(db,job.id)!.error_code).toBe('HTTP_ERROR');
  });
  test('claims atomic and transaction released while transport awaits; concurrent worker sends once',async()=>{
    const db=fixture(),job=enqueueReport(db,'test',reportAt)!;let release!:()=>void,entered!:()=>void;
    const barrier=new Promise<void>(r=>{release=r;}),started=new Promise<void>(r=>{entered=r;});
    const first=runReportWorker(db,{now:reportAt,resolve:resolver,transport:async()=>{expect(db.inTransaction).toBe(false);entered();await barrier;return {status:200};}});
    await started;expect(getReportRun(db,job.id)!.status).toBe('processing');expect(await runReportWorker(db,{now:reportAt,resolve:resolver,transport})).toEqual([]);release();await first;expect(getReportRun(db,job.id)!.attempts).toBe(1);
  });
  test('crashed lease reclaimed, attempts capped, no payload/status exposure',async()=>{
    const db=fixture(),job=enqueueReport(db,'test',reportAt)!;
    db.query("UPDATE traffic_report_runs SET status='processing',attempts=1,lease_token='crashed',lease_expires_at=? WHERE id=?").run(reportAt.getTime()-1,job.id);
    await runReportWorker(db,{now:reportAt,resolve:resolver,transport});expect(getReportRun(db,job.id)!.status).toBe('sent');expect(getReportRun(db,job.id)!.attempts).toBe(2);
    const capped=enqueueReport(db,'test',reportAt)!;db.query("UPDATE traffic_report_runs SET status='processing',attempts=3,lease_expires_at=? WHERE id=?").run(reportAt.getTime()-1,capped.id);await runReportWorker(db,{now:reportAt,resolve:resolver,transport});expect(getReportRun(db,capped.id)!.status).toBe('failed');
  });
  test('PATCH during DNS await prevents old-url send; oversized outbox message cannot post',async()=>{
    const db=fixture(),job=enqueueReport(db,'test',reportAt)!;let calls=0;
    await runReportWorker(db,{now:reportAt,resolve:async()=>{saveReportSettings(db,{webhook_url:'https://new.example.invalid'});return resolver();},transport:async()=>{calls++;return {status:200};}});expect(calls).toBe(0);expect(getReportRun(db,job.id)!.status).toBe('cancelled');
    const large=enqueueReport(db,'test',reportAt)!;db.query('UPDATE traffic_report_runs SET message=? WHERE id=?').run('x'.repeat(256*1024),large.id);await runReportWorker(db,{now:reportAt,resolve:resolver,transport:async()=>{calls++;return {status:200};}});expect(calls).toBe(0);expect(getReportRun(db,large.id)!.error_code).toBe('INVALID_CONFIG');
  });
});

describe('private operator CLI',()=>{
  test('private absolute regular database only, safe summary and fixed one-test key',async()=>{
    const db=fixture(),dir=temporary(),path=join(dir,'mboard.sqlite');writeFileSync(path,db.serialize(),{mode:0o600});
    expect((await cliMain(['--db',path,'--settings']) as any).url_display).toBe('report.example.invalid');
    const p=await cliMain(['--db',path,'--preview','daily']);expect(JSON.stringify(p)).not.toContain('@');expect(JSON.stringify(p)).not.toContain('message');
    await expect(cliMain(['--db',path,'--enqueue','test','--manual','--request-id','anything'])).rejects.toThrow('INVALID_CONFIG');
    const a=await cliMain(['--db',path,'--enqueue','test','--manual','--request-id','first','--allow-real-migration-test']) as any;
    const b=await cliMain(['--db',path,'--enqueue','test','--manual','--request-id','second','--allow-real-migration-test']) as any;expect(a.id).toBe(b.id);expect(a.status).toBe('queued');
    const list=await cliMain(['--db',path,'--list']);expect(JSON.stringify(list)).not.toContain('secret-value');expect(JSON.stringify(list)).not.toContain('token-value');expect(JSON.stringify(list)).not.toContain('message');
    const link=join(dir,'link.sqlite');symlinkSync(path,link);await expect(cliMain(['--db',link,'--list'])).rejects.toThrow('INVALID_CONFIG');chmodSync(path,0o644);await expect(cliMain(['--db',path,'--list'])).rejects.toThrow('INVALID_CONFIG');
    await expect(cliMain(['--db','relative.sqlite','--list'])).rejects.toThrow('INVALID_CONFIG');await expect(cliMain(['--db',path,'--list','--manual'])).rejects.toThrow('INVALID_CONFIG');
  });
});

describe('SSRF and bounded pinned HTTPS',()=>{
  test('shape rejects HTTP, empty userinfo, fragments and raw/encoded CRLF; DNS not checked at save',()=>{
    for(const value of ['http://example.invalid','https://@example.invalid','https://user@example.invalid','https://example.invalid/#','https://example.invalid/#x','https://example.invalid/\r\nx','https://example.invalid/%0d%0A','https:\\example.invalid'])expect(()=>validateReportURL(value)).toThrow('INVALID_CONFIG');
    expect(validateReportURL('https://private-unresolved.invalid/path').hostname).toBe('private-unresolved.invalid');
  });
  test('private, metadata, mapped IPv6 and reserved blocks rejected; public v4/v6 accepted',()=>{
    for(const ip of ['0.0.0.0','10.2.3.4','100.64.0.1','127.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','192.0.2.1','198.18.0.1','198.51.100.1','203.0.113.1','224.0.0.1','255.255.255.255','::','::1','::ffff:127.0.0.1','::ffff:7f00:1','fc00::1','fe80::1','2001::1','2001:0:1234::1','2001:11::1','2001:21::1','2001:db8::1','3fff::1','3ffe::1','2002:7f00:1::','invalid'])expect(isPublicReportAddress(ip)).toBe(false);
    expect(isPublicReportAddress('8.8.8.8')).toBe(true);expect(isPublicReportAddress('2606:4700:4700::1111')).toBe(true);
  });
  test('all DNS answers must be public; DNS is repeated on each retry and errors are enums',async()=>{
    const db=fixture(),job=enqueueReport(db,'test',reportAt)!;let dns=0,calls=0;
    const rebinding=async()=>{dns++;return dns===1?[{address:'8.8.8.8',family:4}]:[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}];};
    const fail=async()=>{calls++;throw new Error('EXACT token-value https://report.example.invalid/secret');};
    await runReportWorker(db,{now:reportAt,resolve:rebinding,transport:fail});expect(getReportRun(db,job.id)!.error_code).toBe('NETWORK_ERROR');
    await runReportWorker(db,{now:new Date(reportAt.getTime()+60000),resolve:rebinding,transport:fail});expect(dns).toBe(2);expect(calls).toBe(1);expect(getReportRun(db,job.id)!.error_code).toBe('PRIVATE_ADDRESS');expect(JSON.stringify(listReportRuns(db))).not.toContain('token-value');
  });
  test('no redirects; DNS failure, timeout and private literal report only enum',async()=>{
    const db=fixture(),job=enqueueReport(db,'test',reportAt)!;let calls=0;
    await runReportWorker(db,{now:reportAt,resolve:async()=>{throw new Error('secret-value');},transport:async()=>{calls++;return {status:200};}});expect(calls).toBe(0);expect(getReportRun(db,job.id)!.error_code).toBe('DNS_FAILED');
    await runReportWorker(db,{now:new Date(reportAt.getTime()+60000),resolve:resolver,transport:async()=>({status:302})});expect(getReportRun(db,job.id)!.http_status).toBe(302);expect(getReportRun(db,job.id)!.error_code).toBe('HTTP_ERROR');
    await runReportWorker(db,{now:new Date(reportAt.getTime()+180000),resolve:resolver,transport:async()=>{throw new ReportError('TIMEOUT');}});expect(getReportRun(db,job.id)!.error_code).toBe('TIMEOUT');
    saveReportSettings(db,{webhook_url:'https://[::ffff:127.0.0.1]/'});const privateJob=enqueueReport(db,'test',reportAt)!;await runReportWorker(db,{now:reportAt,resolve:resolver,transport:async()=>{calls++;return {status:200};}});expect(calls).toBe(0);expect(getReportRun(db,privateJob.id)!.error_code).toBe('PRIVATE_ADDRESS');
  });
  test('production request options pin address, preserve SNI/host, discard bounded body (offline socket factory)',async()=>{
    let options:any,body='';const input:ReportTransportInput={url:new URL('https://report.example.invalid/path'),address:{address:'8.8.8.8',family:4},headers:{Authorization:'EXACT token-value'},body:'{"message":"test"}',timeoutMs:100,maxResponseBytes:8};
    const factory=((url:any,opts:any,callback:any)=>{expect(url.hostname).toBe('report.example.invalid');options=opts;const req=new EventEmitter() as any;req.destroy=()=>{};req.end=(b:string)=>{body=b;const res=new EventEmitter() as any;res.statusCode=200;res.destroy=()=>{};callback(res);queueMicrotask(()=>{res.emit('data',Buffer.from('ignore'));res.emit('end');});};return req;}) as any;
    expect(await pinnedReportTransport(input,factory)).toEqual({status:200});expect(body).toBe(input.body);expect(options.agent).toBe(false);expect(options.servername).toBe('report.example.invalid');expect(options.family).toBe(4);
    let pinned:any;options.lookup('report.example.invalid',{},(...args:any[])=>{pinned=args;});expect(pinned).toEqual([null,'8.8.8.8',4]);options.lookup('report.example.invalid',{all:true},(...args:any[])=>{pinned=args;});expect(pinned).toEqual([null,[input.address]]);
    const tooLarge=((_:any,__:any,callback:any)=>{const req=new EventEmitter() as any;req.destroy=()=>{};req.end=()=>{const res=new EventEmitter() as any;res.statusCode=200;res.destroy=()=>{};callback(res);queueMicrotask(()=>res.emit('data',Buffer.alloc(9)));};return req;}) as any;
    await expect(pinnedReportTransport(input,tooLarge)).rejects.toThrow('RESPONSE_TOO_LARGE');
  });
  test('Bun 1.3.14 actual HTTPS lookup pins synthetic hostname; CA/SNI verified on localhost only',async()=>{
    const dir=temporary(),keyPath=join(dir,'key.pem'),certPath=join(dir,'cert.pem'),host='never-resolves.example.test';
    execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN='+host,'-addext','subjectAltName=DNS:'+host],{stdio:'ignore'});
    const cert=readFileSync(certPath,'utf8'),key=readFileSync(keyPath,'utf8');let seen=0,receivedHost='',receivedBody='';
    const server=Bun.serve({hostname:'127.0.0.1',port:0,tls:{cert,key},async fetch(req){seen++;receivedHost=req.headers.get('host')??'';receivedBody=await req.text();return new Response('discard',{status:200});}});
    let lookupCalls=0;
    // The only injected difference is trusting this disposable test CA. TLS
    // verification stays enabled; no production private-address exception exists.
    const requestFactory=((url:any,opts:any,cb:any)=>realHTTPSRequest(url,{...opts,ca:cert,lookup:(h:any,o:any,c:any)=>{lookupCalls++;opts.lookup(h,o,c);}},cb)) as any;
    try {
      const input:ReportTransportInput={url:new URL(`https://${host}:${server.port}/migration-test`),address:{address:'127.0.0.1',family:4},headers:{'Content-Type':'application/json'},body:'{"message":"synthetic local transport test"}',timeoutMs:1000,maxResponseBytes:65536};
      expect(await pinnedReportTransport(input,requestFactory)).toEqual({status:200});expect(lookupCalls).toBeGreaterThan(0);expect(seen).toBe(1);expect(receivedHost).toBe(`${host}:${server.port}`);expect(receivedBody).toBe(input.body);
    } finally {server.stop(true);}
  });
  test('production transport wall-clock timeout kills socket (offline socket factory)',async()=>{
    let destroyed=false;const factory=(()=>{const req=new EventEmitter() as any;req.destroy=()=>{destroyed=true;};req.end=()=>{};return req;}) as any;
    await expect(pinnedReportTransport({url:new URL('https://test.example.invalid'),address:{address:'8.8.8.8',family:4},headers:{},body:'{}',timeoutMs:5,maxResponseBytes:8},factory)).rejects.toThrow('TIMEOUT');expect(destroyed).toBe(true);
  });
});
