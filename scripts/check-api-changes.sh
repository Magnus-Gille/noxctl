#!/usr/bin/env bash
set -euo pipefail

# Fetch the current Fortnox OpenAPI spec and compare against the stored
# fingerprint. Exits 0 if unchanged, 1 if changed (report on stdout), 2 on error.
#
# We do NOT commit Fortnox's OpenAPI document to this repo — its schemas and
# call structure are restricted by the Fortnox Developer Agreement (cl. 6.1/6.3).
# The spec is fetched into a git-ignored local cache (api-spec/openapi.json) and
# drift is tracked via opaque hashes in api-spec/openapi-fingerprint.json.
#
# Fortnox's standalone openapi.json endpoint is hard rate-limited (HTTP 429 to
# every client — see issue #39). The ReDoc docs portal inlines the full spec in
# a `__redoc_state` script, and the HTML page is reachable with a browser
# User-Agent, so we fetch the page and extract the spec from it.
DOCS_URL="https://apps.fortnox.se/apidocs"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
# Local-only spec cache (git-ignored) and the committed fingerprint baseline.
SPEC_CACHE="$REPO_DIR/api-spec/openapi.json"
FINGERPRINT="$REPO_DIR/api-spec/openapi-fingerprint.json"
HTMLFILE="$(mktemp)"

trap 'rm -f "$HTMLFILE"' EXIT

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
mkdir -p "$(dirname "$SPEC_CACHE")"
if ! python3 "$SCRIPT_DIR/extract-redoc-spec.py" "$HTMLFILE" > "$SPEC_CACHE"; then
  echo "Error: could not extract the OpenAPI spec from the docs page (format may have changed)" >&2
  exit 2
fi

# First run / no baseline yet: generate the fingerprint and stop.
if [ ! -f "$FINGERPRINT" ]; then
  echo "No existing fingerprint — saving initial version."
  python3 "$SCRIPT_DIR/api-fingerprint.py" generate "$SPEC_CACHE" > "$FINGERPRINT"
  exit 0
fi

# Compare the freshly fetched spec against the committed fingerprint.
set +e
python3 "$SCRIPT_DIR/api-fingerprint.py" compare "$FINGERPRINT" "$SPEC_CACHE"
RC=$?
set -e

if [ "$RC" -eq 1 ]; then
  # Drift detected — refresh the committed fingerprint (NOT the spec).
  python3 "$SCRIPT_DIR/api-fingerprint.py" generate "$SPEC_CACHE" > "$FINGERPRINT"
  exit 1
elif [ "$RC" -ne 0 ]; then
  echo "Error: fingerprint comparison failed" >&2
  exit 2
fi

exit 0
