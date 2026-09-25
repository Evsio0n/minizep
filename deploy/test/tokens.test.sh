#!/usr/bin/env bash
# Tests for deploy/tokens.sh, run in a temporary directory. Needs openssl.
#
#   bash deploy/test/tokens.test.sh
# shellcheck disable=SC2317,SC2329  # helpers are called through check()
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
TOKENS="$HERE/../tokens.sh"
tmp_base=${TMPDIR:-/tmp}
ROOT=$(mktemp -d "${tmp_base%/}/tokens-test.XXXXXX")
trap 'rm -rf "$ROOT"' EXIT

PASSED=0
FAILED=0
N=0
TOKEN_RE='^[A-Za-z0-9_-]{43}'

# A case gets a fresh, empty directory T that is also the working directory.
new_case() {
  CASE=$1
  N=$((N + 1))
  T="$ROOT/case$N"
  mkdir -p "$T"
  cd "$T" || exit 1
  echo "# $CASE"
}

# tokens [args...]: stdout in $T/.stdout, stderr in $T/.stderr, status in $RC.
tokens() {
  bash "$TOKENS" "$@" >"$T/.stdout" 2>"$T/.stderr"
  RC=$?
}

check() {
  if "${@:2}"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "FAIL [$CASE] $1"
    sed 's/^/    out | /' "$T/.stdout"
    sed 's/^/    err | /' "$T/.stderr"
    [ ! -f "$T/env" ] || sed 's/^/    env | /' "$T/env"
  fi
}

stdout_is_entry() { [ "$(wc -l <"$T/.stdout")" -eq 1 ] && grep -Eqx "$TOKEN_RE:$1" "$T/.stdout"; }
entry() { cat "$T/.stdout"; }
# Only these files (besides the captured output) are in T.
files_are() { [ "$(find "$T" -mindepth 1 ! -name '.std*' -exec basename {} \; | sort | tr '\n' ' ')" = "$*" ]; }
mode_600() { [ -n "$(find "$1" -prune -perm 600)" ]; }
line_is() { [ "$(grep -E '^[[:space:]]*MINIZEP_TOKENS[[:space:]]*=' "$T/env")" = "$1" ]; }
backups() { find "$T" -name 'env.bak.*' | sort; }
backup() { backups | head -n 1; }
same_as_backup() { cmp -s "$T/env.orig" "$(backup)"; }
failed_quietly() { [ "$RC" -ne 0 ] && [ ! -s "$T/.stdout" ]; }

# env file with the given lines, mode 600, and a copy to compare against
env_file() {
  printf '%s\n' "$@" >"$T/env"
  chmod 600 "$T/env"
  cp -p "$T/env" "$T/env.orig"
}

# ---- generating --------------------------------------------------------------------------

new_case "default: one entry for the group default, nothing written"
tokens
check "exit 0" test "$RC" -eq 0
check "entry on stdout" stdout_is_entry default
check "hint on stderr" grep -q MINIZEP_TOKENS "$T/.stderr"
check "no files" files_are ""
first=$(entry)
tokens
check "a new token every time" test "$(entry)" != "$first"

new_case "several groups, the first is the default"
tokens --group 'teamA|shared'
check "exit 0" test "$RC" -eq 0
check "groups kept in order" stdout_is_entry 'teamA\|shared'

new_case "invalid group lists are rejected"
for bad in '' 'a,b' 'a:b' 'a|' '|a' 'a||b' 'a b' "a'b" 'a"b' 'a=b' '#a'; do
  tokens --group "$bad"
  check "rejects '$bad'" failed_quietly
done
tokens --group
check "missing value" test "$RC" -ne 0
tokens --bogus
check "unknown option" test "$RC" -ne 0
check "no files" files_are ""

# ---- --append ----------------------------------------------------------------------------

new_case "--append adds to an existing line and keeps everything else"
env_file "# tokens" "MINIZEP_HOST=127.0.0.1" "MINIZEP_TOKENS=tok-a:teamA|shared" "MINIZEP_PORT=8787"
tokens --group teamB --append "$T/env"
check "exit 0" test "$RC" -eq 0
check "entry on stdout" stdout_is_entry teamB
check "appended after a comma" line_is "MINIZEP_TOKENS=tok-a:teamA|shared,$(entry)"
check "other lines untouched" test "$(grep -v MINIZEP_TOKENS "$T/env")" = "$(grep -v MINIZEP_TOKENS "$T/env.orig")"
check "line stays in place" test "$(sed -n 3p "$T/env")" = "MINIZEP_TOKENS=tok-a:teamA|shared,$(entry)"
check "backup of the previous version" same_as_backup
check "mode kept" mode_600 "$T/env"
check "backup mode kept" mode_600 "$(backup)"
check "no temporary files left" files_are "env $(basename "$(backup)") env.orig "
check "restart hint" grep -q 'systemctl restart minizep' "$T/.stderr"

new_case "--append twice keeps both entries"
env_file "MINIZEP_TOKENS=tok-a:teamA"
tokens --append "$T/env"
one=$(entry)
tokens --append "$T/env"
check "both appended" line_is "MINIZEP_TOKENS=tok-a:teamA,$one,$(entry)"
check "one backup per change" test "$(backups | wc -l)" -eq 2

new_case "--append keeps quotes"
env_file 'MINIZEP_TOKENS="tok-a:teamA"'
tokens --append "$T/env"
check "inside the double quotes" line_is "MINIZEP_TOKENS=\"tok-a:teamA,$(entry)\""
env_file "MINIZEP_TOKENS='tok-a:teamA'"
tokens --append "$T/env"
check "inside the single quotes" line_is "MINIZEP_TOKENS='tok-a:teamA,$(entry)'"

new_case "--append to an empty value"
env_file "MINIZEP_TOKENS=" "MINIZEP_PORT=8787"
tokens --append "$T/env"
check "exit 0" test "$RC" -eq 0
check "only the new entry" line_is "MINIZEP_TOKENS=$(entry)"

new_case "--append to a value with a trailing comma"
env_file "MINIZEP_TOKENS=tok-a:teamA,"
tokens --append "$T/env"
check "no empty entry" line_is "MINIZEP_TOKENS=tok-a:teamA,$(entry)"

new_case "--append adds the line when there is none"
env_file "# MINIZEP_TOKENS=commented-out:x" "MINIZEP_PORT=8787"
tokens --group teamA --append "$T/env"
check "exit 0" test "$RC" -eq 0
check "comment kept" grep -qx '# MINIZEP_TOKENS=commented-out:x' "$T/env"
check "new line at the end" test "$(tail -n 1 "$T/env")" = "MINIZEP_TOKENS=$(entry)"
check "backup" same_as_backup

new_case "--append refuses two MINIZEP_TOKENS lines"
env_file "MINIZEP_TOKENS=tok-a:teamA" "MINIZEP_TOKENS=tok-b:teamB"
tokens --append "$T/env"
check "fails" test "$RC" -ne 0
check "says why" grep -q 'merge them into one' "$T/.stderr"
check "no entry printed" test ! -s "$T/.stdout"
check "file unchanged" cmp -s "$T/env" "$T/env.orig"
check "no backup or temporary file" files_are "env env.orig "

new_case "--append refuses a missing file or a symlink"
tokens --append "$T/missing"
check "missing file fails" test "$RC" -ne 0
check "and is not created" test ! -e "$T/missing"
env_file "MINIZEP_TOKENS=tok-a:teamA"
ln -s "$T/env" "$T/link"
tokens --append "$T/link"
check "symlink fails" test "$RC" -ne 0
check "target unchanged" cmp -s "$T/env" "$T/env.orig"
tokens --append
check "missing path fails" test "$RC" -ne 0

echo
echo "$PASSED passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
