#!/usr/bin/env bash
# Keeps the embedding service running on the cluster.
#
# A Slurm job has a wall-clock limit (7 days here); "resident" therefore means
# "resubmitted whenever it is not running". Also publishes the current backend
# address for embed-proxy.py to follow.
set -uo pipefail

BASE=/mnt/ai-data/jobs/minizep-embed
JOBNAME="${JOBNAME:-minizep-llama-serve}"
JOBSCRIPT="${JOBSCRIPT:-$BASE/llamacpp-serve.sh}"
TARGET_FILE="$BASE/current-target"
INTERVAL="${INTERVAL:-30}"

log() { echo "[$(date -Is)] $*"; }

while true; do
  running=$(squeue -u "$USER" -h -n "$JOBNAME" -t RUNNING -o '%N' 2>/dev/null | head -1)

  if [ -z "$running" ]; then
    pending=$(squeue -u "$USER" -h -n "$JOBNAME" -t PENDING -o '%i' 2>/dev/null | head -1)
    if [ -z "$pending" ]; then
      log "no $JOBNAME job found — submitting"
      sbatch -D "$BASE" "$JOBSCRIPT" >>"$BASE/logs/supervisor.log" 2>&1 \
        || log "sbatch failed (see logs/supervisor.log)"
    fi
  else
    ip=$(getent hosts "$running" | awk '{print $1}' | head -1)
    if [ -n "$ip" ]; then
      echo "$ip:11435" > "$TARGET_FILE"
    else
      log "could not resolve $running"
    fi
  fi

  sleep "$INTERVAL"
done
