#!/bin/sh
# One-click mboard node deployment for a machine that already exists in the panel.
#
#   sh deploy-node.sh --machine-id 12 --token 0123...cdef [--panel https://panel.example]
#
# The machine number comes from the panel's machine list; the token is the
# 64-hex credential from the panel's "rotate token" action, or the machine's
# original 32/64-character source credential for a machine that has never been
# enrolled. Everything else is fetched from the panel.
#
# Idempotent: rerunning reconciles the same machine. `--force` replaces an
# existing installation after taking a backup. Never run with sh -x.
set -eu
umask 077

PANEL_DEFAULT=https://panel.example
WORK=/opt/mboard-node
DATA=$WORK/data
TLS_DIR=/etc/mboard-node/tls
BACKUP_ROOT=/opt/mboard-node-backups
STAGE_ROOT=/opt/mboard-node-stage
SERVICE=/etc/systemd/system/mboard-node.service
# Published release digests. The release publisher updates these together with
# deploy/install-mboard-node.sh; pass --sha-agent/--sha-core to pin another build.
AGENT_SHA256=458ccfbcfc24f428184b9125456c7c246db9508c5d343bfa510c43294847490d
CORE_SHA256=1e6b4ef716062484f52d3490c3b1c4d7798e8cd76aeaba3f01e9f3320c63bd90

say() { printf '%s\n' "$*"; }
warn() { printf 'attention: %s\n' "$*" >&2; }
die() { printf 'deploy-node stopped: %s\n' "$*" >&2; exit 1; }
usage() {
    cat <<'USAGE'
Usage: sh deploy-node.sh --machine-id N --token TOKEN [options]

  --machine-id N     machine number from the panel (required)
  --token TOKEN      panel token, or the machine's original source credential
  --panel URL        panel HTTPS origin (default https://panel.example)
  --binary-dir DIR   use mboard-node and sing-box from DIR instead of downloading
  --sha-agent HEX    expected sha256 of the node binary (default: published release)
  --sha-core HEX     expected sha256 of the sing-box core (default: published release)
  --core-version V   core version to record when the panel does not set one
  --force            reinstall over an existing installation after a backup
  --dry-run          run every check, then stop before touching the system
  --help             show this text

Environment equivalents: MBOARD_PANEL, MBOARD_MACHINE_ID, MBOARD_NODE_TOKEN.
USAGE
}

# --- input validation -------------------------------------------------------
hex64() { [ "${#1}" -eq 64 ] && case "$1" in *[!0-9a-fA-F]*) return 1;; *) return 0;; esac; }
hex_any() { [ "${#1}" -eq 64 ] && hex64 "$1"; }
token_shape() { case "${#1}" in 32|64) case "$1" in *[!A-Za-z0-9_-]*) return 1;; *) return 0;; esac;; *) return 1;; esac; }
valid_id() { case "$1" in ''|0|0*|*[!0-9]*) return 1;; esac; [ "${#1}" -le 15 ]; }
valid_origin() {
    case "$1" in https://*) host=${1#https://};; *) return 1;; esac
    case "$host" in ''|*[!a-zA-Z0-9.:-]*|:*|*:) return 1;; esac
    printf '%s\n' "$host" | awk -F: 'NF>2 {exit 1} $1 !~ /^[a-zA-Z0-9][a-zA-Z0-9.-]*$/ {exit 1} NF==2 && ($2 !~ /^[0-9]+$/ || $2<1 || $2>65535) {exit 1}'
}

# --- helpers ----------------------------------------------------------------
secure_dir() {
    [ ! -L "$1" ] || die "replace the symlink at $1 with a root-owned directory"
    if [ -e "$1" ]; then
        [ -d "$1" ] && [ "$(stat -c %u "$1")" = 0 ] || die "review ownership of $1"
    else mkdir -p "$1"; fi
    chmod 700 "$1"
}
plain_file() {
    [ ! -L "$1" ] && { [ ! -e "$1" ] || { [ -f "$1" ] && [ "$(stat -c %u "$1")" = 0 ] && [ "$(stat -c %h "$1")" = 1 ]; }; }
}
download() {
    if command -v curl >/dev/null 2>&1; then
        curl --disable --proto '=https' --tlsv1.2 --fail --silent --show-error \
            --connect-timeout 20 --max-time 600 --output "$2" "$1"
    else
        wget -q -T 60 -O "$2" "$1"
    fi
}
verify_sha() { [ -z "$2" ] || printf '%s  %s\n' "$2" "$1" | sha256sum -c - >/dev/null 2>&1; }
sha_of() { sha256sum "$1" | awk '{print $1}'; }

install_deps() {
    missing=
    for tool in jq curl sha256sum tar awk stat; do
        command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
    done
    [ -n "$missing" ] || return 0
    say "installing prerequisites:$missing"
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update >/dev/null 2>&1
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends $missing >/dev/null 2>&1
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache $missing >/dev/null 2>&1
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y $missing >/dev/null 2>&1
    else
        die "install these with the system package manager, then rerun:$missing"
    fi
    for tool in jq curl sha256sum tar awk stat; do
        command -v "$tool" >/dev/null 2>&1 || die "still missing $tool after install"
    done
}

api() {
    # api METHOD PATH BODY_FILE OUT_FILE -> echoes the HTTP status
    method=$1; path=$2; body=$3; out=$4
    if [ -n "$body" ]; then
        curl --disable --proto '=https' --tlsv1.2 --silent --show-error -o "$out" -w '%{http_code}' \
            --connect-timeout 15 --max-time 60 --max-filesize 16777216 \
            -H "Authorization: Bearer $BEARER" -H 'Accept: application/json' \
            -H 'Content-Type: application/json' --request "$method" --data-binary "@$body" "$PANEL$path"
    else
        curl --disable --proto '=https' --tlsv1.2 --silent --show-error -o "$out" -w '%{http_code}' \
            --connect-timeout 15 --max-time 60 --max-filesize 16777216 \
            -H "Authorization: Bearer $BEARER" -H 'Accept: application/json' \
            --request "$method" "$PANEL$path"
    fi
}
api_code() { jq -r '.error.code // empty' "$1" 2>/dev/null || true; }

# The enrollment bundle is the only trusted input; check every field the agent
# depends on before anything is written outside the staging directory.
validate_bundle() {
    [ "$(wc -c < "$1")" -le 16777216 ] || return 1
    jq -se '
      length == 1 and (.[0].data | type == "object" and
      (.token | type == "string" and test("^[0-9a-f]{64}$")) and
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
validate_activation() {
    [ "$(wc -c < "$1")" -le 1048576 ] || return 1
    jq -se --argjson r "$REVISION" --argjson id "$MACHINE_ID" \
        'length == 1 and (.[0].data | type == "object" and .machine_id == $id and .config_revision == $r and .activated == true)' \
        "$1" >/dev/null 2>&1
}

render_service() {
    cat > "$1" <<UNIT
[Unit]
Description=mboard independent node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WORK
ExecStart=$WORK/mboard-node run -config $WORK/agent.json
Restart=on-failure
RestartSec=3
TimeoutStopSec=75
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$WORK $TLS_DIR /var/lib/mboard-node

[Install]
WantedBy=multi-user.target
UNIT
    chmod 755 "$1"
}

service_active() { systemctl is-active --quiet mboard-node; }
service_stop() { systemctl stop mboard-node >/dev/null 2>&1 || true; }

cleanup() {
    code=$?
    [ -z "${STAGE:-}" ] || rm -rf "$STAGE"
    [ "${LOCKED:-0}" = 0 ] || rmdir "$STAGE_ROOT/install.lock" 2>/dev/null || true
    if [ "$code" -ne 0 ] && [ "${TOUCHED:-0}" = 1 ] && [ "${ACTIVATED:-0}" = 0 ]; then
        warn "the service may be running with an unconfirmed configuration; inspect: systemctl status mboard-node; journalctl -u mboard-node -n 50"
    fi
    exit "$code"
}

# --- main -------------------------------------------------------------------
main() {
    PANEL=${MBOARD_PANEL:-$PANEL_DEFAULT}
    MACHINE_ID=${MBOARD_MACHINE_ID:-}
    TOKEN=${MBOARD_NODE_TOKEN:-}
    BINARY_DIR=; SHA_AGENT=$AGENT_SHA256; SHA_CORE=$CORE_SHA256; SHA_PINNED=0; CORE_VERSION=; FORCE=0; DRY=0
    STAGE=; LOCKED=0; TOUCHED=0; ACTIVATED=0

    while [ "$#" -gt 0 ]; do
        case "$1" in
            --machine-id|--token|--panel|--binary-dir|--sha-agent|--sha-core|--core-version)
                [ "$#" -ge 2 ] || die "$1 needs a value"
                case "$1" in
                    --machine-id) MACHINE_ID=$2;;
                    --token) TOKEN=$2;;
                    --panel) PANEL=$2;;
                    --binary-dir) BINARY_DIR=$2;;
                    --sha-agent) SHA_AGENT=$2; SHA_PINNED=1;;
                    --sha-core) SHA_CORE=$2; SHA_PINNED=1;;
                    --core-version) CORE_VERSION=$2;;
                esac
                shift 2;;
            --force) FORCE=1; shift;;
            --dry-run) DRY=1; shift;;
            --help|-h) usage; return 0;;
            *) usage >&2; die "unknown option: $1";;
        esac
    done

    [ "$(id -u)" = 0 ] || die 'run as root'
    [ "$(uname -s)" = Linux ] || die 'this path targets Linux'
    [ "$(uname -m)" = x86_64 ] || [ -n "$BINARY_DIR" ] || die 'the published binaries are amd64; pass --binary-dir with a local build for this architecture'
    PANEL=${PANEL%/}
    valid_origin "$PANEL" || die 'set --panel to an HTTPS origin such as https://panel.example'
    valid_id "$MACHINE_ID" || die 'set --machine-id to the machine number from the panel'
    token_shape "$TOKEN" || die 'set --token to the panel or original machine credential (32 or 64 characters)'
    [ -z "$SHA_AGENT" ] || hex_any "$SHA_AGENT" || die '--sha-agent must be a sha256 hex digest'
    [ -z "$SHA_CORE" ] || hex_any "$SHA_CORE" || die '--sha-core must be a sha256 hex digest'
    # A local build is not the published release, so an explicit digest is the
    # only meaningful check for it. Without one, compare nothing and report what
    # was installed.
    if [ -n "$BINARY_DIR" ] && [ "$SHA_PINNED" = 0 ]; then SHA_AGENT=; SHA_CORE=; fi

    install_deps
    command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || die 'systemd is required; the OpenRC path lives in install-mboard-node.sh'

    # One managed identity per machine: reruns reconcile, --force replaces.
    if [ -e "$WORK/agent.json" ] && [ ! -e "$WORK/identity.json" ] && [ "$FORCE" = 0 ]; then
        die "$WORK holds an install without an identity file; pass --force to replace it after a backup"
    fi
    if [ -e "$WORK/identity.json" ] && [ "$FORCE" = 0 ]; then
        plain_file "$WORK/identity.json" || die "review $WORK/identity.json"
        have_panel=$(jq -r '.panel_url // empty' "$WORK/identity.json" 2>/dev/null || true)
        have_id=$(jq -r '.machine_id // empty' "$WORK/identity.json" 2>/dev/null || true)
        [ "$have_panel" = "$PANEL" ] || die "this host is registered to $have_panel; pass --force to move it"
        [ "$have_id" = "$MACHINE_ID" ] || die "this host is registered as machine $have_id; pass --force to change it"
        if service_active; then
            say "machine $MACHINE_ID is already installed here; reconciling configuration and token"
        fi
    fi

    secure_dir "$STAGE_ROOT"
    mkdir "$STAGE_ROOT/install.lock" 2>/dev/null || die "another run owns $STAGE_ROOT/install.lock"
    LOCKED=1
    trap cleanup EXIT
    trap 'exit 130' INT
    trap 'exit 143' HUP TERM
    STAGE=$(mktemp -d "$STAGE_ROOT/run.XXXXXX"); chmod 700 "$STAGE"

    # 1. Enrollment doubles as authentication: the panel returns the current
    #    token when the bearer already matches, derives one from an original
    #    source credential, and refuses a stale credential after rotation.
    BEARER=$TOKEN
    printf '{"machine_id":%s}\n' "$MACHINE_ID" > "$STAGE/enroll.json"
    say "authenticating machine $MACHINE_ID against $PANEL"
    status=$(api POST /api/node/v1/enroll "$STAGE/enroll.json" "$STAGE/bundle.json")
    case "$status" in
        200) ;;
        409)
            code=$(api_code "$STAGE/bundle.json")
            case "$code" in
                NODE_ENROLLED|NODE_CREDENTIAL_CHANGED)
                    die "this machine is already enrolled: rotate its token in the panel (POST /api/v1/admin/machines/$MACHINE_ID/token) and rerun with the new 64-hex token";;
                *) die "the panel refused enrollment ($code)";;
            esac;;
        401) die "the panel rejected the credential for machine $MACHINE_ID; copy the token from the panel, and confirm the machine number exists";;
        404) die 'the panel has no machine with this number';;
        *) die "enrollment failed with HTTP $status";;
    esac
    validate_bundle "$STAGE/bundle.json" || die 'the panel bundle failed validation; ask the operator to check the compiled config'
    REVISION=$(jq -r .data.revision "$STAGE/bundle.json")
    BEARER=$(jq -r .data.token "$STAGE/bundle.json")
    hex64 "$BEARER" || die 'the panel returned a malformed token'
    say "panel reports config revision $REVISION"

    # 2. Binaries: from a local build, or from the panel's published downloads.
    mkdir "$STAGE/bin"
    if [ -n "$BINARY_DIR" ]; then
        for pair in mboard-node:agent sing-box:core; do
            src=$BINARY_DIR/${pair%%:*}; [ -f "$src" ] || die "missing $src"
            cp "$src" "$STAGE/bin/${pair##*:}"
        done
    else
        say "downloading the node and core from $PANEL/downloads"
        download "$PANEL/downloads/mboard-node-linux-amd64" "$STAGE/bin/agent" || die 'could not download the node binary'
        download "$PANEL/downloads/sing-box-linux-amd64" "$STAGE/bin/core" || die 'could not download the sing-box core'
    fi
    verify_sha "$STAGE/bin/agent" "$SHA_AGENT" || die 'the node binary does not match the expected sha256'
    verify_sha "$STAGE/bin/core" "$SHA_CORE" || die 'the core does not match the expected sha256'
    AGENT_DIGEST=$(sha_of "$STAGE/bin/agent"); CORE_DIGEST=$(sha_of "$STAGE/bin/core")
    [ -n "$SHA_AGENT" ] || warn "no pinned digest for the node binary; installing $AGENT_DIGEST"
    [ -n "$SHA_CORE" ] || warn "no pinned digest for the core; installing $CORE_DIGEST"
    chmod 700 "$STAGE/bin/agent" "$STAGE/bin/core"

    # 3. Layer in the TLS material the bundle carries, then preflight the exact
    #    config the core will load with the paths rewritten to staging.
    mkdir "$STAGE/tls"
    count=$(jq -r '.data.files | length' "$STAGE/bundle.json"); index=0
    while [ "$index" -lt "$count" ]; do
        name=$(jq -r --argjson i "$index" '.data.files[$i].path_under_mboard_tls' "$STAGE/bundle.json")
        jq -jr --argjson i "$index" '.data.files[$i].content' "$STAGE/bundle.json" > "$STAGE/tls/$name"
        chmod 600 "$STAGE/tls/$name"; index=$((index + 1))
    done
    jq --arg d "$STAGE/tls/" '.data.config | walk(if type == "string" and startswith("/etc/mboard-node/tls/") then $d + ltrimstr("/etc/mboard-node/tls/") else . end)' \
        "$STAGE/bundle.json" > "$STAGE/preflight.json"
    "$STAGE/bin/core" check -c "$STAGE/preflight.json" > "$STAGE/core-check.log" 2>&1 \
        || die "the core rejected the compiled config: $(tail -3 "$STAGE/core-check.log" | tr '\n' ' ')"

    jq --arg p "$PANEL" --arg cv "${CORE_VERSION:-1.14}" '.data | {
        panel_url: $p, token: .token,
        config_path: "'"$WORK"'/server.json",
        core_binary: "'"$WORK"'/sing-box",
        data_dir: "'"$DATA"'",
        interval: "10s", request_timeout: "20s",
        telemetry_interval: "5s", telemetry_timeout: "5s",
        telemetry_spool_max_bytes: 33554432}' "$STAGE/bundle.json" > "$STAGE/agent.json"
    "$STAGE/bin/agent" validate -config "$STAGE/agent.json" > "$STAGE/agent-check.log" 2>&1 \
        || die "the node rejected its own config: $(tail -3 "$STAGE/agent-check.log" | tr '\n' ' ')"
    say 'preflight passed for the core and the node'

    if [ "$DRY" = 1 ]; then
        say "dry run: machine $MACHINE_ID, revision $REVISION, $(jq -r '.data.files | length' "$STAGE/bundle.json") TLS files, $(jq -r '.data.traffic_labels | length' "$STAGE/bundle.json") traffic labels"
        say 'nothing was written outside the staging directory'
        return 0
    fi

    # 4. Install. Everything written from here can be rolled back from $BACKUP.
    BACKUP=$BACKUP_ROOT/deploy-$(date -u +%Y%m%dT%H%M%SZ)
    secure_dir "$BACKUP_ROOT"; mkdir "$BACKUP"; chmod 700 "$BACKUP"
    if [ -e "$WORK" ]; then
        service_stop
        tar -czf "$BACKUP/tree.tar.gz" -C / "${WORK#/}" 2>/dev/null || true
    fi
    [ ! -e "$SERVICE" ] || cp -p "$SERVICE" "$BACKUP/mboard-node.service"
    [ ! -d "$TLS_DIR" ] || tar -czf "$BACKUP/tls.tar.gz" -C / "${TLS_DIR#/}" 2>/dev/null || true
    chmod 600 "$BACKUP"/* 2>/dev/null || true

    TOUCHED=1
    secure_dir "$WORK"; secure_dir "$DATA"; secure_dir "$TLS_DIR"; secure_dir /var/lib/mboard-node
    for name in agent.json identity.json server.json; do
        plain_file "$WORK/$name" || die "review the symlink at $WORK/$name"
    done
    install -m 700 "$STAGE/bin/agent" "$WORK/mboard-node"
    install -m 700 "$STAGE/bin/core" "$WORK/sing-box"
    install -m 600 "$STAGE/agent.json" "$WORK/agent.json"
    install -m 600 "$STAGE/preflight.json" "$WORK/preflight.json"
    for file in "$STAGE"/tls/*; do
        [ -f "$file" ] || continue
        name=${file##*/}
        plain_file "$TLS_DIR/$name" || die "review the symlink at $TLS_DIR/$name"
        install -m 600 "$file" "$TLS_DIR/$name"
    done
    jq -n --arg p "$PANEL" --argjson id "$MACHINE_ID" '{panel_url:$p,machine_id:$id}' > "$STAGE/identity.json"
    install -m 600 "$STAGE/identity.json" "$WORK/identity.json"
    render_service "$STAGE/mboard-node.service"
    plain_file "$SERVICE" || die "review the symlink at $SERVICE"
    install -m 755 "$STAGE/mboard-node.service" "$SERVICE"
    systemctl daemon-reload

    # 5. Start, then activate only after the panel sees a ready heartbeat.
    systemctl enable --now mboard-node >/dev/null 2>&1 || die 'the node service did not start; check journalctl -u mboard-node'
    say 'waiting for the core and telemetry to become ready'
    printf '{"config_revision":%s}\n' "$REVISION" > "$STAGE/activate.json"
    deadline=$(($(date +%s) + 120)); activated=0
    while [ "$(date +%s)" -lt "$deadline" ]; do
        service_active || die 'the node service stopped during startup; check journalctl -u mboard-node'
        if [ -f "$DATA/state.json" ] && jq -e --argjson r "$REVISION" '.revision == $r' "$DATA/state.json" >/dev/null 2>&1; then
            status=$(api POST /api/node/v1/activate "$STAGE/activate.json" "$STAGE/activated.json")
            if [ "$status" = 200 ] && validate_activation "$STAGE/activated.json"; then activated=1; break; fi
            [ "$status" != 401 ] && [ "$status" != 403 ] || die 'the panel withdrew authorization during activation'
        fi
        sleep 3
    done
    [ "$activated" = 1 ] || die 'activation timed out; the node stays installed — check readiness with: journalctl -u mboard-node -n 50'
    ACTIVATED=1

    say ""
    say "machine $MACHINE_ID is active on revision $REVISION"
    say "  node:    $WORK (node $AGENT_DIGEST, core $CORE_DIGEST)"
    say "  data:    $DATA (queue in $DATA/spool, refused batches in $DATA/spool/rejected)"
    say "  backup:  $BACKUP"
    say "  verify:  systemctl status mboard-node; journalctl -u mboard-node -n 30"
    say "  revert:  systemctl disable --now mboard-node && tar -xzf $BACKUP/tree.tar.gz -C /"
}

# Test helper mode only defines functions; execution always defaults to main.
if [ "${MBOARD_DEPLOY_LIBRARY:-0}" != 1 ]; then main "$@"; fi
