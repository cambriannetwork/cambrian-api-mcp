# Changelog

All notable changes to the `cambrian-api-mcp` server are documented here. This
project follows [Semantic Versioning](https://semver.org/). Dates are UTC.

Releases before 1.3.0 predate this file; see the
[GitHub releases](https://github.com/cambriannetwork/cambrian-api-mcp/releases)
for those.

## [Unreleased]

## [1.3.2] - 2026-08-05

### Changed

- Per-endpoint documentation requests now use the stripped public docs paths.
- Updated `cambrian` to 1.1.5 so API calls use the production gateway URLs.

## [1.3.1] - 2026-07-29

### Fixed

- **`structuredContent` is now bounded.** `_maxResponseLength` clamped only the
  text fallback, so the structured payload was unlimited. Measured against
  production, `cambrian_solana_orca_pools` returns 137,864 rows — the endpoint
  has no `limit` parameter at all — and serialized to a **58.8 MB** JSON-RPC
  message that killed the stdio connection outright, taking every later call in
  that session with it. That is what the hosted server's `MCP error -32001` and
  the apparent `cambrian_solana_trending_tokens` failure both were: collateral
  from one oversized response, not three broken tools. Records are capped at
  1000 per table; `rowCount` still reports the true upstream total and the
  payload carries `truncated: true` plus `returnedRecordCount`. Same call now
  returns 483 KB.

### Changed

- **Every tool is time-bounded, not just risk.** 72 of 73 tools had no timeout,
  so a slow call hung until the client aborted and surfaced a bare protocol
  error an agent cannot act on. Non-risk tools now use a 45 s bound and return
  the same structured retryable `TIMEOUT` the risk tool has always returned.
  Risk keeps its shorter 40 s budget and its Monte Carlo-specific hint.
- The underlying Cambrian client is constructed with a matching 45 s
  `timeoutMs`, so an abandoned request is actually aborted rather than left
  holding a socket until the client default of 90 s.

## [1.3.0] - 2026-07-28

### Breaking

- **Removed `cambrian_usage`.** Only Deep42 publishes `x-ratelimit-*` headers;
  the tool reported `null` for three of four services while spending four API
  calls to do it.
- **Removed `cambrian_resolve_token`.** It returned a strict subset of
  `cambrian_solana_token_snapshot`. Use the snapshot instead.

Public tool surface: 75 → 73. Callers of either removed tool must migrate.

### Fixed

The composite workflow tools call `client.<service>.query()` directly, bypassing
the metadata validation every generated tool goes through, and per-section error
tolerance then swallowed the resulting 400s. Measured against production before
this release, `cambrian_solana_token_snapshot` returned 5 of 8 sections and
`cambrian_health` took 14.3 s.

- `cambrian_solana_token_snapshot` top holders: send `program_id`, not
  `token_address` — that endpoint keys on the mint. Previously a 400 on every
  call.
- `cambrian_solana_token_snapshot` price-volume windows: `1h`/`4h`/`24h` instead
  of `24h`/`7d`/`30d`. The endpoint enum is `1h|2h|4h|8h|24h`; `7d` and `30d`
  never existed and 400'd on every call.
- `cambrian_solana_token_snapshot` Deep42 section: when `token_symbol` is
  supplied it now calls the token-scoped `social-data/token-analysis`; without
  it, market-wide `sentiment-shifts`. The result labels which one you got under
  `deep42.scope`. Previously `token_symbol` was accepted but used only for
  display.
- `cambrian_health` risk probe: probes the risk service's own `/health` instead
  of the Monte Carlo perp-risk engine. 14.3 s → ~1.1 s, since `Promise.all` made
  the whole check as slow as its slowest probe.

### Changed

- `/health` now reports `authMode: "api-key"` instead of `"byok"`.
  Authentication has always been a caller-supplied Cambrian API key; BYOK read
  as a product mode that does not exist.
- Dependency refresh clearing five npm advisories, two of them high and in the
  transport path: `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0 (bringing
  `@hono/node-server` 2.x), plus `body-parser`, `fast-uri`, `postcss`, `nanoid`.

### Internal

- Tests replay every call each composite records through the same
  `validateAndBuildParams` used by the generated tools, so a composite that
  sends parameters its endpoint rejects fails in CI instead of silently
  degrading a section in production. This is the check that was missing when the
  bugs above shipped in 1.2.0.
