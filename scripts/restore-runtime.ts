import { openDatabase } from '../src/server/database';
import { restoreRuntime, compileMachine, provisionMachineToken, writePrivateMachineBundle, RuntimeCompileError, type RuntimeSupplement } from '../src/server/runtime';
import { statSync } from 'node:fs';

// Explicit CLI only. Startup must never import/activate restored hosts automatically.
const args = process.argv.slice(2);
const value = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const dbPath = value('--db');
if (!dbPath) { console.error('Usage: bun scripts/restore-runtime.ts --db PATH [--supplements PRIVATE_JSON] [--core-version 1.14|1.12] [--machine ID --bundle PRIVATE_PATH] [--new-token]'); process.exit(2); }
let db: ReturnType<typeof openDatabase> | undefined;
try {
  const supplementsPath = value('--supplements');
  let supplements: RuntimeSupplement[] = [];
  if (supplementsPath) {
    const st = statSync(supplementsPath);
    if ((st.mode & 0o077) !== 0) throw new Error('Supplement file must have permissions 0600 or stricter');
    const input = await Bun.file(supplementsPath).json(); supplements = Array.isArray(input) ? input : input.supplements;
    if (!Array.isArray(supplements)) throw new Error('Supplement JSON must be an array or {supplements:[]}');
  }
  const coreVersion = value('--core-version') || '1.14';
  if (!['1.12','1.14'].includes(coreVersion)) throw new Error('Core version must be 1.12 or 1.14');
  db = openDatabase(dbPath);
  const summary = restoreRuntime(db, {supplements,coreVersion:coreVersion as '1.12'|'1.14'});
  const machineID = Number(value('--machine'));
  let compiledSummary;
  if (machineID) {
    const bundlePath = value('--bundle'); if (!bundlePath) throw new Error('--machine requires --bundle; native configuration must not be printed');
    const compiled = compileMachine(db,machineID);
    const token = args.includes('--new-token') ? provisionMachineToken(db,machineID) : undefined;
    writePrivateMachineBundle(compiled,bundlePath);
    if (token) { const tokenPath = bundlePath + '.token'; const {writeFileSync,chmodSync} = await import('node:fs'); writeFileSync(tokenPath,token+'\n',{mode:0o600});chmodSync(tokenPath,0o600); }
    compiledSummary = {machine_id:machineID,revision:compiled.revision,inbounds:compiled.config.inbounds.length,traffic_labels:compiled.traffic_labels.length,files:compiled.files.length,warnings:compiled.warnings};
  }
  console.log(JSON.stringify({restoration:summary,compilation:compiledSummary}));
} catch (error) {
  // Database/native payloads can include credentials. Never print arbitrary parser/driver errors.
  console.error(error instanceof RuntimeCompileError ? error.message : 'Runtime restoration failed. Check private input permissions, schema, and CLI arguments.');process.exitCode=1;
} finally { db?.close(); }
