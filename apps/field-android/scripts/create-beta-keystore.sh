#!/usr/bin/env bash
# SP-0124: create the Sunpride Field beta signing key OUTSIDE the repository, once.
#   ~/.sunpride-keys/field-beta.jks         the key (PKCS12)
#   ~/.sunpride-keys/field-beta.properties  its path and generated password (chmod 600)
# The password is generated here and only ever written to that properties file; it is never printed.
# Refuses to overwrite an existing key: every beta APK must be signed with the same key or phones
# cannot update without uninstalling (and losing unsent work).
set -euo pipefail

DIR="${SUNPRIDE_KEYS_DIR:-$HOME/.sunpride-keys}"
STORE="$DIR/field-beta.jks"
PROPS="$DIR/field-beta.properties"
ALIAS="sunpride-field-beta"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
KEYTOOL="$JAVA_HOME/bin/keytool"

if [[ -e "$STORE" || -e "$PROPS" ]]; then
  printf 'Beta key already exists in %s; nothing to do.\n' "$DIR"
  exit 0
fi
[[ -x "$KEYTOOL" ]] || { printf 'keytool not found at %s\n' "$KEYTOOL" >&2; exit 1; }

umask 077
mkdir -p "$DIR"
chmod 700 "$DIR"
SUNPRIDE_BETA_KEY_PASSWORD="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 40)"
export SUNPRIDE_BETA_KEY_PASSWORD
[[ ${#SUNPRIDE_BETA_KEY_PASSWORD} -ge 32 ]] || { printf 'Could not generate a password\n' >&2; exit 1; }

# Write the properties file first (600), then the key that it describes.
{
  printf '# Sunpride Field beta signing key. Never commit or share this file.\n'
  printf 'storeFile=%s\n' "$STORE"
  printf 'storePassword=%s\n' "$SUNPRIDE_BETA_KEY_PASSWORD"
  printf 'keyAlias=%s\n' "$ALIAS"
  printf 'keyPassword=%s\n' "$SUNPRIDE_BETA_KEY_PASSWORD"
} > "$PROPS"
chmod 600 "$PROPS"

"$KEYTOOL" -genkeypair -noprompt -storetype PKCS12 -keystore "$STORE" -alias "$ALIAS" \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -dname "CN=Sunpride Field Beta, O=Sunpride Foods Inc, C=PH" \
  -storepass:env SUNPRIDE_BETA_KEY_PASSWORD -keypass:env SUNPRIDE_BETA_KEY_PASSWORD >/dev/null
chmod 600 "$STORE"
unset SUNPRIDE_BETA_KEY_PASSWORD
printf 'Created %s and %s (password stored only in the properties file).\n' "$STORE" "$PROPS"
