#!/usr/bin/env bash
set -euo pipefail
umask 077

gateway_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
gateway_project_dir="$(cd "$gateway_script_dir/.." && pwd)"

if [[ "${1:-}" == "--help" || "$#" -gt 3 ]]; then
  printf 'Usage: bash scripts/move-firebase-key.sh [SOURCE_JSON] [DESTINATION_JSON] [ENV_FILE]\n'
  printf 'Defaults: Downloads/sms-gateway-server.json -> ~/.config/sms-gateway/sms-gateway-server.json, updating the project .env.\n'
  exit 0
fi

gateway_source="${1:-$HOME/Downloads/sms-gateway-server.json}"
gateway_destination="${2:-$HOME/.config/sms-gateway/sms-gateway-server.json}"
gateway_env_file="${3:-$gateway_project_dir/.env}"
gateway_destination_dir="$(dirname "$gateway_destination")"
gateway_key_temp=""
gateway_env_temp=""

gateway_cleanup() {
  [[ -z "$gateway_key_temp" ]] || rm -f "$gateway_key_temp"
  [[ -z "$gateway_env_temp" ]] || rm -f "$gateway_env_temp"
}
trap gateway_cleanup EXIT

if [[ ! -f "$gateway_source" ]]; then
  printf 'Source JSON file does not exist: %s\n' "$gateway_source" >&2
  exit 1
fi
if [[ -e "$gateway_destination" || -L "$gateway_destination" ]]; then
  printf 'Destination already exists; nothing was overwritten: %s\n' "$gateway_destination" >&2
  exit 1
fi
if [[ ! -f "$gateway_env_file" || -L "$gateway_env_file" ]]; then
  printf 'Expected an existing, regular .env file: %s\n' "$gateway_env_file" >&2
  exit 1
fi

mkdir -p "$gateway_destination_dir"
chmod 700 "$gateway_destination_dir"
gateway_key_temp="$(mktemp "$gateway_destination_dir/.firebase-key.XXXXXX")"

if ! cat "$gateway_source" > "$gateway_key_temp"; then
  printf 'Cannot read the source key. Run this script from macOS Terminal with access to Downloads. The source file was preserved.\n' >&2
  exit 1
fi
chmod 600 "$gateway_key_temp"
if ! cmp -s "$gateway_source" "$gateway_key_temp"; then
  printf 'Copy verification failed. The source file was preserved.\n' >&2
  exit 1
fi

gateway_env_temp="$(mktemp "$(dirname "$gateway_env_file")/.env.firebase-move.XXXXXX")"
awk -v gateway_key_path="$gateway_destination" '
  BEGIN { gateway_found = 0 }
  /^[[:space:]]*(export[[:space:]]+)?GOOGLE_APPLICATION_CREDENTIALS[[:space:]]*=/ {
    if (!gateway_found) print "GOOGLE_APPLICATION_CREDENTIALS=" gateway_key_path
    gateway_found = 1
    next
  }
  { print }
  END {
    if (!gateway_found) print "GOOGLE_APPLICATION_CREDENTIALS=" gateway_key_path
  }
' "$gateway_env_file" > "$gateway_env_temp"
chmod 600 "$gateway_env_temp"

# A hard link publishes the verified copy without overwriting an existing file.
# The original remains intact until the destination and .env update succeed.
if ! ln "$gateway_key_temp" "$gateway_destination"; then
  printf 'Could not create the destination. The source file was preserved.\n' >&2
  exit 1
fi
if ! mv -f "$gateway_env_temp" "$gateway_env_file"; then
  printf 'Could not update .env. Both key copies were preserved; the destination is %s\n' "$gateway_destination" >&2
  exit 1
fi
gateway_env_temp=""
rm "$gateway_source"

printf 'Key moved to: %s\n' "$gateway_destination"
printf 'Updated GOOGLE_APPLICATION_CREDENTIALS in: %s\n' "$gateway_env_file"
printf 'Ready to retry npm run provision. No Firebase registrations were changed.\n'
