#!/usr/bin/env bash
# Reproducible local Postgres + pgvector for minizep.
#
#   bash infra/postgres/setup.sh
#
# Creates a container named minizep-pg on 127.0.0.1:${PORT}, with data on a
# persistent path (not tmpfs) and a restart policy. Writes the connection URL
# to PGDIR/url (mode 600) so tooling and tests can pick it up.
set -euo pipefail

PGDIR="${MINIZEP_PGDIR:-/var/tmp/minizep-pg}"
PORT="${MINIZEP_PGPORT:-5433}"
IMAGE="${MINIZEP_PGIMAGE:-pgvector/pgvector:pg17}"
NAME="${MINIZEP_PGNAME:-minizep-pg}"

mkdir -p "$PGDIR/data"

if [ ! -s "$PGDIR/password" ]; then
  umask 077
  head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 28 > "$PGDIR/password"
  echo "generated new password at $PGDIR/password"
fi
PW="$(cat "$PGDIR/password")"

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$NAME" \
  --restart unless-stopped \
  -e POSTGRES_USER=minizep \
  -e POSTGRES_PASSWORD="$PW" \
  -e POSTGRES_DB=minizep \
  -p "127.0.0.1:${PORT}:5432" \
  -v "$PGDIR/data:/var/lib/postgresql/data" \
  --health-cmd "pg_isready -U minizep -d minizep" \
  --health-interval 5s --health-retries 12 \
  "$IMAGE" >/dev/null

echo -n "waiting for postgres"
for _ in $(seq 1 40); do
  [ "$(docker inspect --format '{{.State.Health.Status}}' "$NAME" 2>/dev/null || echo none)" = healthy ] && break
  echo -n "."
  sleep 1
done
echo

docker exec "$NAME" psql -U minizep -d minizep -q -c "CREATE EXTENSION IF NOT EXISTS vector;"

umask 077
printf 'postgres://minizep:%s@127.0.0.1:%s/minizep' "$PW" "$PORT" > "$PGDIR/url"
chmod 600 "$PGDIR/url" "$PGDIR/password"

echo "postgres ready"
echo "  url file : $PGDIR/url"
echo "  data dir : $PGDIR/data"
docker exec "$NAME" psql -U minizep -d minizep -tAc \
  "SELECT 'pgvector ' || extversion FROM pg_extension WHERE extname='vector';"
