# Changelog

All notable changes to clinky are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] — 2026-07-12

### Added

- **Token-level streaming of thought nodes (claude backend).** The claude parser
  now decodes each Bash tool call's input JSON *as it streams*
  (`--include-partial-messages`) and emits each thought the instant its JSON
  object closes — rather than waiting for the whole tool-call block to land.
  First-node latency drops noticeably and long batches paint progressively
  instead of all at once. Backed by a new incremental scanner,
  `extractNodeStrings(text, from)`, that scans a growing buffer and returns a
  resumable `consumedTo` offset.
- **Reference arcs in `sequencer` mode.** Cells now connect to the cells they
  reference with `rel`-coloured quadratic arcs, styled per relation (dash
  pattern, width, alpha) — `synthesizes`, `contradicts`, `refines`,
  `questions`, `supersedes` each read differently.
- **Pivot-node emphasis in `galaxy` mode.** Thoughts referenced by three or
  more later thoughts (incoming refs ≥ 3) now scale up, so load-bearing nodes
  stand out in the drift.
- **Effort pass-through for codex.** `--effort` now maps to
  `model_reasoning_effort` (clamped `max` → `xhigh`), and the start log shows
  the active effort tier.

### Changed

- **Agent subprocesses run in an isolated scratch directory.** All three CLIs
  auto-load project docs (`CLAUDE.md` / `AGENTS.md`) from their working
  directory; spawning from the source tree fed clinky's own architecture docs
  into every thinking session — costing tokens and invalidating the prompt
  cache whenever the docs changed. Sessions now spawn in a fresh temp dir with
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- **Per-session parser isolation.** `runWithProvider` invokes `parseLine` on a
  per-run `Object.create(provider)` wrapper, so any state a provider keeps on
  `this` (streaming buffers, usage counters) is scoped to that session instead
  of leaking across concurrent runs.
- **Tighter backend sandboxing / isolation:**
  - **claude** — restricts tools to `Bash`, disables MCP servers, slash
    commands, and hooks, skips session persistence, adds a `sonnet` fallback
    model and a `--max-budget-usd 1` guardrail.
  - **codex** — `--sandbox read-only`, `--ignore-user-config`, `--ephemeral`;
    emits nodes at `item.started` (pre-execution) instead of `item.completed`,
    and surfaces `error` / `turn.failed` events as fatal errors.
  - **copilot** — restricts tools to `shell`, skips custom instructions,
    built-in MCPs, the `ask_user` tool, and the launch update check.

### Fixed

- **Shell-escaped batch recovery (claude).** When a Bash call's command-string
  extraction yields zero nodes (e.g. the model double-quoted the `echo`, so the
  JSON arrived shell-escaped and unparseable), the batch is recovered from the
  echoed stdout, where the shell has already resolved quoting.
- **String-aware brace scanning.** The node extractor no longer miscounts
  braces that appear inside JSON string literals (e.g.
  `"text":"if x { return y }"`), which previously corrupted depth tracking.
- **No phantom empty batches (codex).** A batch is opened only when the command
  actually carries node JSON, so non-echo commands no longer create empty
  batches.

## [1.0.7]

Current published baseline on npm (`@ichbinsoftware/clinky`).

[Unreleased]: https://github.com/ichbinsoftware/clinky/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/ichbinsoftware/clinky/compare/v1.0.7...v1.1.0
[1.0.7]: https://github.com/ichbinsoftware/clinky/releases/tag/v1.0.7
