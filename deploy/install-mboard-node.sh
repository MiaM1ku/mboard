#!/bin/sh
# Public, self-contained amd64 installer. Never run with sh -x.
# Release publisher replaces both SHA256 constants before publishing.
set -eu
umask 077
AGENT_SHA256='81562d3681a4cbb60ac8409cda363c8df55d0c1ad8a98be9f9e05332fede2e1d'
CORE_SHA256='1e6b4ef716062484f52d3490c3b1c4d7798e8cd76aeaba3f01e9f3320c63bd90'

say() { printf '%s\n' "$*"; }
fail() { printf 'Installer needs attention: %s\n' "$*" >&2; exit 1; }
hex_token() { [ "${#1}" -eq 64 ] && case "$1" in *[!0-9a-fA-F]*) return 1;; *) return 0;; esac; }
machine_token() { case "${#1}" in 32|64) case "$1" in *[!0-9a-fA-F]*) return 1;; *) return 0;; esac;; *) return 1;; esac; }
valid_id() { case "$1" in ''|0|0*|*[!0-9]*) return 1;; esac; [ "${#1}" -le 15 ]; }
valid_origin() {
    case "$1" in https://*) host=${1#https://};; *) return 1;; esac
    case "$host" in ''|*[!a-zA-Z0-9.:-]*|:*|*:) return 1;; esac
    # Restrict to DNS/IPv4 origins with an optional decimal port. No userinfo/path.
    printf '%s\n' "$host" | awk -F: 'NF>2 {exit 1} $1 !~ /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/ {exit 1} NF==2 && ($2 !~ /^[0-9]+$/ || $2<1 || $2>65535) {exit 1}'
}
# This deliberately accepts a small literal YAML subset, not general YAML.
# Exactly one machine block is required. node_id and panel token are never used.
old_machine_record() {
    awk '
    function scalar(s, q) {
        sub(/^[ \t]+/, "", s); sub(/[ \t]+$/, "", s)
        q=substr(s,1,1)
        if(q=="\047" || q=="\042") {
            if(substr(s,length(s),1)!=q) {bad=1; return ""}
            return substr(s,2,length(s)-2)
        }
        sub(/[ \t]+#.*/, "", s); return s
    }
    /\t/ {bad=1}
    /^[ ]*(#|$)/ {next}
    {
        match($0,/[^ ]/); indent=RSTART-1; text=substr($0,RSTART)
        if(text ~ /^- +/) {sub(/^- +/, "", text); indent+=2}
        if(active && indent<=base) active=0
        if(text ~ /^machine:[ ]*(#.*)?$/) {count++; active=1; base=indent; next}
        if(active) {
            if(text ~ /^machine_id:/) {ids++; id=scalar(substr(text,12))}
            else if(text ~ /^token_env:/) {envs++; env=scalar(substr(text,11))}
            else if(text ~ /^token:/) {tokens++; token=scalar(substr(text,7))}
            else if(text !~ /^#/) bad=1
        }
    }
    END {
        if(bad || count!=1 || ids!=1 || tokens>1 || envs>1 || (tokens==1 && envs==1) || id !~ /^[1-9][0-9]*$/) exit 1
        if(tokens && ((length(token)!=32 && length(token)!=64) || token ~ /[^0-9a-fA-F]/)) exit 1
        if(envs && env !~ /^[A-Za-z_][A-Za-z0-9_]*$/) exit 1
        printf "%s|%s|%s\n",id,token,env
    }' "$1"
}
# No eval, source, shell expansion, or command substitution of credential data.
credential_token() {
    awk -v wanted="$2" '
    /^[ \t]*(#|$)/ {next}
    { s=$0; sub(/^[ \t]*export[ \t]+/,"",s); pos=index(s,"="); if(!pos) next
      key=substr(s,1,pos-1); if(key!=wanted) next
      count++; value=substr(s,pos+1)
      if(substr(value,1,1)=="\047" || substr(value,1,1)=="\042") {
          q=substr(value,1,1); if(substr(value,length(value),1)!=q) bad=1
          value=substr(value,2,length(value)-2)
      }
      if((length(value)!=32 && length(value)!=64) || value ~ /[^0-9a-fA-F]/) bad=1
    }
    END {if(count!=1 || bad) exit 1; print value}' "$1"
}
validate_bundle() {
    # -s rejects trailing extra JSON values. Byte/count limits bound private output.
    [ "$(wc -c < "$1")" -le 8388608 ] || return 1
    jq -se '
      length == 1 and (.[0].data | type == "object" and
      (.token | type == "string" and test("^[0-9a-fA-F]{64}$")) and
      (.revision | type == "number" and . >= 0 and . <= 9007199254740991 and floor == .) and
      (.config | type == "object" and (.inbounds | type == "array")) and
      (.traffic_labels | type == "array") and
      (.files | type == "array" and length <= 128 and
        (map(.path_under_mboard_tls) | length == (unique | length)) and
        all(.[]; type == "object" and
          (.path_under_mboard_tls | type == "string" and length <= 128 and test("^[A-Za-z0-9][A-Za-z0-9_.-]*\\.(crt|key)$")) and
          (.content | type == "string" and utf8bytelength <= 1048576 and (test("\u0000") | not)) and
          (.mode | type == "number" and (. == 384 or . == 256 or . == 420)))))
    ' "$1" >/dev/null 2>&1
}
secure_dir() {
    [ ! -L "$1" ] || fail "Replace symlink at $1 with a root-owned directory."
    if [ -e "$1" ]; then
        [ -d "$1" ] && [ "$(stat -c %u "$1")" = 0 ] || fail "Review directory ownership: $1"
    else mkdir -p "$1"; fi
    chmod 700 "$1"
}
plain_file() { [ ! -L "$1" ] && { [ ! -e "$1" ] || { [ -f "$1" ] && [ "$(stat -c %u "$1")" = 0 ] && [ "$(stat -c %h "$1")" = 1 ]; }; }; }
download() {
    if command -v curl >/dev/null 2>&1; then
        curl --disable --proto '=https' --tlsv1.2 --fail --silent --show-error --connect-timeout 20 --max-time 300 --output "$2" "$1" 2>"$STAGE/download.log"
    else
        wget -q -T 60 -O "$2" "$1" 2>"$STAGE/download.log"
    fi
}
verify_binary() { printf '%s  %s\n' "$2" "$1" | sha256sum -c - >/dev/null 2>&1; }
auth_config() {
    # token passed as a shell value only; printf is a shell builtin.
    machine_token "$1" || fail 'Provide the existing 32-hex or new 64-hex node token.'
    { printf 'header = "Authorization: Bearer %s"\n' "$1"; printf 'header = "Content-Type: application/json"\n'; } > "$2"
    chmod 600 "$2"
}
api_post() {
    limit=30
    [ "$2" != /api/node/v1/activate ] || limit=5
    (ulimit -f 16384
     curl --disable --config "$1" --proto '=https' --tlsv1.2 --fail --silent --connect-timeout 5 --max-time "$limit" --max-filesize 8388608 \
        --request POST --data-binary "@$3" --output "$4" --write-out '%{http_code}' "$PANEL$2" >"$STAGE/http-status" 2>"$STAGE/api.log")
}
stats_bound() {
    # Linux procfs avoids ss/netstat dependencies on minimal Alpine.
    awk '$2 == "0100007F:4A92" && $4 == "0A" {found=1} END {exit !found}' /proc/net/tcp
}
service_active() {
    if [ "$MANAGER" = systemd ]; then systemctl is-active --quiet "$1.service"; else rc-service "$1" status >/dev/null 2>&1; fi
}
service_start() {
    if [ "$MANAGER" = systemd ]; then systemctl start "$1.service"; else rc-service "$1" start; fi
}
service_stop() {
    if [ "$MANAGER" = systemd ]; then systemctl stop "$1.service"; else rc-service "$1" stop; fi
}
service_enable() {
    if [ "$MANAGER" = systemd ]; then systemctl enable "$1.service"; else rc-update add "$1" default; fi
}
service_disable() {
    if [ "$MANAGER" = systemd ]; then systemctl disable "$1.service"; else rc-update del "$1" default; fi
}
reload_services() { if [ "$MANAGER" = systemd ]; then systemctl daemon-reload; fi; }
# Known service names plus exact executable/config binding, never guessed process IDs.
verify_old_service() {
    if [ "$MANAGER" = systemd ]; then
        [ "$(systemctl show --property=FragmentPath --value xboard-node.service)" = "$OLD_SERVICE" ] || return 1
        [ -z "$(systemctl show --property=DropInPaths --value xboard-node.service)" ] || return 1
        systemctl show --property=ExecStart --value xboard-node.service | awk '
            index($0,"path=/usr/local/bin/xboard-node ;") && index($0,"argv[]=/usr/local/bin/xboard-node -c /etc/xboard-node/config.yml ;") && gsub(/\{/,"{")==1 {found=1}
            END {exit !found}' || return 1
        awk '/^ExecStart=/ {n++; if($0!="ExecStart=/usr/local/bin/xboard-node -c /etc/xboard-node/config.yml") bad=1} END {exit (n!=1 || bad)}' "$OLD_SERVICE"
    else
        awk '/^command=/ {n++; if($0!="command=\042/usr/local/bin/xboard-node\042") bad=1}
             /^command_args=/ {m++; if($0!="command_args=\042-c /etc/xboard-node/config.yml\042") bad=1}
             END {exit (n!=1 || m!=1 || bad)}' "$OLD_SERVICE"
    fi
}
verify_new_service() {
    if [ "$MANAGER" = systemd ]; then
        [ "$(systemctl show --property=FragmentPath --value mboard-node.service)" = "$NEW_SERVICE" ] || return 1
        [ -z "$(systemctl show --property=DropInPaths --value mboard-node.service)" ] || return 1
        systemctl show --property=ExecStart --value mboard-node.service | awk '
            index($0,"path=/opt/mboard-node/mboard-node ;") && index($0,"argv[]=/opt/mboard-node/mboard-node run -config /opt/mboard-node/agent.json ;") && gsub(/\{/,"{")==1 {found=1}
            END {exit !found}' || return 1
        awk '/^ExecStart=/ {n++; if($0!="ExecStart=/opt/mboard-node/mboard-node run -config /opt/mboard-node/agent.json") bad=1} END {exit (n!=1 || bad)}' "$NEW_SERVICE"
    else
        awk '/^command=/ {n++; if($0!="command=\042/opt/mboard-node/mboard-node\042") bad=1}
             /^command_args=/ {m++; if($0!="command_args=\042run -config /opt/mboard-node/agent.json\042") bad=1}
             END {exit (n!=1 || m!=1 || bad)}' "$NEW_SERVICE"
    fi
}
render_service() {
    if [ "$MANAGER" = systemd ]; then
        printf '%s\n' '[Unit]' 'Description=mboard independent node' 'After=network-online.target' 'Wants=network-online.target' '' '[Service]' 'Type=simple' 'WorkingDirectory=/opt/mboard-node' 'ExecStart=/opt/mboard-node/mboard-node run -config /opt/mboard-node/agent.json' 'Restart=on-failure' 'RestartSec=3' 'TimeoutStopSec=75' 'UMask=0077' 'NoNewPrivileges=true' 'PrivateTmp=true' 'ProtectHome=true' 'ProtectSystem=strict' 'ReadWritePaths=/opt/mboard-node /etc/mboard-node/tls /var/lib/mboard-node' '' '[Install]' 'WantedBy=multi-user.target' > "$STAGE/new-service"
    else
        printf '%s\n' '#!/sbin/openrc-run' 'name="mboard independent node"' 'supervisor="supervise-daemon"' 'command="/opt/mboard-node/mboard-node"' 'command_args="run -config /opt/mboard-node/agent.json"' 'directory="/opt/mboard-node"' 'pidfile="/run/${RC_SVCNAME}.pid"' 'output_log="/var/log/mboard-node.log"' 'error_log="/var/log/mboard-node.log"' 'respawn_delay=3' 'respawn_max=0' 'retry="TERM/75/KILL/5"' 'depend() {' '    need net' '    after firewall' '}' 'start_pre() {' '    umask 077' '}' > "$STAGE/new-service"
    fi
    chmod 755 "$STAGE/new-service"
}
cleanup() {
    code=$?
    trap - EXIT HUP INT TERM
    set +e
    [ -z "${tty_mode:-}" ] || stty "$tty_mode" </dev/tty 2>/dev/null
    if [ "$code" -ne 0 ] && [ "$CUTOVER" = 1 ] && { [ "${ACTIVATION_IN_FLIGHT:-0}" = 1 ] || [ "${ACTIVATION_UNCERTAIN:-0}" = 1 ]; }; then
        say "Activation outcome needs confirmation. New service keeps running. Retry this command to reconcile with the panel. Private recovery files: $BACKUP" >&2
    elif [ "$code" -ne 0 ] && [ "$CUTOVER" = 1 ] && [ "$COMMITTED" = 0 ]; then
        service_stop mboard-node >>"$BACKUP/rollback.log" 2>&1
        if service_active mboard-node >>"$BACKUP/rollback.log" 2>&1; then
            say "New service is still running. Stop it before restoring files or starting the old node. Private recovery files: $BACKUP" >&2
            [ -z "$STAGE" ] || rm -rf "$STAGE"
            [ "$LOCKED" = 0 ] || rmdir /opt/mboard-node-stage/install.lock 2>/dev/null
            exit "$code"
        fi
        service_disable mboard-node >>"$BACKUP/rollback.log" 2>&1
        # Restore exact snapshots; gate all restarts on successful restoration.
        restore_ok=1
        rm -f "$NEW_SERVICE" || restore_ok=0
        if [ -f "$BACKUP/new-service" ]; then cp -p "$BACKUP/new-service" "$NEW_SERVICE" || restore_ok=0; fi
        rm -rf /opt/mboard-node /etc/mboard-node/tls || restore_ok=0
        if [ -f "$BACKUP/new-tree.tar.gz" ]; then tar -xzf "$BACKUP/new-tree.tar.gz" -C / || restore_ok=0; fi
        if [ -f "$BACKUP/tls-tree.tar.gz" ]; then tar -xzf "$BACKUP/tls-tree.tar.gz" -C / || restore_ok=0; fi
        reload_services >>"$BACKUP/rollback.log" 2>&1 || restore_ok=0
        if [ "$restore_ok" = 0 ]; then
            say "Restore needs manual repair before restarting either node. Private recovery files: $BACKUP" >&2
        else
            if [ "$NEW_ENABLED" = 1 ]; then service_enable mboard-node >>"$BACKUP/rollback.log" 2>&1; fi
            if [ "$NEW_ACTIVE" = 1 ]; then service_start mboard-node >>"$BACKUP/rollback.log" 2>&1; fi
            if [ "$OLD_ACTIVE" = 1 ]; then
                if service_start xboard-node >>"$BACKUP/rollback.log" 2>&1; then
                    say "Old node restarted. Private recovery files: $BACKUP"
                else say "Start xboard-node using the private recovery files: $BACKUP" >&2; fi
            else say "Private recovery files: $BACKUP"; fi
        fi
    fi
    [ -z "$STAGE" ] || rm -rf "$STAGE"
    [ "$LOCKED" = 0 ] || rmdir /opt/mboard-node-stage/install.lock 2>/dev/null
    exit "$code"
}
finish_old_uninstall() {
    cleanup_warning=0
    if [ "$OLD_PRESENT" = 1 ]; then
        if service_active xboard-node; then
            service_stop xboard-node >>"$BACKUP/service.log" 2>&1 || { cleanup_warning=1; return 0; }
        fi
        service_disable xboard-node >>"$BACKUP/service.log" 2>&1 || cleanup_warning=1
        mv "$OLD_SERVICE" "$BACKUP/xboard-node.service.disabled" || cleanup_warning=1
        if [ -f /usr/local/bin/xboard-node ]; then mv /usr/local/bin/xboard-node "$BACKUP/xboard-node" || cleanup_warning=1; fi
    fi
    reload_services >>"$BACKUP/service.log" 2>&1 || cleanup_warning=1
}
usage() {
    say 'Usage: sh install-mboard-node.sh [--machine-id N] [--panel https://HOST] [--token TOKEN] [--force]'
    say 'Root required. Token defaults to MBOARD_NODE_TOKEN, existing mboard token, or the source machine token.'
    say 'Use --force to replace a previously managed installation after backing it up.'
}
main() {
    PANEL=https://panel.example; MACHINE_ID=; TOKEN=${MBOARD_NODE_TOKEN:-}; FORCE=0
    STAGE=; BACKUP=; LOCKED=0; CUTOVER=0; COMMITTED=0; ACTIVATION_IN_FLIGHT=0; ACTIVATION_UNCERTAIN=0; OLD_ACTIVE=0; NEW_ACTIVE=0; NEW_ENABLED=0
    while [ "$#" -gt 0 ]; do
        case "$1" in
            --panel|--machine-id|--token) [ "$#" -ge 2 ] || fail "Supply a value for $1"
                case "$1" in --panel) PANEL=$2;; --machine-id) MACHINE_ID=$2;; --token) TOKEN=$2;; esac; shift 2;;
            --force) FORCE=1; shift;;
            --help|-h) usage; return 0;;
            *) fail 'Use --help to review installer options.';;
        esac
    done
    [ "$(id -u)" = 0 ] || fail 'Run this command as root.'
    [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || fail 'Use a Linux amd64 machine.'
    PANEL=${PANEL%/}; valid_origin "$PANEL" || fail 'Set --panel to an HTTPS origin.'
    BASE=${MBOARD_BINARY_BASE:-$PANEL/downloads}; BASE=${BASE%/}
    # Override may change download path, never origin or authentication destination.
    case "$BASE" in "$PANEL"/*) suffix=${BASE#"$PANEL"/}; case "$suffix" in ''|*[!a-zA-Z0-9_./-]*|*..*) fail 'Review MBOARD_BINARY_BASE path.';; esac;; *) fail 'Use the panel HTTPS origin for MBOARD_BINARY_BASE.';; esac
    hex_token "$AGENT_SHA256" && hex_token "$CORE_SHA256" || fail 'Ask the publisher to pin both release SHA256 values before hosting this script.'
    for tool in awk sha256sum stat tar wc; do command -v "$tool" >/dev/null 2>&1 || fail "Install prerequisite: $tool"; done
    # Install dependencies before any service is stopped or credential is requested.
    missing=
    command -v jq >/dev/null 2>&1 || missing="$missing jq"
    command -v curl >/dev/null 2>&1 || missing="$missing curl"
    if [ -n "$missing" ]; then
        say 'Installing JSON and HTTPS prerequisites before cutover.'
        if command -v apk >/dev/null 2>&1; then apk add --no-cache $missing >/dev/null 2>&1 || fail 'Run apk add --no-cache jq curl, then retry.'
        elif command -v apt-get >/dev/null 2>&1; then
            apt-get update >/dev/null 2>&1 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing >/dev/null 2>&1 || fail 'Run apt-get update and apt-get install jq curl, then retry.'
        else fail 'Install jq and curl using the system package manager, then retry.'; fi
    fi
    # Agent env overrides must not leak into validation or rewrite the enrolled identity.
    unset MBOARD_NODE_TOKEN MBOARD_NODE_PANEL_URL MBOARD_NODE_CONFIG_PATH MBOARD_NODE_CORE_BINARY MBOARD_NODE_DATA_DIR MBOARD_NODE_INTERVAL MBOARD_NODE_REQUEST_TIMEOUT MBOARD_NODE_TELEMETRY_INTERVAL MBOARD_NODE_TELEMETRY_TIMEOUT MBOARD_NODE_TELEMETRY_SPOOL_MAX_BYTES MBOARD_NODE_TLS_CA_PATH MBOARD_NODE_TLS_CERT_PATH MBOARD_NODE_TLS_KEY_PATH
    secure_dir /opt/mboard-node-stage
    mkdir /opt/mboard-node-stage/install.lock 2>/dev/null || fail 'Another install owns /opt/mboard-node-stage/install.lock. Check that process before retrying.'
    LOCKED=1
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' HUP TERM
    STAGE=$(mktemp -d /opt/mboard-node-stage/run.XXXXXX); chmod 700 "$STAGE"
    if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
        MANAGER=systemd; OLD_SERVICE=/etc/systemd/system/xboard-node.service; NEW_SERVICE=/etc/systemd/system/mboard-node.service
    elif command -v rc-service >/dev/null 2>&1 && command -v rc-update >/dev/null 2>&1; then
        MANAGER=openrc; OLD_SERVICE=/etc/init.d/xboard-node; NEW_SERVICE=/etc/init.d/mboard-node
    else fail 'Install with systemd or OpenRC as the service manager.'; fi
    OLD_PRESENT=0
    if [ -e /etc/xboard-node/config.yml ]; then
        plain_file /etc/xboard-node/config.yml || fail 'Review source configuration symlink.'
        record=$(old_machine_record /etc/xboard-node/config.yml) || fail 'Use one literal machine block in /etc/xboard-node/config.yml before cutover.'
        source_id=${record%%|*}; rest=${record#*|}; source_token=${rest%%|*}; source_env=${rest#*|}
        [ -z "$MACHINE_ID" ] || [ "$MACHINE_ID" = "$source_id" ] || fail 'Match --machine-id to the source machine_id before cutover.'
        MACHINE_ID=$source_id
        if [ -z "$TOKEN" ] && [ ! -f /opt/mboard-node/agent.json ]; then
            TOKEN=$source_token
            if [ -n "$source_env" ]; then
                plain_file /etc/xboard-node/credentials.env || fail 'Review source credential symlink.'
                TOKEN=$(credential_token /etc/xboard-node/credentials.env "$source_env") || fail 'Put a literal 32/64-hex machine credential in credentials.env.'
            fi
        fi
    fi
    if [ -e "$OLD_SERVICE" ]; then
        plain_file "$OLD_SERVICE" && verify_old_service || fail 'Review xboard-node service executable/config binding before cutover.'
        [ -n "${source_id:-}" ] || fail 'Restore source machine configuration before uninstalling the old service.'
        OLD_PRESENT=1
        if service_active xboard-node; then OLD_ACTIVE=1; fi
    elif service_active xboard-node; then fail 'Review the active xboard-node service definition before cutover.'; fi
    # A managed identity makes retries safe and prevents adopting an unrelated node.
    if [ -e /opt/mboard-node/agent.json ] || [ -e "$NEW_SERVICE" ]; then
        plain_file "$NEW_SERVICE" && [ -f "$NEW_SERVICE" ] && verify_new_service || fail 'Review the managed mboard service executable/config binding.'
        plain_file /opt/mboard-node/identity.json && jq -e --arg p "$PANEL" '.panel_url == $p and (.machine_id | type == "number")' /opt/mboard-node/identity.json >/dev/null 2>&1 || fail 'Review the existing mboard installation identity.'
        managed_id=$(jq -r .machine_id /opt/mboard-node/identity.json)
        [ -z "$MACHINE_ID" ] || [ "$MACHINE_ID" = "$managed_id" ] || fail 'Match --machine-id to the installed mboard identity.'
        MACHINE_ID=$managed_id
        plain_file /opt/mboard-node/agent.json || fail 'Review installed agent config symlink.'
        if [ -z "$TOKEN" ]; then TOKEN=$(jq -er '.token | select(type == "string")' /opt/mboard-node/agent.json) || fail 'Review installed agent token.'; fi
        if service_active mboard-node; then NEW_ACTIVE=1; fi
        if [ "$MANAGER" = systemd ]; then
            if systemctl is-enabled --quiet mboard-node.service; then NEW_ENABLED=1; fi
        elif rc-update show default 2>/dev/null | awk '$1=="mboard-node" {found=1} END {exit !found}'; then NEW_ENABLED=1; fi
    fi
    valid_id "$MACHINE_ID" || fail 'Provide --machine-id with the source machine number.'
    if [ -z "$TOKEN" ]; then
        [ -r /dev/tty ] || fail 'Set MBOARD_NODE_TOKEN to the 64-hex node token, then retry.'
        printf 'Node token (hidden): ' >/dev/tty
        tty_mode=$(stty -g </dev/tty); stty -echo </dev/tty
        IFS= read -r TOKEN </dev/tty || { stty "$tty_mode" </dev/tty; fail 'Read the token from the terminal, then retry.'; }
        stty "$tty_mode" </dev/tty; tty_mode=; printf '\n' >/dev/tty
    fi
    auth_config "$TOKEN" "$STAGE/old-auth.conf"; TOKEN=; source_token=; record=; rest=
    printf '{"machine_id":%s}\n' "$MACHINE_ID" > "$STAGE/enroll.json"
    say "Preparing machine $MACHINE_ID. Existing service keeps running during checks."
    api_post "$STAGE/old-auth.conf" /api/node/v1/enroll "$STAGE/enroll.json" "$STAGE/response.json" || fail 'Check enrollment access and panel reachability, then retry.'
    validate_bundle "$STAGE/response.json" || fail 'Ask the panel operator to review the enrollment bundle schema.'
    REVISION=$(jq -r .data.revision "$STAGE/response.json")
    new_token=$(jq -r .data.token "$STAGE/response.json"); auth_config "$new_token" "$STAGE/new-auth.conf"; new_token=
    printf '{"config_revision":%s}\n' "$REVISION" > "$STAGE/activate.json"
    if [ "$NEW_ACTIVE" = 1 ] && [ "$FORCE" = 0 ]; then
        verify_binary /opt/mboard-node/mboard-node "$AGENT_SHA256" && verify_binary /opt/mboard-node/sing-box "$CORE_SHA256" || fail 'Run --force to install the pinned release after backup.'
        jq -e --argjson r "$REVISION" '.revision == $r' /opt/mboard-node/data/state.json >/dev/null 2>&1 || fail 'Wait for the installed agent to apply this revision, or run --force.'
        activate_once || fail 'Wait for a fresh ready heartbeat, then retry.'
        if [ "$OLD_PRESENT" = 1 ]; then
            secure_dir /opt/mboard-node-backups
            BACKUP=$(mktemp -d "/opt/mboard-node-backups/reconcile-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX")
            cp -p "$OLD_SERVICE" "$BACKUP/old-service"
            tar -czf "$BACKUP/old-config.tar.gz" -C / etc/xboard-node
            finish_old_uninstall
            if [ "$cleanup_warning" = 1 ]; then say "Machine $MACHINE_ID is running revision $REVISION. Finish old launch cleanup using private recovery files: $BACKUP"; return 0; fi
        fi
        say "Machine $MACHINE_ID is already running revision $REVISION. Old launch entry removed."
        return 0
    fi
    [ ! -e /opt/mboard-node/agent.json ] || [ "$FORCE" = 1 ] || fail 'Use --force to replace this managed installation after backup.'
    old_bytes=0; config_bytes=0
    [ ! -f /usr/local/bin/xboard-node ] || old_bytes=$(stat -c %s /usr/local/bin/xboard-node)
    [ ! -d /etc/xboard-node ] || config_bytes=$(du -sk /etc/xboard-node | awk '{print $1 * 1024}')
    available_bytes=$(df -Pk /opt | awk 'NR==2 {printf "%.0f", $4 * 1024}')
    required_bytes=$((2 * (12583074 + 41218210) + old_bytes + config_bytes + 67108864))
    [ -n "$available_bytes" ] && [ "$available_bytes" -ge "$required_bytes" ] || fail 'Free disk space for two release copies, rollback binary, configuration and queue reserve, then retry.'
    download "$BASE/mboard-node-linux-amd64" "$STAGE/mboard-node" || fail 'Retry downloading the agent from the panel.'
    download "$BASE/sing-box-linux-amd64" "$STAGE/sing-box" || fail 'Retry downloading the core from the panel.'
    verify_binary "$STAGE/mboard-node" "$AGENT_SHA256" && verify_binary "$STAGE/sing-box" "$CORE_SHA256" || fail 'Ask the publisher to match binaries to the pinned SHA256 release.'
    chmod 700 "$STAGE/mboard-node" "$STAGE/sing-box"
    mkdir "$STAGE/tls"
    count=$(jq -r '.data.files | length' "$STAGE/response.json"); index=0
    while [ "$index" -lt "$count" ]; do
        name=$(jq -r --argjson i "$index" '.data.files[$i].path_under_mboard_tls' "$STAGE/response.json")
        jq -jr --argjson i "$index" '.data.files[$i].content' "$STAGE/response.json" > "$STAGE/tls/$name"
        chmod 600 "$STAGE/tls/$name"; index=$((index+1))
    done
    # One known source-local certificate: machine 2/node 180. Never scan/glob keys.
    if [ "$MACHINE_ID" = 2 ]; then
        certdir=/etc/xboard-node/instances/panel-example-xyz-machine-2-8256c8/node-180/certs
        for pair in cert.pem:180.crt key.pem:180.key; do
            old=${pair%%:*}; new=${pair#*:}
            if [ ! -f "$STAGE/tls/$new" ]; then
                src="$certdir/$old"
                if [ ! -f "$src" ]; then src="/etc/mboard-node/tls/$new"; fi
                plain_file "$src" && [ -f "$src" ] || fail 'Restore machine 2 node 180 local certificate before cutover.'
                cp "$src" "$STAGE/tls/$new"; chmod 600 "$STAGE/tls/$new"
            fi
        done
    fi
    secure_dir /var/lib/mboard-node
    jq --arg d "$STAGE/tls/" '.data.config | walk(if type == "string" and startswith("/etc/mboard-node/tls/") then $d + ltrimstr("/etc/mboard-node/tls/") else . end)' "$STAGE/response.json" > "$STAGE/preflight.json"
    "$STAGE/sing-box" check -c "$STAGE/preflight.json" >"$STAGE/core-check.log" 2>&1 || fail 'Ask the panel operator to review native config/TLS preflight for this machine.'
    jq --arg p "$PANEL" '.data | {panel_url:$p,token:.token,config_path:"/opt/mboard-node/sing-box.json",core_binary:"/opt/mboard-node/sing-box",data_dir:"/opt/mboard-node/data",interval:"15s",request_timeout:"15s",telemetry_interval:"5s",telemetry_timeout:"5s",telemetry_spool_max_bytes:33554432}' "$STAGE/response.json" > "$STAGE/agent.json"
    "$STAGE/mboard-node" validate -config "$STAGE/agent.json" >"$STAGE/agent-check.log" 2>&1 || fail 'Review agent configuration before cutover.'
    render_service
    secure_dir /opt/mboard-node-backups
    BACKUP=$(mktemp -d "/opt/mboard-node-backups/cutover-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX"); chmod 700 "$BACKUP"
    if [ -d /etc/xboard-node ]; then tar -czf "$BACKUP/old-config.tar.gz" -C / etc/xboard-node; fi
    if [ "$OLD_PRESENT" = 1 ]; then cp -p "$OLD_SERVICE" "$BACKUP/old-service"; fi
    if [ -e /usr/local/bin/xboard-node ]; then plain_file /usr/local/bin/xboard-node || fail 'Review old executable symlink.'; cp -p /usr/local/bin/xboard-node "$BACKUP/old-binary"; fi
    if [ -e /opt/mboard-node ]; then secure_dir /opt/mboard-node; tar -czf "$BACKUP/new-tree.tar.gz" -C / opt/mboard-node; fi
    secure_dir /etc/mboard-node
    if [ -e /etc/mboard-node/tls ]; then secure_dir /etc/mboard-node/tls; tar -czf "$BACKUP/tls-tree.tar.gz" -C / etc/mboard-node/tls; fi
    plain_file /opt/mboard-node/identity.json || fail 'Review installed identity ownership or symlink.'
    plain_file "$NEW_SERVICE" || fail 'Review new service symlink.'
    if [ -e "$NEW_SERVICE" ]; then cp -p "$NEW_SERVICE" "$BACKUP/new-service"; fi
    for archive in "$BACKUP"/*.tar.gz; do [ ! -f "$archive" ] || chmod 600 "$archive"; done
    say "Checks passed. Switching machine $MACHINE_ID. Recovery snapshot: $BACKUP"
    CUTOVER=1
    if [ "$OLD_PRESENT" = 1 ]; then service_stop xboard-node >"$BACKUP/service.log" 2>&1 || fail 'Stop the verified old service, then retry.'; fi
    if [ "$NEW_ACTIVE" = 1 ]; then service_stop mboard-node >>"$BACKUP/service.log" 2>&1 || fail 'Stop the existing managed service, then retry.'; fi
    secure_dir /opt/mboard-node; secure_dir /opt/mboard-node/data; secure_dir /etc/mboard-node/tls
    for name in mboard-node sing-box agent.json; do
        plain_file "/opt/mboard-node/$name" || fail 'Review installed file symlink.'
        cp "$STAGE/$name" "/opt/mboard-node/$name"
    done
    chmod 700 /opt/mboard-node/mboard-node /opt/mboard-node/sing-box; chmod 600 /opt/mboard-node/agent.json
    for file in "$STAGE"/tls/*; do [ -f "$file" ] || continue; name=${file##*/}; plain_file "/etc/mboard-node/tls/$name" || fail 'Review installed TLS symlink.'; cp "$file" "/etc/mboard-node/tls/$name"; chmod 600 "/etc/mboard-node/tls/$name"; done
    plain_file /opt/mboard-node/identity.json || fail 'Review installed identity ownership or symlink.'
    jq -n --arg p "$PANEL" --argjson id "$MACHINE_ID" '{panel_url:$p,machine_id:$id}' > "$STAGE/identity.json"
    mv "$STAGE/identity.json" /opt/mboard-node/identity.json
    cp "$STAGE/new-service" "$NEW_SERVICE"; chmod 755 "$NEW_SERVICE"
    reload_services >>"$BACKUP/service.log" 2>&1
    service_start mboard-node >>"$BACKUP/service.log" 2>&1 || fail 'Review new service startup using the recovery snapshot.'
    service_enable mboard-node >>"$BACKUP/service.log" 2>&1 || fail 'Enable mboard-node at boot, then retry.'
    # Activation is server-authoritative: revision + fresh core/telemetry ready heartbeat.
    deadline=$(($(date +%s)+90)); ready=0
    while [ "$(date +%s)" -lt "$deadline" ]; do
        service_active mboard-node || fail 'New agent stopped during readiness checks. Recovery starts automatically.'
        if stats_bound && [ -f /opt/mboard-node/data/state.json ] && jq -e --argjson r "$REVISION" '.revision == $r' /opt/mboard-node/data/state.json >/dev/null 2>&1; then
            if activate_once; then ready=1; break; fi
            status=$(awk '{print $0}' "$STAGE/http-status")
            case "$status" in 401|403) fail 'Ask the panel operator to restore this machine enrollment authorization.';; esac
        fi
        sleep 2
    done
    [ "$ready" = 1 ] || fail 'Readiness timed out. Recovery starts automatically. Ask the panel operator to check ready heartbeats.'
    # Activation changes the backend owner and revokes the legacy token. From this
    # commit point, keep the ready new node running even if uninstall cleanup fails.
    COMMITTED=1
    finish_old_uninstall
    printf '{"machine_id":%s,"revision":%s,"state":"switched","old_active_before":%s}\n' "$MACHINE_ID" "$REVISION" "$OLD_ACTIVE" > "$BACKUP/result.json"
    if [ "$cleanup_warning" = 1 ]; then
        say "Machine $MACHINE_ID is running revision $REVISION. Finish removing the stopped old launch entry using recovery snapshot: $BACKUP"
    else say "Machine $MACHINE_ID is running revision $REVISION. Old launch entry removed. Recovery snapshot: $BACKUP"; fi
}
activate_once() {
    # A lost reply may hide a committed activation. Signals during the request
    # leave IN_FLIGHT set, so cleanup preserves the ready new service.
    ACTIVATION_IN_FLIGHT=1
    if api_post "$STAGE/new-auth.conf" /api/node/v1/activate "$STAGE/activate.json" "$STAGE/activated.json"; then
        if validate_activation "$STAGE/activated.json"; then
            COMMITTED=1; ACTIVATION_UNCERTAIN=0; ACTIVATION_IN_FLIGHT=0; return 0
        fi
        ACTIVATION_UNCERTAIN=1
    else
        status=$(awk '{print $0}' "$STAGE/http-status")
        case "$status" in 409|401|403) :;; *) ACTIVATION_UNCERTAIN=1;; esac
    fi
    ACTIVATION_IN_FLIGHT=0
    return 1
}
validate_activation() {
    [ "$(wc -c < "$1")" -le 1048576 ] || return 1
    # API reports success in its data envelope; HTTP 2xx alone is insufficient.
    jq -se --argjson r "$REVISION" --argjson id "$MACHINE_ID" 'length == 1 and (.[0].data | type == "object" and .machine_id == $id and .config_revision == $r and .activated == true)' "$1" >/dev/null 2>&1
}
# Test helper mode only defines functions; execution always defaults to main.
if [ "${MBOARD_INSTALLER_LIBRARY:-0}" != 1 ]; then main "$@"; fi
