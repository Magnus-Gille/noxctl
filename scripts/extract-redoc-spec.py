#!/usr/bin/env python3
"""Extract the inlined OpenAPI spec from a Fortnox ReDoc apidocs HTML page.

Fortnox's standalone ``openapi.json`` endpoint is hard rate-limited (returns
HTTP 429 to every client, authenticated or not — see issue #39). The ReDoc docs
portal at https://apps.fortnox.se/apidocs instead inlines the full spec in a
``const __redoc_state = {...}`` script tag, and that HTML page is reachable with
a browser User-Agent. This script pulls the ``__redoc_state`` object out of the
page and emits ``__redoc_state.spec.data`` (the OpenAPI document) as JSON.

Usage: extract-redoc-spec.py [path-to-html | -]   (defaults to stdin)
"""
import json
import sys


def extract_spec(html: str) -> dict:
    marker = html.find("__redoc_state")
    if marker == -1:
        raise ValueError("no __redoc_state found in page")
    start = html.index("{", marker)

    # String-aware balanced-brace scan: braces inside JSON string values must
    # not affect nesting depth, so track string/escape state.
    depth = 0
    in_str = False
    esc = False
    end = -1
    for j in range(start, len(html)):
        c = html[j]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    end = j + 1
                    break
    if end == -1:
        raise ValueError("unbalanced __redoc_state object")

    state = json.loads(html[start:end])
    spec = (state.get("spec") or {}).get("data")
    if not isinstance(spec, dict) or "openapi" not in spec or "paths" not in spec:
        raise ValueError("no OpenAPI document at __redoc_state.spec.data")
    return spec


def main() -> int:
    src = sys.argv[1] if len(sys.argv) > 1 else "-"
    if src == "-":
        html = sys.stdin.read()
    else:
        with open(src, encoding="utf-8", errors="replace") as fh:
            html = fh.read()
    spec = extract_spec(html)
    # Sorted keys for a stable, diff-friendly baseline.
    json.dump(spec, sys.stdout, sort_keys=True, ensure_ascii=False)
    return 0


if __name__ == "__main__":
    sys.exit(main())
