# Cambrian API MCP

Model Context Protocol server for the Cambrian API. It exposes the same product surface as the `cambrian` CLI for agents that need live DeFi, social intelligence, risk, and API documentation tools.

Authentication is BYOK only. The hosted server and local package both require the caller to provide a Cambrian API key; the server never ships or proxies a shared key.

## What You Get

- 74 generated endpoint tools from Cambrian API metadata
- 4 composite workflow tools for token snapshots, token resolution, API health, and usage probes
- `cambrian_docs` for live docs from `https://docs.cambrian.org/llms.txt`
- stdio transport for local MCP clients
- Streamable HTTP transport for hosted and self-hosted deployments

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

- `cambrian_base_chains`
- `cambrian_solana_price_current`
- `cambrian_deep42_social_data_alpha_tweet_detection`
- `cambrian_risk_perp_risk_engine`
- `cambrian_docs`
- `cambrian_solana_token_snapshot`

Legacy double-underscore names such as `evm__chains` are intentionally not exposed.

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

`server.json` is kept ready for MCP Registry submission under:

```text
io.github.cambriannetwork/cambrian-api
```

The manifest uses `https://mcp.cambrian.org/mcp`, matching the production edge URL emitted by CI/CD. Do not publish the registry entry until DNS resolves and a production MCP smoke test passes through that hostname.
