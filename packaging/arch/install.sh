#!/usr/bin/env bash
# Installs protunel from its signed pacman repo on Arch-based distros.
#
#   curl -fsSL https://raw.githubusercontent.com/vrykolakas166/protunel/master/packaging/arch/install.sh | sudo bash
#   curl -fsSL https://raw.githubusercontent.com/vrykolakas166/protunel/master/packaging/arch/install.sh | sudo bash -s -- --uninstall
#
# PACMAN_CONF / PACMAN_D / KEY_FILE exist so the file logic can be tested
# against copies; leave them unset normally.
set -euo pipefail

FPR=017C5997B8FE5A79784BA2C29A38E414ECE95901
# Overridable only in test mode, so a stray environment can't swap the trusted key.
[ -z "${PROTUNEL_TEST:-}" ] || FPR="${PROTUNEL_FPR:-$FPR}"
KEY_URL="https://raw.githubusercontent.com/vrykolakas166/protunel/master/packaging/arch/protunel-repo.asc"
PKG="protunel-bin"
PACMAN_CONF="${PACMAN_CONF:-/etc/pacman.conf}"
PACMAN_D="${PACMAN_D:-/etc/pacman.d}"
REPO_CONF="$PACMAN_D/protunel.conf"
INCLUDE_LINE="Include = $REPO_CONF"

die() { echo "error: $*" >&2; exit 1; }

mode=install
for arg in "$@"; do
  case "$arg" in
    --uninstall) mode=uninstall ;;
    -h|--help) echo "usage: install.sh [--uninstall]"; exit 0 ;;
    *) die "unknown argument: $arg" ;;
  esac
done

if [ -z "${PROTUNEL_TEST:-}" ]; then
  [ "$(id -u)" -eq 0 ] || die "this needs root. Re-run with sudo (… | sudo bash)."
  command -v pacman >/dev/null 2>&1 || die "pacman not found. This script is for Arch-based distros; see the README for other systems: https://github.com/vrykolakas166/protunel#install"
fi

# Drop an inline [protunel] section from pacman.conf (older manual setups).
remove_inline_section() {
  grep -qx '\[protunel\]' "$PACMAN_CONF" || return 0
  cp -- "$PACMAN_CONF" "$PACMAN_CONF.protunel.bak"
  echo "Removing inline [protunel] section from $PACMAN_CONF (backup: $PACMAN_CONF.protunel.bak)"
  local tmp
  tmp="$(mktemp)"
  awk '
    /^\[protunel\]$/ { skip=1; next }
    skip && /^\[/ { skip=0 }
    skip && (/^[[:space:]]*$/ || /^[A-Za-z]+[[:space:]]*=/) { next }
    { skip=0; print }
  ' "$PACMAN_CONF" > "$tmp"
  cat -- "$tmp" > "$PACMAN_CONF"
  rm -f -- "$tmp"
}

# Fingerprint of the first key in the file, uppercase.
key_fpr() {
  # Throwaway GNUPGHOME: inspecting the key must not create or touch root's ~/.gnupg.
  GNUPGHOME="$TMPD" gpg --batch --with-colons --show-keys -- "$1" 2>/dev/null | awk -F: '$1=="fpr"{print toupper($10); exit}'
}

install_repo() {
  command -v gpg >/dev/null 2>&1 || die "gpg not found (install the gnupg package)."
  local key got
  TMPD="$(mktemp -d)"
  trap 'rm -rf -- "$TMPD"' EXIT
  key="${KEY_FILE:-$TMPD/protunel-repo.asc}"
  if [ -z "${KEY_FILE:-}" ]; then
    echo "Downloading repo key..."
    curl -fsSL "$KEY_URL" -o "$key"
  fi
  got="$(key_fpr "$key")"
  [ "$got" = "$FPR" ] || die "repo key fingerprint mismatch (expected $FPR, got ${got:-none}). Aborting."
  echo "Key fingerprint OK: $FPR"

  if [ -z "${PROTUNEL_TEST:-}" ]; then
    [ -d /etc/pacman.d/gnupg ] || pacman-key --init
    pacman-key --add "$key"
    pacman-key --lsign-key "$FPR"
  fi

  mkdir -p -- "$PACMAN_D"
  cat > "$REPO_CONF" <<CONF
[protunel]
SigLevel = Required
Server = https://github.com/vrykolakas166/protunel/releases/download/pacman-repo
CONF
  remove_inline_section
  if ! grep -qxF "$INCLUDE_LINE" "$PACMAN_CONF"; then
    printf '\n%s\n' "$INCLUDE_LINE" >> "$PACMAN_CONF"
  fi

  [ -z "${PROTUNEL_TEST:-}" ] || return 0
  # stdin is the script itself under curl|bash, so never prompt.
  # -Syu, not -Sy: refreshing the databases and installing without upgrading
  # is a partial upgrade, which Arch does not support.
  pacman -Syu --needed --noconfirm "$PKG"
  echo
  echo "protunel installed. Find it in your app launcher."
  echo "Updates arrive with: sudo pacman -Syu"
}

uninstall_repo() {
  if [ -z "${PROTUNEL_TEST:-}" ] && pacman -Qq "$PKG" >/dev/null 2>&1; then
    pacman -Rns --noconfirm "$PKG"
  fi
  if [ -f "$PACMAN_CONF" ]; then
    local tmp
    tmp="$(mktemp)"
    grep -vxF "$INCLUDE_LINE" "$PACMAN_CONF" > "$tmp" || true
    cat -- "$tmp" > "$PACMAN_CONF"
    rm -f -- "$tmp"
  fi
  rm -f -- "$REPO_CONF"
  if [ -z "${PROTUNEL_TEST:-}" ]; then
    pacman-key --delete "$FPR" 2>/dev/null || true
  fi
  echo "protunel and its repo configuration were removed."
}

case "$mode" in
  install) install_repo ;;
  uninstall) uninstall_repo ;;
esac
