# Contributing

Thanks for improving `cambrian-api-mcp`.

## Requirements

- Node.js 20 or newer for development and CI parity
- npm
- Cambrian API key for live MCP smoke tests

## Local Setup

```bash
npm ci
npm test
npm run build
node dist/index.js --version
npm pack --dry-run
```

Local stdio smoke tests require credentials:

```bash
export CAMBRIAN_API_KEY=<your-api-key>
npx -y cambrian-api-mcp
```

Local HTTP smoke test:

```bash
node dist/index.js --transport http --host 127.0.0.1 --port 8080
curl http://127.0.0.1:8080/health
```

## Development Rules

- Keep authentication BYOK only. Do not add shared server-side Cambrian API keys for public consumers.
- Preserve canonical `cambrian_*` tool names.
- Keep `server.json` version and repository metadata aligned with `package.json`.
- Add tests for MCP-visible behavior, especially tool schemas, auth handling, CORS, and structured errors.
- Do not commit credentials, `.env` files, generated tarballs, `dist/`, or local agent configuration.

## Verification Before Opening a PR

```bash
npm ci
npm audit --audit-level=moderate
npm run check:public
npm test
npm run build
node dist/index.js --version
npm pack --dry-run
```

For endpoint, auth, or transport changes, also run representative live stdio and HTTP MCP client tests with a valid `CAMBRIAN_API_KEY`.
