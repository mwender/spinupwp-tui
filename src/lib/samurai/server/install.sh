#!/usr/bin/env bash
#
# install.sh: register a site with the spinuptui-nginx gate, or take one off.
# Run as root (sudo) on the SpinupWP server, from a bundle directory SpinupTUI
# uploads, holding:
#
#   spinuptui-nginx   the gate script (the same for every site)
#   <site>.allowed    the site's allowlist of custom files
#   <site>.pub        the site's deploy public keys, one per line: one per
#                     machine allowed to deploy it, all pinned to this site
#
#   install.sh <site>               register (or re-register) the site. Safe to
#                                   re-run: it is how the allowlist and keys
#                                   change. Other sites are left as they are,
#                                   and so is anything in authorized_keys
#                                   outside our block.
#   install.sh --remove <site>      take the site off: its allowlist, its keys
#                                   and their authorized_keys lines. Its nginx
#                                   files are left alone; empty them through
#                                   the gate first.
#   install.sh --remove-gate        remove the gate, its sudoers rule and its
#                                   user. Refused while any site is registered.
#                                   Backups are kept.
#
# Any change here changes INSTALLER_SHA256 in ../gate.ts, which the tests check.

set -euo pipefail

# --- paths (the sandbox test rewrites this block) ---
SITES_ROOT=/etc/nginx/sites-available
CONF_ROOT=/etc/spinuptui/nginx
GATE=/usr/local/sbin/spinuptui-nginx
SUDOERS=/etc/sudoers.d/spinuptui-nginx
DEPLOY_USER=spinuptui-nginx
DEPLOY_HOME=/home/spinuptui-nginx
REQUIRE_ROOT=1
# --- end paths ---

BEGIN='# BEGIN spinuptui-nginx (managed by SpinupTUI; edit via install.sh)'
END='# END spinuptui-nginx'
AK="$DEPLOY_HOME/.ssh/authorized_keys"
EXTRA_DROP=()

die() { echo "ERROR: $*" >&2; exit 1; }

if [[ "$REQUIRE_ROOT" == 1 ]]; then
  [[ "$(id -u)" -eq 0 ]] || die "run with sudo"
fi

# Rebuilds our block of authorized_keys from every registered site. Lines
# outside the block are kept, except any carrying one of our keys (e.g. a
# hand-installed predecessor of this tool, or a site just removed), which the
# block now replaces or drops.
rebuild_authorized_keys() {
  local block keys_file new_ak pub s k
  install -d -o root -g root -m 755 "$DEPLOY_HOME/.ssh"
  block=$(mktemp)
  keys_file=$(mktemp)
  new_ak=$(mktemp)

  {
    echo "$BEGIN"
    for pub in "$CONF_ROOT"/sites/*.pub; do
      [[ -f "$pub" ]] || continue
      s=$(basename "$pub" .pub)
      [[ -f "$CONF_ROOT/sites/$s.allowed" ]] || continue
      while IFS= read -r k; do
        [[ -n "$k" ]] || continue
        echo "command=\"sudo $GATE $s \\\"\$SSH_ORIGINAL_COMMAND\\\"\",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc $k"
      done < "$pub"
    done
    echo "$END"
  } > "$block"

  { cat "$CONF_ROOT"/sites/*.pub 2>/dev/null || true; printf '%s\n' ${EXTRA_DROP[@]+"${EXTRA_DROP[@]}"}; } \
    | awk '{for (i=1;i<=NF;i++) if ($i ~ /^ssh-/) {print $(i+1); break}}' > "$keys_file"
  if [[ -f "$AK" ]]; then
    awk -v begin="$BEGIN" -v end="$END" '
      FNR == NR { managed[$1] = 1; next }
      $0 == begin { skip = 1; next }
      $0 == end   { skip = 0; next }
      skip { next }
      { for (i = 1; i <= NF; i++) if ($i ~ /^ssh-/ && managed[$(i+1)]) { dropped++; next } }
      { print }
      END { if (dropped) printf "Replaced %d pre-existing line(s) for managed keys.\n", dropped > "/dev/stderr" }
    ' "$keys_file" "$AK" > "$new_ak"
  fi
  cat "$block" >> "$new_ak"
  install -o root -g root -m 644 "$new_ak" "$AK"
  rm -f "$block" "$keys_file" "$new_ak"
}

if [[ "${1:-}" == "--remove" ]]; then
  SITE=${2:-}
  [[ "$SITE" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || die "usage: install.sh --remove <site>"
  [[ -f "$CONF_ROOT/sites/$SITE.allowed" ]] || die "$SITE isn't registered"
  removed_keys=$(cat "$CONF_ROOT/sites/$SITE.pub" 2>/dev/null || true)
  while IFS= read -r k; do [[ -n "$k" ]] && EXTRA_DROP+=("$k"); done <<< "$removed_keys"
  rm -f "$CONF_ROOT/sites/$SITE.allowed" "$CONF_ROOT/sites/$SITE.pub"
  rebuild_authorized_keys
  echo "Removed $SITE. Its nginx files are unchanged; backups are in place."
  left=0
  for f in "$CONF_ROOT"/sites/*.allowed; do [[ -f "$f" ]] && left=$((left + 1)); done
  echo "Sites still registered on this server: $left"
  exit 0
fi

if [[ "${1:-}" == "--remove-gate" ]]; then
  if ls "$CONF_ROOT"/sites/*.allowed >/dev/null 2>&1; then
    die "sites are still registered: $(ls "$CONF_ROOT"/sites/*.allowed | xargs -n1 basename | sed 's/\.allowed$//' | paste -sd' ' -). Remove them first."
  fi
  rm -f "$GATE" "$SUDOERS"
  if [[ -f "$AK" ]]; then
    awk -v begin="$BEGIN" -v end="$END" '$0 == begin {skip=1; next} $0 == end {skip=0; next} !skip' "$AK" > "$AK.new" && mv "$AK.new" "$AK"
  fi
  if id "$DEPLOY_USER" &>/dev/null; then userdel "$DEPLOY_USER" && echo "Removed user $DEPLOY_USER"; fi
  rm -rf "$CONF_ROOT"
  rmdir "$(dirname "$CONF_ROOT")" 2>/dev/null || true
  echo "Removed the gate, its sudoers rule and its user. Backups are kept."
  exit 0
fi

SITE=${1:-}
[[ "$SITE" =~ ^[a-z0-9][a-z0-9.-]*$ ]] || die "usage: install.sh <site>  (e.g. example.com)"
[[ -d "$SITES_ROOT/$SITE" ]] || die "no nginx config dir at $SITES_ROOT/$SITE; is the site name right?"

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
for f in spinuptui-nginx "$SITE.allowed" "$SITE.pub"; do
  [[ -f "$HERE/$f" ]] || die "missing $HERE/$f"
done

bash -n "$HERE/spinuptui-nginx"

# Allowlist entries must be plain .conf files directly inside one of SpinupWP's
# include dirs. Anything else is a typo or an attempt to escape the site dir.
while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line%%#*}
  line=${line//[[:space:]]/}
  [[ -z "$line" ]] && continue
  [[ "$line" =~ ^(before|server|location|after)/[A-Za-z0-9][A-Za-z0-9._-]*\.conf$ ]] \
    || die "bad allowlist entry '$line' (expected before|server|location|after/<name>.conf)"
done < "$HERE/$SITE.allowed"

# One or more keys, one per line. Re-registering replaces the site's whole set,
# so a key left out here is revoked.
pubkeys=$(grep -v '^[[:space:]]*#' "$HERE/$SITE.pub" | grep -v '^[[:space:]]*$' || true)
[[ -n "$pubkeys" ]] || die "$SITE.pub holds no public key"
while IFS= read -r k; do
  [[ "$k" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+ ]] \
    || die "$SITE.pub: not an ssh-ed25519 or ssh-rsa public key: ${k:0:40}..."
done <<< "$pubkeys"
key_blobs=$(awk '{print $2}' <<< "$pubkeys")
[[ -z "$(sort <<< "$key_blobs" | uniq -d)" ]] || die "$SITE.pub lists the same key twice"

# A key pinned to two sites would get whichever line sshd meets first, so a
# key may serve one site only.
for other in "$CONF_ROOT"/sites/*.pub; do
  [[ -f "$other" ]] || continue
  o=$(basename "$other" .pub)
  [[ "$o" == "$SITE" ]] && continue
  while IFS= read -r blob; do
    awk -v b="$blob" '$2 == b {found=1} END {exit !found}' "$other" \
      && die "a key in $SITE.pub is already registered for $o; give each site its own key"
  done <<< "$key_blobs"
done

if ! id "$DEPLOY_USER" &>/dev/null; then
  useradd --create-home --home-dir "$DEPLOY_HOME" --shell /bin/bash "$DEPLOY_USER"
  echo "Created user $DEPLOY_USER"
fi

install -d -o root -g root -m 755 "$(dirname "$GATE")"
install -o root -g root -m 755 "$HERE/spinuptui-nginx" "$GATE"

sudoers_tmp=$(mktemp)
trap 'rm -f "$sudoers_tmp"' EXIT
cat > "$sudoers_tmp" <<EOF
# Managed by SpinupTUI (Samurai's install.sh for spinuptui-nginx).
# Lets $DEPLOY_USER run the nginx deploy gate as root, and nothing else. Which
# site a key may act on is fixed by its forced command in authorized_keys.
$DEPLOY_USER ALL=(root) NOPASSWD: $GATE
EOF
visudo -cf "$sudoers_tmp" >/dev/null
install -o root -g root -m 440 "$sudoers_tmp" "$SUDOERS"

install -d -o root -g root -m 755 "$(dirname "$CONF_ROOT")" "$CONF_ROOT" "$CONF_ROOT/sites"
install -o root -g root -m 644 "$HERE/$SITE.allowed" "$CONF_ROOT/sites/$SITE.allowed"
printf '%s\n' "$pubkeys" > "$CONF_ROOT/sites/$SITE.pub"
chmod 644 "$CONF_ROOT/sites/$SITE.pub"

rebuild_authorized_keys

echo "Registered $SITE. Allowlist:"
grep -v '^[[:space:]]*#' "$CONF_ROOT/sites/$SITE.allowed" | grep -v '^[[:space:]]*$' | while IFS= read -r f; do
  if [[ -e "$SITES_ROOT/$SITE/$f" ]]; then echo "  $f (exists)"; else echo "  $f (new)"; fi
done || true
echo "Deploy keys for $SITE: $(grep -c . "$CONF_ROOT/sites/$SITE.pub")"
echo "Sites registered on this server: $(ls "$CONF_ROOT"/sites/*.allowed | xargs -n1 basename | sed 's/\.allowed$//' | paste -sd' ' -)"
