#!/bin/bash
# Build the tftp-hpa client and server binaries used as a wire-compat reference.
# The sources are downloaded from the official upstream tagged snapshot and
# cached locally under .tftp-hpa-cache/ so the repo does not need to vendor
# tftp-hpa directly.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UPSTREAM_URL="https://git.kernel.org/pub/scm/network/tftp/tftp-hpa.git"
CACHE="$ROOT/.tftp-hpa-cache"
DOWNLOADS="$CACHE/downloads"
OUT="$ROOT/.tftp-hpa-bin"
CLIENT="$OUT/tftp"
SERVER="$OUT/tftpd"
MARKER="$OUT/.built-from-tag"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

latest_tag() {
  git ls-remote --tags --refs "$UPSTREAM_URL" "refs/tags/tftp-hpa-*" |
    awk -F/ '{ print $3 }' |
    sort -V |
    tail -n 1
}

replace_text() {
  local file="$1"
  local before="$2"
  local after="$3"

  if AFTER="$after" perl -0ne 'exit(index($_, $ENV{AFTER}) >= 0 ? 0 : 1)' "$file"; then
    return 0
  fi

  if ! BEFORE="$before" perl -0ne 'exit(index($_, $ENV{BEFORE}) >= 0 ? 0 : 1)' "$file"; then
    echo "Unable to patch upstream tftp-hpa source: missing snippet \"${before}\"" >&2
    exit 1
  fi

  BEFORE="$before" AFTER="$after" perl -0pi -e '
    BEGIN {
      $before = $ENV{BEFORE};
      $after = $ENV{AFTER};
    }

    s/\Q$before\E/$after/
      or die "Unable to patch upstream tftp-hpa source\n";
  ' "$file"
}

apply_unprivileged_patch() {
  local file="$1"

  replace_text \
    "$file" \
    '    setrv = initgroups(user, pw->pw_gid);' \
    $'    /* Skip group-list setup when we do not have CAP_SETGID (testing harness). */\n    setrv = (geteuid() == 0) ? initgroups(user, pw->pw_gid) : 0;'

  replace_text \
    "$file" \
    '    setrv = setregid(pw->pw_gid, pw->pw_gid);' \
    $'    /* Skip when unprivileged (testing harness). */\n    setrv = (geteuid() == 0) ? setregid(pw->pw_gid, pw->pw_gid) : 0;'

  replace_text \
    "$file" \
    '    setrv = setrv || setreuid(pw->pw_uid, pw->pw_uid);' \
    '    setrv = setrv || ((geteuid() == 0) ? setreuid(pw->pw_uid, pw->pw_uid) : 0);'
}

require_command curl
require_command gcc
require_command git
require_command autoconf
require_command autoheader
require_command make
require_command perl
require_command tar

mkdir -p "$DOWNLOADS" "$OUT"

TAG="$(latest_tag)"
if [[ -z "$TAG" ]]; then
  echo "Unable to determine latest tftp-hpa tag from $UPSTREAM_URL" >&2
  exit 1
fi

SRC="$CACHE/$TAG"
ARCHIVE="$DOWNLOADS/$TAG.tar.gz"

if [[ -x "$CLIENT" && -x "$SERVER" && -f "$MARKER" ]] && [[ "$(cat "$MARKER")" == "$TAG" ]] && [[ "$CLIENT" -nt "$0" && "$SERVER" -nt "$0" ]]; then
  exit 0
fi

if [[ ! -f "$ARCHIVE" ]]; then
  curl -fsSL "$UPSTREAM_URL/snapshot/$TAG.tar.gz" -o "$ARCHIVE"
fi

if [[ ! -d "$SRC" ]]; then
  tar -xzf "$ARCHIVE" -C "$CACHE"
fi

apply_unprivileged_patch "$SRC/tftpd/tftpd.c"
make -C "$SRC" distclean >/dev/null 2>&1 || true
make -C "$SRC" tftp.build tftpd.build
install -m 755 "$SRC/tftp/tftp" "$CLIENT"
install -m 755 "$SRC/tftpd/tftpd" "$SERVER"

printf '%s' "$TAG" > "$MARKER"
echo "Built tftp-hpa ($TAG): $CLIENT, $SERVER" >&2
