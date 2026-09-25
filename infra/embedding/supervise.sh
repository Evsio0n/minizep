#!/usr/bin/env bash
# Keeps the embedding service running on the cluster, without a gap at the job time limit.
#
# A Slurm job has a wall-clock limit (7 days here), so "resident" means rolling over to
# a fresh job before the old one ends. Every INTERVAL seconds one pass:
#   1. lists this user's pending/running jobs named $JOBNAME with their time left;
#   2. health-checks each running job's endpoint ($BASE/endpoints/<jobid>, written by
#      llamacpp-serve.sh) and points $BASE/current-target at the newest healthy one.
#      The file is replaced atomically, only when it changes, and never with a backend
#      that fails GET /health (embed-proxy.py follows it);
#   3. cancels older jobs once the target has been on a newer job for GRACE seconds, and
#      running jobs that have not answered /health for STALE_AFTER seconds;
#   4. submits a job when no remaining job has more than LEAD seconds left, which covers
#      both the rollover and a cold start.
# When squeue fails the pass does nothing: an unknown queue must not cause submissions.
#
# Settings (environment):
#   BASE            job directory                (default /mnt/ai-data/jobs/minizep-embed)
#   JOBNAME         Slurm job name               (default minizep-llama-serve)
#   JOBSCRIPT       job script to submit         (default $BASE/llamacpp-serve.sh)
#   SBATCH_ARGS     extra sbatch options, e.g. "-p <partition>"
#   INTERVAL        seconds between passes       (default 30)
#   LEAD            rollover lead time, seconds  (default 10800 = 3 h)
#   GRACE           seconds an old job keeps running after the switch (default 300)
#   STALE_AFTER     seconds without a healthy answer, counted from the job's start or its
#                   last healthy answer, before a running job is cancelled
#                   (default 1800, 0 disables)
#   SUBMIT_BACKOFF  minimum seconds between two submissions (default 300)
#   HEALTH_TIMEOUT  seconds per health check     (default 5)
#   STATE_DIR       supervisor state             (default $BASE/state)
#   DRY_RUN=1       log the decisions instead of acting; writes nothing
#   ONCE=1          run a single pass and exit
#   VERBOSE=1       also log the steady state
# Logs go to stdout, e.g. nohup supervise.sh >>"$BASE/logs/supervisor.log" 2>&1 &
set -uo pipefail

BASE="${BASE:-/mnt/ai-data/jobs/minizep-embed}"
JOBNAME="${JOBNAME:-minizep-llama-serve}"
JOBSCRIPT="${JOBSCRIPT:-$BASE/llamacpp-serve.sh}"
TARGET_FILE="$BASE/current-target"
ENDPOINT_DIR="$BASE/endpoints"
STATE_DIR="${STATE_DIR:-$BASE/state}"
INTERVAL="${INTERVAL:-30}"
LEAD="${LEAD:-10800}"
GRACE="${GRACE:-300}"
STALE_AFTER="${STALE_AFTER:-1800}"
SUBMIT_BACKOFF="${SUBMIT_BACKOFF:-300}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-5}"
DRY_RUN="${DRY_RUN:-0}"
ONCE="${ONCE:-0}"
VERBOSE="${VERBOSE:-0}"
SLURM_USER="${USER:-$(id -un)}"
FOREVER=999999999 # time left of an UNLIMITED (or not yet known) job
ENDPOINT_RE='^[A-Za-z0-9._-]+:[0-9]+$'

read -r -a SBATCH_EXTRA <<<"${SBATCH_ARGS:-}"

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"; }
note() { if [ "$VERBOSE" = 1 ] || dry; then log "$@"; fi; }
dry() { [ "$DRY_RUN" = 1 ]; }

# Slurm durations: [days-]hours:minutes:seconds or minutes:seconds. Prints seconds;
# fails for UNLIMITED, NOT_SET, INVALID and anything else unexpected.
to_seconds() {
  local rest=$1 days=0 total=0 part re='^[0-9]+(:[0-9]+){0,2}$'
  if [[ $rest == *-* ]]; then
    days=${rest%%-*}
    rest=${rest#*-}
  fi
  [[ $days =~ ^[0-9]+$ && $rest =~ $re ]] || return 1
  local IFS=:
  for part in $rest; do total=$(( total * 60 + 10#$part )); done
  echo $(( total + 10#$days * 86400 ))
}

# Replaces FILE with CONTENT via tmp + mv, so readers see the old or the new content.
atomic_write() {
  local tmp
  tmp=$(mktemp "$(dirname "$1")/.$(basename "$1").XXXXXX") || return 1
  if printf '%s\n' "$2" >"$tmp" && chmod 644 "$tmp" && mv -f "$tmp" "$1"; then
    return 0
  fi
  rm -f "$tmp"
  return 1
}

# Fills the JOB_* arrays with this user's live $JOBNAME jobs, oldest first.
list_jobs() {
  local out id state left used node
  if ! out=$(squeue -h -u "$SLURM_USER" -n "$JOBNAME" -t PENDING,CONFIGURING,RUNNING \
    -o '%i %T %L %M %N'); then
    log "squeue failed; skipping this pass"
    return 1
  fi
  JOB_IDS=() JOB_STATES=() JOB_LEFT=() JOB_USED=() JOB_NODES=()
  while read -r id state left used node; do
    [ -n "$id" ] || continue
    if ! [[ $id =~ ^[0-9]+$ ]]; then
      log "ignoring job $id: not a plain job id"
      continue
    fi
    JOB_IDS+=("$id")
    JOB_STATES+=("$state")
    JOB_LEFT+=("$left")
    JOB_USED+=("$used")
    JOB_NODES+=("$node")
  done < <(printf '%s\n' "$out" | sort -n -k1,1)
}

is_listed() {
  local i
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    [ "${JOB_IDS[i]}" = "$1" ] && return 0
  done
  return 1
}

# Endpoint files and health marks of jobs that are gone: a job killed with SIGKILL
# cannot remove its own endpoint file.
prune_stale() {
  local file id
  for file in "$ENDPOINT_DIR"/* "$STATE_DIR"/healthy.*; do
    [ -f "$file" ] || continue
    id=${file##*/}
    id=${id#healthy.}
    [[ $id =~ ^[0-9]+$ ]] || continue
    is_listed "$id" && continue
    if dry; then
      note "DRY_RUN: would remove $file (job $id is gone)"
    else
      rm -f "$file"
      [ "${file%/*}" = "$ENDPOINT_DIR" ] && log "removed endpoint of finished job $id"
    fi
  done
}

# HTTP status of GET /health on host:port; "000" when unreachable.
http_status() {
  curl -s -o /dev/null -m "$HEALTH_TIMEOUT" -w '%{http_code}' "http://$1/health" 2>/dev/null
}

# JOB_EP: published endpoint of each running job; JOB_OK: 1 when it answered 200.
# llama-server answers 503 until the model is loaded.
check_health() {
  local i id file ep code
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    id=${JOB_IDS[i]}
    JOB_EP[i]=""
    JOB_OK[i]=0
    [ "${JOB_STATES[i]}" = RUNNING ] || continue
    file="$ENDPOINT_DIR/$id"
    if [ ! -f "$file" ]; then
      note "job $id on ${JOB_NODES[i]}: no endpoint published (starting, or an older job script)"
      continue
    fi
    ep=""
    read -r ep <"$file" || true
    if ! [[ $ep =~ $ENDPOINT_RE ]]; then
      log "job $id: ignoring malformed endpoint '$ep'"
      continue
    fi
    JOB_EP[i]=$ep
    code=$(http_status "$ep") || true
    if [ "$code" = 200 ]; then
      JOB_OK[i]=1
      dry || echo "$NOW" >"$STATE_DIR/healthy.$id"
    else
      log "job $id at $ep: not healthy (HTTP ${code:-000})"
    fi
  done
}

# JOB_DEAD: running jobs that published an endpoint but have not answered /health for
# STALE_AFTER seconds, since their start or their last healthy answer. They no longer
# count towards the rollover, so a hung replacement cannot block the next one.
find_dead() {
  local i last silent
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    JOB_DEAD[i]=0
    if [ "$STALE_AFTER" -eq 0 ] || [ -z "${JOB_EP[i]}" ] || [ "${JOB_OK[i]}" = 1 ]; then
      continue
    fi
    last=""
    if [ -f "$STATE_DIR/healthy.${JOB_IDS[i]}" ]; then
      read -r last <"$STATE_DIR/healthy.${JOB_IDS[i]}" || true
    fi
    if [[ $last =~ ^[0-9]+$ ]]; then
      silent=$(( NOW - last ))
    else
      silent=$(to_seconds "${JOB_USED[i]}") || silent=0
    fi
    [ "$silent" -gt "$STALE_AFTER" ] && JOB_DEAD[i]=1
  done
}

# Points current-target at the newest healthy job. Sets TARGET_ID and TARGET_SINCE (when
# the target moved to that job) from $STATE_DIR/target; both stay empty when no job is
# healthy, in which case the file is left alone rather than pointed at a sick backend.
update_target() {
  local i newest=-1 running=0 id ep current="" state_id="" state_since=""
  TARGET_ID=""
  TARGET_SINCE=""
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    [ "${JOB_STATES[i]}" = RUNNING ] && running=$(( running + 1 ))
    [ "${JOB_OK[i]}" = 1 ] && newest=$i
  done
  if [ "$newest" -lt 0 ]; then
    [ "$running" -gt 0 ] && note "no healthy backend; current-target unchanged"
    return 0
  fi
  id=${JOB_IDS[newest]}
  ep=${JOB_EP[newest]}
  [ -f "$TARGET_FILE" ] && { read -r current <"$TARGET_FILE" || true; }
  if [ "$current" != "$ep" ]; then
    if dry; then
      log "DRY_RUN: would point current-target at job $id ($ep, now ${current:-unset})"
    elif atomic_write "$TARGET_FILE" "$ep"; then
      log "current-target -> job $id ($ep, was ${current:-unset})"
    else
      log "could not write $TARGET_FILE"
      return 1
    fi
  else
    note "current-target stays on job $id ($ep)"
  fi
  [ -f "$STATE_DIR/target" ] && { read -r state_id state_since <"$STATE_DIR/target" || true; }
  if [ "$state_id" != "$id" ] || ! [[ $state_since =~ ^[0-9]+$ ]]; then
    state_since=$NOW
    dry || atomic_write "$STATE_DIR/target" "$id $NOW"
  fi
  TARGET_ID=$id
  TARGET_SINCE=$state_since
}

# cancel INDEX REASON
cancel() {
  local id=${JOB_IDS[$1]}
  if dry; then
    log "DRY_RUN: would scancel job $id ($2)"
    JOB_GONE[$1]=1
  elif scancel "$id"; then
    log "cancelled job $id ($2)"
    JOB_GONE[$1]=1
  else
    log "scancel $id failed ($2)"
  fi
}

# Cancels dead jobs, and jobs older than the target once it has served for GRACE seconds.
retire_jobs() {
  local i served
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    JOB_GONE[i]=0
  done
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    if [ "${JOB_DEAD[i]}" = 1 ]; then
      cancel "$i" "no healthy answer for more than ${STALE_AFTER}s"
    elif [ -n "$TARGET_ID" ] && [ "${JOB_IDS[i]}" -lt "$TARGET_ID" ]; then
      served=$(( NOW - TARGET_SINCE ))
      if [ "$served" -ge "$GRACE" ]; then
        cancel "$i" "superseded by job $TARGET_ID ${served}s ago"
      else
        note "job ${JOB_IDS[i]} superseded by job $TARGET_ID; cancelling after ${GRACE}s"
      fi
    fi
  done
}

# submit REASON, unless the previous submission was less than SUBMIT_BACKOFF ago
# (a job that fails at once must not turn into a submission every INTERVAL).
submit() {
  local last="" out
  if [ -f "$STATE_DIR/last-submit" ]; then
    read -r last <"$STATE_DIR/last-submit" || true
  fi
  if [[ $last =~ ^[0-9]+$ ]] && [ $(( NOW - last )) -lt "$SUBMIT_BACKOFF" ]; then
    log "$1; last submission was $(( NOW - last ))s ago, waiting (SUBMIT_BACKOFF ${SUBMIT_BACKOFF}s)"
    return 0
  fi
  if dry; then
    log "DRY_RUN: would sbatch $JOBSCRIPT ($1)"
    return 0
  fi
  mkdir -p "$BASE/logs"
  if out=$(sbatch -D "$BASE" -J "$JOBNAME" --export="ALL,BASE=$BASE" \
    ${SBATCH_EXTRA[@]+"${SBATCH_EXTRA[@]}"} "$JOBSCRIPT" 2>&1); then
    atomic_write "$STATE_DIR/last-submit" "$NOW"
    log "$1; sbatch: $out"
  else
    log "$1; sbatch failed: $out"
  fi
}

# Submits unless a job that can still serve has more than LEAD seconds left. Pending
# jobs count: they will start before a new submission would.
ensure_coverage() {
  local i left best=-1 best_i=-1
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    [ "${JOB_GONE[i]}" = 1 ] || [ "${JOB_DEAD[i]}" = 1 ] && continue
    left=$(to_seconds "${JOB_LEFT[i]}") || left=$FOREVER
    if [ "$left" -gt "$best" ]; then
      best=$left
      best_i=$i
    fi
  done
  if [ "$best_i" -lt 0 ]; then
    submit "no job running or pending"
  elif [ "$best" -le "$LEAD" ]; then
    submit "rollover: job ${JOB_IDS[best_i]} has ${JOB_LEFT[best_i]} left (LEAD ${LEAD}s)"
  else
    note "job ${JOB_IDS[best_i]} (${JOB_STATES[best_i]}, ${JOB_LEFT[best_i]} left) covers the next ${LEAD}s"
  fi
}

one_pass() {
  NOW=$(date +%s)
  JOB_EP=() JOB_OK=() JOB_DEAD=() JOB_GONE=()
  list_jobs || return 1
  prune_stale
  check_health
  find_dead
  update_target
  retire_jobs
  ensure_coverage
  return 0
}

# Only one supervisor may act on a BASE; dry runs may watch alongside it.
acquire_lock() {
  if ! command -v flock >/dev/null 2>&1; then
    log "flock not found; not guarding against a second supervisor"
    return 0
  fi
  exec 9>"$STATE_DIR/supervise.lock"
  if ! flock -n 9; then
    log "another supervise.sh already manages $BASE"
    exit 1
  fi
}

main() {
  local setting
  for setting in INTERVAL LEAD GRACE STALE_AFTER SUBMIT_BACKOFF HEALTH_TIMEOUT; do
    if ! [[ ${!setting} =~ ^[0-9]+$ ]]; then
      echo "supervise.sh: $setting must be a whole number of seconds, got '${!setting}'" >&2
      exit 2
    fi
  done
  # curl -m 0 would never time out, and a zero INTERVAL would poll Slurm in a busy loop.
  if [ "$HEALTH_TIMEOUT" -lt 1 ] || { [ "$ONCE" != 1 ] && [ "$INTERVAL" -lt 1 ]; }; then
    echo "supervise.sh: HEALTH_TIMEOUT and INTERVAL must be at least 1" >&2
    exit 2
  fi
  # Without curl every backend would look dead and eventually be cancelled.
  if ! command -v curl >/dev/null 2>&1; then
    echo "supervise.sh: curl is required for health checks" >&2
    exit 2
  fi
  if ! dry; then
    mkdir -p "$STATE_DIR" "$ENDPOINT_DIR" "$BASE/logs" || exit 2
    acquire_lock
  fi
  [ -f "$JOBSCRIPT" ] || log "warning: job script $JOBSCRIPT not found; sbatch will fail"

  if [ "$ONCE" = 1 ]; then
    one_pass
    exit
  fi
  log "supervising $JOBNAME every ${INTERVAL}s (lead ${LEAD}s, grace ${GRACE}s)"
  while true; do
    one_pass
    sleep "$INTERVAL"
  done
}

main "$@"
