import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CambrianData } from 'cambrian';
import { CAMBRIAN_MCP_TOOLS } from 'cambrian/metadata';
import {
  DOCS_TOOL_NAME,
  DOCS_BASE_URL,
  DOCS_ROOT_URL,
  MAX_RESPONSE_LENGTH_CAP,
  RISK_TOOL_TIMEOUT_MS,
  SERVER_VERSION,
  baseServerInstructions,
  buildToolInputSchema,
  buildToolResult,
  callCambrianHealth,
  callCambrianTool,
  callSolanaTokenSnapshot,
  createCambrianMcpServer,
  docPathForTool,
  endpointDocsUrl,
  fetchDocumentationForTest,
  getMaxResponseLength,
  listMcpTools,
  normalizeDocPath,
  tableResponseToStructured,
  toStructuredError,
  validateAndBuildParams,
  withTimeout,
} from '../src/server.js';
import { ApiError, calls, resetCalls } from './fixtures/cambrian.js';

// Build a mock fetch that maps exact URLs to {status, body, contentType}.
function mockFetch(routes: Record<string, { status?: number; body: string; contentType?: string }>): typeof globalThis.fetch {
  const calls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push(u);
    const route = routes[u];
    if (!route) return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(route.body, {
      status: route.status ?? 200,
      headers: { 'content-type': route.contentType ?? 'text/plain' },
    });
  }) as unknown as typeof globalThis.fetch & { calls: string[] };
  (fn as unknown as { calls: string[] }).calls = calls;
  return fn;
}

describe('Cambrian MCP tools', () => {
  beforeEach(() => resetCalls());

  it('lists canonical tools and docs tool', () => {
    const tools = listMcpTools();
    expect(tools).toHaveLength(73);
    expect(tools.some((tool) => tool.name === DOCS_TOOL_NAME)).toBe(true);
    expect(tools.some((tool) => tool.name === 'cambrian_base_chains')).toBe(false);
    expect(tools.some((tool) => tool.name === 'cambrian_base_dexes')).toBe(true);
    expect(tools.some((tool) => tool.name === 'cambrian_solana_price_current')).toBe(true);
    expect(tools.some((tool) => tool.name === 'cambrian_deep42_social_data_alpha_tweet_detection')).toBe(true);
    expect(tools.some((tool) => tool.name === 'cambrian_risk_perp_risk_engine')).toBe(true);
    expect(tools.some((tool) => tool.name === 'evm__chains')).toBe(false);
  });

  it('builds required fields while respecting CLI defaults', () => {
    const aeroPool = CAMBRIAN_MCP_TOOLS.find((tool) => tool.name === 'cambrian_base_aero_v2_pool');
    expect(aeroPool).toBeDefined();
    const schema = buildToolInputSchema(aeroPool!);
    expect(schema.required).toContain('pool_address');
    expect(schema.required ?? []).not.toContain('apr_days_annualized');

    const risk = CAMBRIAN_MCP_TOOLS.find((tool) => tool.name === 'cambrian_risk_perp_risk_engine');
    expect(risk).toBeDefined();
    expect(buildToolInputSchema(risk!).required ?? []).toEqual([]);
  });

  it('applies defaults and rejects unknown params', () => {
    const aeroPool = CAMBRIAN_MCP_TOOLS.find((tool) => tool.name === 'cambrian_base_aero_v2_pool')!;
    expect(validateAndBuildParams(aeroPool, { pool_address: '0xabc' })).toEqual({
      pool_address: '0xabc',
      apr_days_annualized: '30',
    });
    expect(() => validateAndBuildParams(aeroPool, { pool_address: '0xabc', bad: true }))
      .toThrow('Unknown parameter');
  });

  it('routes Base tools through Opabinia client', async () => {
    const tool = CAMBRIAN_MCP_TOOLS.find((candidate) => candidate.name === 'cambrian_base_dexes')!;
    const result = await callCambrianTool(new CambrianData({ apiKey: 'test' }), tool, {});
    expect(result).toMatchObject({ ok: true, client: 'opabinia' });
    expect(calls[0]).toMatchObject({ client: 'opabinia', apiPath: '/api/v1/evm/dexes' });
  });

  it('routes Deep42 and Risk tools through their service clients', async () => {
    const deep42 = CAMBRIAN_MCP_TOOLS.find((candidate) =>
      candidate.name === 'cambrian_deep42_social_data_sentiment_shifts'
    )!;
    const risk = CAMBRIAN_MCP_TOOLS.find((candidate) => candidate.name === 'cambrian_risk_perp_risk_engine')!;
    await callCambrianTool(new CambrianData({ apiKey: 'test' }), deep42, {});
    await callCambrianTool(new CambrianData({ apiKey: 'test' }), risk, {
      token_address: 'So11111111111111111111111111111111111111112',
      entry_price: 100,
      leverage: 5,
      direction: 'long',
      risk_horizon: '1d',
    });
    expect(calls[0].client).toBe('deep42');
    expect(calls[1].client).toBe('risk');
  });
});

describe('validateAndBuildParams coercion', () => {
  const ohlcv = CAMBRIAN_MCP_TOOLS.find((t) => t.name === 'cambrian_solana_ohlcv_base_quote')!;
  const holders = CAMBRIAN_MCP_TOOLS.find((t) => t.name === 'cambrian_solana_holder_token_balances')!;

  const ohlcvBase = {
    base_address: 'So11111111111111111111111111111111111111112',
    quote_address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    after_time: 1,
    before_time: 2,
  };

  it('canonicalizes enum values case-insensitively', () => {
    const params = validateAndBuildParams(ohlcv, { ...ohlcvBase, interval: '1H' });
    expect(params.interval).toBe('1h');
  });

  it('rejects values outside the enum', () => {
    expect(() => validateAndBuildParams(ohlcv, { ...ohlcvBase, interval: '7m' }))
      .toThrow(/interval must be one of/);
  });

  it('accepts integer params as both string and number', () => {
    const fromNumber = validateAndBuildParams(holders, { wallet_address: '0xabc', limit: 50 });
    const fromString = validateAndBuildParams(holders, { wallet_address: '0xabc', limit: '50' });
    expect(fromNumber.limit).toBe(50);
    expect(fromString.limit).toBe(50);
  });

  it('rejects integers below the minimum', () => {
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', limit: 0 }))
      .toThrow(/limit must be at least 1/);
  });

  it('rejects integers above the maximum', () => {
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', limit: 100000 }))
      .toThrow(/limit must be at most 1000/);
  });

  it('rejects non-integer numeric input', () => {
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', limit: 'abc' }))
      .toThrow(/limit must be an integer/);
  });
});

describe('getMaxResponseLength clamping', () => {
  it('clamps requests above the hard cap', () => {
    expect(getMaxResponseLength({ _maxResponseLength: 10_000_000 }, 30000)).toBe(MAX_RESPONSE_LENGTH_CAP);
  });

  it('honors values below the cap', () => {
    expect(getMaxResponseLength({ _maxResponseLength: 500 }, 30000)).toBe(500);
  });

  it('falls back to the default (also clamped) when unset', () => {
    expect(getMaxResponseLength({}, 30000)).toBe(30000);
    expect(getMaxResponseLength({}, 10_000_000)).toBe(MAX_RESPONSE_LENGTH_CAP);
  });

  it('ignores non-positive or non-finite values', () => {
    expect(getMaxResponseLength({ _maxResponseLength: -5 }, 30000)).toBe(30000);
    expect(getMaxResponseLength({ _maxResponseLength: 'nope' }, 30000)).toBe(30000);
  });
});

describe('toStructuredError', () => {
  it('maps an ApiError to a structured error and derives retryable from status', () => {
    const err = new ApiError({ status: 502, code: null, message: 'gateway down', body: '', rateLimit: null });
    const structured = toStructuredError(err);
    expect(structured).toEqual({
      code: 'UPSTREAM_ERROR',
      message: 'gateway down',
      status: 502,
      retryable: true,
    });
  });

  it('prefers a server-supplied code and marks 4xx non-retryable', () => {
    const err = new ApiError({ status: 400, code: 'INVALID_TOKEN', message: 'bad token', body: '', rateLimit: null });
    expect(toStructuredError(err)).toEqual({
      code: 'INVALID_TOKEN',
      message: 'bad token',
      status: 400,
      retryable: false,
    });
  });

  it('maps 429 to RATE_LIMITED and retryable', () => {
    const err = new ApiError({ status: 429, code: null, message: 'slow down', body: '', rateLimit: null });
    expect(toStructuredError(err)).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });

  it('strips HTML bodies so no markup leaks (defensive vs published client)', () => {
    const html = '<!DOCTYPE html>\n<html><body><h1>502 Bad Gateway</h1></body></html>';
    const err = new ApiError({ status: 502, code: null, message: html, body: html, rateLimit: null });
    const structured = toStructuredError(err);
    expect(structured.code).toBe('UPSTREAM_ERROR');
    expect(structured.retryable).toBe(true);
    expect(structured.message).not.toContain('<!DOCTYPE');
    expect(structured.message).not.toContain('<html');
    expect(JSON.stringify(structured)).not.toContain('<!DOCTYPE');
  });

  it('normalizes non-ApiError throwables without status', () => {
    expect(toStructuredError(new Error('boom'))).toEqual({
      code: 'MCP_ERROR',
      message: 'boom',
      status: 0,
      retryable: false,
    });
  });
});

describe('docs path helpers', () => {
  it('derives the docs path from a tool apiPath (strips /api/v1/)', () => {
    const dexes = CAMBRIAN_MCP_TOOLS.find((t) => t.name === 'cambrian_base_dexes')!;
    const price = CAMBRIAN_MCP_TOOLS.find((t) => t.name === 'cambrian_solana_price_current')!;
    const risk = CAMBRIAN_MCP_TOOLS.find((t) => t.name === 'cambrian_risk_perp_risk_engine')!;
    expect(docPathForTool(dexes)).toBe('evm/dexes');
    expect(docPathForTool(price)).toBe('solana/price-current');
    expect(docPathForTool(risk)).toBe('perp-risk-engine');
  });

  it('normalizeDocPath trims, drops api/v1, and aliases base -> evm', () => {
    expect(normalizeDocPath('/solana/price-current/')).toBe('solana/price-current');
    expect(normalizeDocPath('base/dexes')).toBe('evm/dexes');
    expect(normalizeDocPath('base')).toBe('evm');
    expect(normalizeDocPath('api/v1/evm/dexes')).toBe('evm/dexes');
    // does not alias a `base` that is not the first segment
    expect(normalizeDocPath('solana/base-pool')).toBe('solana/base-pool');
  });

  it('builds the per-endpoint docs URL', () => {
    expect(endpointDocsUrl('solana/price-current')).toBe(`${DOCS_BASE_URL}/api/v1/solana/price-current/llms.txt`);
  });
});

describe('tool description docs pointers', () => {
  it('appends a cambrian_docs pointer with the endpoint path to every endpoint tool', () => {
    const tools = listMcpTools();
    const dexes = tools.find((t) => t.name === 'cambrian_base_dexes')!;
    expect(dexes.description).toContain(`call ${DOCS_TOOL_NAME} with path "evm/dexes"`);
    const price = tools.find((t) => t.name === 'cambrian_solana_price_current')!;
    expect(price.description).toContain('Query Cambrian solana price current data.');
    expect(price.description).toContain(`call ${DOCS_TOOL_NAME} with path "solana/price-current"`);
    // the docs tool itself documents the path arg + base->evm alias
    const docs = tools.find((t) => t.name === DOCS_TOOL_NAME)!;
    expect(docs.description.toLowerCase()).toContain('endpoint path');
    expect(docs.description.toLowerCase()).toContain('alias for `evm');
  });
});

describe('cambrian_docs resolution', () => {
  it('returns the per-endpoint llms.txt when a path is given', async () => {
    const url = `${DOCS_BASE_URL}/api/v1/solana/price-current/llms.txt`;
    const fetchFn = mockFetch({
      [url]: { body: '**URL**: solana/price-current\n## Query Parameters\ntoken_address (string)' },
      [DOCS_ROOT_URL]: { body: 'ROOT INDEX - should not be used when per-endpoint resolves' },
    });
    const out = await fetchDocumentationForTest(fetchFn, { path: 'solana/price-current' });
    expect(out).toContain('## Query Parameters');
    expect(out).not.toContain('ROOT INDEX');
  });

  it('aliases base/... to the evm per-endpoint URL', async () => {
    const evmUrl = `${DOCS_BASE_URL}/api/v1/evm/dexes/llms.txt`;
    const fetchFn = mockFetch({
      [evmUrl]: { body: 'EVM DEXES per-endpoint docs' },
      [DOCS_ROOT_URL]: { body: 'root index' },
    });
    const out = await fetchDocumentationForTest(fetchFn, { path: 'base/dexes' });
    expect(out).toContain('EVM DEXES per-endpoint docs');
  });

  it('falls back to the root index (line-filtered) when the per-endpoint page is missing', async () => {
    // per-endpoint URL not in routes -> 404 -> fall back to root, filter by path
    const fetchFn = mockFetch({
      [DOCS_ROOT_URL]: { body: 'solana/price-current - current price\nsolana/ohlcv - candles\nevm/dexes - DEX list' },
    });
    const out = await fetchDocumentationForTest(fetchFn, { path: 'solana/price-current' });
    expect(out).toContain('solana/price-current - current price');
    expect(out).not.toContain('evm/dexes - DEX list');
  });

  it('falls back to root when the per-endpoint URL serves an HTML landing page', async () => {
    const url = `${DOCS_BASE_URL}/api/v1/solana/foo/llms.txt`;
    const fetchFn = mockFetch({
      [url]: { body: '<!DOCTYPE html><html><body>Docs landing</body></html>', contentType: 'text/html' },
      [DOCS_ROOT_URL]: { body: 'solana/foo - something\nother line' },
    });
    const out = await fetchDocumentationForTest(fetchFn, { path: 'solana/foo' });
    expect(out).not.toContain('<!DOCTYPE');
    expect(out).toContain('solana/foo - something');
  });

  it('returns the root index when no path is given', async () => {
    const fetchFn = mockFetch({ [DOCS_ROOT_URL]: { body: 'ROOT DOCS INDEX' } });
    const out = await fetchDocumentationForTest(fetchFn, {});
    expect(out).toContain('ROOT DOCS INDEX');
  });

  it('throws a clear error when both per-endpoint and root are unreachable', async () => {
    const fetchFn = mockFetch({}); // everything 404s
    await expect(fetchDocumentationForTest(fetchFn, { path: 'solana/price-current' }))
      .rejects.toThrow(/unreachable/);
  });
});

describe('server instructions', () => {
  it('base instructions point at the cambrian_docs tool', () => {
    const base = baseServerInstructions();
    expect(base).toContain(DOCS_TOOL_NAME);
    expect(base.toLowerCase()).toContain('parameters');
  });

  it('does not fetch llms.txt while constructing a data server', () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;
    createCambrianMcpServer({ apiKey: 'test', fetch: fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('SERVER_VERSION read from package.json', () => {
  it('is a semver string, not "unknown"', () => {
    expect(SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// WS2: Structured MCP content
// ---------------------------------------------------------------------------

describe('tableResponseToStructured', () => {
  const now = '2026-01-01T00:00:00.000Z';

  const table = {
    columns: [
      { name: 'symbol', type: 'string' },
      { name: 'price', type: 'number' },
    ],
    data: [
      ['SOL', 150.5],
      ['USDC', 1.0],
    ],
    rows: 2,
  };

  it('zips columns with rows into records', () => {
    const result = tableResponseToStructured(table, now);
    expect(result.records).toEqual([
      { symbol: 'SOL', price: 150.5 },
      { symbol: 'USDC', price: 1.0 },
    ]);
  });

  it('includes schema, rowCount, and retrievedAt', () => {
    const result = tableResponseToStructured(table, now);
    expect(result.schema).toEqual([
      { name: 'symbol', type: 'string' },
      { name: 'price', type: 'number' },
    ]);
    expect(result.rowCount).toBe(2);
    expect(result.retrievedAt).toBe(now);
  });

  it('omits rateLimit when _rateLimit is not present', () => {
    const result = tableResponseToStructured(table, now);
    expect('rateLimit' in result).toBe(false);
  });

  it('surfaces rateLimit when _rateLimit is present', () => {
    const withRl = {
      ...table,
      _rateLimit: { limit: 100, remaining: 50, resetAt: '2026-01-01T01:00:00Z', retryAfterSeconds: null },
    };
    const result = tableResponseToStructured(withRl, now);
    expect(result.rateLimit).toMatchObject({ limit: 100, remaining: 50 });
  });
});

describe('buildToolResult', () => {
  const now = '2026-01-01T00:00:00.000Z';

  it('returns structuredContent for a TableResponse', () => {
    const table = {
      columns: [{ name: 'x', type: 'string' }],
      data: [['hello']],
      rows: 1,
    };
    const result = buildToolResult(table, 30000, now);
    expect(result.structuredContent).toBeDefined();
    expect((result.structuredContent as { records: unknown[] }).records).toHaveLength(1);
    expect(result.content[0].type).toBe('text');
    // text fallback should mention rowCount
    expect(result.content[0].text).toContain('"rowCount"');
  });

  it('returns structuredContent for a plain JSON object (Deep42/Risk)', () => {
    const json = { status: 'ok', riskProbability: 0.1 };
    const result = buildToolResult(json, 30000, now);
    expect(result.structuredContent).toEqual(json);
    expect(result.content[0].text).toContain('"riskProbability"');
  });

  it('wraps a plain JSON array in an MCP-compatible object', () => {
    const result = buildToolResult([{ symbol: 'SOL' }], 30000, now);
    expect(result.structuredContent).toEqual({
      items: [{ symbol: 'SOL' }],
      itemCount: 1,
      retrievedAt: now,
    });
  });

  it('wraps arrays of TableResponses in an MCP-compatible object', () => {
    const result = buildToolResult([{
      columns: [{ name: 'blockNumber', type: 'UInt64' }],
      data: [[123]],
      rows: 1,
    }], 30000, now);
    expect(result.structuredContent).toMatchObject({
      tableCount: 1,
      tables: [{ records: [{ blockNumber: 123 }], rowCount: 1 }],
      retrievedAt: now,
    });
  });

  it('passes an array response through the MCP SDK result validator', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      fetch: (async () => new Response(JSON.stringify([{
        columns: [{ name: 'blockNumber', type: 'UInt64' }],
        data: [[123]],
        rows: 1,
      }]), { headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch,
    });
    const client = new Client({ name: 'array-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: 'cambrian_solana_latest_block',
        arguments: {},
      });
      expect(result.structuredContent).toMatchObject({ tableCount: 1 });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns plain text for a string result', () => {
    const result = buildToolResult('raw text', 30000, now);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).toBe('raw text');
  });

  it('truncates the text fallback when it exceeds maxLength', () => {
    const bigTable = {
      columns: [{ name: 'data', type: 'string' }],
      data: Array.from({ length: 100 }, (_, i) => [`row-${i}`]),
      rows: 100,
    };
    const result = buildToolResult(bigTable, 200, now);
    expect(result.content[0].text!.length).toBeLessThanOrEqual(300); // truncation adds marker
    expect(result.content[0].text).toContain('truncated');
    // structuredContent is the FULL structured result (not truncated)
    expect((result.structuredContent as { rowCount: number }).rowCount).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// WS3: Composite tools
// ---------------------------------------------------------------------------

describe('callSolanaTokenSnapshot', () => {
  beforeEach(() => resetCalls());

  it('reports a per-section error without throwing', async () => {
    const client = new CambrianData({ apiKey: 'test' });
    // Override opabinia to throw on one path.
    const original = client.opabinia.query.bind(client.opabinia);
    client.opabinia.query = async (path: string, params: Record<string, unknown>) => {
      if (path === '/api/v1/solana/token-details') throw new Error('details unavailable');
      return original(path, params);
    };
    const result = await callSolanaTokenSnapshot(client, 'TokenMint', 'SOL', '2026-01-01T00:00:00.000Z') as Record<string, unknown>;
    const details = result.details as { error?: { code: string; section: string } };
    expect(details.error).toBeDefined();
    expect(details.error!.code).toBe('MCP_ERROR');
    expect(details.error!.section).toBe('token-details');
  });

  it('makes concurrent calls across opabinia and deep42', async () => {
    const client = new CambrianData({ apiKey: 'test' });
    const result = await callSolanaTokenSnapshot(client, 'TokenMint', 'SOL', '2026-01-01T00:00:00.000Z') as Record<string, unknown>;
    expect(result.tokenAddress).toBe('TokenMint');
    expect(result.tokenSymbol).toBe('SOL');
    // At least opabinia + deep42 calls happened
    const clients = new Set(calls.map((c) => c.client));
    expect(clients.has('opabinia')).toBe(true);
    expect(clients.has('deep42')).toBe(true);
  });

  it('never calls the hidden Deep42 discovery endpoint', async () => {
    const client = new CambrianData({ apiKey: 'test' });
    const result = await callSolanaTokenSnapshot(client, 'TokenMint', undefined, '2026-01-01T00:00:00.000Z') as {
      deep42: Record<string, unknown>;
    };
    expect(calls.some((call) => call.apiPath.includes('/discovery/'))).toBe(false);
    expect(result.deep42).toHaveProperty('sentimentShifts');
    expect(result.deep42).not.toHaveProperty('projectMetadata');
  });

  it('scopes the Deep42 section to the token when a symbol is given', async () => {
    const client = new CambrianData({ apiKey: 'test' });
    const result = await callSolanaTokenSnapshot(client, 'TokenMint', 'SOL', 'x') as {
      deep42: Record<string, unknown>;
    };
    expect(result.deep42.scope).toBe('token');
    expect(result.deep42).toHaveProperty('tokenAnalysis');
    expect(calls.some((call) => call.apiPath.endsWith('/social-data/token-analysis'))).toBe(true);
  });

  it('falls back to market-wide sentiment without a symbol', async () => {
    const client = new CambrianData({ apiKey: 'test' });
    const result = await callSolanaTokenSnapshot(client, 'TokenMint', undefined, 'x') as {
      deep42: Record<string, unknown>;
    };
    expect(result.deep42.scope).toBe('market-wide');
    expect(calls.some((call) => call.apiPath.endsWith('/social-data/sentiment-shifts'))).toBe(true);
  });
});

describe('callCambrianHealth', () => {
  beforeEach(() => resetCalls());

  it('returns healthy when all services respond', async () => {
    const client = new CambrianData({ apiKey: 'test' });
    const result = await callCambrianHealth(client, '2026-01-01T00:00:00.000Z') as Record<string, unknown>;
    expect(result.status).toBe('healthy');
    expect(Array.isArray(result.services)).toBe(true);
    const services = result.services as Array<{ service: string; status: string }>;
    expect(services.every((s) => s.status === 'up')).toBe(true);
    expect(calls.some((call) => call.apiPath === '/api/v1/evm/dexes')).toBe(true);
    expect(calls.some((call) => call.apiPath === '/api/v1/evm/chains')).toBe(false);
    // The risk probe is the service's own /health, not perp-risk-engine:
    // the Monte Carlo engine took ~14 s and Promise.all made the whole health
    // check that slow.
    expect(calls.find((call) => call.client === 'risk')?.apiPath).toBe('/health');
  });

  it('reports degraded when a service is down, without throwing', async () => {
    const client = new CambrianData({ apiKey: 'test' });
    client.opabinia.query = async () => { throw new Error('solana down'); };
    const result = await callCambrianHealth(client, '2026-01-01T00:00:00.000Z') as Record<string, unknown>;
    expect(result.status).toBe('degraded');
    const services = result.services as Array<{ service: string; status: string }>;
    const solana = services.find((s) => s.service === 'solana');
    expect(solana?.status).toBe('down');
  });
});

describe('composite tools listed in listMcpTools', () => {
  it('includes cambrian_solana_token_snapshot and cambrian_health only', () => {
    const tools = listMcpTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('cambrian_solana_token_snapshot');
    expect(names).toContain('cambrian_health');
    // Removed in 1.3.0: unfixable (no rate-limit headers) and redundant with the snapshot.
    expect(names).not.toContain('cambrian_usage');
    expect(names).not.toContain('cambrian_resolve_token');
  });

  it('cambrian_solana_token_snapshot requires token_address', () => {
    const tool = listMcpTools().find((t) => t.name === 'cambrian_solana_token_snapshot')!;
    expect(tool.inputSchema.required).toContain('token_address');
  });
});

// ---------------------------------------------------------------------------
// WS5: Risk tool bounded timeout
// ---------------------------------------------------------------------------

describe('withTimeout', () => {
  it('resolves when the promise completes within the timeout', async () => {
    const result = await withTimeout(Promise.resolve('ok'), 5000, 'test');
    expect(result).toBe('ok');
  });

  it('rejects with a TIMEOUT structured error when the promise is too slow', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => {});
    const promise = withTimeout(never, 100, 'cambrian_risk_perp_risk_engine');
    vi.advanceTimersByTime(200);
    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('timed out'),
    });
    vi.useRealTimers();
  });

  it('RISK_TOOL_TIMEOUT_MS is defined as a reasonable positive bound', () => {
    expect(RISK_TOOL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(RISK_TOOL_TIMEOUT_MS).toBeLessThanOrEqual(60000);
  });

  it('propagates real rejections immediately without waiting for the timeout', async () => {
    vi.useFakeTimers();
    const boom = Promise.reject(new Error('real error'));
    // Should reject before advancing timers.
    await expect(withTimeout(boom, 30000, 'test')).rejects.toThrow('real error');
    vi.useRealTimers();
  });
});

describe('composite tools send parameters their endpoints actually accept', () => {
  beforeEach(() => resetCalls());

  /**
   * Composites call `client.<service>.query()` directly, bypassing the
   * metadata validation every generated tool goes through. That is how the
   * snapshot shipped with `token_address` on an endpoint keyed by `program_id`
   * and with `7d`/`30d` on an enum that only accepts 1h|2h|4h|8h|24h — both
   * 400s, silently swallowed by per-section error tolerance.
   *
   * Replay every recorded call through validateAndBuildParams so any future
   * drift fails here instead of degrading a section in production.
   */
  function assertRecordedCallsValidate() {
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const tool = CAMBRIAN_MCP_TOOLS.find((candidate) => candidate.apiPath === call.apiPath);
      if (!tool) continue; // non-endpoint probes such as risk /health
      expect(() => validateAndBuildParams(tool, call.params)).not.toThrow();
    }
  }

  it('cambrian_solana_token_snapshot without a symbol', async () => {
    await callSolanaTokenSnapshot(new CambrianData(), 'So11111111111111111111111111111111111111112', undefined, 'x');
    assertRecordedCallsValidate();
  });

  it('cambrian_solana_token_snapshot with a symbol', async () => {
    await callSolanaTokenSnapshot(new CambrianData(), 'So11111111111111111111111111111111111111112', 'SOL', 'x');
    assertRecordedCallsValidate();
  });

  it('cambrian_health', async () => {
    await callCambrianHealth(new CambrianData(), 'x');
    assertRecordedCallsValidate();
  });

  it('cambrian_health probes risk /health, never the Monte Carlo engine', async () => {
    await callCambrianHealth(new CambrianData(), 'x');
    const riskCalls = calls.filter((call) => call.client === 'risk');
    expect(riskCalls).toHaveLength(1);
    expect(riskCalls[0].apiPath).toBe('/health');
  });
});
