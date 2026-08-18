---
name: cambrian-mcp
description: Use this skill to set up and use the Cambrian API MCP server. Covers Cambrian API key auth, hosted and local client config, the cambrian_* tool naming scheme, docs lookup, composite workflow tools, response limits, and error handling for Solana/Base DeFi, Deep42 social intelligence, and perpetual risk data.
---

`cambrian-api-mcp` is the Model Context Protocol server for the Cambrian API. It exposes the same product surface as the `cambrian` CLI to any MCP-capable agent runtime.

Use this document to get connected and then to call tools well. If your runtime is not MCP-capable, use the CLI instead: <https://github.com/cambriannetwork/cambrian-cli/blob/main/skills/cambrian/SKILL.md>.

## What You Get

Three kinds of tool:

- **endpoint tools** — generated from API metadata for Solana, Base, Ethereum, Deep42, and perpetual risk
- **composite workflow tools** — multi-endpoint reads in a single call, such as `cambrian_solana_token_snapshot`
- **`cambrian_docs`** — live endpoint and guide documentation from `docs.cambrian.org/llms.txt`

The tool list is generated and changes as the API gains endpoints. Treat the live `tools/list` from your client as the authoritative inventory; every name and example in this document is illustrative, not exhaustive. Runtime OpenAPI discovery shares the CLI's 15-minute per-source request floor and falls back to the installed inventory when discovery is unavailable.

Transports: stdio for local clients, Streamable HTTP for hosted and self-hosted deployments.

## Authentication

Every call needs your own Cambrian API key. The hosted server and the local package both require the caller to supply one; neither ships nor proxies a shared key.
Create one at `https://console.cambrian.org/`. x402 access without an API key is
available through the separate CLI `cambrian pay` path, not through MCP
transport.

- **stdio**: set `CAMBRIAN_API_KEY` in the server process environment.
- **HTTP**: send one of

  ```text
  Authorization: Bearer <CAMBRIAN_API_KEY>
  X-Cambrian-Api-Key: <CAMBRIAN_API_KEY>
  ```

Without a key, every tool call fails with `AUTH_REQUIRED`. Ask the user to configure a key rather than retrying.

## Fast Start

1. Get a Cambrian API key and put it in `CAMBRIAN_API_KEY`.
2. Add the server to your client (hosted is the default — see below).
3. Confirm the connection by listing tools.
4. Confirm a live read with `cambrian_base_dexes` (no required arguments).
5. Before using an unfamiliar endpoint tool, call `cambrian_docs` with its path.

### Hosted (recommended)

Claude Code, one command:

```bash
claude mcp add --transport http cambrian \
  https://mcp.cambrian.org/mcp \
  --header "Authorization: Bearer YOUR_CAMBRIAN_API_KEY"
```

Claude / Cursor config file:

```json
{
  "mcpServers": {
    "cambrian": {
      "type": "http",
      "url": "https://mcp.cambrian.org/mcp",
      "headers": { "Authorization": "Bearer ${CAMBRIAN_API_KEY}" }
    }
  }
}
```

Codex uses the same shape under `mcp_servers` instead of `mcpServers`.

### Local stdio

```json
{
  "mcpServers": {
    "cambrian": {
      "command": "npx",
      "args": ["-y", "cambrian-api-mcp"],
      "env": { "CAMBRIAN_API_KEY": "${CAMBRIAN_API_KEY}" }
    }
  }
}
```

Or run it directly:

```bash
export CAMBRIAN_API_KEY=<your-api-key>
npx -y cambrian-api-mcp
```

### Generate and test the config with the CLI

If the `cambrian` CLI is available, it prints and tests ready-to-use client config:

```bash
npm install -g cambrian
cambrian mcp config --client claude --mode hosted
cambrian mcp config --client cursor --mode hosted
cambrian mcp config --client codex --mode hosted
cambrian mcp config --client claude --mode local
cambrian mcp install --client claude --mode hosted
cambrian mcp test --mode hosted
```

### Self-hosted HTTP

```bash
npm install -g cambrian-api-mcp
export CAMBRIAN_API_KEY=<your-api-key>
cambrian-api-mcp --transport http --host 127.0.0.1 --port 8080
curl http://127.0.0.1:8080/health
```

Bind `0.0.0.0` only in a real hosted deployment. `PORT`, `ALLOWED_ORIGINS`, `RATE_LIMIT_WINDOW_MS`, and `RATE_LIMIT_MAX` are read from the environment.

## Tool Naming

Names are canonical and prefixed with `cambrian_`, then the service group and the resource with `_` separators. The pattern is stable even as the set of tools changes. For example:

- `cambrian_solana_price_current`
- `cambrian_solana_token_details`
- `cambrian_base_dexes`
- `cambrian_ethereum_dexes`
- `cambrian_base_uniswap_v3_pool`
- `cambrian_deep42_social_data_sentiment_shifts`
- `cambrian_risk_perp_risk_engine`

Legacy double-underscore names such as `evm__chains` are intentionally not exposed. Do not guess a tool name — list tools, or call `cambrian_docs` with no `path` for the root endpoint index.

## Routing

- Solana tokens, pools, prices, transactions → `cambrian_solana_*`
- Base chain tokens, pools, TVL, prices → `cambrian_base_*`
- Ethereum tokens, pools, TVL, prices → `cambrian_ethereum_*`
- Social sentiment, alpha tweets, influencer credibility → `cambrian_deep42_*`
- Perpetual position risk, liquidation, position sizing → `cambrian_risk_perp_risk_engine`

Never send a Solana mint address to an EVM tool. Never send an EVM contract address to a Solana tool. If the user has not supplied a pool or token address, ask for it. Do not guess one.

## Use `cambrian_docs` Before Unfamiliar Endpoints

Every endpoint tool's description ends with the docs path to call. `cambrian_docs` returns live parameter descriptions, units, constraints, and response-field meanings, so it never drifts from a cached tool list.

```json
{ "path": "solana/price-current" }
{ "path": "base/dexes" }
{ "path": "deep42/social-data/sentiment-shifts" }
{ "path": "guides/x402" }
{}
```

`base` is an alias for `evm` in docs paths; a leading `api/v1/` is stripped. Omitting `path` returns the root index of available endpoints and guides.
The same root index lists live guides. Fetch any indexed guide with
`guides/<slug>`; guide names are not compiled into the MCP server.

## Composite Tools

Some tools compose several endpoint reads into one call. Reach for one when answering the prompt would otherwise take several round trips. Each fetches its sections concurrently, tolerates partial failure (a failed section reports its own error instead of failing the call), and returns a `retrievedAt` timestamp.

Currently available, as examples of the pattern:

| Tool | Arguments | What it returns |
| --- | --- | --- |
| `cambrian_solana_token_snapshot` | `token_address`, optional `token_symbol` | token details, current price, 1h/4h/24h price-volume, top holders, pools, and Deep42 social data |

Start a "tell me about this Solana token" prompt with `cambrian_solana_token_snapshot`, not six separate reads. Pass `token_symbol` whenever you know the ticker: with it, the Deep42 section is scoped to that token, and without it the section falls back to market-wide sentiment. The result labels which one you got under `deep42.scope`.

Because partial failure does not fail the call, always check each section before treating a composite result as complete. A section carrying an `error` object returned no data — say so in the answer, or re-fetch that one piece with its dedicated endpoint tool. Never present a partial snapshot as a full one.

## Response Size

Every tool accepts an optional `_maxResponseLength` (characters). Each tool's schema description states the current default; a request above the server's hard cap is clamped down, never rejected.

A truncated response ends with an explicit truncation notice naming the limit that was applied. When you see one, prefer narrowing the query (lower `limit`, tighter time window, fewer addresses) over raising `_maxResponseLength`.

## Errors

Failures come back as a structured object, never as a raw HTML error page:

```json
{ "code": "RATE_LIMITED", "message": "...", "status": 429, "retryable": true }
```

| Code | Status | What to do |
| --- | --- | --- |
| `AUTH_REQUIRED` | 401 | Ask the user to set a valid `CAMBRIAN_API_KEY`. Do not retry. |
| `AUTH_FORBIDDEN` | 403 | Key lacks access to that service. Do not retry. |
| `BAD_REQUEST` | 400/422 | Fix the arguments — call `cambrian_docs` for the correct parameter shape. |
| `NOT_FOUND` | 404 | Address or resource does not exist. Verify the address; do not substitute another. |
| `RATE_LIMITED` | 429 | Retryable. Back off, then retry. |
| `TIMEOUT` | 408 | Retryable. Narrow the query and retry. |
| `UPSTREAM_ERROR` | 5xx | Retryable. Back off, then retry. |
| `MCP_ERROR` | 0 | Client-side or transport failure. Check config and key. |

`cambrian_risk_perp_risk_engine` runs Monte Carlo simulations and carries a bounded server-side timeout so it stays inside client tool-call limits. A long `risk_horizon` is the usual cause of a timeout there.

## Answer Principles

- Turn tool output into judgment, not a raw transcript.
- For pool metrics, say what the numbers mean for a liquidity provider: fee APR, volume trend, TVL change.
- For social intelligence, contextualize sentiment and credibility scores.
- For risk simulations, give liquidation distance and actionable position adjustments.
- Before formatting or comparing numeric fields, check the value conventions — percent scale (0–1 vs 0–100 vs multiplier), USD vs token units, NULL handling, score ranges: <https://github.com/cambriannetwork/cambrian-cli/blob/main/skills/cambrian/references/conventions.md>. Do not assume a percent convention.

## Failure Modes To Avoid

- Guessing tool names instead of listing tools or reading `cambrian_docs`.
- Routing a Solana question to a `cambrian_base_*` tool, or the reverse.
- Routing a sentiment question to a chain tool instead of `cambrian_deep42_*`.
- Chaining single-endpoint calls where a composite tool covers the whole prompt.
- Raising `_maxResponseLength` to the cap instead of narrowing the query.
- Retrying a non-retryable error (`AUTH_REQUIRED`, `AUTH_FORBIDDEN`, `BAD_REQUEST`, `NOT_FOUND`).
- Treating this server as a web search engine, a trading execution engine, or an RPC provider. It is a read surface for Cambrian data.

## Boundaries

Deployments of the hosted server are handled by CI/CD. This package is the client-facing MCP server only — it is not a self-hosting control plane, ingest system, or dashboard.
