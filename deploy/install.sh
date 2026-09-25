#!/usr/bin/env bash
# Installs or refreshes the minizep HTTP service (MCP + REST) as a systemd unit.
#
# Run as root on the target host, from a checkout:
#   sudo deploy/install.sh --user minizep --env-file /etc/minizep/minizep.env
#   deploy/install.sh --dry-run --user minizep ...   # print the steps and the unit, change nothing
#
# Every step can be repeated safely:
#   1. npm ci and npm run build in --dir, as --user;
#   2. render deploy/systemd/minizep.service and install it as
#      /etc/systemd/system/minizep.service (rewritten only when it changed);
#   3. create --env-file from deploy/minizep.env.example when it does not exist (root-owned,
#      mode 600). An existing file is never modified;
#   4. systemctl daemon-reload; then, once the env file is filled in (no CHANGE_ME left,
#      MINIZEP_TOKENS set), enable and restart the service and poll GET /health on its
#      loopback address until it answers {"ok":true}.
#
# Options:
#   --user NAME          account the service runs as; not root (default: $SUDO_USER)
#   --dir PATH           checkout to build and run (default: the one containing this script)
#   --env-file PATH      environment file (default: /etc/minizep/minizep.env)
#   --node PATH          node binary >= 20.11 (default: node on PATH; root's PATH under sudo
#                        often lacks a node installed with nvm)
#   --snapshot-dir PATH  in-memory store only: directory of MINIZEP_DB, created for --user
#                        and made writable in the sandbox
#   --health-timeout S   seconds to wait for /health after the restart (default: 60)
#   --dry-run            print what would be done, including the rendered unit
#   -h, --help
# Environment: MINIZEP_UNIT_DIR overrides /etc/systemd/system (tests).
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TEMPLATE="$HERE/systemd/minizep.service"
EXAMPLE="$HERE/minizep.env.example"
UNIT_NAME=minizep.service
UNIT_DIR="${MINIZEP_UNIT_DIR:-/etc/systemd/system}"

SVC_USER="${SUDO_USER:-}"
DIR=$(dirname "$HERE")
ENV_FILE=/etc/minizep/minizep.env
NODE=""
SNAPSHOT_DIR=""
HEALTH_TIMEOUT=60
DRY_RUN=0

say() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}"; }

# Runs a command, or prints it under --dry-run.
run() {
  if [ "$DRY_RUN" = 1 ]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    "$@"
  fi
}

# ---- arguments -----------------------------------------------------------------------

need_value() { if [ $# -lt 2 ] || [ -z "$2" ]; then die "$1 needs a value"; fi; }

while [ $# -gt 0 ]; do
  case "$1" in
    --user) need_value "$@"; SVC_USER=$2; shift 2 ;;
    --dir) need_value "$@"; DIR=$2; shift 2 ;;
    --env-file) need_value "$@"; ENV_FILE=$2; shift 2 ;;
    --node) need_value "$@"; NODE=$2; shift 2 ;;
    --snapshot-dir) need_value "$@"; SNAPSHOT_DIR=$2; shift 2 ;;
    --health-timeout) need_value "$@"; HEALTH_TIMEOUT=$2; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

if [ "$DRY_RUN" = 0 ] && [ "$(id -u)" != 0 ]; then
  die "run as root (sudo), or pass --dry-run to only print the steps"
fi

# Paths end up in the unit file and in a sed replacement: allow only characters that
# mean nothing to either (no spaces, %, @, |, &, \), and no relative components.
SAFE_PATH='^/[A-Za-z0-9._/+-]*$'
check_path() {
  [[ $2 =~ $SAFE_PATH ]] || die "$1 must be an absolute path of letters, digits and . _ / + - (got: $2)"
  case "/$2/" in
    */../* | */./*) die "$1 must not contain . or .. components (got: $2)" ;;
  esac
}
strip_slash() { local p=$1; while [ "${#p}" -gt 1 ] && [ "${p%/}" != "$p" ]; do p=${p%/}; done; printf '%s' "$p"; }

SAFE_USER='^[A-Za-z_][A-Za-z0-9_.-]*$'
[ -n "$SVC_USER" ] || die "--user is required (the unprivileged account to run the service as)"
[[ $SVC_USER =~ $SAFE_USER ]] || die "invalid user name: $SVC_USER"
[ "$SVC_USER" != root ] || die "--user must not be root: the service runs unprivileged"
if id -u "$SVC_USER" >/dev/null 2>&1; then
  [ "$(id -u "$SVC_USER")" != 0 ] || die "--user $SVC_USER has uid 0"
elif [ "$DRY_RUN" = 1 ]; then
  warn "user $SVC_USER does not exist on this host"
else
  die "user $SVC_USER does not exist (create it first, e.g. useradd --system --create-home $SVC_USER)"
fi

DIR=$(strip_slash "$DIR")
ENV_FILE=$(strip_slash "$ENV_FILE")
check_path --dir "$DIR"
check_path --env-file "$ENV_FILE"
[ -f "$DIR/package.json" ] || die "--dir $DIR is not a minizep checkout (no package.json)"
if [ -n "$SNAPSHOT_DIR" ]; then
  SNAPSHOT_DIR=$(strip_slash "$SNAPSHOT_DIR")
  check_path --snapshot-dir "$SNAPSHOT_DIR"
fi
[[ $HEALTH_TIMEOUT =~ ^[0-9]+$ ]] || die "--health-timeout must be a number of seconds"

if [ -z "$NODE" ]; then
  NODE=$(command -v node || true)
  [ -n "$NODE" ] || die "node not found on PATH; pass --node /path/to/node"
fi
check_path --node "$NODE"
[ -x "$NODE" ] || die "--node $NODE is not executable"
"$NODE" -e 'const [a, b] = process.versions.node.split(".").map(Number);
process.exit(a > 20 || (a === 20 && b >= 11) ? 0 : 1)' ||
  die "node $("$NODE" --version) is too old: minizep needs >= 20.11"
NODE_DIR=$(dirname "$NODE")

if [ "$DRY_RUN" = 0 ]; then
  for tool in systemctl runuser install getent; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found: this installer targets a systemd Linux host"
  done
fi

SVC_HOME=$(getent passwd "$SVC_USER" 2>/dev/null | cut -d: -f6 || true)
[ -n "$SVC_HOME" ] || SVC_HOME="/home/$SVC_USER"

tmp_base=${TMPDIR:-/tmp}
WORK=$(mktemp -d "${tmp_base%/}/minizep-install.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

# ---- env file helpers ------------------------------------------------------------------

# Value of the last uncommented KEY=... line of the env file (what systemd uses), with one
# pair of surrounding quotes removed. Empty when the key is absent.
env_value() {
  [ -r "$ENV_FILE" ] || return 0
  awk -v key="$1" '
    { line = $0; sub(/^[ \t]+/, "", line) }
    index(line, key "=") == 1 { v = substr(line, length(key) + 2); found = 1 }
    END {
      if (!found) exit
      sub(/[ \t\r]+$/, "", v)
      q = substr(v, 1, 1)
      if (length(v) >= 2 && (q == "\"" || q == "\047") && substr(v, length(v), 1) == q) v = substr(v, 2, length(v) - 2)
      print v
    }' "$ENV_FILE"
}

# Prints why the env file is not ready for the service; prints nothing when it is.
env_not_ready() {
  if [ ! -e "$ENV_FILE" ]; then
    echo "$ENV_FILE does not exist yet"
  elif [ ! -r "$ENV_FILE" ]; then
    echo "$ENV_FILE is not readable by $(id -un)"
  else
    local left
    left=$(grep -E '^[[:space:]]*[A-Za-z_][A-Za-z0-9_]*=.*CHANGE_ME' "$ENV_FILE" | cut -d= -f1 | tr -d ' \t' | paste -sd, - || true)
    [ -z "$left" ] || echo "CHANGE_ME left in: $left"
    [ -n "$(env_value MINIZEP_TOKENS)" ] || echo "MINIZEP_TOKENS is empty (create entries with deploy/tokens.sh)"
  fi
}

# Loopback URL of /health, from MINIZEP_HOST and MINIZEP_PORT in the env file.
health_url() {
  local hosts port host pick="" first=""
  local -a list
  hosts=$(env_value MINIZEP_HOST | tr -d ' \t\133\135')
  port=$(env_value MINIZEP_PORT)
  [[ ${port:-8787} =~ ^[0-9]+$ ]] || die "MINIZEP_PORT in $ENV_FILE is not a number: $port"
  IFS=, read -r -a list <<<"${hosts:-127.0.0.1}"
  for host in "${list[@]}"; do
    [ -n "$host" ] || continue
    [ -n "$first" ] || first=$host
    case "$host" in
      127.* | localhost | ::1) pick=$host; break ;;
      0.0.0.0) pick=127.0.0.1; break ;;
      ::) pick=::1; break ;;
    esac
  done
  if [ -z "$pick" ]; then
    pick=${first:-127.0.0.1}
    warn "MINIZEP_HOST has no loopback address; polling $pick instead"
  fi
  case "$pick" in *:*) pick="[$pick]" ;; esac
  printf 'http://%s:%s/health' "$pick" "${port:-8787}"
}

# Warnings about an env file that would start but not do what a VPN deployment wants.
check_env_file() {
  [ -r "$ENV_FILE" ] || return 0
  local hosts db
  hosts=$(env_value MINIZEP_HOST | tr -d ' \t\133\135')
  case ",$hosts," in
    *,0.0.0.0,* | *,::,*)
      warn "MINIZEP_HOST contains a wildcard address: the service listens on every interface." \
        "On a host with a public interface, list loopback and the VPN address instead." ;;
  esac
  if [ -n "$(find "$ENV_FILE" -prune \( -perm -004 -o -perm -040 \) -print)" ]; then
    warn "$ENV_FILE is readable by group or others; it holds tokens: chmod 600 $ENV_FILE"
  fi
  if [ -z "$(env_value MINIZEP_DATABASE_URL)" ]; then
    db=$(env_value MINIZEP_DB)
    if [ -z "$SNAPSHOT_DIR" ]; then
      warn "MINIZEP_DATABASE_URL is not set: the service uses the in-memory store, and its" \
        "snapshot cannot be written in the sandbox. Set MINIZEP_DATABASE_URL, or pass" \
        "--snapshot-dir with MINIZEP_DB inside it."
    elif [ "${db%/*}" != "$SNAPSHOT_DIR" ]; then
      warn "set MINIZEP_DB=$SNAPSHOT_DIR/graph.json in $ENV_FILE: only --snapshot-dir is writable"
    fi
  fi
}

# ---- 1. build --------------------------------------------------------------------------

# Runs a command as the service user, with the chosen node first on PATH.
as_user() {
  run runuser -u "$SVC_USER" -- env HOME="$SVC_HOME" PATH="$NODE_DIR:/usr/local/bin:/usr/bin:/bin" "$@"
}

say "building $DIR as $SVC_USER (node $("$NODE" --version))"
cd "$DIR"
if [ "$DRY_RUN" = 0 ] && ! as_user test -w "$DIR"; then
  die "$DIR is not writable by $SVC_USER: chown -R $SVC_USER $DIR"
fi
as_user npm ci
as_user npm run build
[ "$DRY_RUN" = 1 ] || [ -f "$DIR/dist/server/http.js" ] || die "build did not produce dist/server/http.js"

# ---- 2. unit ---------------------------------------------------------------------------

if [ -n "$SNAPSHOT_DIR" ]; then
  snapshot_expr="s|^#ReadWritePaths=@SNAPSHOT_DIR@\$|ReadWritePaths=$SNAPSHOT_DIR|"
else
  snapshot_expr='s|@SNAPSHOT_DIR@|/path/to/snapshot-dir|'
fi
{
  echo "# Rendered by deploy/install.sh from deploy/systemd/minizep.service; edit the template"
  echo "# in the checkout and run install.sh again instead of editing this file."
  sed -e "$snapshot_expr" \
    -e "s|@USER@|$SVC_USER|g" \
    -e "s|@WORKDIR@|$DIR|g" \
    -e "s|@ENV_FILE@|$ENV_FILE|g" \
    -e "s|@NODE@|$NODE|g" \
    "$TEMPLATE"
} >"$WORK/$UNIT_NAME"
if grep -n '@[A-Z_]*@' "$WORK/$UNIT_NAME" >&2; then
  die "placeholders left in the rendered unit (above)"
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "----- rendered $UNIT_DIR/$UNIT_NAME -----"
  cat "$WORK/$UNIT_NAME"
  echo "----- end of unit -----"
fi
if [ -f "$UNIT_DIR/$UNIT_NAME" ] && cmp -s "$WORK/$UNIT_NAME" "$UNIT_DIR/$UNIT_NAME"; then
  say "unit $UNIT_DIR/$UNIT_NAME is up to date"
else
  if [ -f "$UNIT_DIR/$UNIT_NAME" ]; then
    say "updating $UNIT_DIR/$UNIT_NAME:"
    diff -u "$UNIT_DIR/$UNIT_NAME" "$WORK/$UNIT_NAME" || true
  else
    say "installing $UNIT_DIR/$UNIT_NAME"
  fi
  run install -m 0644 -o 0 -g 0 "$WORK/$UNIT_NAME" "$UNIT_DIR/$UNIT_NAME"
fi

if [ -n "$SNAPSHOT_DIR" ]; then
  if [ -d "$SNAPSHOT_DIR" ]; then
    say "snapshot directory $SNAPSHOT_DIR exists; leaving it as is"
    if [ "$DRY_RUN" = 0 ] && ! as_user test -w "$SNAPSHOT_DIR"; then
      die "$SNAPSHOT_DIR is not writable by $SVC_USER"
    fi
  else
    run install -d -m 0700 -o "$SVC_USER" -g "$(id -gn "$SVC_USER" 2>/dev/null || echo "$SVC_USER")" "$SNAPSHOT_DIR"
  fi
fi

# ---- 3. env file -----------------------------------------------------------------------

if [ -e "$ENV_FILE" ]; then
  say "env file $ENV_FILE exists; leaving it unchanged"
else
  say "creating $ENV_FILE from deploy/minizep.env.example (root-owned, mode 600)"
  [ -d "$(dirname "$ENV_FILE")" ] || run install -d -m 0750 -o 0 -g 0 "$(dirname "$ENV_FILE")"
  run install -m 0600 -o 0 -g 0 "$EXAMPLE" "$ENV_FILE"
fi
check_env_file

# ---- 4. systemd ------------------------------------------------------------------------

run systemctl daemon-reload

if [ "$DRY_RUN" = 1 ] && [ ! -e "$ENV_FILE" ]; then
  not_ready="$ENV_FILE would be created from the example and still needs filling in"
elif [ "$DRY_RUN" = 1 ] && [ ! -r "$ENV_FILE" ]; then
  warn "cannot read $ENV_FILE as $(id -un); assuming it is filled in (run the dry run with sudo to check it)"
  not_ready=""
else
  not_ready=$(env_not_ready)
fi
if [ -n "$not_ready" ]; then
  say "not enabling or starting $UNIT_NAME yet:"
  printf '%s\n' "$not_ready" | sed 's/^/    /'
  say "fill in $ENV_FILE (sudoedit $ENV_FILE; see docs/DEPLOY.md), then run this installer again"
  exit 0
fi

url=$(health_url) # before any change: fails on an unusable MINIZEP_PORT
run systemctl enable "$UNIT_NAME"
run systemctl restart "$UNIT_NAME"
if [ "$DRY_RUN" = 1 ]; then
  say "would poll $url for up to ${HEALTH_TIMEOUT}s"
  exit 0
fi

# ---- 5. health -------------------------------------------------------------------------

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --noproxy '*' --max-time 3 "$1"
  else
    "$NODE" -e 'fetch(process.argv[1], { signal: AbortSignal.timeout(3000) })
      .then(async (r) => { if (!r.ok) process.exit(1); process.stdout.write(await r.text()); })
      .catch(() => process.exit(1));' "$1"
  fi
}

say "waiting for $url"
OK_BODY='"ok"[[:space:]]*:[[:space:]]*true'
deadline=$(($(date +%s) + HEALTH_TIMEOUT))
while :; do
  if body=$(fetch "$url" 2>/dev/null) && [[ $body =~ $OK_BODY ]]; then
    say "minizep is up: $url answered $body"
    exit 0
  fi
  [ "$(date +%s)" -lt "$deadline" ] || break
  sleep 1
done
systemctl --no-pager --full status "$UNIT_NAME" || true
journalctl --no-pager -u "$UNIT_NAME" -n 50 || true
die "no healthy answer from $url within ${HEALTH_TIMEOUT}s (status and log above)"
