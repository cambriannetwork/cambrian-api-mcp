# Cambrian API MCP

Model Context Protocol server for the Cambrian API. It exposes the same product surface as the `cambrian` CLI for agents that need live DeFi, social intelligence, risk, and API documentation tools.

Every call needs a Cambrian API key supplied by the caller. The hosted server and local package both require one; the server never ships or proxies a shared key.
Create a key at `https://console.cambrian.org/`. For x402 pay-per-call access
without an API key, use `cambrian pay --help`; MCP transport still requires a
caller-supplied key.

## What You Get

- one generated tool per public Cambrian API endpoint, built from Cambrian API metadata
- a composite workflow tool for Solana token snapshots
- `cambrian_docs` for live endpoint and guide docs from `https://docs.cambrian.org/llms.txt`
- stdio transport for local MCP clients
- Streamable HTTP transport for hosted and self-hosted deployments

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
- `cambrian_solana_price_current`
- `cambrian_deep42_social_data_alpha_tweet_detection`
- `cambrian_risk_perp_risk_engine`
- `cambrian_docs`
- `cambrian_solana_token_snapshot`

Call `cambrian_docs` without a path to discover the live root index, or use
`guides/<slug>` (for example, `guides/x402`) for any guide listed there.

Legacy double-underscore names such as `evm__chains` are intentionally not exposed.

Endpoint tools come from the same validated runtime registry as the CLI. MCP
rechecks that local cache for each tool-list/tool-call request, while OpenAPI
network attempts are coalesced and limited to once per source every 15 minutes.
If runtime discovery is unavailable, the installed bundled inventory remains
available without changing existing tool names or schemas.

Visible EVM operations that advertise `chain_id=1` also expose
`cambrian_ethereum_*` tools. Base tools fix `chain_id` to `8453`. Ethereum
tools fix it to `1`.

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
