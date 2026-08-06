import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CambrianData } from 'cambrian';
import { CAMBRIAN_MCP_TOOLS, CAMBRIAN_METADATA_GROUPS } from 'cambrian/metadata';
import {
  DOCS_TOOL_NAME,
  DOCS_BASE_URL,
  DOCS_ROOT_URL,
  MAX_RESPONSE_LENGTH_CAP,
  MAX_STRUCTURED_RECORDS,
  RISK_TOOL_TIMEOUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  SERVER_VERSION,
  baseServerInstructions,
  buildToolInputSchema,
  buildToolResult,
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
import { ApiError, calls, resetCalls, setHangOpabinia } from './fixtures/cambrian.js';

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
    expect(tools).toHaveLength(72);
    expect(tools.some((tool) => tool.name === 'cambrian_health')).toBe(false);
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
    expect(endpointDocsUrl('solana/price-current')).toBe(`${DOCS_BASE_URL}/solana/price-current/llms.txt`);
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
    expect(docs.description).toContain('guides/<slug>');
    expect(docs.description).toContain('guides/x402');
  });
});

describe('cambrian_docs resolution', () => {
  it('returns the per-endpoint llms.txt when a path is given', async () => {
    const url = `${DOCS_BASE_URL}/solana/price-current/llms.txt`;
    const fetchFn = mockFetch({
      [url]: { body: '**URL**: solana/price-current\n## Query Parameters\ntoken_address (string)' },
      [DOCS_ROOT_URL]: { body: 'ROOT INDEX - should not be used when per-endpoint resolves' },
    });
    const out = await fetchDocumentationForTest(fetchFn, { path: 'solana/price-current' });
    expect(out).toContain('## Query Parameters');
    expect(out).not.toContain('ROOT INDEX');
  });

  it('aliases base/... to the evm per-endpoint URL', async () => {
    const evmUrl = `${DOCS_BASE_URL}/evm/dexes/llms.txt`;
    const fetchFn = mockFetch({
      [evmUrl]: { body: 'EVM DEXES per-endpoint docs' },
      [DOCS_ROOT_URL]: { body: 'root index' },
    });
    const out = await fetchDocumentationForTest(fetchFn, { path: 'base/dexes' });
    expect(out).toContain('EVM DEXES per-endpoint docs');
  });

  it('returns a dynamically indexed guide by its docs path', async () => {
    const guideUrl = `${DOCS_BASE_URL}/guides/new-guide/llms.txt`;
    const fetchFn = mockFetch({
      [guideUrl]: { body: '# New guide\nAdded after this MCP release.' },
      [DOCS_ROOT_URL]: { body: 'ROOT INDEX - should not be used when the guide resolves' },
    });

    const out = await fetchDocumentationForTest(fetchFn, { path: 'guides/new-guide' });

    expect(out).toContain('Added after this MCP release.');
    expect(out).not.toContain('ROOT INDEX');
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
    const url = `${DOCS_BASE_URL}/solana/foo/llms.txt`;
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
    expect(base).toContain('guides/<slug>');
    expect(base).toContain('guides/x402');
  });

  it('does not fetch llms.txt while constructing a data server', () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;
    createCambrianMcpServer({ apiKey: 'test', fetch: fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('lists and executes tools from validated runtime metadata', async () => {
    const resource = 'social-data/new-signal';
    const metadata = {
      ...CAMBRIAN_METADATA_GROUPS,
      deep42: {
        ...CAMBRIAN_METADATA_GROUPS.deep42,
        resources: [...CAMBRIAN_METADATA_GROUPS.deep42.resources, resource],
        spec: {
          ...CAMBRIAN_METADATA_GROUPS.deep42.spec,
          [resource]: {
            apiPath: '/api/v1/deep42/social-data/new-signal',
            method: 'GET',
            params: { limit: { required: true, type: 'integer', strict: true } },
          },
        },
      },
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      metadataProvider: async () => metadata,
    });
    const client = new Client({ name: 'runtime-metadata-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools.some((tool) => tool.name === 'cambrian_deep42_social_data_new_signal'))
        .toBe(true);

      const result = await client.callTool({
        name: 'cambrian_deep42_social_data_new_signal',
        arguments: { limit: 2 },
      });
      expect(result.isError).not.toBe(true);
      expect(calls.at(-1)).toMatchObject({
        client: 'deep42',
        apiPath: '/api/v1/deep42/social-data/new-signal',
        params: { limit: 2 },
      });
      expect(CAMBRIAN_MCP_TOOLS.some((tool) => tool.resource === resource)).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('falls back to bundled tools when runtime metadata loading fails', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      metadataProvider: async () => { throw new Error('registry unavailable'); },
    });
    const client = new Client({ name: 'metadata-fallback-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(72);
      expect(listed.tools.some((tool) => tool.name === 'cambrian_base_dexes')).toBe(true);

      const result = await client.callTool({ name: 'cambrian_base_dexes', arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reuses the 15-minute schema cache across MCP server instances', async () => {
    const cacheRoot = mkdtempSync(join(tmpdir(), 'cambrian-mcp-schema-test-'));
    const previousCacheRoot = process.env.XDG_CACHE_HOME;
    process.env.XDG_CACHE_HOME = cacheRoot;
    const openapiRequests: string[] = [];
    const documents: Record<string, unknown> = {
      'https://api.cambrian.org/openapi.json': {
        openapi: '3.1.0',
        info: { title: 'Gateway', version: '1' },
        paths: {
          '/api/v1/solana/new-signal': { get: { parameters: [] } },
          '/api/v1/evm/new-signal': { get: { parameters: [] } },
        },
      },
      'https://api.cambrian.org/deep42/openapi.json': {
        openapi: '3.1.0',
        info: { title: 'Deep42', version: '1' },
        paths: { '/api/v1/deep42/social-data/new-signal': { get: { parameters: [] } } },
      },
      'https://api.cambrian.org/risk/openapi.json': {
        openapi: '3.1.0',
        info: { title: 'Risk', version: '1' },
        paths: { '/api/v1/perp-risk-engine': { get: { parameters: [] } } },
      },
    };
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/openapi.json')) {
        openapiRequests.push(url);
        return new Response(JSON.stringify(documents[url]), { status: 200 });
      }
      if (url === 'https://docs.cambrian.org/llms.txt') return new Response('', { status: 200 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const listFromNewServer = async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createCambrianMcpServer({ apiKey: 'test', fetch });
      const client = new Client({ name: 'cache-test', version: '1.0.0' }, { capabilities: {} });
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        return await client.listTools();
      } finally {
        await client.close();
        await server.close();
      }
    };

    try {
      const first = await listFromNewServer();
      const second = await listFromNewServer();
      expect(first.tools.some((tool) => tool.name === 'cambrian_deep42_social_data_new_signal'))
        .toBe(true);
      expect(second.tools.map((tool) => tool.name)).toEqual(first.tools.map((tool) => tool.name));
      expect(openapiRequests).toEqual([
        'https://api.cambrian.org/openapi.json',
        'https://api.cambrian.org/deep42/openapi.json',
        'https://api.cambrian.org/risk/openapi.json',
      ]);
    } finally {
      if (previousCacheRoot === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previousCacheRoot;
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

  it('rechecks cached runtime metadata in a long-lived MCP session', async () => {
    const resource = 'social-data/new-signal';
    let loads = 0;
    const metadataProvider = async () => {
      loads += 1;
      if (loads === 1) return CAMBRIAN_METADATA_GROUPS;
      return {
        ...CAMBRIAN_METADATA_GROUPS,
        deep42: {
          ...CAMBRIAN_METADATA_GROUPS.deep42,
          resources: [...CAMBRIAN_METADATA_GROUPS.deep42.resources, resource],
          spec: {
            ...CAMBRIAN_METADATA_GROUPS.deep42.spec,
            [resource]: {
              apiPath: '/api/v1/deep42/social-data/new-signal',
              method: 'GET',
              params: {},
            },
          },
        },
      };
    };
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({ apiKey: 'test', metadataProvider });
    const client = new Client({ name: 'refresh-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const first = await client.listTools();
      const second = await client.listTools();
      expect(first.tools.some((tool) => tool.name === 'cambrian_deep42_social_data_new_signal'))
        .toBe(false);
      expect(second.tools.some((tool) => tool.name === 'cambrian_deep42_social_data_new_signal'))
        .toBe(true);
      expect(loads).toBe(2);
    } finally {
      await client.close();
      await server.close();
    }
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
      metadataProvider: async () => CAMBRIAN_METADATA_GROUPS,
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

  // cambrian_solana_orca_pools returns 137k+ rows and has no `limit` param.
  // Uncapped, that serialized to a 58.8 MB JSON-RPC message that killed the
  // stdio connection — taking every later call in the session with it.
  it('caps structuredContent records and reports the true rowCount', () => {
    const hugeTable = {
      columns: [{ name: 'poolAddress', type: 'string' }],
      data: Array.from({ length: MAX_STRUCTURED_RECORDS + 500 }, (_, i) => [`pool-${i}`]),
      rows: MAX_STRUCTURED_RECORDS + 500,
    };
    const structured = buildToolResult(hugeTable, 30000, now).structuredContent as {
      records: unknown[]; rowCount: number; returnedRecordCount: number; truncated: boolean;
    };
    expect(structured.records).toHaveLength(MAX_STRUCTURED_RECORDS);
    expect(structured.returnedRecordCount).toBe(MAX_STRUCTURED_RECORDS);
    expect(structured.truncated).toBe(true);
    // The caller must still learn how much data actually exists upstream.
    expect(structured.rowCount).toBe(MAX_STRUCTURED_RECORDS + 500);
  });

  it('leaves a table under the cap untagged', () => {
    const smallTable = {
      columns: [{ name: 'blockNumber', type: 'UInt64' }],
      data: [[123]],
      rows: 1,
    };
    const structured = buildToolResult(smallTable, 30000, now).structuredContent as Record<string, unknown>;
    expect(structured.truncated).toBeUndefined();
    expect(structured.returnedRecordCount).toBeUndefined();
  });

  it('caps a plain (non-table) array response too', () => {
    const items = Array.from({ length: MAX_STRUCTURED_RECORDS + 10 }, (_, i) => ({ i }));
    const structured = buildToolResult(items, 30000, now).structuredContent as {
      items: unknown[]; itemCount: number; returnedItemCount: number; truncated: boolean;
    };
    expect(structured.items).toHaveLength(MAX_STRUCTURED_RECORDS);
    expect(structured.itemCount).toBe(MAX_STRUCTURED_RECORDS + 10);
    expect(structured.returnedItemCount).toBe(MAX_STRUCTURED_RECORDS);
    expect(structured.truncated).toBe(true);
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
      if (path === '/solana/token-details') throw new Error('details unavailable');
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
    expect(calls.every((call) => !call.apiPath.startsWith('/api/v1'))).toBe(true);
  });
});

describe('composite tools listed in listMcpTools', () => {
  it('includes only cambrian_solana_token_snapshot', () => {
    const tools = listMcpTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain('cambrian_solana_token_snapshot');
    expect(names).not.toContain('cambrian_health');
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

  it('DEFAULT_TOOL_TIMEOUT_MS stays under the ~60 s client-side abort', () => {
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBeGreaterThan(RISK_TOOL_TIMEOUT_MS);
    expect(DEFAULT_TOOL_TIMEOUT_MS).toBeLessThan(60000);
  });

  it('uses a generic hint by default and the supplied one when given', async () => {
    vi.useFakeTimers();
    const generic = withTimeout(new Promise<never>(() => {}), 100, 'cambrian_solana_orca_pools');
    const specific = withTimeout(
      new Promise<never>(() => {}), 100, 'cambrian_risk_perp_risk_engine', 'Monte Carlo hint.',
    );
    vi.advanceTimersByTime(200);
    await expect(generic).rejects.toThrow(/narrow the request/);
    await expect(specific).rejects.toThrow(/Monte Carlo hint\./);
    vi.useRealTimers();
  });

  // A non-risk tool that hangs must come back as a structured retryable
  // TIMEOUT. Before this bound, 71 of 72 tools hung until the client aborted
  // and surfaced a bare MCP -32001 the agent could not act on.
  it('returns a TIMEOUT structured error when a non-risk tool hangs', async () => {
    vi.useFakeTimers();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      metadataProvider: async () => CAMBRIAN_METADATA_GROUPS,
    });
    const client = new Client({ name: 'timeout-test', version: '1.0.0' }, { capabilities: {} });
    setHangOpabinia(true);
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const pending = client.callTool({ name: 'cambrian_solana_latest_block', arguments: {} });
      await vi.advanceTimersByTimeAsync(DEFAULT_TOOL_TIMEOUT_MS + 1000);
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(JSON.parse((result.content as { text: string }[])[0].text).error).toMatchObject({
        code: 'TIMEOUT',
        retryable: true,
      });
    } finally {
      setHangOpabinia(false);
      await client.close();
      await server.close();
      vi.useRealTimers();
    }
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
      const metadataPath = call.client === 'deep42'
        ? `/api/v1/deep42${call.apiPath}`
        : `/api/v1${call.apiPath}`;
      const tool = CAMBRIAN_MCP_TOOLS.find((candidate) => candidate.apiPath === metadataPath);
      expect(tool, `Missing metadata for ${call.client} ${call.apiPath}`).toBeDefined();
      if (!tool) continue;
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
});
