# Migration guide

## 0.1.x → 0.2.0

0.2.0 introduces multi-profile support (run noxctl against multiple Fortnox tenants from one installation). **Upgrading is a no-op for existing single-tenant users** — your existing credentials are automatically adopted as the `default` profile on first run.

### What happens on upgrade

On the first invocation after upgrading, noxctl transparently dual-reads credentials:

1. **Reads the legacy credential entry** (the one 0.1.x wrote under fixed service names) and uses it as the `default` profile's credentials. No rewrite happens at read time — the legacy entry is the source of truth until something updates credentials.
2. **Seeds the profile index** — on first observation of the legacy entry, noxctl writes a `default` row to `~/.fortnox-mcp/profiles.json` so `noxctl profile list` and `profile current` have something to show.
3. **Migrates lazily on the next save.** The first time 0.2.0 writes credentials for the `default` profile (a token refresh, or running `noxctl init` again), it dual-writes to both the new namespaced entry and the legacy entry. From that point on the new entry exists and is preferred, while the legacy entry stays in sync so a downgrade still works.

No data loss; no action required.

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

Global install:

```bash
npm install -g noxctl@0.1.0
```

**If you registered the MCP server with Claude Desktop / claude.ai / Code**, that registration runs `npx noxctl serve`, which resolves `noxctl` dynamically and may still pick the latest published version regardless of your global pin. Re-register with an explicit version to actually pin the MCP server:

```bash
claude mcp remove fortnox
claude mcp add fortnox -- npx noxctl@0.1.0 serve
```

0.1.x will read the legacy credential entry that 0.2.0 left in place. Profiles other than `default` are invisible to 0.1.x — their credentials remain in the secure store but are not used.
