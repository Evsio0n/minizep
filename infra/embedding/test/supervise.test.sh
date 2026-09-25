#!/usr/bin/env bash
# Tests for supervise.sh and llamacpp-serve.sh. squeue, sbatch, scancel, curl, getent, ss
# and llama-server are fakes on PATH that read and record state in a temporary directory,
# so nothing here touches the network or a real cluster.
#
#   bash infra/embedding/test/supervise.test.sh
#
# Fake cluster state of a case (under $FAKE):
#   jobs            squeue output, one "<id> <state> <time left> <time used> <submitted>
#                   <nodes or (reason)>" per line
#   health/<ep>     HTTP status that GET http://<ep>/health returns (absent: unreachable)
#   listening       ports that ss reports as taken on the node, one per line
#   calls           every fake invocation, one per line
set -uo pipefail
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy no_proxy NO_PROXY

HERE=$(cd "$(dirname "$0")" && pwd)
SUPERVISE="$HERE/../supervise.sh"
SERVE="$HERE/../llamacpp-serve.sh"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/supervise-test.XXXXXX")
trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$ROOT"' EXIT

PASSED=0
FAILED=0
N=0
TIMEOUT=20

# A run that hangs is killed after TIMEOUT seconds and ends the suite as a failure
# (hang_check), rather than stalling it.
if command -v timeout >/dev/null 2>&1; then
  with_timeout() { timeout "$TIMEOUT" "$@"; }
elif command -v perl >/dev/null 2>&1; then
  with_timeout() { perl -e 'alarm shift; exec @ARGV or exit 127' "$TIMEOUT" "$@"; }
else
  with_timeout() { "$@"; }
fi

# ---- fakes ---------------------------------------------------------------------------

mkdir -p "$ROOT/bin"
fake() { cat >"$ROOT/bin/$1"; chmod +x "$ROOT/bin/$1"; }

fake squeue <<'EOF_FAKE'
#!/usr/bin/env bash
echo "squeue $* (SLURM_TIME_FORMAT=${SLURM_TIME_FORMAT:-})" >>"$FAKE/calls"
if [ -e "$FAKE/squeue-fails" ]; then
  echo "squeue: error: Unable to contact slurm controller (connect failure)" >&2
  exit 1
fi
cat "$FAKE/jobs"
EOF_FAKE

fake sbatch <<'EOF_FAKE'
#!/usr/bin/env bash
echo "sbatch $*" >>"$FAKE/calls"
if [ -e "$FAKE/sbatch-fails" ]; then
  echo "sbatch: error: Batch job submission failed" >&2
  exit 1
fi
id=$(cat "$FAKE/next-id" 2>/dev/null || echo 500)
echo $(( id + 1 )) >"$FAKE/next-id"
# Submitted after every job a case sets up by hand (those default to 2026-01-01).
echo "$id PENDING 7-00:00:00 0:00 2030-01-01T00:00:00 (Priority)" >>"$FAKE/jobs"
echo "Submitted batch job $id"
EOF_FAKE

fake scancel <<'EOF_FAKE'
#!/usr/bin/env bash
echo "scancel $*" >>"$FAKE/calls"
if [ -e "$FAKE/scancel-fails" ]; then
  echo "scancel: error: Kill job error on job id $1: Access/permission denied" >&2
  exit 1
fi
for id in "$@"; do
  grep -v "^$id " "$FAKE/jobs" >"$FAKE/jobs.tmp"
  mv "$FAKE/jobs.tmp" "$FAKE/jobs"
done
EOF_FAKE

# Like curl, sends the request to a proxy from the environment unless --noproxy '*' says
# otherwise, and a proxy cannot reach the (fake) compute nodes.
fake curl <<'EOF_FAKE'
#!/usr/bin/env bash
echo "curl $*" >>"$FAKE/calls"
url="" noproxy="" prev=""
for arg in "$@"; do
  case $arg in http://*) url=$arg ;; esac
  [ "$prev" = --noproxy ] && noproxy=$arg
  prev=$arg
done
if [ -n "${http_proxy:-}${ALL_PROXY:-}${all_proxy:-}" ] && [ "$noproxy" != '*' ]; then
  printf '000'
  exit 56
fi
ep=${url#http://}
ep=${ep%%/*}
if [ -f "$FAKE/health/$ep" ]; then
  printf '%s' "$(cat "$FAKE/health/$ep")"
  exit 0
fi
printf '000'
exit 7
EOF_FAKE

fake getent <<'EOF_FAKE'
#!/usr/bin/env bash
echo "getent $*" >>"$FAKE/calls"
[ "$1" = ahostsv4 ] || exit 2
if [ -f "$FAKE/getent" ]; then cat "$FAKE/getent"; else echo "192.0.2.10 STREAM $2"; fi
EOF_FAKE

# ss -ltn "sport = :PORT": a listener when PORT is in $FAKE/listening.
fake ss <<'EOF_FAKE'
#!/usr/bin/env bash
echo "ss $*" >>"$FAKE/calls"
filter="$*"
port=${filter##*:}
echo "State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process"
if grep -qx -- "$port" "$FAKE/listening" 2>/dev/null; then
  echo "LISTEN 0      128    0.0.0.0:$port      0.0.0.0:*"
fi
EOF_FAKE

fake llama-server <<'EOF_FAKE'
#!/usr/bin/env bash
sleep "${FAKE_LLAMA_DELAY:-0}"
printf '%s\n' "$@" >"$FAKE/llama-args"
if [ "${FAKE_LLAMA_MODE:-exit}" = serve ]; then
  trap 'echo TERM >"$FAKE/llama-signal"; exit 0' TERM
  : >"$FAKE/llama-ready"
  while :; do sleep 0.1; done
fi
exit "${FAKE_LLAMA_STATUS:-0}"
EOF_FAKE

# macOS has no flock(1). This stand-in does the one thing supervise.sh asks of it,
# "flock -n FD", with the same flock(2) lock on the descriptor it inherits.
if ! command -v flock >/dev/null 2>&1 && command -v perl >/dev/null 2>&1; then
  fake flock <<'EOF_FAKE'
#!/usr/bin/env bash
[ "$1" = -n ] || exit 64
exec perl -MFcntl=:flock -e \
  'open(my $fh, ">&=", $ARGV[0]) or exit 1; flock($fh, LOCK_EX | LOCK_NB) or exit 1' "$2"
EOF_FAKE
fi
HAVE_FLOCK=0
( PATH="$ROOT/bin:$PATH"; command -v flock ) >/dev/null 2>&1 && HAVE_FLOCK=1

# ---- helpers -------------------------------------------------------------------------

# new_case NAME: fresh BASE and empty fake cluster.
new_case() {
  CASE=$1
  N=$(( N + 1 ))
  T="$ROOT/case$N"
  BASE="$T/base"
  FAKE="$T/fake"
  mkdir -p "$BASE/endpoints" "$FAKE/health"
  : >"$FAKE/jobs"
  : >"$FAKE/calls"
  : >"$T/log"
  printf '#!/bin/bash\n# publishes $BASE/endpoints/$SLURM_JOB_ID\n' >"$BASE/llamacpp-serve.sh"
  export BASE FAKE
  echo "# $CASE"
}

# hang_check STATUS WHAT: a run killed by with_timeout fails the suite at once; the
# cases after it would only hang too.
hang_check() {
  if [ "$1" -eq 124 ] || [ "$1" -eq 142 ]; then
    FAILED=$(( FAILED + 1 ))
    echo "FAIL [$CASE] $2 did not finish within ${TIMEOUT}s"
    sed 's/^/    | /' "$T/log" | tail -20
    echo
    echo "$PASSED passed, $FAILED failed (stopped at the hang)"
    exit 1
  fi
}

# Environment of a supervise.sh run in this case: one pass with test defaults.
sup_env() {
  SUP_ENV=(PATH="$ROOT/bin:$PATH" ONCE=1 DRY_RUN=0 VERBOSE=0 INTERVAL=0 LEAD=10800
    GRACE=300 STALE_AFTER=1800 SUBMIT_BACKOFF=0 HEALTH_TIMEOUT=1
    JOBNAME=minizep-llama-serve JOBSCRIPT="$BASE/llamacpp-serve.sh"
    STATE_DIR="$BASE/state" SBATCH_ARGS=)
}

# supervise [VAR=value...]: one pass; the arguments override the test defaults.
supervise() {
  local status
  echo "--- supervise $*" >>"$T/log"
  sup_env
  with_timeout env "${SUP_ENV[@]}" "$@" bash "$SUPERVISE" >>"$T/log" 2>&1
  status=$?
  hang_check "$status" "supervise${*:+ $*}"
  return "$status"
}

# job ID STATE LEFT USED [NODES-OR-(REASON) [SUBMITTED]]
job() { echo "$1 $2 $3 $4 ${6:-2026-01-01T00:00:00} ${5:-}" >>"$FAKE/jobs"; }
set_job() { grep -v "^$1 " "$FAKE/jobs" >"$FAKE/jobs.tmp"; mv "$FAKE/jobs.tmp" "$FAKE/jobs"; job "$@"; }
endpoint() { echo "$2" >"$BASE/endpoints/$1"; }        # endpoint ID HOST:PORT
health() { echo "$2" >"$FAKE/health/$1"; }             # health HOST:PORT CODE
# failing_since ID SECONDS: job ID has failed every check for SECONDS, the last one now.
failing_since() {
  local now
  now=$(date +%s)
  mkdir -p "$BASE/state"
  echo "$(( now - $2 )) $now" >"$BASE/state/unhealthy.$1"
}

calls() { grep -c -- "$1" "$FAKE/calls"; }
called() { grep -q -- "$1" "$FAKE/calls"; }
not_called() { ! called "$1"; }
logged() { grep -q -- "$1" "$T/log"; }
not_logged() { ! logged "$1"; }
log_matches() { grep -Eq -- "$1" "$T/log"; }
target_is() { [ "$(cat "$BASE/current-target" 2>/dev/null)" = "$1" ]; }
no_target() { [ ! -e "$BASE/current-target" ]; }
inode() { ls -i "$1" | awk '{ print $1 }'; }
not_newer() { [ -z "$(find "$1" -newer "$2")" ]; }     # not_newer FILE REFERENCE
lacks() { ! grep -Eq -- "$1" "$2"; }                   # lacks REGEX FILE

# wait_for FILE: up to 5 s.
wait_for() {
  local i
  for (( i = 0; i < 50; i++ )); do
    [ -e "$1" ] && return 0
    sleep 0.1
  done
  return 1
}

# wait_for_log TEXT: up to 5 s.
wait_for_log() {
  local i
  for (( i = 0; i < 50; i++ )); do
    logged "$1" && return 0
    sleep 0.1
  done
  return 1
}

# stop PID: sends SIGTERM to a background process and reaps it, killing it (a failure)
# when it has not exited after 5 s. Quiet: no "Terminated" notice from the shell.
stop() {
  local i
  kill -TERM "$1"
  for (( i = 0; i < 50; i++ )); do
    kill -0 "$1" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$1" 2>/dev/null; then
    kill -KILL "$1"
    FAILED=$(( FAILED + 1 ))
    echo "FAIL [$CASE] process $1 did not exit"
  fi
  wait "$1"
} 2>/dev/null

# check DESCRIPTION COMMAND...: records a pass, or prints the failure with the log.
check() {
  if "${@:2}"; then
    PASSED=$(( PASSED + 1 ))
  else
    FAILED=$(( FAILED + 1 ))
    echo "FAIL [$CASE] $1"
    sed 's/^/    | /' "$T/log"
    sed 's/^/    calls: /' "$FAKE/calls"
  fi
}

# ---- supervise.sh --------------------------------------------------------------------

new_case "cold start submits once"
supervise
check "sbatch called" called "^sbatch "
check "job name passed" called "sbatch .*-J minizep-llama-serve"
check "submits from BASE" called "sbatch .*-D $BASE "
check "submits the job script" called "sbatch .*$BASE/llamacpp-serve.sh\$"
check "logs the reason" logged "no job running or pending"
check "timestamped log" log_matches '^\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}[+-][0-9]{4}\] '
check "log dir created" test -d "$BASE/logs"
check "no target before any job is healthy" no_target
supervise
check "pending job covers: still one sbatch" test "$(calls '^sbatch ')" -eq 1
check "squeue filters by name and state" \
  called "squeue -h -u .* -n minizep-llama-serve -t PENDING,CONFIGURING,RUNNING -o %i %T %L %M %V %R"
check "submission times in a sortable format" called "(SLURM_TIME_FORMAT=standard)"

new_case "steady state"
job 101 RUNNING 5-00:00:00 2-00:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
supervise
check "target on the healthy job" target_is 192.0.2.11:20101
check "target readable by the proxy user" test "$(ls -l "$BASE/current-target" | cut -c1-10)" = "-rw-r--r--"
check "health checked via GET /health" called "^curl .* http://192.0.2.11:20101/health\$"
check "health check bypasses proxies" called "^curl --noproxy \* "
check "no sbatch" not_called "^sbatch "
check "no scancel" not_called "^scancel "
before=$(inode "$BASE/current-target")
touch -t 202001010000 "$BASE/current-target"
touch -t 202101010000 "$T/ref"
supervise
supervise
check "target file not replaced when unchanged" test "$(inode "$BASE/current-target")" = "$before"
check "target file not rewritten when unchanged" not_newer "$BASE/current-target" "$T/ref"
check "switch logged once" test "$(grep -c 'current-target ->' "$T/log")" -eq 1
check "still no sbatch" not_called "^sbatch "

new_case "rollover: submit, switch only after health, cancel after grace"
job 101 RUNNING 2:59:00 6-21:01:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
supervise
check "target on job 101" target_is 192.0.2.11:20101
check "rollover submitted" test "$(calls '^sbatch ')" -eq 1
check "rollover logged" logged "rollover: job 101 has 2:59:00 left"
supervise
check "pending replacement covers: no second sbatch" test "$(calls '^sbatch ')" -eq 1
set_job 500 RUNNING 6-23:59:00 0:01:00 node-b
endpoint 500 192.0.2.12:20500
health 192.0.2.12:20500 503
supervise
check "loading replacement is not the target" target_is 192.0.2.11:20101
check "unhealthy replacement logged" logged "job 500 at 192.0.2.12:20500: not healthy (HTTP 503)"
check "old job kept while the new one loads" not_called "^scancel "
before=$(inode "$BASE/current-target")
health 192.0.2.12:20500 200
supervise
check "switched to the healthy replacement" target_is 192.0.2.12:20500
check "switched by rename, not by rewriting in place" test "$(inode "$BASE/current-target")" != "$before"
check "failure mark dropped once healthy" test ! -e "$BASE/state/unhealthy.500"
check "old job kept during grace" not_called "^scancel "
supervise GRACE=600
check "old job still kept within grace" not_called "^scancel "
supervise GRACE=0
check "old job cancelled after grace" called "^scancel 101\$"
check "new job not cancelled" not_called "^scancel 500"
check "no extra submission" test "$(calls '^sbatch ')" -eq 1
supervise GRACE=0
check "old endpoint file pruned" test ! -e "$BASE/endpoints/101"
check "new endpoint file kept" test -e "$BASE/endpoints/500"
check "target stays on the new job" target_is 192.0.2.12:20500

new_case "rollover threshold"
job 101 RUNNING 3:00:01 1:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
supervise
check "more than LEAD left: no sbatch" not_called "^sbatch "
set_job 101 RUNNING 3:00:00 1:00:00 node-a
supervise
check "exactly LEAD left: sbatch" test "$(calls '^sbatch ')" -eq 1

new_case "duration formats"
job 101 RUNNING UNLIMITED 1:00:00 node-a
supervise
check "UNLIMITED counts as covered" not_called "^sbatch "
set_job 101 RUNNING 1-00:00:00 1:00:00 node-a
supervise
check "days-hh:mm:ss parsed" not_called "^sbatch "
set_job 101 PENDING NOT_SET 0:00 "(Priority)"
supervise
check "unknown time limit does not cause submissions" not_called "^sbatch "
set_job 101 RUNNING 2:08:09 1:00:00 node-a
supervise
check "leading zeros are not octal" test "$(calls '^sbatch ')" -eq 1
check "no arithmetic errors" not_logged "value too great"

new_case "a job past its time limit is replaced"
job 101 RUNNING INVALID 7-00:10:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
supervise
check "INVALID time left causes a rollover" test "$(calls '^sbatch ')" -eq 1
check "rollover logged" logged "rollover: job 101 has INVALID left"

new_case "an unhealthy backend never becomes the target"
job 102 RUNNING 6-00:00:00 0:05:00 node-a
endpoint 102 192.0.2.12:20102
health 192.0.2.12:20102 503
job 103 RUNNING 6-00:00:00 0:05:00 node-b
endpoint 103 192.0.2.13:20103
supervise
check "no target written" no_target
check "failures recorded" test -s "$BASE/state/unhealthy.102" -a -s "$BASE/state/unhealthy.103"
echo "192.0.2.90:11435" >"$BASE/current-target"
supervise
check "existing target left alone" target_is 192.0.2.90:11435
check "no scancel within STALE_AFTER" not_called "^scancel "
check "loading jobs cover: no sbatch" not_called "^sbatch "

new_case "newest healthy job wins"
job 101 RUNNING 1-00:00:00 6-00:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
job 102 RUNNING 6-00:00:00 1-00:00:00 node-b
endpoint 102 192.0.2.12:20102
health 192.0.2.12:20102 200
supervise
check "target on the newer job" target_is 192.0.2.12:20102
health 192.0.2.12:20102 503
supervise
check "falls back to the older healthy job" target_is 192.0.2.11:20101
check "fallback job not cancelled" not_called "^scancel "

new_case "job ids that wrap around"
job 67043300 RUNNING 2:59:00 6-21:01:00 node-a 2026-09-18T10:00:00
endpoint 67043300 192.0.2.11:21300
health 192.0.2.11:21300 200
mkdir -p "$BASE/state"
echo "67043300 $(( $(date +%s) - 500000 ))" >"$BASE/state/target"
echo 12 >"$FAKE/next-id"
supervise
check "rollover submitted" test "$(calls '^sbatch ')" -eq 1
supervise
check "the newer job, with a smaller id, is kept" not_called "^scancel "
check "no second submission" test "$(calls '^sbatch ')" -eq 1
set_job 12 RUNNING 6-23:59:00 0:01:00 node-b 2030-01-01T00:00:00
endpoint 12 192.0.2.12:20012
health 192.0.2.12:20012 200
supervise
check "target moves to the newer job" target_is 192.0.2.12:20012
supervise GRACE=0
check "the older job is retired" called "^scancel 67043300\$"
check "the newer job is not" not_called "^scancel 12\$"

new_case "squeue failure changes nothing"
touch "$FAKE/squeue-fails"
endpoint 77 192.0.2.77:20077
echo "192.0.2.90:11435" >"$BASE/current-target"
supervise
status=$?
check "pass reports failure" test "$status" -ne 0
check "logged" logged "squeue failed"
check "squeue's error logged with a timestamp" \
  log_matches '^\[[^]]+\] squeue: error: Unable to contact slurm controller'
check "no sbatch" not_called "^sbatch "
check "no scancel" not_called "^scancel "
check "endpoints not pruned" test -e "$BASE/endpoints/77"
check "target unchanged" target_is 192.0.2.90:11435

new_case "scancel failure is logged with a timestamp"
job 102 PENDING 7-00:00:00 0:00 "(JobHeldUser)"
touch "$FAKE/scancel-fails"
supervise
check "scancel's error logged with a timestamp" \
  log_matches '^\[[^]]+\] scancel: error: Kill job error on job id 102'
check "failure logged" logged "scancel 102 failed (held: JobHeldUser)"

new_case "stale replacement is cancelled and replaced"
job 101 RUNNING 2:00:00 6-22:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
job 102 RUNNING 6-23:50:00 0:10:00 node-b
endpoint 102 192.0.2.12:20102
health 192.0.2.12:20102 503
supervise
check "young replacement kept" not_called "^scancel "
check "young replacement covers" not_called "^sbatch "
set_job 102 RUNNING 6-23:20:00 0:40:00 node-b
failing_since 102 2000
supervise
check "replacement failing past STALE_AFTER cancelled" called "^scancel 102\$"
check "reason logged" logged "cancelled job 102 (failing /health for more than 1800s)"
check "serving job kept" not_called "^scancel 101"
check "new replacement submitted" test "$(calls '^sbatch ')" -eq 1
check "target stays on the serving job" target_is 192.0.2.11:20101
supervise
check "failure mark of the cancelled job pruned" test ! -e "$BASE/state/unhealthy.102"
check "its endpoint pruned" test ! -e "$BASE/endpoints/102"

new_case "a job is not cancelled for time nobody watched"
job 101 RUNNING 5-00:00:00 2-00:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 000
supervise
check "fresh state, long-running job, one failed check: kept" not_called "^scancel "
check "no replacement" not_called "^sbatch "
now=$(date +%s)
# It was failing when the supervisor stopped an hour ago, and fails again now.
echo "$(( now - 7200 )) $(( now - 3600 ))" >"$BASE/state/unhealthy.101"
supervise
check "a failure before the supervisor was down is not counted" not_called "^scancel "
check "still no replacement" not_called "^sbatch "
health 192.0.2.11:20101 200
supervise
check "a 200 ends the streak" test ! -e "$BASE/state/unhealthy.101"

new_case "a requeued job is not cancelled while it loads again"
job 101 RUNNING 5-00:00:00 2-00:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 000
supervise
check "failure recorded" test -s "$BASE/state/unhealthy.101"
set_job 101 PENDING 7-00:00:00 0:00 "(BeginTime)"
supervise
check "mark dropped while the job is pending" test ! -e "$BASE/state/unhealthy.101"
check "a requeued job covers" not_called "^sbatch "
set_job 101 RUNNING 6-23:58:00 0:02:00 node-b
endpoint 101 192.0.2.12:20101
health 192.0.2.12:20101 503
failing_since 101 4000 # as if the requeue had happened between two passes
supervise
check "loading after the requeue: kept" not_called "^scancel "
check "no replacement" not_called "^sbatch "

new_case "a job that stops answering is replaced"
job 101 RUNNING 5-00:00:00 2-00:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
supervise
check "target on job 101" target_is 192.0.2.11:20101
health 192.0.2.11:20101 000
supervise
check "a short outage is tolerated" not_called "^scancel "
failing_since 101 4000
supervise
check "no job answers: the job behind current-target is kept" not_called "^scancel "
check "and why" logged "job 101 is failing /health for more than 1800s, but no job answers"
check "a replacement is submitted" test "$(calls '^sbatch ')" -eq 1
set_job 500 RUNNING 6-23:59:00 0:01:00 node-b
endpoint 500 192.0.2.12:20500
health 192.0.2.12:20500 200
supervise
check "switched to the replacement" target_is 192.0.2.12:20500
check "failing job cancelled once another answers" called "^scancel 101\$"
check "one submission" test "$(calls '^sbatch ')" -eq 1

new_case "when no job answers, only the job behind current-target is spared"
job 101 RUNNING 1-00:00:00 6-00:00:00 node-a
endpoint 101 192.0.2.11:20101
job 102 RUNNING 6-23:00:00 1:00:00 node-b
endpoint 102 192.0.2.12:20102
echo "192.0.2.11:20101" >"$BASE/current-target"
failing_since 101 4000
failing_since 102 4000
supervise
check "the target's job kept" not_called "^scancel 101"
check "the other failing job cancelled" called "^scancel 102\$"
check "a replacement submitted" test "$(calls '^sbatch ')" -eq 1

new_case "health checks bypass proxy settings"
job 101 RUNNING 5-00:00:00 2-00:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
supervise http_proxy=http://192.0.2.99:3128 ALL_PROXY=http://192.0.2.99:3128
check "backend reached despite http_proxy" target_is 192.0.2.11:20101

new_case "held jobs are cancelled and replaced"
job 101 RUNNING 1:00:00 6-23:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
job 102 PENDING 7-00:00:00 0:00 "(launch failed requeued held)"
supervise
check "held job cancelled" called "^scancel 102\$"
check "reason logged" logged "cancelled job 102 (held: launch failed requeued held)"
check "replacement submitted" test "$(calls '^sbatch ')" -eq 1
check "serving job kept" not_called "^scancel 101"
set_job 500 PENDING 7-00:00:00 0:00 "(JobHeldAdmin)" 2030-01-01T00:00:00
supervise
check "JobHeldAdmin cancelled" called "^scancel 500\$"
check "and replaced" test "$(calls '^sbatch ')" -eq 2
supervise
check "a job waiting for resources counts" test "$(calls '^sbatch ')" -eq 2

new_case "migration from a job without an endpoint file"
job 90 RUNNING 5-00:00:00 2-00:00:00 node-a
echo "192.0.2.90:11435" >"$BASE/current-target"
supervise
check "old job left alone" not_called "^scancel "
check "no sbatch while it has time" not_called "^sbatch "
check "its target kept" target_is 192.0.2.90:11435
check "warned that it publishes no endpoint" \
  logged "warning: job 90 on node-a has run for 2-00:00:00 without publishing"
set_job 90 RUNNING 2:00:00 6-22:00:00 node-a
supervise
check "rollover submitted" test "$(calls '^sbatch ')" -eq 1
set_job 500 RUNNING 6-23:59:00 0:01:00 node-b
endpoint 500 192.0.2.12:20500
health 192.0.2.12:20500 200
supervise GRACE=0
check "switched to the new job" target_is 192.0.2.12:20500
supervise GRACE=0
check "old job cancelled" called "^scancel 90\$"

new_case "a job script without endpoints is flagged"
echo '#!/bin/bash' >"$BASE/llamacpp-serve.sh"
supervise
check "warned at start" logged 'does not publish \$BASE/endpoints/<jobid>'

new_case "dry run acts on nothing"
endpoint 77 192.0.2.77:20077
supervise DRY_RUN=1
check "no sbatch" not_called "^sbatch "
check "decision logged" logged "DRY_RUN: would sbatch"
check "stale endpoint kept" test -e "$BASE/endpoints/77"
check "no state written" test ! -e "$BASE/state"
job 101 RUNNING 2:00:00 6-22:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
job 100 RUNNING 1:00:00 6-23:00:00 node-c
supervise DRY_RUN=1 GRACE=0
check "target not written" no_target
check "switch logged" logged "DRY_RUN: would point current-target at job 101"
echo "192.0.2.11:20101" >"$BASE/current-target"
supervise DRY_RUN=1 GRACE=0
check "no scancel" not_called "^scancel "
check "cancel decision logged" logged "DRY_RUN: would scancel job 100 (superseded by job 101"
check "no sbatch" not_called "^sbatch "
check "rollover decision logged" logged "DRY_RUN: would sbatch .*rollover: job 101"
check "still no state written" test ! -e "$BASE/state"

new_case "submit backoff"
supervise SUBMIT_BACKOFF=300
check "first submission" test "$(calls '^sbatch ')" -eq 1
: >"$FAKE/jobs" # the job failed at once
supervise SUBMIT_BACKOFF=300
check "no resubmission within backoff" test "$(calls '^sbatch ')" -eq 1
check "backoff logged" logged "waiting (SUBMIT_BACKOFF 300s)"
supervise SUBMIT_BACKOFF=0
check "resubmitted after backoff" test "$(calls '^sbatch ')" -eq 2

new_case "sbatch failure and extra options"
touch "$FAKE/sbatch-fails"
supervise SUBMIT_BACKOFF=300 SBATCH_ARGS="-p gpu-part --exclude=node-x"
check "failure logged" logged "sbatch failed: sbatch: error"
check "extra options passed" called "sbatch .*-p gpu-part --exclude=node-x $BASE/llamacpp-serve.sh"
rm "$FAKE/sbatch-fails"
supervise SUBMIT_BACKOFF=300
check "a failed sbatch does not start the backoff" test "$(calls '^sbatch ')" -eq 2

new_case "bad settings are rejected"
supervise LEAD=3h
check "exit status 2" test $? -eq 2
check "message" logged "LEAD must be a whole number of seconds"
check "message timestamped" log_matches '^\[[^]]+\] supervise.sh: LEAD must be'
check "nothing ran" not_called "^squeue "
supervise ONCE=0 INTERVAL=0
check "zero INTERVAL rejected outside ONCE mode" test $? -eq 2
supervise HEALTH_TIMEOUT=0
check "zero HEALTH_TIMEOUT rejected" test $? -eq 2
check "still nothing ran" not_called "^squeue "

new_case "one supervisor per BASE"
if [ "$HAVE_FLOCK" = 1 ]; then
  sup_env
  env "${SUP_ENV[@]}" ONCE=0 INTERVAL=5 bash "$SUPERVISE" >>"$T/log" 2>&1 &
  sup_pid=$!
  check "first supervisor runs a pass" wait_for_log "no job running or pending; sbatch"
  sleep 0.5 # now between passes
  supervise
  check "a second supervisor exits 1" test $? -eq 1
  check "and says why" logged "another supervise.sh already manages"
  supervise DRY_RUN=1
  check "a dry run may watch alongside" test $? -eq 0
  stop "$sup_pid"
  supervise
  check "a restart right after kill takes over" test $? -eq 0
else
  echo "  (skipped: neither flock nor perl)"
fi

# ---- llamacpp-serve.sh ---------------------------------------------------------------

# serve [VAR=value...]: runs the job script with fakes.
serve() {
  local status
  with_timeout env PATH="$ROOT/bin:$PATH" SLURM_JOB_ID=12345 LLAMA_BIN="$ROOT/bin/llama-server" \
    LLAMA_HOME="$T/home" "$@" bash "$SERVE" >>"$T/log" 2>&1
  status=$?
  hang_check "$status" "serve${*:+ $*}"
  return "$status"
}

new_case "job template"
check "no node pinning" lacks '^#SBATCH[[:space:]]+(-w|--nodelist)' "$SERVE"

new_case "job script publishes its endpoint and removes it on SIGTERM"
# Started directly rather than through serve(), so that $! is the job script itself.
# The delay makes llama-server start after the endpoint is published, as it can in reality.
env PATH="$ROOT/bin:$PATH" SLURM_JOB_ID=12345 LLAMA_BIN="$ROOT/bin/llama-server" \
  LLAMA_HOME="$T/home" FAKE_LLAMA_MODE=serve FAKE_LLAMA_DELAY=0.3 bash "$SERVE" >>"$T/log" 2>&1 &
job_pid=$!
check "endpoint published" wait_for "$BASE/endpoints/12345"
check "llama-server started" wait_for "$FAKE/llama-ready"
check "port derived from the job id" test "$(cat "$BASE/endpoints/12345" 2>/dev/null)" = "192.0.2.10:20345"
check "llama-server gets the port" grep -qx -- 20345 "$FAKE/llama-args"
check "llama-server gets the model" grep -qx -- "$BASE/llamacpp/qwen3-embed-q8.gguf" "$FAKE/llama-args"
check "embedding mode" grep -qx -- --embedding "$FAKE/llama-args"
stop "$job_pid"
check "SIGTERM forwarded to llama-server" test "$(cat "$FAKE/llama-signal" 2>/dev/null)" = TERM
check "endpoint removed" test ! -e "$BASE/endpoints/12345"
check "no temporary file left" test -z "$(ls -A "$BASE/endpoints")"

new_case "job script cleans up when llama-server exits"
printf '127.0.1.1 STREAM node-a\n192.0.2.20 STREAM node-a\n' >"$FAKE/getent"
serve FAKE_LLAMA_STATUS=3 PORT_BASE=30000 PORT_RANGE=1000 LLAMA_EXTRA_ARGS="-ub 2048 -b 2048"
check "exit status of llama-server kept" test $? -eq 3
check "endpoint removed" test ! -e "$BASE/endpoints/12345"
check "port from PORT_BASE/PORT_RANGE" grep -qx -- 30345 "$FAKE/llama-args"
check "extra args passed" grep -qx -- -ub "$FAKE/llama-args"
check "loopback address skipped" logged "on 192.0.2.20:30345"

new_case "job script moves on when its port is taken"
echo 20345 >"$FAKE/listening"
serve
check "next port used" grep -qx -- 20346 "$FAKE/llama-args"
check "and published" logged "on 192.0.2.10:20346"
printf '30999\n' >"$FAKE/listening"
serve SLURM_JOB_ID=12999 PORT_BASE=30000 PORT_RANGE=1000
check "wraps around within the range" grep -qx -- 30000 "$FAKE/llama-args"

new_case "job script refuses to run outside Slurm"
with_timeout env PATH="$ROOT/bin:$PATH" LLAMA_BIN="$ROOT/bin/llama-server" LLAMA_HOME="$T/home" \
  bash -c 'unset SLURM_JOB_ID; exec bash "$0"' "$SERVE" >>"$T/log" 2>&1
check "non-zero exit" test $? -ne 0
check "llama-server not started" test ! -e "$FAKE/llama-args"

echo
echo "$PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
