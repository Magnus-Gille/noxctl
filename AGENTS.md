# AGENTS.md — noxctl

Instructions for coding agents working in this repository. Claude Code, Codex and
Pi are all expected to work here, so the shared material lives in tool-neutral
locations and each tool gets a pointer rather than its own copy.

## Read first

[`CLAUDE.md`](./CLAUDE.md) holds the project conventions — structure, dev
commands, the CLI-first rule, and the TDD expectation for substantive changes.
It applies to every agent regardless of the filename.

[`docs/shadow-run.md`](./docs/shadow-run.md) is the live thread: Fortnox is being
evaluated against a self-hosted open-source replacement, with a decision due in
December 2026. It opens with where the work stands and what to do next.

## Skills

Reusable procedures live in [`skills/`](./skills), one directory per skill with a
`SKILL.md` inside. They are plain Markdown with YAML frontmatter (`name`,
`description`) and reference nothing tool-specific — every action is a shell
command, so any agent with a terminal can follow them.

Claude Code discovers skills under `.claude/skills/`, so each one is symlinked
there. The file in `skills/` is the original; edit that, never the symlink.

| Skill | What it does |
|---|---|
| [`shadow-close`](./skills/shadow-close/SKILL.md) | Monthly reconciliation between Fortnox and the parallel Accounted instance |

Adding a skill: create `skills/<name>/SKILL.md`, then
`ln -s ../../skills/<name> .claude/skills/<name>`, and add a row above.

## Working with live accounting data

This repository drives real bookkeeping for a real company, which makes some
mistakes expensive and some irreversible.

- Mutations require explicit confirmation — `--yes` on the CLI, `confirm: true`
  over MCP. Preview with `--dry-run` first.
- Prefer read paths when investigating. `noxctl invoices pdf` uses `/preview`
  and does not mark an invoice as sent; `--mark-sent` does, and cannot be undone.
- Payroll output carries personal data. Employee summaries redact personnummer
  and exact pay by default; do not add `includeRaw` or raw JSON to a transcript
  without a reason.
- Never edit a booked voucher to make a report come out right. Swedish
  bookkeeping law requires corrections to be made as new entries.
