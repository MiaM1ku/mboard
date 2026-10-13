#!/usr/bin/env bun
/** Private local operator CLI. No URL/header flags, no message/response-body logging. */
import { lstatSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { openDatabase } from '../src/server/database';
import { buildPreview, enqueueReport, getReportSettings, initializeTrafficReports, listReportRuns, ReportError, runReportWorker, tickReportSchedule, type ReportKind } from '../src/server/traffic-reports';

const usage='Use --db /private/mboard.sqlite with --tick, --list, --settings, --preview daily|weekly|monthly|test, or --enqueue daily|weekly|monthly|test --manual --request-id ID. Test enqueue additionally requires --allow-real-migration-test.';
const fail=():never=>{throw new ReportError('INVALID_CONFIG');};
export async function main(args:string[]) {
  let path='',action='',kind:ReportKind|undefined,id:string|undefined,manual=false,allowTest=false,maxJobs=10;
  const seen=new Set<string>();
  for(let i=0;i<args.length;i++) {
    const arg=args[i]!;if(seen.has(arg))fail();seen.add(arg);
    const next=()=>{const value=args[++i];if(!value||value.startsWith('--'))fail();return value!;};
    if(arg==='--db')path=next();
    else if(arg==='--max-jobs'){maxJobs=Number(next());if(!Number.isInteger(maxJobs)||maxJobs<1||maxJobs>10)fail();}
    else if(arg==='--request-id')id=next();
    else if(arg==='--manual')manual=true;
    else if(arg==='--allow-real-migration-test')allowTest=true;
    else if(['--tick','--list','--settings','--preview','--enqueue'].includes(arg)){if(action)fail();action=arg;if(arg==='--preview'||arg==='--enqueue'){kind=next() as ReportKind;if(!['daily','weekly','monthly','test'].includes(kind))fail();}}
    else fail();
  }
  if(!path||!isAbsolute(path)||!action)fail();
  if(action!=='--enqueue'&&(manual||id!==undefined||allowTest))fail();
  if(action==='--enqueue'&&(!manual||!id))fail();
  if(action==='--enqueue'&&kind==='test'&&!allowTest)fail();
  if(allowTest&&kind!=='test')fail();
  let stat;try{stat=lstatSync(path);}catch{return fail();}
  if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)fail();
  const db=openDatabase(path);
  try {
    initializeTrafficReports(db);
    if(action==='--settings')return getReportSettings(db);
    if(action==='--list')return listReportRuns(db);
    if(action==='--preview'){
      const p=buildPreview(db,kind!);return {kind:p.kind,start_date:p.start_date,end_date:p.end_date,timezone:p.timezone,node_count:p.nodes.length,user_count:p.users.length,warnings:p.warnings};
    }
    if(action==='--enqueue'){
      // The authorized deployment's one migration test has a fixed persistent key.
      const key=kind==='test'?'migration-webhook-test-v1':id!;
      return enqueueReport(db,kind!,new Date(),{manual:true,idempotencyKey:key});
    }
    const enqueued=tickReportSchedule(db);
    const processed=await runReportWorker(db,{maxJobs});
    return {enqueued,processed};
  } finally {db.close();}
}
if(import.meta.main) {
  if(Bun.argv.includes('--help'))console.log(usage);
  else try{console.log(JSON.stringify(await main(Bun.argv.slice(2))));}
  catch{console.error('TRAFFIC_REPORT_OPERATION_FAILED');process.exitCode=1;}
}
