#!/usr/bin/env bash
# Wire up everything that depends on the Chrome Web Store's assigned Item ID.
#
# The store mints the extension id at DRAFT CREATION, and three separate things
# key off it. Doing them by hand means three edits in two repos plus a rebuild,
# and forgetting the third is silent: the extension works, but chat.divinci.app
# never detects it and shows the local model as unavailable.
#
#   ./scripts/set-store-item-id.sh <ITEM_ID> <AUTH0_CLIENT_ID>
#
# Prints the exact Auth0 callback URLs to register before it touches anything.
set -euo pipefail

ITEM_ID="${1:-}"
AUTH0_CLIENT_ID="${2:-}"
SERVER_REPO="${SERVER_REPO:-$HOME/Documents/server}"

die() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ -n "$ITEM_ID" ] && [ -n "$AUTH0_CLIENT_ID" ] || die \
"usage: $0 <ITEM_ID> <AUTH0_CLIENT_ID>

  ITEM_ID          32 chars, a-p, from the Web Store dashboard (also in its URL)
  AUTH0_CLIENT_ID  the divinci-prod SPA application's Client ID"

# Chrome extension ids are 32 characters drawn from a-p. Anything else is a
# paste error — and a wrong id here fails as 'extension not detected', which
# reads as a broken build rather than a typo.
[[ "$ITEM_ID" =~ ^[a-p]{32}$ ]] || die "ITEM_ID '$ITEM_ID' is not 32 chars of a-p."
[ ${#AUTH0_CLIENT_ID} -ge 20 ] || die "AUTH0_CLIENT_ID '$AUTH0_CLIENT_ID' looks too short."

cat <<EOF

Register these in Auth0 → divinci-prod → Applications → your SPA app, BEFORE
the first sign-in attempt. Both fields are comma-separated; keep existing
entries alongside.

  Allowed Callback URLs : https://${ITEM_ID}.chromiumapp.org/
  Allowed Web Origins   : chrome-extension://${ITEM_ID}

EOF

cd "$(dirname "$0")/.."

# 1. the extension's production Auth0 client id
python3 - "$AUTH0_CLIENT_ID" <<'PY'
import re, sys
client_id = sys.argv[1]
p = 'shared/auth-config.ts'
s = open(p, encoding='utf-8').read()
if "PROD_AUTH0_CLIENT_ID: string = PROD_AUTH0_CLIENT_ID_UNSET" not in s:
    raise SystemExit(f"{p}: client id is already set; edit it by hand or revert first.")
s = s.replace(
    "export const PROD_AUTH0_CLIENT_ID: string = PROD_AUTH0_CLIENT_ID_UNSET",
    f"export const PROD_AUTH0_CLIENT_ID: string = '{client_id}'")
open(p, 'w', encoding='utf-8').write(s)
print("✅ shared/auth-config.ts — production Auth0 client id set")
PY

# 2. the web app's extension-detection candidates (other repo)
CAPS="$SERVER_REPO/workspace/clients/web/src/services/local-llm/extension-capabilities.ts"
if [ -f "$CAPS" ]; then
  python3 - "$CAPS" "$ITEM_ID" <<'PY'
import sys
p, item = sys.argv[1], sys.argv[2]
s = open(p, encoding='utf-8').read()
if item in s:
    print("ℹ️  web app already lists this item id")
else:
    old = "const STORE_EXTENSION_IDS: string[] = [];"
    if old not in s:
        raise SystemExit(f"{p}: STORE_EXTENSION_IDS not found in the expected form.")
    s = s.replace(old, f'const STORE_EXTENSION_IDS: string[] = ["{item}"];')
    open(p, 'w', encoding='utf-8').write(s)
    print("✅ web app extension-detection candidates updated")
PY
  echo "   ⚠️  that file is in the SERVER repo — commit it there with ./scripts/git-safe-commit.sh"
else
  echo "⚠️  $CAPS not found (set SERVER_REPO=...); the web app will NOT detect the published extension until it lists $ITEM_ID"
fi

# 3. the shippable package, with no bootstrap escape in sight
echo
echo "Building the submission package…"
pnpm build:prod
pnpm zip

ZIP=$(ls -t .output/*-chrome.zip | head -1)
echo
echo "✅ submission package: $ZIP"
echo "   Upload this to the SAME draft item, then complete the listing and submit."
