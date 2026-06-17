#!/usr/bin/env python3
"""Generate / compare a privacy-preserving fingerprint of the Fortnox OpenAPI spec.

We deliberately do NOT commit Fortnox's OpenAPI document to this repo: its
request/response schemas and parameters are the API's "call structure", which
the Fortnox Developer Agreement (clauses 6.1/6.3) restricts redistributing
without written consent. Instead we commit only this fingerprint — opaque
SHA-256 hashes of each operation and schema, keyed by the (public) endpoint
paths and schema names. That is enough to detect drift (added / removed /
modified endpoints and schemas) without re-publishing Fortnox's IP. The full
spec is fetched on demand into a git-ignored local cache (api-spec/openapi.json).
"""

import hashlib
import json
import sys


def _canon(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _sha(obj) -> str:
    return hashlib.sha256(_canon(obj).encode("utf-8")).hexdigest()


def fingerprint(spec: dict) -> dict:
    paths = spec.get("paths") or {}
    schemas = ((spec.get("components") or {}).get("schemas")) or {}
    return {
        # keys are public route strings / schema names; values are opaque hashes
        "paths": {p: _sha(d) for p, d in paths.items()},
        "schemas": {n: _sha(d) for n, d in schemas.items()},
        "pathCount": len(paths),
        "schemaCount": len(schemas),
    }


def _load(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _diff(old: dict, new: dict):
    added = sorted(set(new) - set(old))
    removed = sorted(set(old) - set(new))
    modified = sorted(k for k in (set(old) & set(new)) if old[k] != new[k])
    return added, removed, modified


def cmd_generate(spec_path: str) -> None:
    print(json.dumps(fingerprint(_load(spec_path)), indent=2, sort_keys=True))


def cmd_compare(old_fp_path: str, new_spec_path: str) -> None:
    old = _load(old_fp_path)
    new = fingerprint(_load(new_spec_path))

    changed = False
    out: list[str] = []
    for label, key in (("Endpoints", "paths"), ("Schemas", "schemas")):
        added, removed, modified = _diff(old.get(key, {}), new.get(key, {}))
        if added or removed or modified:
            changed = True
            out.append(f"### {label}")
            out.extend(f"  + {x}" for x in added)
            out.extend(f"  - {x}" for x in removed)
            out.extend(f"  ~ {x}" for x in modified)
            out.append("")

    if changed:
        print("Changes detected in the Fortnox OpenAPI spec:\n")
        print("\n".join(out))
        sys.exit(1)

    print("No changes detected.")
    sys.exit(0)


def main() -> None:
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "generate":
        cmd_generate(args[1])
    elif len(args) == 3 and args[0] == "compare":
        cmd_compare(args[1], args[2])
    else:
        sys.stderr.write(
            "usage: api-fingerprint.py generate <spec.json>\n"
            "       api-fingerprint.py compare <fingerprint.json> <spec.json>\n"
        )
        sys.exit(2)


if __name__ == "__main__":
    main()
