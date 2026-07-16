# Cambrian API MCP - Marketplace Entry

## Quick Summary

Production MCP access to Cambrian API data across Solana, Base/EVM, Deep42 social intelligence, perpetual risk, and live endpoint documentation.

## Key Features

- 75 MCP tools: 70 generated public API endpoint tools, 4 composite workflow tools, and `cambrian_docs`
- Multi-chain DeFi coverage across Solana and Base/EVM endpoints
- Deep42 social intelligence and Cambrian risk analysis tools
- Live docs lookup through `https://docs.cambrian.org/llms.txt`
- BYOK authentication with `Authorization: Bearer <CAMBRIAN_API_KEY>` or `X-Cambrian-Api-Key`
- Local stdio and hosted Streamable HTTP transports

## Installation

### Recommended CLI setup

```bash
npm install -g cambrian
cambrian mcp config --mode hosted
cambrian mcp install --client claude --mode hosted
cambrian mcp test --mode hosted
```

### Local package

```bash
export CAMBRIAN_API_KEY=<your-api-key>
npx -y cambrian-api-mcp
```

### Hosted HTTP

```bash
claude mcp add --transport http cambrian-api \
  https://mcp.cambrian.org/mcp \
  --header "Authorization: Bearer YOUR_CAMBRIAN_API_KEY"
```

## Example Use Cases

### Get current token and pool data

```text
"What's the current price of SOL?"
"Show me the token snapshot for this Solana mint."
"Find Base DEXes and supported pool endpoints."
```

### Research social intelligence and risk

```text
"Fetch Deep42 sentiment shifts."
"Run the perpetual risk engine with these position parameters."
"Open the Cambrian docs for solana/price-current before choosing parameters."
```

## Available Tool Groups

### Solana

- Token prices, metadata, holders, pools, and OHLCV
- Orca, Raydium, Meteora, and token-pool search endpoints
- Composite token resolution and snapshot workflows

### Base/EVM

- DEX discovery
- Uniswap V2/V3, SushiSwap, and Aerodrome pool data
- Base endpoints exposed with `cambrian_base_*` tool names

### Deep42

- Public social-data intelligence endpoints

### Risk

- Perpetual risk engine with bounded MCP timeout handling

### Documentation

- `cambrian_docs` fetches root or per-endpoint `llms.txt` docs from `docs.cambrian.org`

## Requirements

- Cambrian API key
- Node.js 18+ for local/self-hosted usage
- MCP client with stdio or Streamable HTTP support

## Links

- Documentation: https://docs.cambrian.org
- Public package repo: https://github.com/cambriannetwork/cambrian-api-mcp
- Cambrian website: https://cambrian.org
- Discord community: https://discord.gg/cvmZHsJChB

## Support

- GitHub Issues for package bugs
- Discord for community support
- Email: support@cambrian.xyz
