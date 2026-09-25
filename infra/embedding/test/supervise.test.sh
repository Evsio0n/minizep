#!/usr/bin/env bash
# Tests for supervise.sh and llamacpp-serve.sh. squeue, sbatch, scancel, curl, getent and
# llama-server are fakes on PATH that read and record state in a temporary directory, so
# nothing here touches the network or a real cluster.
#
#   bash infra/embedding/test/supervise.test.sh
#
# Fake cluster state of a case (under $FAKE):
#   jobs            squeue output, one "<id> <state> <time left> <time used> <node>" per line
#   health/<ep>     HTTP status that GET http://<ep>/health returns (absent: unreachable)
#   calls           every fake invocation, one per line
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SUPERVISE="$HERE/../supervise.sh"
SERVE="$HERE/../llamacpp-serve.sh"
ROOT=$(mktemp -d "${TMPDIR:-/tmp}/supervise-test.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT

PASSED=0
FAILED=0
N=0

# ---- fakes ---------------------------------------------------------------------------

mkdir -p "$ROOT/bin"
fake() { cat >"$ROOT/bin/$1"; chmod +x "$ROOT/bin/$1"; }

fake squeue <<'EOF'
#!/usr/bin/env bash
echo "squeue $*" >>"$FAKE/calls"
if [ -e "$FAKE/squeue-fails" ]; then
  echo "squeue: error: Unable to contact slurm controller" >&2
  exit 1
fi
cat "$FAKE/jobs"
EOF

fake sbatch <<'EOF'
#!/usr/bin/env bash
echo "sbatch $*" >>"$FAKE/calls"
if [ -e "$FAKE/sbatch-fails" ]; then
  echo "sbatch: error: Batch job submission failed" >&2
  exit 1
fi
id=$(cat "$FAKE/next-id" 2>/dev/null || echo 500)
echo $(( id + 1 )) >"$FAKE/next-id"
echo "$id PENDING 7-00:00:00 0:00" >>"$FAKE/jobs"
echo "Submitted batch job $id"
EOF

fake scancel <<'EOF'
#!/usr/bin/env bash
echo "scancel $*" >>"$FAKE/calls"
for id in "$@"; do
  grep -v "^$id " "$FAKE/jobs" >"$FAKE/jobs.tmp"
  mv "$FAKE/jobs.tmp" "$FAKE/jobs"
done
EOF

fake curl <<'EOF'
#!/usr/bin/env bash
url=""
for arg in "$@"; do
  case $arg in http://*) url=$arg ;; esac
done
echo "curl $url" >>"$FAKE/calls"
ep=${url#http://}
ep=${ep%%/*}
if [ -f "$FAKE/health/$ep" ]; then
  printf '%s' "$(cat "$FAKE/health/$ep")"
  exit 0
fi
printf '000'
exit 7
EOF

fake getent <<'EOF'
#!/usr/bin/env bash
echo "getent $*" >>"$FAKE/calls"
[ "$1" = ahostsv4 ] || exit 2
if [ -f "$FAKE/getent" ]; then cat "$FAKE/getent"; else echo "192.0.2.10 STREAM $2"; fi
EOF

fake llama-server <<'EOF'
#!/usr/bin/env bash
sleep "${FAKE_LLAMA_DELAY:-0}"
printf '%s\n' "$@" >"$FAKE/llama-args"
if [ "${FAKE_LLAMA_MODE:-exit}" = serve ]; then
  trap 'echo TERM >"$FAKE/llama-signal"; exit 0' TERM
  : >"$FAKE/llama-ready"
  while :; do sleep 0.1; done
fi
exit "${FAKE_LLAMA_STATUS:-0}"
EOF

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
  echo '#!/bin/bash' >"$BASE/llamacpp-serve.sh"
  export BASE FAKE
  echo "# $CASE"
}

# supervise [VAR=value...]: one pass with test defaults; the arguments override them.
supervise() {
  echo "--- supervise $*" >>"$T/log"
  env PATH="$ROOT/bin:$PATH" ONCE=1 DRY_RUN=0 VERBOSE=0 INTERVAL=0 LEAD=10800 GRACE=300 \
    STALE_AFTER=1800 SUBMIT_BACKOFF=0 HEALTH_TIMEOUT=1 JOBNAME=minizep-llama-serve \
    JOBSCRIPT="$BASE/llamacpp-serve.sh" STATE_DIR="$BASE/state" SBATCH_ARGS= \
    "$@" bash "$SUPERVISE" >>"$T/log" 2>&1
}

job() { echo "$*" >>"$FAKE/jobs"; }                    # job ID STATE LEFT USED NODE
set_job() { grep -v "^$1 " "$FAKE/jobs" >"$FAKE/jobs.tmp"; mv "$FAKE/jobs.tmp" "$FAKE/jobs"; job "$@"; }
endpoint() { echo "$2" >"$BASE/endpoints/$1"; }        # endpoint ID HOST:PORT
health() { echo "$2" >"$FAKE/health/$1"; }             # health HOST:PORT CODE

calls() { grep -c -- "$1" "$FAKE/calls"; }
called() { grep -q -- "$1" "$FAKE/calls"; }
not_called() { ! called "$1"; }
logged() { grep -q -- "$1" "$T/log"; }
not_logged() { ! logged "$1"; }
target_is() { [ "$(cat "$BASE/current-target" 2>/dev/null)" = "$1" ]; }
no_target() { [ ! -e "$BASE/current-target" ]; }
inode() { ls -i "$1" | awk '{ print $1 }'; }

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
check "timestamped log" grep -qE '^\[[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:]{8}[+-][0-9]{4}\] ' "$T/log"
check "log dir created" test -d "$BASE/logs"
check "no target before any job is healthy" no_target
supervise
check "pending job covers: still one sbatch" test "$(calls '^sbatch ')" -eq 1
check "squeue filters by name and state" \
  called "squeue -h -u .* -n minizep-llama-serve -t PENDING,CONFIGURING,RUNNING -o %i %T %L %M %N"

new_case "steady state"
job 101 RUNNING 5-00:00:00 2-00:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
supervise
check "target on the healthy job" target_is 192.0.2.11:20101
check "target readable by the proxy user" test "$(ls -l "$BASE/current-target" | cut -c1-10)" = "-rw-r--r--"
check "health checked via GET /health" called "^curl http://192.0.2.11:20101/health\$"
check "no sbatch" not_called "^sbatch "
check "no scancel" not_called "^scancel "
before=$(inode "$BASE/current-target")
supervise
supervise
check "target file not rewritten when unchanged" test "$(inode "$BASE/current-target")" = "$before"
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
health 192.0.2.12:20500 200
supervise
check "switched to the healthy replacement" target_is 192.0.2.12:20500
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

new_case "rollover threshold and duration formats"
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
set_job 101 RUNNING 2:08:09 1:00:00 node-a
supervise
check "leading zeros are not octal" test "$(calls '^sbatch ')" -eq 1
check "no arithmetic errors" not_logged "value too great"
set_job 101 PENDING NOT_SET 0:00
supervise
check "unknown time limit does not cause submissions" test "$(calls '^sbatch ')" -eq 1

new_case "an unhealthy backend never becomes the target"
job 102 RUNNING 6-00:00:00 0:05:00 node-a
endpoint 102 192.0.2.12:20102
health 192.0.2.12:20102 503
job 103 RUNNING 6-00:00:00 0:05:00 node-b
endpoint 103 192.0.2.13:20103
supervise
check "no target written" no_target
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

new_case "squeue failure changes nothing"
touch "$FAKE/squeue-fails"
endpoint 77 192.0.2.77:20077
echo "192.0.2.90:11435" >"$BASE/current-target"
supervise
status=$?
check "pass reports failure" test "$status" -ne 0
check "logged" logged "squeue failed"
check "no sbatch" not_called "^sbatch "
check "no scancel" not_called "^scancel "
check "endpoints not pruned" test -e "$BASE/endpoints/77"
check "target unchanged" target_is 192.0.2.90:11435

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
supervise
check "replacement silent past STALE_AFTER cancelled" called "^scancel 102\$"
check "serving job kept" not_called "^scancel 101"
check "new replacement submitted" test "$(calls '^sbatch ')" -eq 1
check "target stays on the serving job" target_is 192.0.2.11:20101

new_case "a job that stops answering is replaced"
job 101 RUNNING 5-00:00:00 2-00:00:00 node-a
endpoint 101 192.0.2.11:20101
health 192.0.2.11:20101 200
supervise
check "healthy mark recorded" test -s "$BASE/state/healthy.101"
health 192.0.2.11:20101 000
supervise
check "a short outage is tolerated" not_called "^scancel "
echo $(( $(date +%s) - 4000 )) >"$BASE/state/healthy.101"
supervise
check "silent since the last healthy answer: cancelled" called "^scancel 101\$"
check "replacement submitted" test "$(calls '^sbatch ')" -eq 1

new_case "migration from a job without an endpoint file"
job 90 RUNNING 5-00:00:00 2-00:00:00 node-a
echo "192.0.2.90:11435" >"$BASE/current-target"
supervise
check "old job left alone" not_called "^scancel "
check "no sbatch while it has time" not_called "^sbatch "
check "its target kept" target_is 192.0.2.90:11435
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
check "no sbatch" not_called "^sbatch "
check "rollover decision logged" logged "DRY_RUN: would sbatch .*rollover: job 101"

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
check "nothing ran" not_called "^squeue "
supervise ONCE=0 INTERVAL=0
check "zero INTERVAL rejected outside ONCE mode" test $? -eq 2
supervise HEALTH_TIMEOUT=0
check "zero HEALTH_TIMEOUT rejected" test $? -eq 2
check "still nothing ran" not_called "^squeue "

# ---- llamacpp-serve.sh ---------------------------------------------------------------

# serve [VAR=value...]: runs the job script with fakes.
serve() {
  env PATH="$ROOT/bin:$PATH" SLURM_JOB_ID=12345 LLAMA_BIN="$ROOT/bin/llama-server" \
    LLAMA_HOME="$T/home" "$@" bash "$SERVE" >>"$T/log" 2>&1
}

wait_for() { # wait_for FILE: up to 5 s
  local i
  for (( i = 0; i < 50; i++ )); do
    [ -e "$1" ] && return 0
    sleep 0.1
  done
  return 1
}

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
kill -TERM "$job_pid"
wait "$job_pid"
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

new_case "job script refuses to run outside Slurm"
env PATH="$ROOT/bin:$PATH" LLAMA_BIN="$ROOT/bin/llama-server" LLAMA_HOME="$T/home" \
  bash -c 'unset SLURM_JOB_ID; exec bash "$0"' "$SERVE" >>"$T/log" 2>&1
check "non-zero exit" test $? -ne 0
check "llama-server not started" test ! -e "$FAKE/llama-args"

echo
echo "$PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
