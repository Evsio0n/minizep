#!/usr/bin/env bash
# Generates a bearer token for the minizep HTTP service and prints its MINIZEP_TOKENS entry.
#
#   deploy/tokens.sh                                   # entry for the group "default"
#   deploy/tokens.sh --group 'teamA|shared'            # groups it may use; the first is its default
#   sudo deploy/tokens.sh --group teamA --append /etc/minizep/minizep.env
#
# The entry "<token>:<group>[|<group>...]" goes to stdout and is the only thing printed
# there. Without --append nothing is written anywhere: add the entry to MINIZEP_TOKENS
# yourself (entries are comma-separated).
#
# With --append ENVFILE the entry is added to the MINIZEP_TOKENS line of that file, which
# is created when the file has none. The file is first copied to ENVFILE.bak.<time> (same
# mode and owner); the new content goes to a temporary file in the same directory that is
# then renamed over the original, so no reader ever sees a half-written file. The service
# reads the file only when it starts: restart it afterwards (systemctl restart minizep).
#
# The token is 32 random bytes from openssl, base64url without padding: 43 characters of
# [A-Za-z0-9_-], so it never contains the separators , : or |. It is shown once; hand it to
# the client over a private channel.
set -euo pipefail

GROUPS_ARG=default
ENV_FILE=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() { sed -n '2,/^set -euo/{/^set -euo/d;s/^# \{0,1\}//;p;}' "${BASH_SOURCE[0]}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --group | --groups)
      [ $# -ge 2 ] || die "$1 needs a value"
      GROUPS_ARG=$2
      shift 2
      ;;
    --append)
      if [ $# -lt 2 ] || [ -z "$2" ]; then die "--append needs the path of the environment file"; fi
      ENV_FILE=$2
      shift 2
      ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

# Group names end up between the entry separators and inside an env file line.
GROUP_RE='^[A-Za-z0-9._-]+(\|[A-Za-z0-9._-]+)*$'
[[ $GROUPS_ARG =~ $GROUP_RE ]] ||
  die "invalid --group '$GROUPS_ARG': names of letters, digits and . _ - separated by |"

command -v openssl >/dev/null 2>&1 || die "openssl not found"
TOKEN=$(openssl rand -base64 32 | tr -d '\n=' | tr '+/' '-_')
[[ $TOKEN =~ ^[A-Za-z0-9_-]{43}$ ]] || die "unexpected token format from openssl"
ENTRY="$TOKEN:$GROUPS_ARG"

if [ -z "$ENV_FILE" ]; then
  printf '%s\n' "$ENTRY"
  echo "add this entry to MINIZEP_TOKENS (comma-separated), then: systemctl restart minizep" >&2
  exit 0
fi

# ---- --append --------------------------------------------------------------------------

[ ! -L "$ENV_FILE" ] || die "$ENV_FILE is a symlink; pass the file it points to"
[ -f "$ENV_FILE" ] || die "$ENV_FILE does not exist (deploy/install.sh creates it)"
if [ ! -r "$ENV_FILE" ] || [ ! -w "$ENV_FILE" ]; then
  die "$ENV_FILE is not readable and writable by $(id -un) (use sudo)"
fi
KEY_RE='^[[:space:]]*MINIZEP_TOKENS[[:space:]]*='
lines=$(grep -c -E "$KEY_RE" "$ENV_FILE" || true)
[ "$lines" -le 1 ] || die "$ENV_FILE has $lines MINIZEP_TOKENS lines; merge them into one first"

tmp=$(mktemp "$ENV_FILE.XXXXXX")
trap 'rm -f "$tmp"' EXIT
# The copy gives the temporary file the original's mode and owner; its content is
# replaced below.
cp -p "$ENV_FILE" "$tmp"

# Rewrites the MINIZEP_TOKENS line with the entry added (keeping its quotes), or adds the
# line at the end when there is none. The entry reaches awk and grep through the
# environment, not argv: any local user can read a process's command line.
MINIZEP_NEW_ENTRY="$ENTRY" awk -v key_re="$KEY_RE" '
  BEGIN { entry = ENVIRON["MINIZEP_NEW_ENTRY"] }
  $0 ~ key_re {
    v = $0
    sub(key_re, "", v)
    sub(/^[ \t]+/, "", v)
    sub(/[ \t\r]+$/, "", v)
    q = substr(v, 1, 1)
    if (length(v) >= 2 && (q == "\"" || q == "\047") && substr(v, length(v), 1) == q) v = substr(v, 2, length(v) - 2)
    else q = ""
    sub(/,+$/, "", v)
    print "MINIZEP_TOKENS=" q (v == "" ? entry : v "," entry) q
    done = 1
    next
  }
  { print }
  END { if (!done) print "MINIZEP_TOKENS=" entry }
' "$ENV_FILE" >"$tmp"

# Sanity check before replacing anything: one MINIZEP_TOKENS line, carrying the entry,
# and every other line untouched.
[ "$(grep -c -E "$KEY_RE" "$tmp")" = 1 ] || die "rewrite failed; $ENV_FILE left unchanged"
grep -E "$KEY_RE" "$tmp" | MINIZEP_NEW_ENTRY="$ENTRY" awk 'index($0, ENVIRON["MINIZEP_NEW_ENTRY"]) { found = 1 } END { exit !found }' ||
  die "rewrite failed; $ENV_FILE left unchanged"
[ "$(grep -v -E "$KEY_RE" "$ENV_FILE")" = "$(grep -v -E "$KEY_RE" "$tmp")" ] ||
  die "rewrite changed other lines; $ENV_FILE left unchanged"

backup="$ENV_FILE.bak.$(date +%Y%m%dT%H%M%S)"
[ ! -e "$backup" ] || backup="$backup.$$"
cp -p "$ENV_FILE" "$backup"
mv -f "$tmp" "$ENV_FILE"
trap - EXIT

printf '%s\n' "$ENTRY"
{
  echo "added the entry to MINIZEP_TOKENS in $ENV_FILE (previous version: $backup)"
  echo "restart the service to load it: systemctl restart minizep"
  echo "the backup holds tokens as well; delete it once the new file is known to work"
} >&2
