#!/usr/bin/env bash
# SP-0125: create the Sunpride Van Sales beta signing key OUTSIDE the repository, once.
#   ~/.sunpride-keys/van-beta.jks         the key (PKCS12)
#   ~/.sunpride-keys/van-beta.properties  its path and generated password (chmod 600)
# The password is generated here and only ever written to that properties file; it is never printed.
# Refuses to overwrite an existing key: every beta APK must be signed with the same key or
# handhelds cannot update without uninstalling (and losing unsent work).
set -euo pipefail

DIR="${SUNPRIDE_KEYS_DIR:-$HOME/.sunpride-keys}"
STORE="$DIR/van-beta.jks"
PROPS="$DIR/van-beta.properties"
ALIAS="sunpride-van-beta"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
KEYTOOL="$JAVA_HOME/bin/keytool"

if [[ -e "$STORE" || -e "$PROPS" ]]; then
  printf 'Van beta key already exists in %s; nothing to do.\n' "$DIR"
  exit 0
fi
[[ -x "$KEYTOOL" ]] || { printf 'keytool not found at %s\n' "$KEYTOOL" >&2; exit 1; }

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
SUNPRIDE_VAN_BETA_KEY_PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"
export SUNPRIDE_VAN_BETA_KEY_PASSWORD
[[ ${#SUNPRIDE_VAN_BETA_KEY_PASSWORD} -ge 32 ]] || { printf 'Could not generate a password\n' >&2; exit 1; }

# Write the properties file first (600), then the key that it describes.
{
  printf '# Sunpride Van Sales beta signing key. Never commit or share this file.\n'
  printf 'storeFile=%s\n' "$STORE"
  printf 'storePassword=%s\n' "$SUNPRIDE_VAN_BETA_KEY_PASSWORD"
  printf 'keyAlias=%s\n' "$ALIAS"
  printf 'keyPassword=%s\n' "$SUNPRIDE_VAN_BETA_KEY_PASSWORD"
} > "$PROPS"
chmod 600 "$PROPS"

"$KEYTOOL" -genkeypair -noprompt -storetype PKCS12 -keystore "$STORE" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Sunpride Van Sales Beta, O=Sunpride Foods Inc, C=PH" \
  -storepass:env SUNPRIDE_VAN_BETA_KEY_PASSWORD -keypass:env SUNPRIDE_VAN_BETA_KEY_PASSWORD >/dev/null
chmod 600 "$STORE"
unset SUNPRIDE_VAN_BETA_KEY_PASSWORD
printf 'Created %s and %s (password stored only in the properties file).\n' "$STORE" "$PROPS"
