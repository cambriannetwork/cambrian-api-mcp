import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CambrianData } from 'cambrian';
import { CAMBRIAN_MCP_TOOLS, listCambrianTools as listRuntimeTools } from 'cambrian/metadata';
import { OFFLINE_REGISTRY } from '../src/generated/offline-registry.js';
import {
  COMPACT_CALL_TOOL_NAME,
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
  listCompactMcpTools,
  listProgressiveMcpTools,
  parseToolsets,
  projectEvmTools,
  normalizeDocPath,
  tableResponseToStructured,
  toStructuredError,
  validateAndBuildParams,
  withTimeout,
} from '../src/server.js';
import { ApiError, calls, resetCalls, setHangOpabinia, setUseBoundaryFetch } from './fixtures/cambrian.js';

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
    const names = tools.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(CAMBRIAN_MCP_TOOLS.every((tool) => names.includes(tool.name))).toBe(true);
    expect(names).not.toContain('cambrian_health');
    expect(names).toContain(DOCS_TOOL_NAME);
    expect(names).toContain('cambrian_base_dexes');
    expect(names).toContain('cambrian_solana_price_current');
    expect(names).toContain('cambrian_deep42_social_data_alpha_tweet_detection');
    expect(names).toContain('cambrian_risk_perp_risk_engine');
    expect(names).not.toContain('evm__chains');
  });

  it('keeps the compact catalog below 5,000 characters', () => {
    const tools = listCompactMcpTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      DOCS_TOOL_NAME,
      COMPACT_CALL_TOOL_NAME,
      'cambrian_solana_token_snapshot',
    ]);
    expect(JSON.stringify(tools).length).toBeLessThan(5_000);
  });

  it('lists every endpoint with parameter names, types, and enums in the progressive catalog', () => {
    const tools = listProgressiveMcpTools();
    const names = tools.map((tool) => tool.name);
    const holders = tools.find((tool) => tool.name === 'cambrian_solana_tokens_holders')!;

    expect(CAMBRIAN_MCP_TOOLS.every((tool) => names.includes(tool.name))).toBe(true);
    expect(names).not.toContain(COMPACT_CALL_TOOL_NAME);
    expect(holders.inputSchema.required).toEqual(['program_id']);
    expect(holders.inputSchema.properties).toHaveProperty('program_id', { type: 'string' });
    expect(holders.inputSchema.properties).toHaveProperty('limit', {
      type: 'integer',
      maximum: 1000,
    });
    expect(holders.inputSchema.properties).not.toHaveProperty('_maxResponseLength');
    expect(holders.inputSchema.properties.limit).not.toHaveProperty('description');
    expect(JSON.stringify(tools)).not.toContain('Query Cambrian');
    for (const omitted of ['offset', 'order_asc', 'order_desc']) {
      expect(JSON.stringify(tools)).not.toContain(`"${omitted}"`);
    }
    // Context budget. The full profile is ~130 kB; progressive must stay far
    // under it or the profile has stopped earning its name.
    expect(JSON.stringify(tools).length).toBeLessThan(28_000);
  });

  // The whole trim rests on this: omitting a parameter from the advertised
  // schema must not make it unusable. Validation runs against the full
  // metadata, so an agent that learned `offset`/`order_desc` from the
  // instructions or from cambrian_docs can still send them.
  it('still accepts the parameters the progressive catalog omits', async () => {
    const tool = listRuntimeTools(OFFLINE_REGISTRY)
      .find((candidate) => candidate.name === 'cambrian_base_alien_v3_pools')!;
    const args = { limit: 5, offset: 20, order_desc: ['poolAddress'] };
    expect(validateAndBuildParams(tool, args)).toMatchObject(args);
    await callCambrianTool(new CambrianData({ apiKey: 'test' }), tool, args);
    expect(calls[0].params).toMatchObject(args);
  });

  it('keeps a useful endpoint description in the progressive catalog', () => {
    const source = CAMBRIAN_MCP_TOOLS.find((tool) => tool.name === 'cambrian_base_dexes')!;
    const tool = listProgressiveMcpTools([{
      ...source,
      description: 'List decentralized exchanges and their protocol types on Base.',
    }])[1];

    expect(tool).toMatchObject({
      name: 'cambrian_base_dexes',
      description: 'List decentralized exchanges and their protocol types on Base.',
    });
  });

  it('preserves every first-call constraint in the progressive catalog', () => {
    const fullByName = new Map(listMcpTools().map((tool) => [tool.name, tool]));
    for (const tool of listProgressiveMcpTools()) {
      const full = fullByName.get(tool.name);
      if (!full || tool.name === DOCS_TOOL_NAME || tool.name === 'cambrian_solana_token_snapshot') continue;

      expect(tool.inputSchema.required ?? []).toEqual(full.inputSchema.required ?? []);
      for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
        const source = full.inputSchema.properties[name];
        expect(property.type).toBe(source.type);
        // `limit` deliberately advertises its ceiling only: the floor is always
        // 1 and the default carries no decision the agent has to make.
        if (name === 'limit') {
          expect(property).toEqual({
            type: source.type,
            ...(source.maximum !== undefined ? { maximum: source.maximum } : {}),
          });
          continue;
        }
        for (const key of ['enum', 'default', 'minimum', 'maximum'] as const) {
          expect(property[key]).toEqual(source[key]);
        }
        if (source.items) expect(property.items).toEqual({ type: source.items.type });
      }
      // Omitted params must never be silently dropped from a *required* list.
      for (const omitted of ['offset', 'order_asc', 'order_desc']) {
        expect(tool.inputSchema.properties).not.toHaveProperty(omitted);
        expect(full.inputSchema.required ?? []).not.toContain(omitted);
      }
    }
  });

  it('uses OpenAPI required fields and defaults instead of CLI conveniences', () => {
    const aeroPool = CAMBRIAN_MCP_TOOLS.find((tool) => tool.name === 'cambrian_base_aero_v2_pool');
    expect(aeroPool).toBeDefined();
    const schema = buildToolInputSchema(aeroPool!);
    expect(schema.required).toContain('pool_address');
    expect(schema.required).toContain('apr_days_annualized');
    expect(schema.properties?.apr_days_annualized).not.toHaveProperty('default');

    const risk = CAMBRIAN_MCP_TOOLS.find((tool) => tool.name === 'cambrian_risk_perp_risk_engine');
    expect(risk).toBeDefined();
    expect(buildToolInputSchema(risk!).required).toEqual([
      'token_address',
      'entry_price',
      'leverage',
      'direction',
      'risk_horizon',
    ]);
    expect(() => validateAndBuildParams(risk!, {})).toThrow('Missing required parameter "token_address"');
  });

  it('applies defaults and rejects unknown params', () => {
    const holders = CAMBRIAN_MCP_TOOLS.find((tool) => tool.name === 'cambrian_solana_holder_token_balances')!;
    expect(validateAndBuildParams(holders, { wallet_address: '0xabc' })).toMatchObject({
      wallet_address: '0xabc',
      limit: 10,
    });
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', bad: true }))
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
  const risk = CAMBRIAN_MCP_TOOLS.find((t) => t.name === 'cambrian_risk_perp_risk_engine')!;

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
      .toThrow(/"interval" must be one of/);
  });

  it('accepts integer params as both string and number', () => {
    const fromNumber = validateAndBuildParams(holders, { wallet_address: '0xabc', limit: 50 });
    const fromString = validateAndBuildParams(holders, { wallet_address: '0xabc', limit: '50' });
    expect(fromNumber.limit).toBe(50);
    expect(fromString.limit).toBe(50);
  });

  it('rejects integers below the minimum', () => {
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', limit: 0 }))
      .toThrow(/"limit" must be at least 1/);
  });

  it('rejects integers above the maximum', () => {
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', limit: 100000 }))
      .toThrow(/"limit" must be at most 1000/);
  });

  it('rejects non-integer numeric input', () => {
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', limit: 'abc' }))
      .toThrow(/"limit" must be an integer/);
  });

  it('rejects partially numeric integer strings', () => {
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', limit: '5abc' }))
      .toThrow(/"limit" must be an integer/);
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', limit: '1.5' }))
      .toThrow(/"limit" must be an integer/);
  });

  it('rejects booleans and empty strings for integer parameters', () => {
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', limit: true }))
      .toThrow(/"limit" must be an integer/);
    expect(() => validateAndBuildParams(holders, { wallet_address: '0xabc', limit: '' }))
      .toThrow(/"limit" must be an integer/);
  });

  it('rejects booleans and empty strings for number parameters', () => {
    const otherRequired = {
      token_address: 'So11111111111111111111111111111111111111112',
      leverage: 5,
      direction: 'long',
      risk_horizon: '1d',
    };
    expect(() => validateAndBuildParams(risk, { ...otherRequired, entry_price: true }))
      .toThrow(/"entry_price" must be a number/);
    expect(() => validateAndBuildParams(risk, { ...otherRequired, entry_price: '' }))
      .toThrow(/"entry_price" must be a number/);
  });
});

describe('getMaxResponseLength clamping', () => {
  it('clamps requests above the hard cap', () => {
    expect(getMaxResponseLength({ _maxResponseLength: 10_000_000 }, 30000)).toBe(MAX_RESPONSE_LENGTH_CAP);
  });

  it('honors values below the cap', () => {
    expect(getMaxResponseLength({ _maxResponseLength: 500 }, 30000)).toBe(500);
    expect(getMaxResponseLength({ _maxResponseLength: '500' }, 30000)).toBe(500);
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
    // the docs tool itself gives the canonical endpoint path
    const docs = tools.find((t) => t.name === DOCS_TOOL_NAME)!;
    expect(docs.description.toLowerCase()).toContain('endpoint path');
    expect(docs.description).toContain('"evm/dexes"');
    expect(docs.description.toLowerCase()).not.toContain('alias');
    expect(docs.description).toContain('guides/<slug>');
    expect(docs.description).toContain('guides/x402');
    expect(docs.description).toContain('query only');
    expect(docs.description).toContain('defaults to the request schema');
    expect(docs.description).toContain('response fields');
    expect(docs.description).toContain('examples and all endpoint prose');
    expect(docs.inputSchema.properties).toHaveProperty('tool_name');
    expect(docs.inputSchema.properties.detail).toMatchObject({
      type: 'string',
      enum: ['schema', 'response', 'full'],
      default: 'schema',
    });
    expect(docs.inputSchema.properties.detail.description)
      .toContain('Response detail also includes the OpenAPI request schema');
  });
});

const ROOT_INDEX_SAMPLE = [
  '# Cambrian API Documentation',
  '- GET /solana/price-current - Get the current token price.',
  '- GET /evm/dexes - List EVM exchanges.',
].join('\n');

// D1 regression. The offline fallback used to come from `cambrian/metadata`,
// which ships on that package's release cadence. By 1.3.1 it had drifted: no
// `chain_id` numericEnum (so zero Ethereum tools projected), no exclusive
// numeric bounds, `token_address` where the API had renamed to
// `token_addresses`, and six Solana endpoints the API no longer serves. Every
// one of these is silent -- the server starts, lists tools, and answers wrong.
// These assertions pin the shipped snapshot against each of those symptoms.
// Toolsets: the context lever that costs nothing when unused. Defaulting to
// the whole catalog keeps existing clients byte-identical; a client that names
// its toolsets pays only for what it will call.
// D4. `cambrian/schema` parses the live OpenAPI at runtime, and the published
// 1.3.1 parser drops `exclusiveMinimum`/`exclusiveMaximum` entirely. The live
// path normally wins over the bundled snapshot, so a correct snapshot is not
// enough: without a restore step, `entry_price: 0` sails past validation and
// comes back as a raw upstream 422 with no reason, parameter, or docs hint.
describe('exclusive bounds survive a lossy runtime parser', () => {
  // Same registry with both exclusive bounds stripped -- what the published
  // `cambrian/schema` actually returns from a successful live fetch.
  const lossy = () => {
    const metadata = structuredClone(OFFLINE_REGISTRY) as Record<string, {
      spec: Record<string, { params: Record<string, { exclusiveMin?: number; exclusiveMax?: number }> }>;
    }>;
    for (const group of Object.values(metadata)) {
      for (const endpoint of Object.values(group.spec)) {
        for (const param of Object.values(endpoint.params)) {
          delete param.exclusiveMin;
          delete param.exclusiveMax;
        }
      }
    }
    return metadata as unknown as typeof OFFLINE_REGISTRY;
  };

  it('strips them from the fixture, so the test is not vacuous', () => {
    const stripped = listRuntimeTools(lossy())
      .flatMap((tool) => tool.params)
      .filter((param) => {
        const spec = param.spec as { exclusiveMin?: number; exclusiveMax?: number };
        return spec.exclusiveMin !== undefined || spec.exclusiveMax !== undefined;
      });
    expect(stripped).toEqual([]);
  });

  it('restores them from the bundled snapshot and still rejects the bad value', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({ apiKey: 'test', metadataProvider: async () => lossy() });
    const client = new Client({ name: 'lossy-parser-test', version: '1.0.0' }, { capabilities: {} });
    const callCount = calls.length;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const risk = (await client.listTools()).tools
        .find((tool) => tool.name === 'cambrian_risk_perp_risk_engine');
      expect(risk?.inputSchema.properties?.entry_price).toMatchObject({ exclusiveMinimum: 0 });

      const result = await client.callTool({
        name: 'cambrian_risk_perp_risk_engine',
        arguments: {
          token_address: 'So11111111111111111111111111111111111111112',
          entry_price: 0,
          leverage: 10,
          direction: 'long',
          risk_horizon: '1d',
        },
      });
      const error = JSON.parse((result.content as Array<{ text: string }>)[0].text).error;
      expect(error.reason).toBe('BELOW_MINIMUM');
      expect(error.parameter).toBe('entry_price');
      expect(error.expected).toMatchObject({ exclusiveMinimum: 0 });
      // Rejected locally: no upstream request was spent on a value we knew was bad.
      expect(calls).toHaveLength(callCount);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe('toolsets', () => {
  const listFor = async (toolsets?: string[]) => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      metadataProvider: async () => OFFLINE_REGISTRY,
      ...(toolsets ? { toolsets: toolsets as never } : {}),
    });
    const client = new Client({ name: 'toolset-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      return (await client.listTools()).tools;
    } finally {
      await client.close();
      await server.close();
    }
  };

  it('parses lists, rejects unknown names, and treats empty/all as no filter', () => {
    expect(parseToolsets('solana,risk')).toEqual(['solana', 'risk']);
    expect(parseToolsets(' solana , evm ')).toEqual(['solana', 'evm']);
    expect(parseToolsets(undefined)).toEqual([]);
    expect(parseToolsets('')).toEqual([]);
    expect(parseToolsets('all')).toEqual([]);
    expect(() => parseToolsets('solana,bogus')).toThrow('Unknown toolset(s): bogus');
  });

  it('serves the whole catalog by default', async () => {
    const names = (await listFor()).map((tool) => tool.name);
    expect(names.some((name) => name.startsWith('cambrian_solana_'))).toBe(true);
    expect(names.some((name) => name.startsWith('cambrian_base_'))).toBe(true);
    expect(names.some((name) => name.startsWith('cambrian_ethereum_'))).toBe(true);
    expect(names.some((name) => name.startsWith('cambrian_deep42_'))).toBe(true);
  });

  it('drops the other toolsets and shrinks the payload', async () => {
    const all = await listFor();
    const solana = await listFor(['solana']);
    const names = solana.map((tool) => tool.name);
    expect(names.some((name) => name.startsWith('cambrian_solana_'))).toBe(true);
    for (const prefix of ['cambrian_base_', 'cambrian_ethereum_', 'cambrian_deep42_', 'cambrian_risk_']) {
      expect(names.filter((name) => name.startsWith(prefix))).toEqual([]);
    }
    expect(JSON.stringify(solana).length).toBeLessThan(JSON.stringify(all).length / 2);
  });

  it('keeps evm meaning both Base and Ethereum', async () => {
    const names = (await listFor(['evm'])).map((tool) => tool.name);
    expect(names.some((name) => name.startsWith('cambrian_base_'))).toBe(true);
    expect(names.some((name) => name.startsWith('cambrian_ethereum_'))).toBe(true);
    expect(names.filter((name) => name.startsWith('cambrian_solana_'))).toEqual([]);
  });

  it('always keeps cambrian_docs so a narrowed client can still discover the rest', async () => {
    const names = (await listFor(['risk'])).map((tool) => tool.name);
    expect(names).toContain(DOCS_TOOL_NAME);
  });
});

describe('bundled offline registry', () => {
  const tools = projectEvmTools(listRuntimeTools(OFFLINE_REGISTRY));
  const named = (name: string) => tools.find((tool) => tool.name === name);

  it('projects the Ethereum mirror of the Base tools', () => {
    expect(tools.filter((tool) => tool.name.startsWith('cambrian_ethereum_')).length)
      .toBeGreaterThanOrEqual(29);
  });

  it('projects a single-chain EVM endpoint to that chain only', () => {
    // SparkLend appeared in the API on 2026-08-28 declaring chain_id min=max=1
    // (Ethereum only, no numericEnum). Projecting a Base twin would advertise a
    // chain the endpoint rejects, so only the Ethereum tool may exist.
    const source = listRuntimeTools(OFFLINE_REGISTRY)
      .find((tool) => tool.name === 'cambrian_base_lending_morpho_markets');
    if (!source) throw new Error('fixture tool missing from snapshot');
    const ethereumOnly = {
      ...source,
      name: 'cambrian_base_single_chain_probe',
      params: source.params.map((param) => param.name === 'chain_id'
        ? { ...param, spec: { ...param.spec, numericEnum: undefined, min: 1, max: 1, default: 1 } }
        : param),
    };

    const names = projectEvmTools([ethereumOnly] as never).map((tool) => tool.name);

    expect(names).toEqual(['cambrian_ethereum_single_chain_probe']);
  });

  it('carries exclusive numeric bounds', () => {
    const bounded = tools.flatMap((tool) => tool.params).filter((param) =>
      (param.spec as { exclusiveMin?: number; exclusiveMax?: number }).exclusiveMin !== undefined ||
      (param.spec as { exclusiveMin?: number; exclusiveMax?: number }).exclusiveMax !== undefined);
    expect(bounded.length).toBeGreaterThan(0);
  });

  it('uses the current Solana price-current parameter name', () => {
    const params = named('cambrian_solana_price_current')?.params.map((param) => param.name);
    expect(params).toContain('token_addresses');
    expect(params).not.toContain('token_address');
  });

  it('has no endpoints the API has retired', () => {
    for (const retired of [
      'cambrian_solana_price_multi',
      'cambrian_solana_price_volume_single',
      'cambrian_solana_price_volume_multi',
      'cambrian_solana_token_details_multi',
      'cambrian_solana_orca_pool_multi',
      'cambrian_solana_meteora_dlmm_pool_multi',
    ]) expect(named(retired)).toBeUndefined();
    expect(named('cambrian_solana_price_volume')).toBeDefined();
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

  it('falls back to root when the endpoint document returns JSON', async () => {
    const url = `${DOCS_BASE_URL}/solana/foo/llms.txt`;
    const fetchFn = mockFetch({
      [url]: { body: '{"error":"not found"}', contentType: 'application/json' },
      [DOCS_ROOT_URL]: { body: 'solana/foo - something\nother line' },
    });

    const out = await fetchDocumentationForTest(fetchFn, { path: 'solana/foo' });

    expect(out).not.toContain('"error"');
    expect(out).toContain('solana/foo - something');
  });

  it('returns the root index when no path is given', async () => {
    const fetchFn = mockFetch({ [DOCS_ROOT_URL]: { body: 'ROOT DOCS INDEX' } });
    const out = await fetchDocumentationForTest(fetchFn, {});
    expect(out).toContain('ROOT DOCS INDEX');
  });

  // A miss on an explicit path must not dump the whole root index back to the
  // agent. `guides/<slug>` is the only path shape that reaches this branch (an
  // unknown endpoint path is rejected earlier), and the live root index is
  // ~25 kB / ~6 k tokens, returned with no error and no signal it was a miss.
  it('reports a miss instead of returning the whole root index', async () => {
    const fetchFn = mockFetch({ [DOCS_ROOT_URL]: { body: ROOT_INDEX_SAMPLE } });

    const out = await fetchDocumentationForTest(fetchFn, { path: 'guides/does-not-exist' });

    expect(out).not.toContain('- GET /solana/price-current');
    expect(out).toMatch(/no documentation/i);
    expect(out.length).toBeLessThan(200);
  });

  it('finds concise endpoint entries by query', async () => {
    const fetchFn = mockFetch({
      [DOCS_ROOT_URL]: {
        body: [
          '- GET /api/v1/solana/price-current - Get the current token price.',
          '- GET /api/v1/solana/tokens - List Solana tokens.',
          '- GET /api/v1/evm/dexes - List EVM exchanges.',
        ].join('\n'),
      },
    });

    const out = await fetchDocumentationForTest(fetchFn, { query: 'current Solana token price' });

    expect(out).toContain('solana/price-current');
    expect(out).not.toContain('evm/dexes');
  });

  it('reports a miss for a query whose fragments only substring-match', async () => {
    const fetchFn = mockFetch({
      [DOCS_ROOT_URL]: {
        body: [
          '- GET /api/v1/solana/tokens - Returns known tokens. Note: paginated.',
          '- GET /api/v1/evm/dexes - List EVM exchanges such as Uniswap.',
        ].join('\n'),
      },
    });

    // "no" substring-matches "known"/"Note" and "such" appears mid-sentence;
    // whole-word scoring must not turn those fragments into endpoint matches.
    const out = await fetchDocumentationForTest(fetchFn, { query: 'zzz-no-such-topic-zzz' });

    expect(out).toBe('No matching endpoints found.');
  });

  it('rejects documentation requests that send path and query together', async () => {
    const fetchFn = mockFetch({});

    await expect(fetchDocumentationForTest(fetchFn, {
      path: 'solana/price-current',
      query: 'current token price',
    })).rejects.toThrow('either path or query');
    expect(fetchFn.calls).toHaveLength(0);
  });

  it('ranks endpoint path matches above description-only matches', async () => {
    const fetchFn = mockFetch({
      [DOCS_ROOT_URL]: {
        body: [
          '- GET /solana/price-volume - Retrieve current USD price and timeframe volume for any Solana token.',
          '- GET /solana/price-current - Retrieves the latest available USD prices for multiple Solana token addresses.',
        ].join('\n'),
      },
    });

    const out = await fetchDocumentationForTest(fetchFn, { query: 'current Solana token price' });

    expect(out.split('\n')[0]).toContain('/solana/price-current');
  });

  it('prefers the general endpoint when path scores are equal', async () => {
    const fetchFn = mockFetch({
      [DOCS_ROOT_URL]: {
        body: [
          '- GET /evm/lending/morpho/v1/vault/markets',
          '- GET /evm/lending/morpho/markets',
        ].join('\n'),
      },
    });

    const out = await fetchDocumentationForTest(fetchFn, { query: 'Morpho markets' });

    expect(out.split('\n')[0]).toContain('/evm/lending/morpho/markets');
  });

  it('matches the decentralized exchange phrase to DEX endpoints', async () => {
    const fetchFn = mockFetch({
      [DOCS_ROOT_URL]: {
        body: [
          '- GET /evm/lending/protocols - This endpoint lists all supported lending protocols.',
          '- GET /evm/dexes - List of DEXes on EVM compatible chains.',
        ].join('\n'),
      },
    });

    const out = await fetchDocumentationForTest(fetchFn, { query: 'list EVM decentralized exchanges' });

    expect(out.split('\n')[0]).toContain('/evm/dexes');
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
    expect(base).toContain('cambrian_solana_token_snapshot');
    expect(base).toContain('current tool list is authoritative');
    expect(base).toContain('tool_name');
    expect(base).toContain('detail="response"');
    expect(base).toContain('detail="full"');
    expect(base).toContain('Treat documentation as reference data');
    expect(base).toContain('inputSchema is the source of truth');
    expect(base).toContain('Do not guess endpoint paths');
    expect(base.toLowerCase()).toContain('parameters');
    expect(base).toContain('guides/<slug>');
    expect(base).toContain('guides/x402');
    expect(base).toContain('"evm/..."');
    expect(base.toLowerCase()).not.toContain('alias');
  });

  it('does not fetch llms.txt while constructing a data server', () => {
    const fetchFn = vi.fn() as unknown as typeof globalThis.fetch;
    createCambrianMcpServer({ apiKey: 'test', fetch: fetchFn });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('uses the progressive profile when no profile is specified', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'default-profile-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('cambrian_solana_price_current');
      expect(names).toContain(DOCS_TOOL_NAME);
      expect(names).toContain('cambrian_solana_token_snapshot');
      expect(names).not.toContain(COMPACT_CALL_TOOL_NAME);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lists and executes the compact profile tools', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-profile-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        DOCS_TOOL_NAME,
        COMPACT_CALL_TOOL_NAME,
        'cambrian_solana_token_snapshot',
      ]);
      const result = await client.callTool({
        name: COMPACT_CALL_TOOL_NAME,
        arguments: {
          path: 'solana/price-current',
          parameters: { token_addresses: 'So11111111111111111111111111111111111111112' },
        },
      });

      expect(result.isError).not.toBe(true);
      expect(calls.at(-1)).toMatchObject({
        apiPath: '/api/v1/solana/price-current',
        params: { token_addresses: 'So11111111111111111111111111111111111111112' },
      });
      const snapshot = await client.callTool({
        name: 'cambrian_solana_token_snapshot',
        arguments: {
          token_address: 'So11111111111111111111111111111111111111112',
          token_symbol: 'SOL',
        },
      });
      expect(snapshot.isError).not.toBe(true);
      const legacyTool = await client.callTool({
        name: 'cambrian_solana_price_current',
        arguments: { token_addresses: 'So11111111111111111111111111111111111111112' },
      });
      expect(legacyTool.isError).not.toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lists direct endpoint tools and loads optional fields on demand in the progressive profile', async () => {
    const fetchFn = mockFetch({
      [`${DOCS_BASE_URL}/solana/tokens/holders/llms.txt`]: {
        body: '# Token holders\nOptional parameter: limit.',
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'progressive',
      fetch: fetchFn,
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'progressive-profile-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = (await client.listTools()).tools;
      const holders = tools.find((tool) => tool.name === 'cambrian_solana_tokens_holders')!;
      expect(holders.inputSchema.properties).toHaveProperty('program_id');
      expect(holders.inputSchema.properties).toHaveProperty('limit', {
        type: 'integer',
        maximum: 1000,
      });
      expect(holders).not.toHaveProperty('description');
      expect(holders.inputSchema.properties.program_id).not.toHaveProperty('description');
      expect(holders.inputSchema.properties.program_id).not.toHaveProperty('pattern');
      expect(tools.find((tool) => tool.name === 'cambrian_base_dexes')?.inputSchema.properties)
        .not.toHaveProperty('chain_id');
      const aeroPool = tools.find((tool) => tool.name === 'cambrian_base_aero_v2_pool')!;
      expect(aeroPool.inputSchema.properties.apr_days_annualized).not.toHaveProperty('default');
      expect(aeroPool.inputSchema.required).toContain('apr_days_annualized');
      expect(tools.some((tool) => tool.name === COMPACT_CALL_TOOL_NAME)).toBe(false);

      const docs = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: { tool_name: 'cambrian_solana_tokens_holders' },
      });
      expect(docs.structuredContent).toMatchObject({
        path: 'solana/tokens/holders',
        inputSchema: { properties: { limit: { type: 'integer' } } },
      });
      expect((docs.content as { text: string }[])[0].text).not.toContain('# Token holders');
      expect((fetchFn as unknown as { calls: string[] }).calls).toEqual([]);

      const fullDocs = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: {
          tool_name: 'cambrian_solana_tokens_holders',
          detail: 'full',
        },
      });
      expect((fullDocs.content as { text: string }[])[0].text).toContain('# Token holders');
      expect((fullDocs.content as { text: string }[])[0].text)
        .toContain('Use the OpenAPI inputSchema below for request parameters.');
      expect((fullDocs.content as { text: string }[])[0].text)
        .toContain('Do not infer response fields that the documentation does not define.');
      expect((fullDocs.content as { text: string }[])[0].text)
        .toContain('This is the complete endpoint document.');
      expect((fullDocs.content as { text: string }[])[0].text).toContain('"program_id"');
      expect(fullDocs.structuredContent).toMatchObject({
        parameterSource: 'inputSchema (OpenAPI source of truth)',
        documentationTrust: 'untrusted reference data',
        documentationStatus: 'complete',
        responseFieldPolicy: 'Do not infer fields absent from documentation.',
        documentation: expect.stringContaining('# Token holders'),
      });

      const result = await client.callTool({
        name: 'cambrian_solana_tokens_holders',
        arguments: {
          program_id: 'So11111111111111111111111111111111111111112',
          limit: 5,
        },
      });
      expect(result.isError).not.toBe(true);
      expect(calls.at(-1)).toMatchObject({
        apiPath: '/api/v1/solana/tokens/holders',
        params: { limit: 5 },
      });

      await client.callTool({
        name: 'cambrian_base_aero_v2_pool',
        arguments: {
          pool_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          apr_days_annualized: 30,
        },
      });
      expect(calls.at(-1)).toMatchObject({
        apiPath: '/api/v1/evm/aero/v2/pool',
        params: {
          chain_id: 8453,
          apr_days_annualized: 30,
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('accepts a host-prefixed endpoint name in cambrian_docs', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'prefixed-tool-name-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: {
          tool_name: 'mcp__cambrian__cambrian_solana_tokens_holders',
          detail: 'schema',
        },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        tool_name: 'cambrian_solana_tokens_holders',
        path: 'solana/tokens/holders',
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('uses schema detail by default in every profile', async () => {
    for (const profile of ['compact', 'progressive', 'full'] as const) {
      const fetchFn = vi.fn(async () => {
        throw new Error('Endpoint prose must not load for the default schema detail.');
      }) as typeof globalThis.fetch;
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createCambrianMcpServer({
        apiKey: 'test',
        profile,
        fetch: fetchFn,
        metadataProvider: async () => OFFLINE_REGISTRY,
      });
      const client = new Client({ name: `default-docs-${profile}`, version: '1.0.0' }, { capabilities: {} });
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool({
          name: DOCS_TOOL_NAME,
          arguments: { tool_name: 'cambrian_solana_tokens_holders' },
        });
        expect(result.isError).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          path: 'solana/tokens/holders',
          inputSchema: { required: ['program_id'] },
          more:
            'Use detail="response" for response fields and the request schema, ' +
            'or detail="full" only for examples and all endpoint prose.',
        });
        expect(result.structuredContent).not.toHaveProperty('documentation');
        expect(fetchFn).not.toHaveBeenCalled();
      } finally {
        await client.close();
        await server.close();
      }
    }
  });

  it('returns response fields without unrelated endpoint prose', async () => {
    const fetchFn = mockFetch({
      [`${DOCS_BASE_URL}/solana/tokens/holders/llms.txt`]: {
        body: [
          '## Business Value',
          'Long business description.',
          '',
          '## Response Field Descriptions',
          '',
          '| Response Field | Type | Description |',
          '| account | string | Holder account. |',
          '| balanceUi | number | Token balance. |',
          '',
          '## Examples',
          'Large response example.',
          '',
          '## x402 Payment Option',
          'Payment setup.',
        ].join('\n'),
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'progressive',
      fetch: fetchFn,
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'response-docs-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: {
          tool_name: 'cambrian_solana_tokens_holders',
          detail: 'response',
        },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        path: 'solana/tokens/holders',
        documentationScope: 'response',
        documentationStatus: 'complete',
        documentation: expect.stringContaining('| account | string | Holder account. |'),
        inputSchema: { required: ['program_id'] },
      });
      const text = JSON.stringify(result.structuredContent);
      expect(text).not.toContain('Business Value');
      expect(text).not.toContain('Large response example');
      expect(text).not.toContain('Payment setup');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('resolves an indexed Risk API path to its canonical documentation page', async () => {
    const canonicalUrl = `${DOCS_BASE_URL}/perp-risk-engine/llms.txt`;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      fetch: mockFetch({
        [canonicalUrl]: {
          body: '# Perp risk\n## Response Field Descriptions\n- `liquidation_probability`: Estimated probability.',
        },
      }),
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'risk-doc-path-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: { path: 'risk/perp-risk-engine', detail: 'response' },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        path: 'perp-risk-engine',
        documentationScope: 'response',
        documentationStatus: 'complete',
      });
      expect(result.structuredContent?.documentation).toContain('liquidation_probability');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns a corrective structured error when an argument exceeds its maximum', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'corrective-error-test', version: '1.0.0' }, { capabilities: {} });
    const callCount = calls.length;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: 'cambrian_solana_holder_token_balances',
        arguments: { wallet_address: '0xabc', limit: 1001 },
      });
      const expectedError = {
        code: 'BAD_REQUEST',
        reason: 'ABOVE_MAXIMUM',
        message: 'Parameter "limit" must be at most 1000.',
        status: 400,
        retryable: false,
        tool: 'cambrian_solana_holder_token_balances',
        parameter: 'limit',
        received: 1001,
        expected: {
          type: 'integer',
          description: 'Limit the number of results.',
          default: 10,
          minimum: 1,
          maximum: 1000,
        },
        docs: {
          tool_name: 'cambrian_solana_holder_token_balances',
          detail: 'schema',
        },
      };

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ error: expectedError });
      expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ error: expectedError });
      expect(calls).toHaveLength(callCount);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns the allowed values when an array item is invalid', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'array-error-test', version: '1.0.0' }, { capabilities: {} });
    const callCount = calls.length;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: 'cambrian_base_alien_v3_pools',
        arguments: { order_asc: ['notAColumn'] },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: 'BAD_REQUEST',
          reason: 'INVALID_ARRAY_ITEM',
          tool: 'cambrian_base_alien_v3_pools',
          parameter: 'order_asc',
          received: 'notAColumn',
          expected: {
            type: 'array',
            items: { type: 'string', enum: expect.arrayContaining(['poolAddress', 'createdAt']) },
          },
        },
      });
      expect(calls).toHaveLength(callCount);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns actionable validation errors for every local constraint class', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'validation-matrix-test', version: '1.0.0' }, { capabilities: {} });
    const callCount = calls.length;
    const cases = [
      {
        name: 'cambrian_solana_holder_token_balances',
        arguments: {},
        reason: 'MISSING_REQUIRED',
        parameter: 'wallet_address',
      },
      {
        name: 'cambrian_solana_holder_token_balances',
        arguments: { wallet_address: '0xabc', unexpected: true },
        reason: 'UNKNOWN_PARAMETER',
        parameter: 'unexpected',
      },
      {
        name: 'cambrian_solana_holder_token_balances',
        arguments: { wallet_address: '0xabc', limit: 'many' },
        reason: 'INVALID_TYPE',
        parameter: 'limit',
      },
      {
        name: 'cambrian_deep42_social_data_token_analysis',
        arguments: { token_symbol: { invalid: true } },
        reason: 'INVALID_TYPE',
        parameter: 'token_symbol',
      },
      {
        name: 'cambrian_solana_trending_tokens',
        arguments: { order_by: 'not-a-field' },
        reason: 'INVALID_ENUM',
        parameter: 'order_by',
      },
      {
        name: 'cambrian_solana_holder_token_balances',
        arguments: { wallet_address: '0xabc', limit: 0 },
        reason: 'BELOW_MINIMUM',
        parameter: 'limit',
      },
      {
        name: 'cambrian_solana_price_current',
        arguments: { token_addresses: 'not-an-address' },
        reason: 'PATTERN_MISMATCH',
        parameter: 'token_addresses',
      },
    ] as const;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      for (const scenario of cases) {
        const result = await client.callTool({ name: scenario.name, arguments: scenario.arguments });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: 'BAD_REQUEST',
            reason: scenario.reason,
            tool: scenario.name,
            parameter: scenario.parameter,
            retryable: false,
            docs: { tool_name: scenario.name, detail: 'schema' },
          },
        });
        if (scenario.reason === 'MISSING_REQUIRED') {
          expect(result.structuredContent).toMatchObject({ error: { received: null } });
        }
      }
      expect(calls).toHaveLength(callCount);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('advertises and enforces exclusive numeric bounds', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'exclusive-bound-test', version: '1.0.0' }, { capabilities: {} });
    const callCount = calls.length;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const tools = await client.listTools();
      const risk = tools.tools.find((tool) => tool.name === 'cambrian_risk_perp_risk_engine');
      expect(risk?.inputSchema.properties?.entry_price).toMatchObject({ exclusiveMinimum: 0 });

      const result = await client.callTool({
        name: 'cambrian_risk_perp_risk_engine',
        arguments: {
          token_address: 'So11111111111111111111111111111111111111112',
          entry_price: 0,
          leverage: 10,
          direction: 'long',
          risk_horizon: '1d',
        },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: 'BAD_REQUEST',
          reason: 'BELOW_MINIMUM',
          parameter: 'entry_price',
          expected: { type: 'number', exclusiveMinimum: 0 },
        },
      });
      expect((result.structuredContent as { error: { message: string } }).error.message)
        .toContain('must be greater than 0');
      expect(calls).toHaveLength(callCount);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('uses the same endpoint validator in compact and full profiles', async () => {
    const callCount = calls.length;
    for (const profile of ['compact', 'full'] as const) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createCambrianMcpServer({
        apiKey: 'test',
        profile,
        metadataProvider: async () => OFFLINE_REGISTRY,
      });
      const client = new Client({ name: `${profile}-validation-test`, version: '1.0.0' }, { capabilities: {} });
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        const result = await client.callTool(profile === 'compact' ? {
          name: COMPACT_CALL_TOOL_NAME,
          arguments: {
            path: 'solana/holder-token-balances',
            parameters: { wallet_address: '0xabc', limit: 1001 },
          },
        } : {
          name: 'cambrian_solana_holder_token_balances',
          arguments: { wallet_address: '0xabc', limit: 1001 },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
          error: {
            code: 'BAD_REQUEST',
            reason: 'ABOVE_MAXIMUM',
            tool: 'cambrian_solana_holder_token_balances',
            parameter: 'limit',
            expected: { maximum: 1000 },
          },
        });
      } finally {
        await client.close();
        await server.close();
      }
    }
    expect(calls).toHaveLength(callCount);
  });

  it('corrects an invalid compact call wrapper before endpoint validation', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-wrapper-test', version: '1.0.0' }, { capabilities: {} });
    const callCount = calls.length;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: COMPACT_CALL_TOOL_NAME,
        arguments: {
          method: 'GET',
          path: 'solana/tokens/holders',
          params: {
            program_id: 'So11111111111111111111111111111111111111112',
            limit: 1001,
          },
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        error: {
          code: 'BAD_REQUEST',
          reason: 'INVALID_CALL_SHAPE',
          tool: COMPACT_CALL_TOOL_NAME,
          parameter: 'parameters',
          received: ['method', 'path', 'params'],
          expected: {
            required: ['path'],
            properties: {
              path: { type: 'string' },
              parameters: { type: 'object' },
            },
          },
        },
      });
      expect(calls).toHaveLength(callCount);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('defers endpoint metadata during tool listing and documentation search', async () => {
    const metadataProvider = vi.fn(async () => OFFLINE_REGISTRY);
    const fetchFn = mockFetch({
      [DOCS_ROOT_URL]: { body: '- GET /solana/price-current - Get the current token price.' },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({ apiKey: 'test', profile: 'compact', fetch: fetchFn, metadataProvider });
    const client = new Client({ name: 'compact-deferral-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      await client.listTools();
      await client.callTool({ name: DOCS_TOOL_NAME, arguments: { query: 'current token price' } });

      expect(metadataProvider).not.toHaveBeenCalled();

      await client.callTool({
        name: COMPACT_CALL_TOOL_NAME,
        arguments: {
          path: 'solana/price-current',
          parameters: { token_addresses: 'So11111111111111111111111111111111111111112' },
        },
      });
      expect(metadataProvider).toHaveBeenCalledOnce();
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('includes the runtime input schema with compact endpoint documentation', async () => {
    const fetchFn = mockFetch({
      [DOCS_ROOT_URL]: { body: '- GET /risk/perp-risk-engine - Calculate liquidation risk.' },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      fetch: fetchFn,
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-doc-schema-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: { path: 'risk/perp-risk-engine' },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        path: 'perp-risk-engine',
        inputSchema: {
          properties: {
            token_address: { type: 'string' },
            entry_price: { type: 'number' },
            direction: { type: 'string', pattern: '^(long|short)$' },
          },
        },
      });
      expect(result.structuredContent).not.toHaveProperty('inputSchema.properties._maxResponseLength');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns the runtime schema when endpoint prose and the root index are unavailable', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      fetch: mockFetch({}),
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-doc-outage-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: { path: 'risk/perp-risk-engine', detail: 'full' },
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        path: 'perp-risk-engine',
        inputSchema: { properties: { direction: { pattern: '^(long|short)$' } } },
      });
      expect((result.content as { text: string }[])[0].text).toContain('prose documentation is unavailable');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('searches runtime metadata when the root documentation index is unavailable', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      fetch: mockFetch({}),
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-index-outage-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: { query: 'current Solana token price' },
      });

      expect(result.isError).not.toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain('/solana/price-current');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('searches runtime metadata when the root documentation index returns JSON', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      fetch: mockFetch({
        [DOCS_ROOT_URL]: { body: '{"error":"temporary"}', contentType: 'application/json' },
      }),
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-index-json-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: { query: 'current Solana token price' },
      });

      expect(result.isError).not.toBe(true);
      expect((result.content as { text: string }[])[0].text).toContain('/solana/price-current');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('returns a concise directory for a compact docs call without path or query', async () => {
    const root = [
      '- FAQs: https://docs.cambrian.org/guides/faqs/llms.txt',
      '- MCP: https://docs.cambrian.org/guides/mcp/llms.txt',
      '- GET /solana/price-current - A very long endpoint description that compact discovery does not need.',
      '- GET /evm/dexes - Another long endpoint description that compact discovery does not need.',
      '- GET /risk/perp-risk-engine - Another long endpoint description that compact discovery does not need.',
    ].join('\n');
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      fetch: mockFetch({ [DOCS_ROOT_URL]: { body: root } }),
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-directory-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({ name: DOCS_TOOL_NAME, arguments: {} });
      const text = (result.content as { text: string }[])[0].text;

      expect(text).toContain('3 endpoints');
      expect(text).toContain('solana (1)');
      expect(text).toContain('evm (1)');
      expect(text).toContain('risk (1)');
      expect(text).toContain('guides/faqs');
      expect(text).toContain('guides/mcp');
      expect(text).toContain('/solana/price-current');
      expect(text).toContain('/evm/dexes');
      expect(text).toContain('/risk/perp-risk-engine');
      expect(text).toContain('complete group and guide directory');
      expect(text).toContain('query');
      expect(text).not.toContain('very long endpoint description');
      expect(text.length).toBeLessThan(5_000);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects endpoint pattern violations before a compact call reaches the API', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-validation-test', version: '1.0.0' }, { capabilities: {} });
    const callCount = calls.length;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: COMPACT_CALL_TOOL_NAME,
        arguments: {
          path: 'solana/price-current',
          parameters: { token_addresses: 'not-a-solana-address' },
        },
      });

      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(callCount);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects unsupported EVM chain IDs before a compact call reaches the API', async () => {
    const metadata = {
      ...OFFLINE_REGISTRY,
      base: {
        ...OFFLINE_REGISTRY.base,
        resources: ['dexes'],
        spec: {
          dexes: {
            apiPath: '/api/v1/evm/dexes',
            method: 'GET',
            params: {
              chain_id: {
                required: false,
                type: 'integer',
                numericEnum: [1, 8453],
                default: 8453,
                strict: true,
              },
            },
          },
        },
      },
    } as unknown as typeof OFFLINE_REGISTRY;
    const fetchFn = mockFetch({
      [`${DOCS_BASE_URL}/evm/dexes/llms.txt`]: { body: '# GET /evm/dexes' },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      fetch: fetchFn,
      metadataProvider: async () => metadata,
    });
    const client = new Client({ name: 'compact-chain-test', version: '1.0.0' }, { capabilities: {} });
    const callCount = calls.length;
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const docs = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: { path: 'evm/dexes' },
      });
      expect(docs.structuredContent).toMatchObject({
        inputSchema: { properties: { chain_id: { enum: [1, 8453] } } },
      });
      const result = await client.callTool({
        name: COMPACT_CALL_TOOL_NAME,
        arguments: { path: 'evm/dexes', parameters: { chain_id: 10 } },
      });

      expect(result.isError).toBe(true);
      expect(calls).toHaveLength(callCount);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('executes compact calls across EVM, Deep42, and Risk paths', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-groups-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const results = [
        await client.callTool({
          name: COMPACT_CALL_TOOL_NAME,
          arguments: { path: 'evm/dexes', parameters: { chain_id: 8453 } },
        }),
        await client.callTool({
          name: COMPACT_CALL_TOOL_NAME,
          arguments: { path: 'deep42/social-data/sentiment-shifts', parameters: { limit: 2 } },
        }),
        await client.callTool({
          name: COMPACT_CALL_TOOL_NAME,
          arguments: {
            path: 'risk/perp-risk-engine',
            parameters: {
              token_address: 'So11111111111111111111111111111111111111112',
              entry_price: 150,
              leverage: 5,
              direction: 'long',
              risk_horizon: '1d',
            },
          },
        }),
      ];

      expect(results.every((result) => result.isError !== true)).toBe(true);
      expect(calls.slice(-3)).toMatchObject([
        { client: 'opabinia', apiPath: '/api/v1/evm/dexes', params: { chain_id: 8453 } },
        { client: 'deep42', apiPath: '/api/v1/deep42/social-data/sentiment-shifts', params: { limit: 2 } },
        { client: 'risk', apiPath: '/api/v1/perp-risk-engine', params: { leverage: 5 } },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('reports the unknown endpoint path in a compact call error', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-path-error-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: COMPACT_CALL_TOOL_NAME,
        arguments: { path: 'solana/not-an-endpoint' },
      });
      const text = (result.content as { text: string }[])[0].text;

      expect(result.isError).toBe(true);
      expect(text).toContain('Unknown endpoint path: solana/not-an-endpoint');
      expect(text).toContain('query only');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects an unknown compact documentation path before returning the root index', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'compact',
      fetch: mockFetch({
        [DOCS_ROOT_URL]: { body: '- GET /solana/tokens/holders - Get current holders.' },
      }),
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'compact-unknown-doc-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const result = await client.callTool({
        name: DOCS_TOOL_NAME,
        arguments: { path: 'solana/token-holders' },
      });
      const text = (result.content as { text: string }[])[0].text;

      expect(result.isError).toBe(true);
      expect(text).toContain('Unknown endpoint path: solana/token-holders');
      expect(text).toContain('query only');
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('lists and executes tools from validated runtime metadata', async () => {
    const resource = 'social-data/new-signal';
    const metadata = {
      ...OFFLINE_REGISTRY,
      deep42: {
        ...OFFLINE_REGISTRY.deep42,
        resources: [...OFFLINE_REGISTRY.deep42.resources, resource],
        spec: {
          ...OFFLINE_REGISTRY.deep42.spec,
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
      profile: 'full',
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

  it('lists and executes chain-specific Base and Ethereum tools', async () => {
    const metadata = {
      ...OFFLINE_REGISTRY,
      base: {
        ...OFFLINE_REGISTRY.base,
        resources: ['tokens', 'aero-v2-pools'],
        spec: {
          tokens: {
            apiPath: '/api/v1/evm/tokens',
            method: 'GET',
            params: {
              chain_id: {
                required: false,
                type: 'integer',
                numericEnum: [1, 8453],
                default: 8453,
                strict: true,
              },
            },
          },
          'aero-v2-pools': {
            apiPath: '/api/v1/evm/aero/v2/pools',
            method: 'GET',
            params: {
              chain_id: {
                required: false,
                type: 'integer',
                min: 8453,
                max: 8453,
                default: 8453,
                strict: true,
              },
            },
          },
        },
      },
    } as unknown as typeof OFFLINE_REGISTRY;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({ apiKey: 'test', profile: 'full', metadataProvider: async () => metadata });
    const client = new Client({ name: 'ethereum-tools-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain('cambrian_base_tokens');
      expect(names).toContain('cambrian_ethereum_tokens');
      expect(names).not.toContain('cambrian_ethereum_aero_v2_pools');

      await client.callTool({ name: 'cambrian_base_tokens', arguments: {} });
      await client.callTool({ name: 'cambrian_ethereum_tokens', arguments: {} });
      expect(calls.slice(-2)).toMatchObject([
        { apiPath: '/api/v1/evm/tokens', params: { chain_id: 8453 } },
        { apiPath: '/api/v1/evm/tokens', params: { chain_id: 1 } },
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('falls back to bundled tools when runtime metadata loading fails', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      profile: 'full',
      metadataProvider: async () => { throw new Error('registry unavailable'); },
    });
    const client = new Client({ name: 'metadata-fallback-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(listMcpTools().length);
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
    const openApiDocument = (url: string): Record<string, unknown> => {
      if (url.includes('/deep42/')) return {
        openapi: '3.1.0',
        info: { title: 'Deep42', version: '1' },
        paths: { '/api/v1/deep42/social-data/new-signal': { get: { parameters: [] } } },
      };
      if (url.includes('/risk/')) return {
        openapi: '3.1.0',
        info: { title: 'Risk', version: '1' },
        paths: { '/api/v1/perp-risk-engine': { get: { parameters: [] } } },
      };
      if (url.includes('/solana/')) return {
        openapi: '3.1.0',
        info: { title: 'Solana', version: '1' },
        paths: { '/api/v1/solana/new-signal': { get: { parameters: [] } } },
      };
      if (url.includes('/evm/')) return {
        openapi: '3.1.0',
        info: { title: 'EVM', version: '1' },
        paths: { '/api/v1/evm/new-signal': { get: { parameters: [] } } },
      };
      return {
        openapi: '3.1.0',
        info: { title: 'Gateway', version: '1' },
        paths: {
          '/api/v1/solana/new-signal': { get: { parameters: [] } },
          '/api/v1/evm/new-signal': { get: { parameters: [] } },
        },
      };
    };
    const fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/openapi.json')) {
        openapiRequests.push(url);
        return new Response(JSON.stringify(openApiDocument(url)), { status: 200 });
      }
      if (url === 'https://docs.cambrian.org/llms.txt') return new Response('', { status: 200 });
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;

    const listFromNewServer = async () => {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const server = createCambrianMcpServer({ apiKey: 'test', profile: 'full', fetch });
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
      expect(new Set(openapiRequests).size).toBe(openapiRequests.length);
      expect(openapiRequests).toContain('https://api.cambrian.org/deep42/openapi.json');
      expect(openapiRequests).toContain('https://api.cambrian.org/risk/openapi.json');
      if (openapiRequests.some((url) => url.includes('/solana/'))) {
        expect(openapiRequests.some((url) => url.includes('/evm/'))).toBe(true);
        expect(openapiRequests).not.toContain('https://opabinia.cambrian.org/openapi.json');
      }
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
      if (loads === 1) return OFFLINE_REGISTRY;
      return {
        ...OFFLINE_REGISTRY,
        deep42: {
          ...OFFLINE_REGISTRY.deep42,
          resources: [...OFFLINE_REGISTRY.deep42.resources, resource],
          spec: {
            ...OFFLINE_REGISTRY.deep42.spec,
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
    const server = createCambrianMcpServer({ apiKey: 'test', profile: 'full', metadataProvider });
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

// The declared Node floor is a promise to every consumer of the npm package.
// `cambrian` requires >=20, and on Node 18 `globalThis.crypto` is undefined so
// every Streamable HTTP /mcp request fails with a JSON-RPC parse error.
describe('engines.node floor', () => {
  const majorFloor = (range: string): number => Number(range.replace(/[^\d.]/g, '').split('.')[0]);
  const readPkg = (path: string) =>
    JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as
      { engines?: { node?: string } };

  it('is at least the floor of every runtime dependency', () => {
    const ours = majorFloor(readPkg('../package.json').engines?.node ?? '');
    for (const dep of ['cambrian', '@modelcontextprotocol/sdk']) {
      const theirs = majorFloor(readPkg(`../node_modules/${dep}/package.json`).engines?.node ?? '0');
      expect(ours).toBeGreaterThanOrEqual(theirs);
    }
  });

  it('is at least 20, where globalThis.crypto exists for the HTTP transport', () => {
    expect(majorFloor(readPkg('../package.json').engines?.node ?? '')).toBeGreaterThanOrEqual(20);
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
      profile: 'full',
      metadataProvider: async () => OFFLINE_REGISTRY,
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

  it('omits structuredContent when it exceeds maxLength', () => {
    const bigTable = {
      columns: [{ name: 'data', type: 'string' }],
      data: Array.from({ length: 100 }, (_, i) => [`row-${i}`]),
      rows: 100,
    };
    const result = buildToolResult(bigTable, 200, now);
    expect(result.content[0].text!.length).toBeLessThanOrEqual(300); // truncation adds marker
    expect(result.content[0].text).toContain('truncated');
    expect(result.structuredContent).toBeUndefined();
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
    expect(tool.description).toContain('section');
    expect(tool.description).not.toContain('path="solana"');
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
      profile: 'full',
      metadataProvider: async () => OFFLINE_REGISTRY,
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

  it('stops only the upstream request for a client-cancelled tool call', async () => {
    vi.useFakeTimers();
    let active = 0;
    let aborted = 0;
    const fetchFn = vi.fn(async (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<unknown> => {
      if (!String(input).includes('/solana/latest-block')) {
        return {
          columns: [{ name: 'dex', type: 'string' }],
          data: [['aerodrome']],
          rows: 1,
        };
      }
      active += 1;
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          active -= 1;
          aborted += 1;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    }) as typeof globalThis.fetch;
    setUseBoundaryFetch(true);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({
      apiKey: 'test',
      fetch: fetchFn,
      metadataProvider: async () => OFFLINE_REGISTRY,
    });
    const client = new Client({ name: 'request-cancel-test', version: '1.0.0' }, { capabilities: {} });
    const controller = new AbortController();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const cancelled = client.callTool(
        { name: 'cambrian_solana_latest_block', arguments: {} },
        undefined,
        { signal: controller.signal },
      );
      for (let index = 0; index < 10 && active !== 1; index += 1) await Promise.resolve();
      expect(active).toBe(1);

      const successful = await client.callTool({ name: 'cambrian_base_dexes', arguments: {} });
      expect(successful.isError).not.toBe(true);
      expect(successful.structuredContent).toMatchObject({ rowCount: 1 });

      controller.abort();
      await expect(cancelled).rejects.toThrow();
      for (let index = 0; index < 10 && aborted !== 1; index += 1) await Promise.resolve();
      expect(active).toBe(0);
      expect(aborted).toBe(1);
    } finally {
      await vi.advanceTimersByTimeAsync(DEFAULT_TOOL_TIMEOUT_MS + 1);
      await client.close();
      await server.close();
      resetCalls();
      vi.useRealTimers();
    }
  });

  it('stops all snapshot API requests after the tool timeout', async () => {
    vi.useFakeTimers();
    let active = 0;
    let aborted = 0;
    const fetchFn = vi.fn(async (
      _input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1],
    ): Promise<never> => {
      active += 1;
      return new Promise<never>((_resolve, reject) => {
        const abort = () => {
          active -= 1;
          aborted += 1;
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    }) as typeof globalThis.fetch;
    setUseBoundaryFetch(true);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createCambrianMcpServer({ apiKey: 'test', fetch: fetchFn });
    const client = new Client({ name: 'snapshot-cancel-test', version: '1.0.0' }, { capabilities: {} });
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const resultPromise = client.callTool({
        name: 'cambrian_solana_token_snapshot',
        arguments: {
          token_address: 'So11111111111111111111111111111111111111112',
          token_symbol: 'SOL',
        },
      });
      for (let index = 0; index < 10 && active !== 3; index += 1) await Promise.resolve();
      expect(active).toBe(3);

      await vi.advanceTimersByTimeAsync(DEFAULT_TOOL_TIMEOUT_MS + 1);
      const result = await resultPromise;
      for (let index = 0; index < 20 && aborted !== 8; index += 1) await Promise.resolve();

      expect(result).toMatchObject({ isError: true, structuredContent: { error: { code: 'TIMEOUT' } } });
      expect(active).toBe(0);
      expect(aborted).toBe(8);
    } finally {
      await client.close();
      await server.close();
      resetCalls();
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

  it('limits concurrent Solana requests so the snapshot does not trigger API rate limits', async () => {
    let active = 0;
    let peak = 0;
    const client = {
      opabinia: {
        query: async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return {};
        },
      },
      deep42: { query: async () => ({}) },
    } as unknown as CambrianData;

    await callSolanaTokenSnapshot(client, 'So11111111111111111111111111111111111111112', 'SOL', 'x');

    expect(peak).toBeLessThanOrEqual(2);
  });
});
