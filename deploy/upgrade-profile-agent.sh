#!/bin/sh
# Profile accounting rollout: keep the durable journal and every pending batch.
set -eu
umask 077
mid=${1:?machine id required}
case "$mid" in ''|*[!0-9]*) exit 2;; esac
expected=66a42d370414117ecf1f9c5dce92f7efb44d8a1cd5167546951f7d95246c0a83
root=/opt/mboard-node
stage=/opt/mboard-agent-upgrade
[ "$(id -u)" = 0 ] || exit 2
[ -d "$root" ] && [ ! -L "$root" ] && [ -f "$root/identity.json" ] && [ -f "$root/agent.json" ] || { echo 'Review installed node identity before upgrading.' >&2; exit 1; }
if command -v python3 >/dev/null 2>&1; then
 python3 - "$mid" <<'PY'
import json,sys
from pathlib import Path
r=Path('/opt/mboard-node');identity=json.loads((r/'identity.json').read_text());agent=json.loads((r/'agent.json').read_text())
assert identity=={'panel_url':'https://panel.example','machine_id':int(sys.argv[1])}
assert agent['panel_url']=='https://panel.example' and agent['data_dir']=='/opt/mboard-node/data' and agent['core_binary']=='/opt/mboard-node/sing-box'
assert agent['config_path'] in ['/opt/mboard-node/server.json','/opt/mboard-node/sing-box.json']
PY
else
 jq -e --argjson id "$mid" '.machine_id==$id and .panel_url=="https://panel.example"' "$root/identity.json" >/dev/null
 jq -e '.panel_url=="https://panel.example" and .data_dir=="/opt/mboard-node/data" and .core_binary=="/opt/mboard-node/sing-box" and(.config_path=="/opt/mboard-node/server.json" or .config_path=="/opt/mboard-node/sing-box.json")' "$root/agent.json" >/dev/null
fi
[ -f "$stage/mboard-node-0.2.1" ] && [ ! -L "$stage/mboard-node-0.2.1" ] || exit 1
printf '%s  %s\n' "$expected" "$stage/mboard-node-0.2.1" | sha256sum -c - >/dev/null
chmod 700 "$stage/mboard-node-0.2.1"
[ "$("$stage/mboard-node-0.2.1" version)" = 0.2.1 ] || exit 1
"$stage/mboard-node-0.2.1" validate -config "$root/agent.json" > "$stage/preflight.log" 2>&1
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
 manager=systemd
 systemctl is-active --quiet mboard-node.service
 start() { systemctl start mboard-node.service; }
 stop() { systemctl stop mboard-node.service; }
 active() { systemctl is-active --quiet mboard-node.service; }
else
 manager=openrc
 rc-service mboard-node status >/dev/null
 start() { rc-service mboard-node start; }
 stop() { rc-service mboard-node stop; }
 active() { rc-service mboard-node status >/dev/null; }
fi
if [ "$("$root/mboard-node" version)" = 0.2.1 ] && active; then
 echo "Machine $mid already runs agent 0.2.1."
 exit 0
fi
backup=$(mktemp -d "/opt/mboard-node-backups/profile-021-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
chmod 700 "$backup"
cp -p "$root/mboard-node" "$backup/mboard-node-previous"
# Only non-secret result metadata is emitted or logged.
printf '{"machine_id":%s,"previous_version":"0.2.0","target_version":"0.2.1"}\n' "$mid" > "$backup/upgrade.json"
cp "$stage/mboard-node-0.2.1" "$root/mboard-node.next"
chmod 700 "$root/mboard-node.next"
stop > "$backup/service.log" 2>&1
mv "$root/mboard-node.next" "$root/mboard-node"
if ! start >> "$backup/service.log" 2>&1; then
 echo "Machine $mid needs startup review. Durable data and previous binary stay in $backup." >&2
 exit 1
fi
ready=0
end=$(($(date +%s)+75))
while [ "$(date +%s)" -lt "$end" ]; do
 if active && [ -f "$root/data/state.json" ] && awk '$2=="0100007F:4A92" && $4=="0A"{found=1} END{exit !found}' /proc/net/tcp; then ready=1; break; fi
 sleep 2
done
[ "$ready" = 1 ] || { echo "Machine $mid needs readiness review. Keep agent 0.2.1 and the durable journal intact." >&2; exit 1; }
printf '{"machine_id":%s,"version":"0.2.1","service":"active","stats_port":19090,"backup":"%s","manager":"%s"}\n' "$mid" "$backup" "$manager"
