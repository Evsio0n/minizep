#!/bin/bash
# Slurm job: llama.cpp embedding server for minizep, submitted by supervise.sh.
#
# Template. Slurm does not expand variables in #SBATCH lines, so adjust them to the
# cluster before the first submission (sbatch command-line options, e.g. from
# SBATCH_ARGS in supervise.sh, override them):
#   -p <partition>   GPU partition.
#   node pinning     deliberately absent: during a rollover the replacement job must be
#                    able to start on any node with a free GPU while the old one still
#                    serves. To keep off bad nodes use "-x <node>" rather than "-w <node>".
#   -o               relative to the submit directory; supervise.sh submits with
#                    -D "$BASE" and creates $BASE/logs.
#
# Runtime settings come from the environment (sbatch exports the submitter's):
#   BASE        job directory              (default /mnt/ai-data/jobs/minizep-embed)
#   LLAMA_BIN   llama-server binary        (default $BASE/llamacpp/build/bin/llama-server)
#   MODEL       GGUF embedding model       (default $BASE/llamacpp/qwen3-embed-q8.gguf)
#   CTX, NGL    context size, GPU layers   (default 4096, 99)
#   LLAMA_EXTRA_ARGS  extra llama-server flags, split on whitespace
#   CUDA_LIB    CUDA runtime directory prepended to LD_LIBRARY_PATH (optional)
#   LLAMA_HOME  HOME for llama.cpp caches  (default /tmp/minizep-llama-home)
#   PORT_BASE, PORT_RANGE  port = PORT_BASE + SLURM_JOB_ID % PORT_RANGE (default 20000,
#               12000, below the Linux ephemeral ports). Two jobs whose ids differ by a
#               multiple of PORT_RANGE get the same port, so when something on the node
#               already listens there the next free port in the range is used.
#   NODE_IFACE  publish this interface's IPv4 address (default: resolve the hostname)
#
# While llama-server runs, $BASE/endpoints/$SLURM_JOB_ID holds "<node-ip>:<port>"; it is
# removed when the job ends. supervise.sh routes traffic to it only once GET /health
# answers 200, i.e. after the model has loaded.
#SBATCH --job-name=minizep-llama-serve
#SBATCH -p <partition>
#SBATCH --gres=gpu:1
#SBATCH -c 16
#SBATCH --mem=32G
#SBATCH -t 7-00:00:00
#SBATCH -o logs/serve-llama-%j.log
set -euo pipefail

: "${SLURM_JOB_ID:?not running under Slurm}"
BASE="${BASE:-/mnt/ai-data/jobs/minizep-embed}"
LLAMA_BIN="${LLAMA_BIN:-$BASE/llamacpp/build/bin/llama-server}"
MODEL="${MODEL:-$BASE/llamacpp/qwen3-embed-q8.gguf}"
CTX="${CTX:-4096}"
NGL="${NGL:-99}"
PORT_BASE="${PORT_BASE:-20000}"
PORT_RANGE="${PORT_RANGE:-12000}"
ENDPOINT_FILE="$BASE/endpoints/$SLURM_JOB_ID"

log() { echo "[$(date '+%Y-%m-%dT%H:%M:%S%z')] $*"; }

# Does anything on this node listen on TCP port $1?
port_in_use() {
  if command -v ss >/dev/null 2>&1; then
    [[ $(ss -ltn "sport = :$1" 2>/dev/null) == *LISTEN* ]]
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
  fi
}

# PORT_BASE + SLURM_JOB_ID % PORT_RANGE, or the first free port after it in the range.
pick_port() {
  local i port
  for (( i = 0; i < 100 && i < PORT_RANGE; i++ )); do
    port=$(( PORT_BASE + (SLURM_JOB_ID + i) % PORT_RANGE ))
    port_in_use "$port" || { echo "$port"; return 0; }
  done
  return 1
}

# First non-loopback IPv4 address of this node, as seen from the gateway.
node_ip() {
  if [ -n "${NODE_IFACE:-}" ]; then
    ip -4 -o addr show dev "$NODE_IFACE" | awk '{ split($4, a, "/"); print a[1]; exit }'
    return
  fi
  local addr
  # Debian-style /etc/hosts maps the hostname to 127.0.1.1, hence the filter and fallback.
  addr=$(getent ahostsv4 "$(hostname)" | awk '$1 !~ /^127\./ { print $1; exit }') || true
  [ -n "$addr" ] || addr=$(hostname -I 2>/dev/null | awk '{ print $1 }') || true
  echo "$addr"
}

server_pid=""
cleanup() { rm -f "$ENDPOINT_FILE" "$ENDPOINT_FILE.tmp"; }
# scancel and the time limit send SIGTERM: pass it on to llama-server and let the
# script finish normally, so the EXIT trap removes the endpoint file.
on_signal() {
  if [ -n "$server_pid" ]; then
    kill -TERM "$server_pid" 2>/dev/null || true
  else
    exit 143
  fi
}
trap cleanup EXIT
trap on_signal TERM INT HUP

ip=$(node_ip)
if [ -z "$ip" ]; then
  log "cannot determine this node's IP address (set NODE_IFACE)"
  exit 1
fi
if ! PORT=$(pick_port); then
  log "no free port among the 100 from $(( PORT_BASE + SLURM_JOB_ID % PORT_RANGE )) (see PORT_BASE, PORT_RANGE)"
  exit 1
fi

export HOME="${LLAMA_HOME:-/tmp/minizep-llama-home}"
mkdir -p "$HOME" "$BASE/endpoints"
if [ -n "${CUDA_LIB:-}" ]; then
  export LD_LIBRARY_PATH="$CUDA_LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

read -r -a extra_args <<<"${LLAMA_EXTRA_ARGS:-}"
"$LLAMA_BIN" -m "$MODEL" --embedding --pooling last -ngl "$NGL" -c "$CTX" \
  --host 0.0.0.0 --port "$PORT" ${extra_args[@]+"${extra_args[@]}"} &
server_pid=$!

# tmp + mv so the supervisor never reads half an address. Publishing before the model has
# loaded is fine: the supervisor waits for GET /health == 200 before sending traffic.
echo "$ip:$PORT" >"$ENDPOINT_FILE.tmp"
mv -f "$ENDPOINT_FILE.tmp" "$ENDPOINT_FILE"
log "job $SLURM_JOB_ID: llama-server pid $server_pid on $ip:$PORT"

status=0
wait "$server_pid" || status=$?
# A trapped signal interrupts wait; wait again for llama-server's real exit.
if kill -0 "$server_pid" 2>/dev/null; then
  status=0
  wait "$server_pid" || status=$?
fi
log "job $SLURM_JOB_ID: llama-server exited with status $status"
exit "$status"
