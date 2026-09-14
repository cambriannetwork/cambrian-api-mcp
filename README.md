# Cambrian API MCP

Model Context Protocol server for the Cambrian API. It exposes the same product surface as the `cambrian` CLI for agents that need live DeFi, social intelligence, risk, and API documentation tools.

Every call needs a Cambrian API key supplied by the caller. The hosted server and local package both require one; the server never ships or proxies a shared key.
Create a key at `https://console.cambrian.org/`. For x402 pay-per-call access
without an API key, use `cambrian pay --help`; MCP transport still requires a
caller-supplied key.

## What You Get

- a progressive default profile with one concise tool per public Cambrian API endpoint
- compact and full profiles for clients with different tool-loading behavior
- a composite workflow tool for Solana token snapshots
- `cambrian_docs` for live endpoint and guide docs from `https://docs.cambrian.org/llms.txt`
- stdio transport for local MCP clients
- Streamable HTTP transport for hosted and self-hosted deployments

## Tool Profiles

| Profile | stdio | HTTP | Tool metadata |
| --- | --- | --- | --- |
| Progressive (default) | no flag, or `--profile progressive` | `/mcp` | Direct endpoint tools with types, required fields, scalar enums, OpenAPI defaults, numeric bounds, and array item types. |
| Compact | `--profile compact` | `/mcp/compact` | Three tools: `cambrian_docs`, `cambrian_call`, and `cambrian_solana_token_snapshot`. |
| Full | `--profile full` | `/mcp/full` | Direct endpoint tools with complete request descriptions, defaults, constraints, and response-size controls. |

All profiles use the same progressive documentation flow. `cambrian_docs`
returns the request schema by default. Set `detail` to `response` for response
fields. The response view also includes the request schema. Set `detail` to
`full` only for examples and all endpoint prose. The full profile does not
preload response documentation for every endpoint.

Progressive omits repeated endpoint descriptions, long patterns, large array
enums, and parameter prose. Call `cambrian_docs` for these details.

Progressive also omits `offset`, `order_asc`, and `order_desc`. These three are
the same on every endpoint that has them, and Progressive already strips the
per-endpoint sortable-column enum, so repeating them adds about 10 kB to the
tool list and tells the agent nothing. The server instructions name them once,
and every endpoint still accepts them. `limit` stays, with its maximum, because
it is how an agent bounds a response.

## Toolsets

The whole catalog is 141 tools. An agent that only asks about Solana still pays
for 99 EVM tools it will never call. Use `--toolsets` to load only what you
need.

| Toolset | Tools |
| --- | --- |
| `solana` | `cambrian_solana_*` and the Solana token snapshot |
| `evm` | `cambrian_base_*`, `cambrian_ethereum_*`, and `cambrian_arbitrum_*` |
| `deep42` | `cambrian_deep42_*` |
| `risk` | `cambrian_risk_*` |

```bash
npx -y cambrian-api-mcp --toolsets solana,risk
CAMBRIAN_TOOLSETS=solana npx -y cambrian-api-mcp
```

Over HTTP, select per request: `https://mcp.cambrian.org/mcp?toolsets=solana`.

Omit the option, or pass `all`, to get every tool. `cambrian_docs` is always
present, so a narrowed client can still discover and read about any endpoint.

Progressive `tools/list` sizes:

| Selection | Tools | Bytes |
| --- | --- | --- |
| default (all) | 141 | 33,869 |
| `evm` | 99 | 22,471 |
| `solana` | 37 | 10,904 |
| `deep42` | 6 | 3,663 |
| `risk` | 2 | 2,093 |

### How MCP Clients Load Tools

The MCP client receives the complete `tools/list` result for the selected
profile. MCP does not control how much of that result enters the model context.

Claude Code normally loads tool names and server instructions first. It loads
complete selected tool definitions after Tool Search. Codex can do the same
when its Tool Search feature is available. Other clients can load every tool
definition at the start.

The client loads the definition from the selected profile. It does not restore
fields that Progressive omitted. Use `cambrian_docs` to load the complete
request schema, response fields, and examples.

## Agent Skill

New users and agent runtimes should start here: [skills/cambrian-mcp/SKILL.md](skills/cambrian-mcp/SKILL.md). It covers Cambrian API key auth, hosted and local client config, tool naming, `cambrian_docs` lookup, composite tools, response limits, and error handling in one document.

For the CLI instead of MCP, see the [`cambrian` CLI skill](https://github.com/cambriannetwork/cambrian-cli/blob/main/skills/cambrian/SKILL.md).

## Recommended Setup Through The CLI

The `cambrian` CLI prints and tests ready-to-use MCP client config:

```bash
npm install -g cambrian
cambrian mcp config --mode hosted
cambrian mcp config --mode local
cambrian mcp install --client claude --mode hosted
cambrian mcp test --mode hosted
```

## Local stdio

Run the published package directly:

```bash
export CAMBRIAN_API_KEY=<your-api-key>
npx -y cambrian-api-mcp
```

Select another profile only when your MCP client needs it:

```bash
npx -y cambrian-api-mcp --profile compact
npx -y cambrian-api-mcp --profile full
```

Narrow the catalog to the toolsets you need:

```bash
npx -y cambrian-api-mcp --toolsets solana,risk
```

Or install it globally:

```bash
npm install -g cambrian-api-mcp
export CAMBRIAN_API_KEY=<your-api-key>
cambrian-api-mcp
```

## Hosted Streamable HTTP

Use the CLI to print the current hosted URL and client-specific config:

```bash
cambrian mcp config --mode hosted
```

Direct Claude setup:

```bash
claude mcp add --transport http cambrian \
  https://mcp.cambrian.org/mcp \
  --header "Authorization: Bearer YOUR_CAMBRIAN_API_KEY"
```

Codex config uses TOML:

```toml
[mcp_servers.cambrian]
url = "https://mcp.cambrian.org/mcp"
bearer_token_env_var = "CAMBRIAN_API_KEY"
```

The default URL uses the progressive profile. Use
`https://mcp.cambrian.org/mcp/compact` or
`https://mcp.cambrian.org/mcp/full` for another profile.

HTTP requests must include one of:

```text
Authorization: Bearer <CAMBRIAN_API_KEY>
X-Cambrian-Api-Key: <CAMBRIAN_API_KEY>
```

## Self-Hosted HTTP

```bash
npm install
npm run build
node dist/index.js --transport http --host 127.0.0.1 --port 8080
```

Health endpoint:

```bash
curl http://127.0.0.1:8080/health
```

For hosted deployments, bind to `0.0.0.0`:

```bash
node dist/index.js --transport http --host 0.0.0.0 --port 8080
```

## Tool Names

Tool names are canonical and prefixed with `cambrian_`.

Examples:

- `cambrian_base_dexes`
- `cambrian_ethereum_dexes`
- `cambrian_arbitrum_dexes`
- `cambrian_solana_price_current`
- `cambrian_deep42_social_data_alpha_tweet_detection`
- `cambrian_risk_perp_risk_engine`
- `cambrian_docs`
- `cambrian_solana_token_snapshot`

Call `cambrian_docs` without a path to discover the live root index, or use
`guides/<slug>` (for example, `guides/x402`) for any guide listed there. For an
endpoint path, omit `detail` to get its request schema. Use `detail: "response"`
for response fields and `detail: "full"` for examples and all endpoint prose.

Endpoint tools come from the same validated runtime registry as the CLI. MCP
rechecks that local cache for each tool-list/tool-call request, while OpenAPI
network attempts are coalesced and limited to once per source every 15 minutes.
If runtime discovery is unavailable, the bundled inventory remains available
without changing existing tool names or schemas. That inventory is this
package's own snapshot of the live OpenAPI (`src/generated/offline-registry.ts`,
regenerated with `npm run registry:generate`), not the `cambrian` package's
bundled registry, so the offline catalog does not drift with that package's
release cadence.

The API serves one generic `/api/v1/evm/*` surface whose `chain_id` parameter
lists the chains each endpoint supports. The MCP turns that into one fixed-chain
tool per supported chain, so an agent never has to remember a magic number and
cannot aim an endpoint at a chain it rejects:

| Chain | Id | Tool prefix |
| --- | --- | --- |
| Base | `8453` | `cambrian_base_*` |
| Ethereum | `1` | `cambrian_ethereum_*` |
| Arbitrum | `42161` | `cambrian_arbitrum_*` |

A tool appears for a chain if and only if that endpoint's own `chain_id` schema
allows the chain — from its `enum`, a fixed `minimum`/`maximum` pair, or an
exclusive bound. No allowlist and no per-endpoint special case: an endpoint the
API widens to `enum: [1, 8453, 42161]` gains Arbitrum tools on the next metadata
load with no MCP change. Base tools fix `chain_id` to `8453`, Ethereum tools to
`1`, and Arbitrum tools to `42161`.

`cambrian_docs` accepts an optional chain segment in an EVM path, by id or slug:
`evm/42161/dexes`, `evm/arbitrum/dexes`, and `evm/dexes` all resolve the same
endpoint, with the chain-scoped forms returning that chain's pinned schema.

The chain registry lives in `EVM_CHAINS` in `src/server.ts` and is the only
place a chain is declared. To add a chain, add one entry there and run
`npm run registry:generate`; see `.claude/skills/adding-a-chain/SKILL.md`.

## Development

```bash
npm ci
npm test
npm run build
npm pack --dry-run
```

The package depends on the published `cambrian` package for shared metadata and the API client. Publish `cambrian` first when changing both packages together, then refresh this package lock and deploy the MCP server through CI/CD.

## Deployment

Deployments are handled by GitHub Actions and Cloud Run from the private source repository. Do not deploy manually.

The workflow:

1. installs dependencies
2. validates `package.json#mcpName` matches `server.json#name`
3. validates `package.json#version` matches `server.json#version`
4. builds and tests
5. builds the Docker image
6. deploys to Cloud Run
7. smoke-checks staging directly; production is smoke-tested through the public edge URL after DNS and certificate activation

## Registry

The official MCP Registry publishes this server under:

```text
io.github.cambriannetwork/cambrian-api
```

The manifest uses `https://mcp.cambrian.org/mcp`, which matches the production edge URL. The public release workflow publishes each new Registry version after npm publication.
