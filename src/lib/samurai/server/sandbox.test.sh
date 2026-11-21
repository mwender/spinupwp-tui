#!/usr/bin/env bash
#
# sandbox.test.sh: exercise install.sh and the spinuptui-nginx gate end to end
# in a temp sandbox, with nginx, systemctl, flock, useradd, userdel and visudo
# mocked. No root, no server. A mock `nginx -t` fails whenever any site file
# contains "BROKEN". Run by gate.test.ts; also runnable on its own.

set -uo pipefail

HERE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
SB=$(mktemp -d)
trap 'rm -rf "$SB"' EXIT

pass=0 fail=0
ok()   { echo "  ok   $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL $1"; fail=$((fail + 1)); }
expect() { local name=$1; shift; if "$@" >"$SB/out" 2>&1; then ok "$name"; else bad "$name"; sed 's/^/       /' "$SB/out"; fi; }
expect_fail() { local name=$1; shift; if "$@" >"$SB/out" 2>&1; then bad "$name (unexpectedly succeeded)"; sed 's/^/       /' "$SB/out"; else ok "$name"; fi; }
has() { grep -q -- "$2" "$1"; }

# --- mocks ---
mkdir -p "$SB/mock" "$SB/sites-available" "$SB/home" "$SB/sbin" "$SB/sudoers.d"
cat > "$SB/mock/nginx" <<EOF
#!/usr/bin/env bash
if grep -rqs BROKEN "$SB/sites-available"; then echo "nginx: [emerg] mock failure" >&2; exit 1; fi
echo "nginx: configuration file test is successful" >&2
EOF
cat > "$SB/mock/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$SB/systemctl.log"
EOF
cat > "$SB/mock/install" <<'EOF'
#!/usr/bin/env bash
args=()
while (( $# )); do case "$1" in -o|-g) shift 2 ;; *) args+=("$1"); shift ;; esac; done
exec /usr/bin/install "${args[@]}"
EOF
printf '#!/bin/sh\nexit 0\n' > "$SB/mock/flock"
printf '#!/bin/sh\nexit 0\n' > "$SB/mock/visudo"
printf '#!/bin/sh\ntouch "%s/user_exists"\n' "$SB" > "$SB/mock/useradd"
printf '#!/bin/sh\nrm -f "%s/user_exists"\n' "$SB" > "$SB/mock/userdel"
cat > "$SB/mock/id" <<EOF
#!/bin/sh
if [ "\$1" = spinuptui-nginx ]; then [ -f "$SB/user_exists" ]; exit \$?; fi
exec /usr/bin/id "\$@"
EOF
chmod +x "$SB"/mock/*
export PATH="$SB/mock:$PATH"

# --- sandboxed copies of the server scripts ---
sandbox() { # file -> rewrite the paths block
  sed -e "s|^PATH=.*|PATH=$SB/mock:/usr/bin:/bin:/usr/sbin:/sbin|" \
      -e "s|^SITES_ROOT=.*|SITES_ROOT=$SB/sites-available|" \
      -e "s|^CONF_ROOT=.*|CONF_ROOT=$SB/etc-spinuptui/nginx|" \
      -e "s|^BACKUP_ROOT=.*|BACKUP_ROOT=$SB/backups/nginx|" \
      -e "s|^LOCK_ROOT=.*|LOCK_ROOT=$SB|" \
      -e "s|^GATE=.*|GATE=$SB/sbin/spinuptui-nginx|" \
      -e "s|^SUDOERS=.*|SUDOERS=$SB/sudoers.d/spinuptui-nginx|" \
      -e "s|^DEPLOY_HOME=.*|DEPLOY_HOME=$SB/home|" \
      -e "s|^REQUIRE_ROOT=.*|REQUIRE_ROOT=0|" "$1"
}
mkdir -p "$SB/bundle"
sandbox "$HERE/spinuptui-nginx" > "$SB/bundle/spinuptui-nginx"
sandbox "$HERE/install.sh" > "$SB/bundle/install.sh"
chmod +x "$SB/bundle"/*

# Two SpinupWP-shaped sites.
for s in alpha.test beta.test; do
  mkdir -p "$SB/sites-available/$s"/{before,server,location,after}
  echo "# managed" > "$SB/sites-available/$s/server/fastcgi-cache.conf"
  echo "# managed" > "$SB/sites-available/$s/location/fastcgi-cache.conf"
  echo "server { }" > "$SB/sites-available/$s/$s"
  # TLS leftovers SpinupWP can keep in the site dir; must never be exported.
  echo "-----BEGIN PRIVATE KEY-----" > "$SB/sites-available/$s/private.pem"
  echo cert > "$SB/sites-available/$s/certificate.crt"
done
ssh-keygen -q -t ed25519 -N '' -f "$SB/alpha_key" -C alpha
ssh-keygen -q -t ed25519 -N '' -f "$SB/beta_key" -C beta
AK="$SB/home/.ssh/authorized_keys"
CONF="$SB/etc-spinuptui/nginx"

echo "install.sh"
printf 'server/samurai.conf\nlocation/zz-extra.conf\n' > "$SB/bundle/alpha.test.allowed"
cp "$SB/alpha_key.pub" "$SB/bundle/alpha.test.pub"
# A hand-installed predecessor line for alpha's key, plus an unrelated key.
mkdir -p "$SB/home/.ssh"
{ echo "command=\"sudo /usr/local/sbin/old-gate\" $(cat "$SB/alpha_key.pub")"; echo "ssh-ed25519 AAAAunrelated other"; } > "$AK"
expect "registers a site" bash "$SB/bundle/install.sh" alpha.test
expect "creates the user" test -f "$SB/user_exists"
expect "installs the gate" test -x "$SB/sbin/spinuptui-nginx"
expect "writes the sudoers rule for the gate only" bash -c "grep -qx 'spinuptui-nginx ALL=(root) NOPASSWD: $SB/sbin/spinuptui-nginx' '$SB/sudoers.d/spinuptui-nginx'"
expect "forced command pins the site" has "$AK" "spinuptui-nginx alpha.test"
expect "the block is marked as SpinupTUI's" has "$AK" "# BEGIN spinuptui-nginx"
expect_fail "replaces the predecessor line for the same key" has "$AK" "old-gate"
expect "keeps unrelated authorized_keys lines" has "$AK" "AAAAunrelated"

printf 'server/samurai.conf\n' > "$SB/bundle/beta.test.allowed"
cp "$SB/beta_key.pub" "$SB/bundle/beta.test.pub"
expect "registers a second site on the same server" bash "$SB/bundle/install.sh" beta.test
expect "block holds both sites" bash -c "grep -c 'spinuptui-nginx [a-z]*\.test' '$AK' | grep -qx 2"
expect "re-run is idempotent" bash -c "bash '$SB/bundle/install.sh' beta.test && [ \$(grep -c BEGIN '$AK') = 1 ]"

printf 'server/../../etc/passwd\n' > "$SB/bundle/beta.test.allowed"
expect_fail "rejects a path-escaping allowlist entry" bash "$SB/bundle/install.sh" beta.test
printf 'server/samurai.conf\n' > "$SB/bundle/beta.test.allowed"
expect_fail "rejects an unknown site dir" bash "$SB/bundle/install.sh" nope.test

ssh-keygen -q -t ed25519 -N '' -f "$SB/beta2_key" -C beta2
{ cat "$SB/beta_key.pub"; echo; echo "# second machine"; cat "$SB/beta2_key.pub"; } > "$SB/bundle/beta.test.pub"
expect "registers two keys for one site" bash "$SB/bundle/install.sh" beta.test
expect "both keys pinned to that site" bash -c "grep 'spinuptui-nginx beta.test' '$AK' | grep -c ssh-ed25519 | grep -qx 2"
expect "the other site keeps its key" bash -c "grep -c 'spinuptui-nginx alpha.test' '$AK' | grep -qx 1"
cp "$SB/beta_key.pub" "$SB/bundle/beta.test.pub"
expect "re-registering without a key revokes it" bash -c "bash '$SB/bundle/install.sh' beta.test && ! grep -q \"\$(awk '{print \$2}' '$SB/beta2_key.pub')\" '$AK'"
{ cat "$SB/beta_key.pub"; cat "$SB/alpha_key.pub"; } > "$SB/bundle/beta.test.pub"
expect_fail "refuses a key already registered for another site" bash "$SB/bundle/install.sh" beta.test
{ cat "$SB/beta_key.pub"; cat "$SB/beta_key.pub"; } > "$SB/bundle/beta.test.pub"
expect_fail "refuses the same key twice" bash "$SB/bundle/install.sh" beta.test
echo "ssh-ed25519" > "$SB/bundle/beta.test.pub"
expect_fail "refuses a malformed key line" bash "$SB/bundle/install.sh" beta.test
cp "$SB/beta_key.pub" "$SB/bundle/beta.test.pub"
expect "back to one key for beta" bash -c "bash '$SB/bundle/install.sh' beta.test && grep 'spinuptui-nginx beta.test' '$AK' | grep -c ssh- | grep -qx 1"

echo "gate: read-only commands"
GATE="$SB/sbin/spinuptui-nginx"
expect "version is 2.0.0" bash -c "bash '$GATE' alpha.test version | grep -qx 2.0.0"
expect "hash is the installed file's SHA-256" bash -c "[ \"\$(bash '$GATE' alpha.test hash)\" = \"\$(shasum -a 256 '$GATE' | cut -d' ' -f1)\" ]"
expect "allowed lists the allowlist" bash -c "bash '$GATE' alpha.test allowed | grep -qx server/samurai.conf"
expect_fail "rejects an unregistered site" bash "$GATE" gamma.test test
expect_fail "rejects an unknown command" bash "$GATE" alpha.test rm
expect_fail "rejects a malformed site name" bash "$GATE" '../etc' version
expect "test runs nginx -t" bash "$GATE" alpha.test test
expect "export includes the site's config" bash -c "bash '$GATE' alpha.test export | tar -t | grep -q 'server/fastcgi-cache.conf'"
expect_fail "export leaves out TLS material" bash -c "bash '$GATE' alpha.test export | tar -t | grep -E '\\.(pem|crt)\$'"

echo "gate: deploy"
P="$SB/payload"
mkdir -p "$P/server" "$P/location"
deploy() { tar -C "$P" -cf - "$@" | bash "$GATE" alpha.test deploy; }
echo 'location = /pma { return 403; }' > "$P/server/samurai.conf"
expect "deploys a new allowlisted file" deploy server/samurai.conf
expect "the file is live" has "$SB/sites-available/alpha.test/server/samurai.conf" "return 403"
expect "nginx was reloaded" has "$SB/systemctl.log" "reload nginx"
expect "deploying the same file again is a no-op" bash -c "$(declare -f deploy); P='$P' GATE='$GATE'; deploy server/samurai.conf 2>&1 | grep -q 'No changes'"
echo 'location = /pma { return 404; }' > "$P/server/samurai.conf"
expect "updates the file" deploy server/samurai.conf
expect "keeps a backup of the previous version" bash -c "grep -rqs 'return 403' '$SB/backups/nginx/alpha.test'"
echo 'BROKEN' > "$P/server/samurai.conf"
expect_fail "a config nginx -t rejects is refused" deploy server/samurai.conf
expect "and the previous file is back" has "$SB/sites-available/alpha.test/server/samurai.conf" "return 404"
echo 'BROKEN' > "$P/location/zz-extra.conf"
expect_fail "a brand-new broken file is refused" deploy location/zz-extra.conf
expect_fail "and removed again" test -e "$SB/sites-available/alpha.test/location/zz-extra.conf"
mkdir -p "$SB/evil/server"; echo x > "$SB/evil/server/fastcgi-cache.conf"
expect_fail "refuses a SpinupWP-managed file" bash -c "tar -C '$SB/evil' -cf - server/fastcgi-cache.conf | bash '$GATE' alpha.test deploy"
expect_fail "the managed file is untouched" grep -q x "$SB/sites-available/alpha.test/server/fastcgi-cache.conf"
mkdir -p "$SB/sym/server"; ln -s /etc/hosts "$SB/sym/server/samurai.conf"
expect_fail "refuses a symlink" bash -c "tar -C '$SB/sym' -cf - server/samurai.conf | bash '$GATE' alpha.test deploy"
expect_fail "refuses an empty payload" bash -c "tar -C '$SB/evil' -cf - --files-from /dev/null | bash '$GATE' alpha.test deploy"
head -c 1100000 /dev/zero > "$SB/big.conf"; mkdir -p "$SB/bigp/server"; cp "$SB/big.conf" "$SB/bigp/server/samurai.conf"
expect_fail "refuses a payload over 1 MB" bash -c "tar -C '$SB/bigp' -cf - server/samurai.conf | bash '$GATE' alpha.test deploy"

echo "install.sh --remove and --remove-gate"
expect_fail "--remove-gate is refused while sites are registered" bash "$SB/bundle/install.sh" --remove-gate
expect "the gate is still there" test -x "$GATE"
expect "--remove takes a site off" bash "$SB/bundle/install.sh" --remove beta.test
expect_fail "its allowlist is gone" test -e "$CONF/sites/beta.test.allowed"
expect_fail "its key line is gone" grep -q "$(awk '{print $2}' "$SB/beta_key.pub")" "$AK"
expect "the other site still has its line" has "$AK" "spinuptui-nginx alpha.test"
expect "unrelated lines are still kept" has "$AK" "AAAAunrelated"
expect "its nginx files are left alone" test -e "$SB/sites-available/beta.test/server/fastcgi-cache.conf"
expect_fail "--remove of an unregistered site fails" bash "$SB/bundle/install.sh" --remove beta.test
expect "--remove the last site" bash "$SB/bundle/install.sh" --remove alpha.test
expect "--remove-gate once no site is left" bash "$SB/bundle/install.sh" --remove-gate
expect_fail "the gate is gone" test -e "$GATE"
expect_fail "the sudoers rule is gone" test -e "$SB/sudoers.d/spinuptui-nginx"
expect_fail "the user is gone" test -f "$SB/user_exists"
expect_fail "the managed block is gone" grep -q "spinuptui-nginx" "$AK"
expect "unrelated lines survive it" has "$AK" "AAAAunrelated"
expect_fail "the config folder is gone" test -e "$SB/etc-spinuptui"
expect "the backups are kept" test -d "$SB/backups/nginx/alpha.test"

echo
echo "$pass passed, $fail failed"
(( fail == 0 ))
