#!/usr/bin/env python3
"""Verified per-machine cutover: source config stays private; stop old node after native validation."""
import argparse, datetime, json, os, pathlib, shutil, subprocess, tarfile, time, urllib.request

def run(args, check=True):
    result=subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    if check and result.returncode: raise RuntimeError('Command needs attention: '+args[0]+' (exit '+str(result.returncode)+')')
    return result

def main():
    p=argparse.ArgumentParser();p.add_argument('--machine-id',type=int,required=True);p.add_argument('--stage',required=True);args=p.parse_args()
    stage=pathlib.Path(args.stage);root=pathlib.Path('/opt/mboard-node');backup=pathlib.Path('/opt/mboard-node-backups')/datetime.datetime.now(datetime.timezone.utc).strftime('cutover-%Y%m%dT%H%M%SZ')
    # Identity belongs to the machine's service-referenced configuration, never a guessed hostname.
    import yaml
    raw=yaml.safe_load(pathlib.Path('/etc/xboard-node/config.yml').read_text())
    instances=raw.get('instances',[raw]);instances=instances.values() if isinstance(instances,dict) else instances
    ids=[int(instance.get('machine',{}).get('machine_id',0)) for instance in instances]
    if ids!=[args.machine_id]:raise RuntimeError('Source machine identity needs review')
    bundle=json.loads((stage/'bundle.json').read_text());agent=json.loads((stage/'agent.json').read_text())
    request=urllib.request.Request(agent['panel_url']+'/api/node/v1/config',headers={'Authorization':'Bearer '+agent['token']})
    with urllib.request.urlopen(request,timeout=30) as response:remote=json.load(response)['data']
    if remote['config']!=bundle['config'] or remote['revision']!=bundle['revision']:raise RuntimeError('Source bundle and live panel revision differ')
    backup.mkdir(parents=True,mode=0o700);os.chmod(backup.parent,0o700)
    with tarfile.open(backup/'old-config.tar.gz','w:gz') as tar:tar.add('/etc/xboard-node',arcname='etc/xboard-node')
    os.chmod(backup/'old-config.tar.gz',0o600)
    unit=pathlib.Path('/etc/systemd/system/xboard-node.service')
    if unit.exists():shutil.copy2(unit,backup/'xboard-node.service')
    root.mkdir(mode=0o700,exist_ok=True);os.chmod(root,0o700)
    for filename in ['mboard-node','sing-box','agent.json']:shutil.copy2(stage/filename,root/filename);os.chmod(root/filename,0o755 if filename!='agent.json' else 0o600)
    tls=pathlib.Path('/etc/mboard-node/tls');tls.mkdir(parents=True,mode=0o700);os.chmod(tls.parent,0o700);os.chmod(tls,0o700)
    for item in bundle['files']:
        name=item['path_under_mboard_tls'];target=tls/name
        if pathlib.Path(name).name!=name:raise RuntimeError('TLS bundle path needs review')
        target.write_text(item['content']);os.chmod(target,0o600)
    if args.machine_id==2:
        certs=pathlib.Path('/etc/xboard-node/instances/panel-example-xyz-machine-2-8256c8/node-180/certs')
        for old,new in [('cert.pem','180.crt'),('key.pem','180.key')]:shutil.copy2(certs/old,tls/new);os.chmod(tls/new,0o600)
    cache=pathlib.Path('/var/lib/mboard-node');cache.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(cache,0o700)
    check=root/'preflight.json';check.write_text(json.dumps(bundle['config']));os.chmod(check,0o600)
    run([str(root/'sing-box'),'check','-c',str(check)])
    run([str(root/'mboard-node'),'validate','-config',str(root/'agent.json')])
    service=pathlib.Path('/etc/systemd/system/mboard-node.service')
    service.write_text('[Unit]\nDescription=mboard independent node\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=/opt/mboard-node\nExecStart=/opt/mboard-node/mboard-node run -config /opt/mboard-node/agent.json\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=75\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\nProtectHome=true\nProtectSystem=strict\nReadWritePaths=/opt/mboard-node /etc/mboard-node/tls /var/lib/mboard-node\n\n[Install]\nWantedBy=multi-user.target\n')
    run(['systemctl','daemon-reload'])
    old_active=run(['systemctl','is-active','xboard-node.service'],False).returncode==0
    run(['systemctl','stop','xboard-node.service'])
    try:
        run(['systemctl','start','mboard-node.service'])
        # Bounded rollout readiness checks, not background job polling.
        deadline=time.monotonic()+65
        ready=False
        while time.monotonic()<deadline:
            if run(['systemctl','is-active','mboard-node.service'],False).returncode:
                raise RuntimeError('New node process needs review')
            state=root/'data'/'state.json'
            if state.exists():
                try:
                    saved=json.loads(state.read_text())
                    # Applied native digest plus live stats endpoint proves the core opened the configuration.
                    stats_ready=run(['sh','-c','ss -lnt | awk \'$4 ~ /127.0.0.1:19090$/ {found=1} END {exit !found}\''],False).returncode==0
                    if stats_ready and int(saved.get('revision',-1))==int(bundle['revision']):ready=True;break
                except (ValueError,TypeError):pass
            time.sleep(2)
        if not ready:raise RuntimeError('New node readiness deadline exceeded')
    except Exception:
        run(['systemctl','stop','mboard-node.service'],False)
        if old_active:run(['systemctl','start','xboard-node.service'],False)
        raise
    run(['systemctl','enable','mboard-node.service'])
    run(['systemctl','disable','xboard-node.service'],False)
    # Uninstall the old launch entry and preserve its executable for rollback on the same filesystem.
    if unit.exists():shutil.move(str(unit),str(backup/'xboard-node.service.disabled'))
    old_binary=pathlib.Path('/usr/local/bin/xboard-node')
    if old_binary.exists():shutil.move(str(old_binary),str(backup/'xboard-node'))
    run(['systemctl','daemon-reload'])
    check.unlink(missing_ok=True)
    (backup/'result.json').write_text(json.dumps({'machine_id':args.machine_id,'revision':bundle['revision'],'inbounds':len(bundle['config']['inbounds']),'state':'switched','old_active_before':old_active}))
    os.chmod(backup/'result.json',0o600)
    print(json.dumps({'machine_id':args.machine_id,'revision':bundle['revision'],'inbounds':len(bundle['config']['inbounds']),'backup':str(backup),'new_service':'active','old_launch':'removed'}))

if __name__=='__main__':
    try:main()
    except Exception as error:raise SystemExit(str(error))
