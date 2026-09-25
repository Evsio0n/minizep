#!/usr/bin/env bash
# Keeps the embedding service running on the cluster, without a gap at the job time limit.
#
# A Slurm job has a wall-clock limit (7 days here), so "resident" means rolling over to
# a fresh job before the old one ends. Every INTERVAL seconds one pass:
#   1. lists this user's pending/running jobs named $JOBNAME, oldest submission first
#      (job ids wrap around at the cluster's MaxJobId, submission times do not);
#   2. health-checks each running job's endpoint ($BASE/endpoints/<jobid>, written by
#      llamacpp-serve.sh) and points $BASE/current-target at the newest healthy one.
#      The file is replaced atomically, only when it changes, and never with a backend
#      that fails GET /health (embed-proxy.py follows it);
#   3. cancels older jobs once the target has been on a newer job for GRACE seconds,
#      running jobs that keep failing /health (see STALE_AFTER), and held pending jobs,
#      which would never start on their own;
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
#   STALE_AFTER     seconds a running job may keep failing /health, as seen by this
#                   supervisor, before it is cancelled (default 1800, 0 disables). The
#                   count starts at the first failed check, and starts again after a 200,
#                   after a requeue, and after the supervisor has not run for that long.
#                   While no job answers at all, the job current-target points at is kept
#                   (the fault may be on this host), but a replacement is submitted.
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
FOREVER=999999999 # time left of an UNLIMITED job
ENDPOINT_WAIT=300 # seconds a running job may take to publish its endpoint before a warning
ENDPOINT_RE='^[A-Za-z0-9._-]+:[0-9]+$'
ERR_FILE=/dev/null # stderr of the last Slurm command, set up in main
WARNED=" "         # jobs already warned about, space-separated

read -r -a SBATCH_EXTRA <<<"${SBATCH_ARGS:-}"

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"; }
note() { if [ "$VERBOSE" = 1 ] || dry; then log "$@"; fi; }
dry() { [ "$DRY_RUN" = 1 ]; }

# Logs what the last command wrote to $ERR_FILE, one timestamped line each.
log_stderr() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do log "$line"; done <"$ERR_FILE"
}

# first_warning ID: true the first time it is called for ID in this process.
first_warning() {
  [[ $WARNED == *" $1 "* ]] && return 1
  WARNED+="$1 "
}

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

# Seconds left of a job, from squeue's %L. UNLIMITED and NOT_SET count as forever;
# INVALID (a job past its limit, e.g. under OverTimeLimit) and anything else unexpected
# as nothing, so that they cause a replacement rather than hide the need for one.
time_left() {
  case $1 in
    UNLIMITED | NOT_SET) echo "$FOREVER" ;;
    *) to_seconds "$1" || echo 0 ;;
  esac
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

# Fills the JOB_* arrays with this user's live $JOBNAME jobs, oldest submission first.
# JOB_WHERE is squeue's %R: the nodes of a running job, "(<reason>)" of a pending one.
# Slurm commands run without the lock descriptor (fd 9): a child that outlives a killed
# supervisor must not keep its successor from starting.
list_jobs() {
  local out status id state left used submit where
  out=$(SLURM_TIME_FORMAT=standard squeue -h -u "$SLURM_USER" -n "$JOBNAME" \
    -t PENDING,CONFIGURING,RUNNING -o '%i %T %L %M %V %R' 2>"$ERR_FILE" 9>&-)
  status=$?
  log_stderr
  if [ "$status" -ne 0 ]; then
    log "squeue failed; skipping this pass"
    return 1
  fi
  JOB_IDS=() JOB_STATES=() JOB_LEFT=() JOB_USED=() JOB_WHERE=()
  while read -r id state left used submit where; do
    [ -n "$id" ] || continue
    if ! [[ $id =~ ^[0-9]+$ ]]; then
      log "ignoring job $id: not a plain job id"
      continue
    fi
    JOB_IDS+=("$id")
    JOB_STATES+=("$state")
    JOB_LEFT+=("$left")
    JOB_USED+=("$used")
    JOB_WHERE+=("$where")
  done < <(printf '%s\n' "$out" | LC_ALL=C sort -k5,5 -k1,1n)
}

is_listed() {
  local i
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    [ "${JOB_IDS[i]}" = "$1" ] && return 0
  done
  return 1
}

# Endpoint files and failure marks of jobs that are gone: a job killed with SIGKILL
# cannot remove its own endpoint file.
prune_stale() {
  local file id
  for file in "$ENDPOINT_DIR"/* "$STATE_DIR"/unhealthy.*; do
    [ -f "$file" ] || continue
    id=${file##*/}
    id=${id#unhealthy.}
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

# HTTP status of GET /health on host:port; "000" when unreachable. The check goes
# straight to the node: a proxy from the environment cannot reach compute nodes.
http_status() {
  curl --noproxy '*' -s -o /dev/null -m "$HEALTH_TIMEOUT" -w '%{http_code}' \
    "http://$1/health" 2>/dev/null 9>&-
}

# A failing streak is kept in $STATE_DIR/unhealthy.<id> as "<since> <seen>": the first
# and the latest pass that found the job failing /health.
forget_failing() {
  if [ -e "$STATE_DIR/unhealthy.$1" ] && ! dry; then
    rm -f "$STATE_DIR/unhealthy.$1"
  fi
}

# Sets JOB_FAILING[I] to how long job I has been failing /health, as seen by this
# supervisor. The streak starts again when its latest failure is more than STALE_AFTER
# old (the supervisor was not running, and the job may have been healthy meanwhile),
# and is never longer than the job's run time (a requeued job starts afresh).
count_failing() {
  local id=${JOB_IDS[$1]} since="" seen="" used
  if [ -f "$STATE_DIR/unhealthy.$id" ]; then
    read -r since seen <"$STATE_DIR/unhealthy.$id" || true
  fi
  if ! [[ $since =~ ^[0-9]+$ && $seen =~ ^[0-9]+$ ]] ||
    [ $(( NOW - 10#$seen )) -gt "$STALE_AFTER" ]; then
    since=$NOW
  fi
  dry || echo "$since $NOW" >"$STATE_DIR/unhealthy.$id"
  JOB_FAILING[$1]=$(( NOW - 10#$since ))
  if used=$(to_seconds "${JOB_USED[$1]}") && [ "$used" -lt "${JOB_FAILING[$1]}" ]; then
    JOB_FAILING[$1]=$used
  fi
}

# JOB_EP: published endpoint of each running job; JOB_OK: 1 when it answered 200;
# JOB_FAILING: seconds it has been failing. llama-server answers 503 until the model
# is loaded.
check_health() {
  local i id file ep code used
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    id=${JOB_IDS[i]}
    JOB_EP[i]=""
    JOB_OK[i]=0
    JOB_FAILING[i]=0
    if [ "${JOB_STATES[i]}" != RUNNING ]; then
      forget_failing "$id" # a requeued job starts afresh when it runs again
      continue
    fi
    file="$ENDPOINT_DIR/$id"
    if [ ! -f "$file" ]; then
      used=$(to_seconds "${JOB_USED[i]}") || used=0
      if [ "$used" -gt "$ENDPOINT_WAIT" ] && first_warning "$id"; then
        log "warning: job $id on ${JOB_WHERE[i]} has run for ${JOB_USED[i]} without publishing $file, so it is never health-checked or switched to (an older job script?)"
      else
        note "job $id on ${JOB_WHERE[i]}: no endpoint published"
      fi
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
      forget_failing "$id"
    else
      log "job $id at $ep: not healthy (HTTP ${code:-000})"
      count_failing "$i"
    fi
  done
}

# JOB_DEAD: why a job should be cancelled, empty when it may stay. Dead jobs no longer
# count towards the rollover, so a hung replacement cannot block the next one.
find_dead() {
  local i reason
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    JOB_DEAD[i]=""
    if [ "${JOB_STATES[i]}" = PENDING ] && [[ ${JOB_WHERE[i]} == *[Hh]eld* ]]; then
      # JobHeldUser, JobHeldAdmin, "launch failed requeued held", ...
      reason=${JOB_WHERE[i]#\(}
      JOB_DEAD[i]="held: ${reason%\)}"
    elif [ "$STALE_AFTER" -gt 0 ] && [ "${JOB_FAILING[i]}" -gt "$STALE_AFTER" ]; then
      JOB_DEAD[i]="failing /health for more than ${STALE_AFTER}s"
    fi
  done
}

# Points current-target at the newest healthy job. Sets TARGET_IDX (its index in JOB_*)
# and TARGET_SINCE (when the target moved to that job) from $STATE_DIR/target; both stay
# empty when no job is healthy, in which case the file is left alone rather than pointed
# at a sick backend.
update_target() {
  local i newest=-1 running=0 id ep current="" state_id="" state_since=""
  TARGET_IDX=""
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
  TARGET_IDX=$newest
  TARGET_SINCE=$state_since
}

# cancel INDEX REASON
cancel() {
  local id=${JOB_IDS[$1]} status
  if dry; then
    log "DRY_RUN: would scancel job $id ($2)"
    JOB_GONE[$1]=1
    return 0
  fi
  scancel "$id" 2>"$ERR_FILE" 9>&-
  status=$?
  log_stderr
  if [ "$status" -eq 0 ]; then
    log "cancelled job $id ($2)"
    JOB_GONE[$1]=1
  else
    log "scancel $id failed ($2)"
  fi
}

# Cancels dead jobs, and jobs submitted before the target once it has served for GRACE
# seconds. While no job answers /health, the job current-target points at is not
# cancelled for failing it: the fault may be on this host (routes, firewall), and
# cancelling would turn it into an outage. Being dead, it no longer counts as coverage,
# so a replacement is submitted, and it is cancelled once another job answers.
retire_jobs() {
  local i served current="" any_ok=0
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    JOB_GONE[i]=0
    [ "${JOB_OK[i]}" = 1 ] && any_ok=1
  done
  [ -f "$TARGET_FILE" ] && { read -r current <"$TARGET_FILE" || true; }
  for (( i = 0; i < ${#JOB_IDS[@]}; i++ )); do
    if [ -n "${JOB_DEAD[i]}" ]; then
      if [ "$any_ok" = 0 ] && [ -n "${JOB_EP[i]}" ] && [ "${JOB_EP[i]}" = "$current" ]; then
        log "job ${JOB_IDS[i]} is ${JOB_DEAD[i]}, but no job answers: keeping it, as current-target points at it"
      else
        cancel "$i" "${JOB_DEAD[i]}"
      fi
    elif [ -n "$TARGET_IDX" ] && [ "$i" -lt "$TARGET_IDX" ]; then
      served=$(( NOW - TARGET_SINCE ))
      if [ "$served" -ge "$GRACE" ]; then
        cancel "$i" "superseded by job ${JOB_IDS[TARGET_IDX]} ${served}s ago"
      else
        note "job ${JOB_IDS[i]} superseded by job ${JOB_IDS[TARGET_IDX]}; cancelling after ${GRACE}s"
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
    ${SBATCH_EXTRA[@]+"${SBATCH_EXTRA[@]}"} "$JOBSCRIPT" 2>&1 9>&-); then
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
    [ "${JOB_GONE[i]}" = 1 ] || [ -n "${JOB_DEAD[i]}" ] && continue
    left=$(time_left "${JOB_LEFT[i]}")
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
  JOB_EP=() JOB_OK=() JOB_FAILING=() JOB_DEAD=() JOB_GONE=()
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
      log "supervise.sh: $setting must be a whole number of seconds, got '${!setting}'" >&2
      exit 2
    fi
  done
  # curl -m 0 would never time out, and a zero INTERVAL would poll Slurm in a busy loop.
  if [ "$HEALTH_TIMEOUT" -lt 1 ] || { [ "$ONCE" != 1 ] && [ "$INTERVAL" -lt 1 ]; }; then
    log "supervise.sh: HEALTH_TIMEOUT and INTERVAL must be at least 1" >&2
    exit 2
  fi
  # Without curl every backend would look dead and eventually be cancelled.
  if ! command -v curl >/dev/null 2>&1; then
    log "supervise.sh: curl is required for health checks" >&2
    exit 2
  fi
  if ! dry; then
    mkdir -p "$STATE_DIR" "$ENDPOINT_DIR" "$BASE/logs" || exit 2
    acquire_lock
  fi
  if ERR_FILE=$(mktemp "${TMPDIR:-/tmp}/supervise.XXXXXX" 2>/dev/null); then
    trap 'rm -f "$ERR_FILE"' EXIT
  else
    ERR_FILE=/dev/null
  fi
  if [ ! -f "$JOBSCRIPT" ]; then
    log "warning: job script $JOBSCRIPT not found; sbatch will fail"
  elif ! grep -q 'endpoints/' "$JOBSCRIPT"; then
    log "warning: $JOBSCRIPT does not publish \$BASE/endpoints/<jobid>, so its jobs can never become the target; install infra/embedding/llamacpp-serve.sh there"
  fi

  if [ "$ONCE" = 1 ]; then
    one_pass
    exit
  fi
  log "supervising $JOBNAME every ${INTERVAL}s (lead ${LEAD}s, grace ${GRACE}s)"
  while true; do
    one_pass
    sleep "$INTERVAL" 9>&-
  done
}

main "$@"
