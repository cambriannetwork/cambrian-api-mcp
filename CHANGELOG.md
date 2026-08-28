# Changelog

All notable changes to the `cambrian-api-mcp` server are documented here. This
project follows [Semantic Versioning](https://semver.org/). Dates are UTC.

Releases before 1.3.0 predate this file; see the
[GitHub releases](https://github.com/cambriannetwork/cambrian-api-mcp/releases)
for those.

## [1.5.1] - 2026-08-28

### Changed

- Updated the minimum `cambrian` dependency to `1.3.3`. Its Codex MCP
  configuration command now prints valid hosted and local TOML.
- MCP Registry publication now waits until the hosted health endpoint reports
  the release version.

## [1.5.0] - 2026-08-28

### Added

- Added `--toolsets` (env `CAMBRIAN_TOOLSETS`, HTTP `?toolsets=`) to load only
  `solana`, `evm`, `deep42`, or `risk`. `cambrian_docs` stays in every
  selection. A Solana-only client loads 37 tools and 10,766 bytes instead of
  111 tools and 27,157 bytes.
- Added `npm run registry:generate` and `npm run registry:check` for the
  bundled offline registry.
- Added progressive, compact, and full tool profiles for stdio and HTTP.
- Added on-demand endpoint call cards and full documentation through
  `cambrian_docs`.
- Added an on-demand response-field documentation mode to `cambrian_docs`.
- Added corrective validation results with the parameter, received value,
  expected schema, and documentation hint.

### Changed

- Built the offline fallback from this package's own snapshot of the live
  OpenAPI instead of the `cambrian` package's bundled registry. The published
  `cambrian@1.3.1` registry had drifted: no `chain_id` numeric enum, so no
  Ethereum tools projected at all; no exclusive numeric bounds; `token_address`
  where the API had renamed to `token_addresses`; and six Solana endpoints the
  API no longer serves. A clean install offline now lists 111 tools instead of
  86.
- Removed `offset`, `order_asc`, and `order_desc` from the progressive tool
  list, and reduced `limit` to its type and maximum. Progressive `tools/list`
  fell from 36,892 to 27,157 bytes. All three stay callable, and the server
  instructions name them.
- Advertised the Solana composite tool only when Solana tools are in scope.
- Updated to `cambrian@1.3.2`, which parses `exclusiveMinimum` and
  `exclusiveMaximum` from the live OpenAPI. The server no longer depends on
  its snapshot to restore those bounds.
- Regenerated the offline registry from the current OpenAPI. It adds
  `cambrian_ethereum_lending_sparklend_pools` for 111 tools. The endpoint
  declares Ethereum only, so no Base tool is projected for it.
- Made progressive the default profile for the server factory, stdio, and the
  hosted `/mcp` route.
- Reduced default tool metadata while preserving direct endpoint tool names,
  parameter names, types, required fields, scalar enums, OpenAPI defaults,
  numeric bounds, and array item types.
- Removed fixed `chain_id` inputs from direct Base and Ethereum tools. Each tool
  now supplies its fixed chain value.
- Made the compact call shape explicit. Endpoint arguments go inside the
  `parameters` object.
- Added explicit documentation status and trust metadata to full documentation
  results.
- Made the concise request schema the default `cambrian_docs` result in every
  profile. Response fields and full prose remain explicit on-demand choices.

### Fixed

- Restored exclusive numeric bounds if the runtime OpenAPI parser drops them.
  `cambrian@1.3.1` parsed no `exclusiveMinimum`/`exclusiveMaximum`, and the
  runtime path takes priority over the bundled registry, so Risk
  `entry_price: 0` reached the API and returned a raw 422 instead of a
  corrective `BELOW_MINIMUM`. `cambrian@1.3.2` supplies the bounds; this
  restore stays as a guard against an older resolved dependency.
- Returned a short miss message from `cambrian_docs` instead of the whole
  25 kB root index when an explicit path does not match.
- Matched `cambrian_docs` query terms as whole words and dropped stopwords.
  Substring scoring let fragments of a nonsense query ("no", "such") match
  "known" or "such as" in endpoint descriptions, returning unrelated
  endpoints instead of a miss.
- Corrected `engines.node` to `>=20.0.0`. `cambrian` requires Node 20, and on
  Node 18 every Streamable HTTP request failed with
  `ReferenceError: crypto is not defined`.
- Updated the Solana token snapshot to use the current token-details,
  price-current, and price-volume paths and parameters.
- Limited the token snapshot to two concurrent Solana requests. This prevents
  partial HTTP 429 results while Deep42 continues in parallel.
- Added validation for array item constraints.
- Rejected objects and arrays for string parameters before an API call.
- Accepted host-prefixed endpoint names in `cambrian_docs`.
- Stopped converting CLI convenience values into MCP defaults. Required fields
  and defaults now come from the OpenAPI request schema only.
- Preserved exclusive OpenAPI numeric bounds in tool schemas and corrective
  validation errors when the shared metadata package provides them.
- Resolved indexed Risk paths to the canonical documentation page.
- Stopped all active API requests when an HTTP client disconnects or a tool
  reaches its timeout.
- Stopped an upstream API request when its MCP tool call is cancelled. Other
  concurrent tool calls continue.
- Applied `_maxResponseLength` to structured API results. If a structured
  result exceeds the limit, the server omits it and returns the bounded text
  result instead.
- Accepted finite numeric strings for `_maxResponseLength`. This keeps the
  hidden Progressive control usable when an agent sends a string value.
- Clarified that response-detail documentation also includes the OpenAPI
  request schema. Agents no longer need full endpoint prose for both parts.
- Corrected Codex stdio setup to forward `CAMBRIAN_API_KEY` with `env_vars`.

## [1.4.1] - 2026-08-18

### Changed

- Updated Base and Ethereum documentation examples to use the public `evm/...`
  paths.
- Removed obsolete internal-path and legacy tool-name guidance from user-facing
  documentation.
- Updated to `cambrian@1.3.1` for current public x402 resource URLs.

## [1.4.0] - 2026-08-18

### Added

- Added dynamic `cambrian_ethereum_*` tools for visible EVM operations that
  advertise `chain_id=1` in the active OpenAPI schema.

### Changed

- Fixed Base tools to `chain_id=8453` and Ethereum tools to `chain_id=1`.
- Updated to `cambrian@1.3.0` to preserve OpenAPI numeric enums during runtime
  discovery.

## [1.3.7] - 2026-08-18

### Changed

- Refined the MCP Registry description. It now groups Solana and EVM as DeFi
  data sources and describes perpetual risk as analysis.

## [1.3.6] - 2026-08-18

### Fixed

- The MCP Registry description now uses EVM instead of Base. This term covers
  the supported EVM networks without naming one chain.

## [1.3.5] - 2026-08-08

### Changed

- Updated to `cambrian@1.2.0`, including chain-specific EVM and Solana OpenAPI
  discovery with bounded fallback, caching, and request cooldown behavior.
- Release tests now validate the dynamic CLI metadata contract instead of
  assuming fixed tool counts, defaults, or schema URLs.

## [1.3.4] - 2026-08-06

### Changed

- MCP instructions and `cambrian_docs` guidance now advertise live guide paths
  such as `guides/faqs`; newly indexed guides remain available through the
  existing dynamic documentation tool without another MCP release.
- API-key guidance now links to `console.cambrian.org` and clarifies that x402
  pay-per-call access is available through the separate Cambrian CLI flow.

## [1.3.3] - 2026-08-05

### Changed

- Endpoint tools now use `cambrian@1.1.7` runtime discovery, sharing its strict
  15-minute per-OpenAPI-source request floor and bundled fallback across CLI and
  MCP processes.
- The Solana token snapshot now passes public gateway paths directly; generated
  tools continue to resolve their metadata paths through the client's public
  gateway normalization.

### Removed

- Removed the unsupported `cambrian_health` composite. Cambrian does not expose
  matching service-health API endpoints. The MCP server's transport-level
  `/health` route is unchanged.

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
