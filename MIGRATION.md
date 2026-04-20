# Migration guide

## 0.1.x → 0.2.0

0.2.0 introduces multi-profile support (run noxctl against multiple Fortnox tenants from one installation). **Upgrading is a no-op for existing single-tenant users** — your existing credentials are automatically adopted as the `default` profile on first run.

### What happens on upgrade

On the first invocation after upgrading, noxctl performs a one-time credential migration:

1. Reads the legacy keychain entry (the one 0.1.x wrote under fixed service names).
2. Re-writes the same credentials under the `default` profile's namespaced keychain entry.
3. Creates a `profiles.json` index entry for `default` under `~/.fortnox-mcp/`.

The legacy entry is left intact for one release cycle so a downgrade to 0.1.x still works. No data loss; no action required.

If you've never set up noxctl, there's nothing to migrate — `noxctl init` will create the `default` profile fresh.

### Verifying the migration

```bash
noxctl doctor               # should report credentials present and API reachable
noxctl profile current      # should print "default (source: …)"
noxctl profile list         # should list at least "default"
noxctl company info         # should return your company
```

### Adding a second profile

```bash
noxctl init --profile staging      # OAuth flow for a second tenant
noxctl --profile staging company info
noxctl profile use staging         # make it the default for future commands
noxctl profile use default         # switch back
```

### MCP clients (Claude Desktop / claude.ai / Web / Mobile)

Existing MCP server registrations continue to work — they bind to the `default` profile on startup and behave exactly as in 0.1.x.

To run multiple MCP servers (one per tenant) side by side, register them with scoped environments:

```bash
claude mcp add fortnox-prod     -- npx noxctl serve
claude mcp add fortnox-staging  -e NOXCTL_PROFILE=staging -- npx noxctl serve
```

Non-default sessions print a `[profile: <name>]` stderr banner on startup and prefix Fortnox API / token-refresh errors with the same tag, so mis-bound sessions are easy to diagnose from a single error line.

### Behavior change: fail-closed on corrupt pointer

`noxctl serve` now refuses to start if the active-profile pointer (`~/.fortnox-mcp/active-profile`) is unreadable or contains an invalid profile name and no `--profile` flag or `NOXCTL_PROFILE` is set. This prevents a corrupt pointer from silently routing MCP sessions to the wrong tenant.

Recovery:

```bash
noxctl profile current                  # shows what went wrong
noxctl profile use default              # repair the pointer
# or: NOXCTL_PROFILE=default noxctl serve   # one-off override
```

`noxctl doctor` and `noxctl profile use` deliberately still work with a corrupt pointer so you can diagnose and repair without needing to hand-edit files.

### Rollback to 0.1.x

```bash
npm install -g noxctl@0.1.0
```

0.1.x will read the legacy keychain entry that 0.2.0 left in place. Profiles other than `default` are invisible to 0.1.x — their credentials remain in the keychain but are not used.
