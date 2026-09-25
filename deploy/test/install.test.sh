#!/usr/bin/env bash
# Tests for deploy/install.sh. Every run is a --dry-run against a temporary checkout, env
# file and unit directory, so nothing here needs root, systemd, npm or the network, and
# the tests also check that a dry run writes nothing.
#
#   bash deploy/test/install.test.sh
# shellcheck disable=SC2317,SC2329  # helpers are called through check()
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DEPLOY=$(dirname "$HERE")
REPO=$(dirname "$DEPLOY")
INSTALL="$DEPLOY/install.sh"
TEMPLATE="$DEPLOY/systemd/minizep.service"
EXAMPLE="$DEPLOY/minizep.env.example"
tmp_base=${TMPDIR:-/tmp}
ROOT=$(mktemp -d "${tmp_base%/}/install-test.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT

NODE_BIN=$(command -v node) || { echo "node not found on PATH"; exit 1; }
SVC=minizep-test # need not exist: a dry run only warns

PASSED=0
FAILED=0
N=0

# A case gets a fresh directory T with a fake checkout (APP), the env file path (ENVF,
# absent until the case creates it) and a unit directory (UNITS, absent).
new_case() {
  CASE=$1
  N=$((N + 1))
  T="$ROOT/case$N"
  APP="$T/app"
  ENVF="$T/etc/minizep.env"
  UNITS="$T/units"
  mkdir -p "$APP"
  echo '{ "name": "minizep" }' >"$APP/package.json"
  : >"$T/out"
  echo "# $CASE"
}

# install [args...]: dry run with the case's paths; output in $T/out, status in $RC.
install_dry() {
  MINIZEP_UNIT_DIR="$UNITS" bash "$INSTALL" --dry-run --user "$SVC" --dir "$APP" \
    --env-file "$ENVF" --node "$NODE_BIN" "$@" >"$T/out" 2>&1
  RC=$?
  sed -n '/^----- rendered /,/^----- end of unit -----$/{/^-----/d;p;}' "$T/out" >"$T/unit"
}

# A filled-in env file; extra KEY=value arguments are appended (the last one wins).
write_env() {
  mkdir -p "$(dirname "$ENVF")"
  {
    echo "MINIZEP_HOST=127.0.0.1,100.64.0.10"
    echo "MINIZEP_TOKENS=tok-a:teamA|shared,tok-b:teamB"
    echo "MINIZEP_DATABASE_URL=postgres://minizep:secret@127.0.0.1:5433/minizep"
    echo "MINIZEP_EMBED_URL=http://100.64.0.20:11435"
    printf '%s\n' "$@"
  } >"$ENVF"
  chmod 600 "$ENVF"
}

check() {
  if "${@:2}"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "FAIL [$CASE] $1"
    sed 's/^/    | /' "$T/out"
  fi
}

has() { grep -qxF -- "$1" "$T/unit"; }            # has LINE: the rendered unit has this line
said() { grep -qF -- "$1" "$T/out"; }             # said TEXT: the output mentions it
not_said() { ! said "$1"; }
no_placeholders() { [ -s "$T/unit" ] && ! grep -n '@[A-Z_]*@' "$T/unit"; }
no_actions() { ! grep -q '^+ ' "$T/out"; }        # a rejected run must not reach any step
nothing_written() { [ ! -e "$ENVF" ] && [ ! -e "$UNITS" ]; }
# Nothing but the fake checkout and the captured output exists under T.
only_checkout() { [ "$(cd "$T" && find . ! -name out ! -name unit | sort | tr '\n' ' ')" = ". ./app ./app/package.json " ]; }
# No warning other than the one about the test user not existing.
no_warnings() { ! grep '^warning: ' "$T/out" | grep -qv 'does not exist on this host'; }

# ---- rendering ---------------------------------------------------------------------------

new_case "fresh dry run renders a complete unit and writes nothing"
install_dry
check "exit 0" test "$RC" -eq 0
check "unit rendered" test -s "$T/unit"
check "no placeholders left" no_placeholders
check "User" has "User=$SVC"
check "WorkingDirectory" has "WorkingDirectory=$APP"
check "EnvironmentFile" has "EnvironmentFile=$ENVF"
check "ExecStart runs dist/server/http.js with node" has "ExecStart=$NODE_BIN $APP/dist/server/http.js"
check "Documentation points into the checkout" has "Documentation=file:$APP/docs/DEPLOY.md"
check "snapshot dir stays commented out" has "#ReadWritePaths=/path/to/snapshot-dir"
check "no writable path" bash -c "! grep -q '^ReadWritePaths=' '$T/unit'"
check "ordering on the VPN" has "After=network-online.target tailscaled.service"
check "weak dependency only" bash -c "! grep -Eq '^(Requires|BindsTo|Requisite)=' '$T/unit'"
check "restart always" has "Restart=always"
check "stop timeout above the drain timeout" has "TimeoutStopSec=150"
for key in NoNewPrivileges=yes ProtectSystem=strict ProtectHome=read-only PrivateTmp=yes \
  PrivateDevices=yes CapabilityBoundingSet= RestrictAddressFamilies='AF_INET AF_INET6 AF_UNIX AF_NETLINK'; do
  check "sandbox: $key" has "$key"
done
check "builds as the service user" said "+ runuser -u $SVC -- env"
check "npm ci" said " npm ci"
check "npm run build" said " npm run build"
check "unit would be installed" said "+ install -m 0644 -o 0 -g 0"
check "env file would be created from the example, mode 600" said "+ install -m 0600 -o 0 -g 0 $EXAMPLE $ENVF"
check "daemon-reload" said "+ systemctl daemon-reload"
check "not started with an unfilled env file" said "not enabling or starting minizep.service yet"
check "no enable" not_said "+ systemctl enable"
check "no restart" not_said "+ systemctl restart"
check "nothing written" only_checkout
check "no env file" test ! -e "$ENVF"
check "no unit dir" test ! -e "$UNITS"

new_case "--snapshot-dir makes that directory writable"
install_dry --snapshot-dir "$T/state/"
check "exit 0" test "$RC" -eq 0
check "no placeholders left" no_placeholders
check "ReadWritePaths (trailing slash dropped)" has "ReadWritePaths=$T/state"
check "commented line replaced" bash -c "! grep -q '^#ReadWritePaths=' '$T/unit'"
check "directory would be created for the service user" said "+ install -d -m 0700 -o $SVC"
check "but is not" test ! -e "$T/state"

new_case "the unit template only uses placeholders the installer fills in"
check "known placeholders" bash -c "! grep -o '@[A-Z_]*@' '$TEMPLATE' | grep -vxE '@(USER|WORKDIR|ENV_FILE|NODE|SNAPSHOT_DIR)@'"

# ---- env file and service ----------------------------------------------------------------

new_case "filled-in env file: enable, restart, poll the loopback /health"
write_env "MINIZEP_PORT=9876"
cp -p "$ENVF" "$T/env.before"
install_dry
check "exit 0" test "$RC" -eq 0
check "env file kept" said "exists; leaving it unchanged"
check "no env file install" not_said "$EXAMPLE"
check "env file byte-identical" cmp -s "$ENVF" "$T/env.before"
check "enable" said "+ systemctl enable minizep.service"
check "restart" said "+ systemctl restart minizep.service"
check "loopback address and port from the env file" said "would poll http://127.0.0.1:9876/health for up to 60s"
check "no warnings" no_warnings

new_case "env file straight from the example is not started"
mkdir -p "$(dirname "$ENVF")"
cp "$EXAMPLE" "$ENVF"
chmod 600 "$ENVF"
install_dry
check "exit 0" test "$RC" -eq 0
check "not started" said "not enabling or starting"
# exactly these three: the commented-out MINIZEP_LLM_API_KEY=CHANGE_ME does not count
check "names what is left" grep -qx '    CHANGE_ME left in: MINIZEP_HOST,MINIZEP_DATABASE_URL,MINIZEP_EMBED_URL' "$T/out"
check "empty tokens reported" grep -qx '    MINIZEP_TOKENS is empty (create entries with deploy/tokens.sh)' "$T/out"
check "no restart" not_said "+ systemctl restart"

new_case "empty MINIZEP_TOKENS is not started"
write_env "MINIZEP_TOKENS="
install_dry
check "not started" said "MINIZEP_TOKENS is empty"
check "no restart" not_said "+ systemctl restart"

new_case "quoted values are read like systemd reads them"
write_env 'MINIZEP_TOKENS="tok-c:teamC"' "MINIZEP_HOST='100.64.0.10, ::1'" "MINIZEP_PORT=8800"
install_dry
check "started" said "+ systemctl restart minizep.service"
check "IPv6 loopback in brackets" said "would poll http://[::1]:8800/health"

new_case "unusable port stops before enabling"
write_env "MINIZEP_PORT=87o7"
install_dry
check "fails" test "$RC" -ne 0
check "says why" said "MINIZEP_PORT in $ENVF is not a number"
check "no enable" not_said "+ systemctl enable"

new_case "wildcard address is warned about"
write_env "MINIZEP_HOST=0.0.0.0"
install_dry
check "warning" said "warning: MINIZEP_HOST contains a wildcard address"
check "polls loopback" said "would poll http://127.0.0.1:8787/health"

new_case "no loopback address"
write_env "MINIZEP_HOST=100.64.0.10"
install_dry
check "warning" said "MINIZEP_HOST has no loopback address"
check "polls the VPN address" said "would poll http://100.64.0.10:8787/health"

new_case "readable env file is warned about"
write_env
chmod 644 "$ENVF"
install_dry
check "warning" said "is readable by group or others"

new_case "in-memory store without --snapshot-dir is warned about"
write_env "MINIZEP_DATABASE_URL="
install_dry
check "warning" said "MINIZEP_DATABASE_URL is not set"
install_dry --snapshot-dir "$T/state"
check "MINIZEP_DB outside the snapshot dir" said "set MINIZEP_DB=$T/state/graph.json"
write_env "MINIZEP_DATABASE_URL=" "MINIZEP_DB=$T/state/graph.json"
install_dry --snapshot-dir "$T/state"
check "consistent: no warning" no_warnings

new_case "installed unit is only rewritten when it changed"
install_dry
mkdir -p "$UNITS"
cp "$T/unit" "$UNITS/minizep.service"
install_dry
check "up to date" said "is up to date"
check "not reinstalled" not_said "+ install -m 0644"
echo "# local edit" >>"$UNITS/minizep.service"
install_dry
check "update shown as a diff" said "-# local edit"
check "reinstalled" said "+ install -m 0644"

# ---- arguments ---------------------------------------------------------------------------

# rejected ARGS...: the run fails before any step, with an error message.
rejected() {
  MINIZEP_UNIT_DIR="$UNITS" bash "$INSTALL" --dry-run --node "$NODE_BIN" "$@" >"$T/out" 2>&1
  local rc=$?
  [ "$rc" -ne 0 ] && grep -q '^error: ' "$T/out" && no_actions
}

new_case "invalid arguments are rejected before doing anything"
check "root" rejected --user root --dir "$APP" --env-file "$ENVF"
check "missing value" rejected --dir "$APP" --env-file "$ENVF" --user
check "option as value" rejected --user --dry-run --dir "$APP" --env-file "$ENVF"
check "relative dir" rejected --user "$SVC" --dir app --env-file "$ENVF"
check "dir with a space" rejected --user "$SVC" --dir "$T/my app" --env-file "$ENVF"
check "dir with .." rejected --user "$SVC" --dir "$APP/../app" --env-file "$ENVF"
check "dir with %" rejected --user "$SVC" --dir "$T/a%b" --env-file "$ENVF"
check "not a checkout" rejected --user "$SVC" --dir "$T" --env-file "$ENVF"
check "relative env file" rejected --user "$SVC" --dir "$APP" --env-file minizep.env
check "env file with |" rejected --user "$SVC" --dir "$APP" --env-file "$T/a|b"
check "snapshot dir with @" rejected --user "$SVC" --dir "$APP" --env-file "$ENVF" --snapshot-dir "$T/@x@"
check "bad user name" rejected --user 'a b' --dir "$APP" --env-file "$ENVF"
check "bad timeout" rejected --user "$SVC" --dir "$APP" --env-file "$ENVF" --health-timeout soon
check "unknown option" rejected --user "$SVC" --dir "$APP" --env-file "$ENVF" --force
check "missing node" rejected --user "$SVC" --dir "$APP" --env-file "$ENVF" --node "$T/node"
check "still nothing written" nothing_written

new_case "a real run needs root"
if [ "$(id -u)" -ne 0 ]; then
  MINIZEP_UNIT_DIR="$UNITS" bash "$INSTALL" --user "$SVC" --dir "$APP" --env-file "$ENVF" \
    --node "$NODE_BIN" >"$T/out" 2>&1
  RC=$?
  check "fails" test "$RC" -ne 0
  check "says why" said "run as root"
  check "nothing written" nothing_written
else
  echo "  (skipped: running as root)"
fi

new_case "--help"
bash "$INSTALL" --help >"$T/out" 2>&1
RC=$?
check "exit 0" test "$RC" -eq 0
check "documents the options" said "--snapshot-dir PATH"

# ---- env example -------------------------------------------------------------------------

new_case "the env example documents every variable the code reads"
{
  grep -rhoE 'process\.env\.MINIZEP_[A-Z0-9_]+' "$REPO/src" | sed 's/^process\.env\.//'
  # read by the servers after the session/drain changes
  printf '%s\n' MINIZEP_SESSION_TTL_MS MINIZEP_MAX_SESSIONS MINIZEP_DRAIN_TIMEOUT_MS
} | sort -u >"$T/vars"
check "found the variables" test "$(wc -l <"$T/vars")" -gt 10
while read -r var; do
  check "$var" grep -qE "^#?$var=" "$EXAMPLE"
done <"$T/vars"
check "no real addresses: only loopback and example ranges" bash -c \
  "! grep -oE '[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+' '$EXAMPLE' | grep -vE '^(127\.0\.0\.1|0\.0\.0\.0|100\.64\.[0-9]+\.[0-9]+)$'"

# ---- scripts -----------------------------------------------------------------------------

new_case "scripts parse (and pass shellcheck when it is installed)"
for script in "$DEPLOY"/install.sh "$DEPLOY"/tokens.sh "$HERE"/*.sh; do
  check "bash -n $(basename "$script")" bash -n "$script"
  if command -v shellcheck >/dev/null 2>&1; then
    check "shellcheck $(basename "$script")" shellcheck -x "$script"
  fi
done

echo
echo "$PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
