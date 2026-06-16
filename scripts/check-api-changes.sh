#!/usr/bin/env bash
set -euo pipefail

# Fetch the current Fortnox OpenAPI spec and compare against the stored snapshot.
# Exits 0 if unchanged, 1 if changed (diff written to stdout).

# Fortnox's standalone openapi.json endpoint is hard rate-limited (HTTP 429 to
# every client — see issue #39). The ReDoc docs portal inlines the full spec in
# a `__redoc_state` script, and the HTML page is reachable with a browser
# User-Agent, so we fetch the page and extract the spec from it.
DOCS_URL="https://apps.fortnox.se/apidocs"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
SNAPSHOT="$REPO_DIR/api-spec/openapi.json"
TMPFILE="$(mktemp)"
HTMLFILE="$(mktemp)"

trap 'rm -f "$TMPFILE" "$HTMLFILE"' EXIT

echo "Fetching Fortnox API docs page..."
HTTP_CODE=$(curl -sS -w '%{http_code}' -o "$HTMLFILE" \
  -A "$UA" -H "Accept: text/html" \
  --retry 4 --retry-delay 5 --retry-all-errors --retry-max-time 120 \
  "$DOCS_URL")

if [ "$HTTP_CODE" -ne 200 ]; then
  echo "Error: API docs page returned HTTP $HTTP_CODE" >&2
  exit 2
fi

echo "Extracting OpenAPI spec from the page..."
if ! python3 "$SCRIPT_DIR/extract-redoc-spec.py" "$HTMLFILE" > "$TMPFILE"; then
  echo "Error: could not extract the OpenAPI spec from the docs page (format may have changed)" >&2
  exit 2
fi

# Normalize JSON (sorted keys) for stable diffing
if ! command -v jq &>/dev/null; then
  echo "Error: jq is required but not installed" >&2
  exit 2
fi

jq -S . "$TMPFILE" > "${TMPFILE}.sorted"
mv "${TMPFILE}.sorted" "$TMPFILE"

if [ ! -f "$SNAPSHOT" ]; then
  echo "No existing snapshot — saving initial version."
  mkdir -p "$(dirname "$SNAPSHOT")"
  cp "$TMPFILE" "$SNAPSHOT"
  exit 0
fi

# Compare
if diff -q <(jq -S . "$SNAPSHOT") "$TMPFILE" >/dev/null 2>&1; then
  echo "No changes detected."
  exit 0
else
  echo "Changes detected in Fortnox OpenAPI spec:"
  echo ""
  # Summarize: count added/removed/changed paths and schemas
  PATHS_OLD=$(jq -r '.paths // {} | keys[]' "$SNAPSHOT" | sort)
  PATHS_NEW=$(jq -r '.paths // {} | keys[]' "$TMPFILE" | sort)

  ADDED=$(comm -13 <(echo "$PATHS_OLD") <(echo "$PATHS_NEW"))
  REMOVED=$(comm -23 <(echo "$PATHS_OLD") <(echo "$PATHS_NEW"))

  if [ -n "$ADDED" ]; then
    echo "### New endpoints"
    echo "$ADDED" | sed 's/^/  + /'
    echo ""
  fi

  if [ -n "$REMOVED" ]; then
    echo "### Removed endpoints"
    echo "$REMOVED" | sed 's/^/  - /'
    echo ""
  fi

  # Show which existing endpoints have changes (method or schema level)
  COMMON=$(comm -12 <(echo "$PATHS_OLD") <(echo "$PATHS_NEW"))
  CHANGED_PATHS=""
  while IFS= read -r path; do
    [ -z "$path" ] && continue
    OLD_DEF=$(jq -cS --arg p "$path" '.paths[$p]' "$SNAPSHOT")
    NEW_DEF=$(jq -cS --arg p "$path" '.paths[$p]' "$TMPFILE")
    if [ "$OLD_DEF" != "$NEW_DEF" ]; then
      CHANGED_PATHS="${CHANGED_PATHS}  ~ ${path}\n"
    fi
  done <<< "$COMMON"

  if [ -n "$CHANGED_PATHS" ]; then
    echo "### Modified endpoints"
    echo -e "$CHANGED_PATHS"
  fi

  # Update snapshot
  cp "$TMPFILE" "$SNAPSHOT"
  exit 1
fi
