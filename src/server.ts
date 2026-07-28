import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { CambrianData, ApiError } from 'cambrian';
import {
  CAMBRIAN_MCP_TOOLS,
  CAMBRIAN_METADATA_GROUPS,
  type CambrianToolMetadata,
  type ParamSpec,
} from 'cambrian/metadata';

export const SERVER_NAME = 'cambrian-api-mcp';
// WS6: read SERVER_VERSION from package.json to avoid manual drift.
export const SERVER_VERSION: string = (() => {
  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string };
    return pkg.version;
  } catch {
    return '1.2.0';
  }
})();
export const DOCS_TOOL_NAME = 'cambrian_docs';
export const DEFAULT_RESPONSE_MAX_LENGTH = 30000;
// Hard upper bound on _maxResponseLength so a caller can't request an
// unbounded payload (memory/transport blowup). Clamp, never reject.
export const MAX_RESPONSE_LENGTH_CAP = 100000;

// WS5: bounded timeout for the risk tool. The perp-risk-engine runs Monte
// Carlo simulations that can take 30-60 s depending on risk_horizon; we cap
// at 40 s so the MCP response stays within LLM tool-call timeouts. A true
// async/cached fix requires an upstream risk.cambrian.network job/poll API
// (not yet available).
export const RISK_TOOL_TIMEOUT_MS = 40000;

export const LLMS_BASE = 'https://docs.cambrian.org';
/** Base URL for docs (alias for test imports). */
export const DOCS_BASE_URL = LLMS_BASE;
/** Full URL for the root llms.txt index. */
export const DOCS_ROOT_URL = `${LLMS_BASE}/llms.txt`;

export interface CambrianMcpServerOptions {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  responseMaxLength?: number;
  /** Optional MCP server instructions (e.g. enriched from root llms.txt). */
  instructions?: string;
}

export interface JsonSchema {
  type: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  enum?: string[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  items?: Record<string, unknown>;
}

function schemaForParam(param: ParamSpec): JsonSchema {
  const schema: JsonSchema = {
    type: param.type || 'string',
  };
  if (param.description) schema.description = param.description;
  if (param.enum) schema.enum = param.enum;
  if (param.default !== undefined) schema.default = param.default;
  if (param.min !== undefined) schema.minimum = param.min;
  if (param.max !== undefined) schema.maximum = param.max;
  if (param.items) schema.items = param.items;
  if (schema.type === 'array' && !schema.items) {
    schema.items = { type: 'string' };
  }
  return schema;
}

export function buildToolInputSchema(tool: CambrianToolMetadata): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  const defaults = CAMBRIAN_METADATA_GROUPS[tool.group].cliDefaults[tool.resource] ?? {};
  for (const param of tool.params) {
    properties[param.name] = schemaForParam(param.spec);
    if (param.required && !(param.name in defaults) && param.spec.default === undefined) required.push(param.name);
  }
  properties._maxResponseLength = {
    type: 'number',
    description: `Optional maximum response length in characters. Default: ${DEFAULT_RESPONSE_MAX_LENGTH}.`,
  };
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// ---------------------------------------------------------------------------
// WS1: Docs helpers (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Strip the `/api/v1/` (or `api/v1/`) prefix from a tool's apiPath so we get
 * the canonical docs-path segment (e.g. "solana/price-current", "evm/chains").
 */
export function docPathForTool(tool: CambrianToolMetadata): string {
  return tool.apiPath.replace(/^\/?api\/v1\//, '');
}

/**
 * Normalize a user-supplied docs path:
 * - Strip leading/trailing slashes.
 * - Drop a leading `api/v1/` prefix.
 * - Alias a leading `base` segment to `evm` (first segment only).
 */
export function normalizeDocPath(path: string): string {
  let p = path.trim().replace(/^\/+|\/+$/g, '');
  p = p.replace(/^api\/v1\//, '');
  // Alias first segment `base` -> `evm`.
  p = p.replace(/^base(\/|$)/, 'evm$1');
  return p;
}

/** Build the per-endpoint llms.txt URL from a normalized doc path. */
export function endpointDocsUrl(normalizedPath: string): string {
  return `${DOCS_BASE_URL}/api/v1/${normalizedPath}/llms.txt`;
}

/**
 * Return the static base MCP server instructions string.
 *
 * Describes the server, the cambrian_docs tool, and the base->evm alias.
 * Used as a deterministic fallback (no fetch) so tests can compare against it.
 */
export function baseServerInstructions(): string {
  return (
    `This is the Cambrian API MCP server. ` +
    `It provides 1:1 tools for every public Cambrian API endpoint (Solana DeFi, Base chain DeFi, ` +
    `Deep42 social intelligence, and perpetual risk analysis) plus composite workflow tools. ` +
    `Use the \`${DOCS_TOOL_NAME}\` tool to fetch live per-endpoint documentation including ` +
    `parameters, units, constraints, and response-field meanings from ` +
    `docs.cambrian.org/llms.txt when parameter or response-field detail is needed. ` +
    `Note: "base" is an alias for \`evm\` in docs paths.`
  );
}

/**
 * WS1: Build the agent-visible description for a generated tool.
 *
 * The generated description from `cambrian/metadata` is kept as the offline
 * fallback. Each description explicitly instructs agents to call `cambrian_docs`
 * with the endpoint path to get full parameter documentation, units, and
 * response-field meanings. This way the MCP never drifts from the live docs
 * even if an agent caches the tool list.
 *
 * Path format: normalized docs path (no `/api/v1/` prefix; base->evm alias).
 */
function buildToolDescription(tool: CambrianToolMetadata): string {
  const path = docPathForTool(tool);
  return (
    `${tool.description} ` +
    `To get full parameter details, units, constraints, and response-field meanings, ` +
    `call ${DOCS_TOOL_NAME} with path "${path}".`
  );
}

export function listMcpTools() {
  return [
    {
      name: DOCS_TOOL_NAME,
      description:
        'Get Cambrian API documentation from docs.cambrian.org/llms.txt. ' +
        'Provide an endpoint path (e.g. "solana/price-current", "base/dexes", ' +
        '"deep42/social-data/sentiment-shifts") to fetch the per-endpoint docs with ' +
        'full parameter descriptions, units, constraints, and response-field meanings. ' +
        '"base" is an alias for `evm` in endpoint paths. ' +
        'Omit path to get the root index listing all available endpoints.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'Endpoint path to fetch docs for. E.g. "solana/price-current", ' +
              '"base/dexes" (alias for `evm/dexes`), "deep42/social-data/sentiment-shifts". ' +
              'Omit for the root llms.txt index.',
          },
          _maxResponseLength: {
            type: 'number',
            description: `Optional maximum response length in characters. Default: ${DEFAULT_RESPONSE_MAX_LENGTH}.`,
          },
        },
      },
    },
    ...CAMBRIAN_MCP_TOOLS.map((tool) => ({
      name: tool.name,
      description: buildToolDescription(tool),
      inputSchema: buildToolInputSchema(tool),
    })),
    // WS3: composite tools
    {
      name: 'cambrian_solana_token_snapshot',
      description:
        'Full Solana token snapshot: concurrently fetches token details, current price, ' +
        '1 h/4 h/24 h price-volume, top holders, pool list, and Deep42 social data. ' +
        'Tolerates partial failures. Returns retrievedAt timestamp. ' +
        `Call \`${DOCS_TOOL_NAME}\` with path="solana" for full field docs.`,
      inputSchema: {
        type: 'object',
        required: ['token_address'],
        properties: {
          token_address: { type: 'string', description: 'Solana token mint address.' },
          token_symbol: {
            type: 'string',
            description:
              'Optional token ticker/symbol. When supplied, the Deep42 section is token-scoped ' +
              '(token-analysis); otherwise it falls back to market-wide sentiment shifts. ' +
              'The result labels which under deep42.scope.',
          },
        },
      },
    },
    {
      name: 'cambrian_health',
      description:
        'Check availability of all Cambrian API services (Opabinia/Solana, Opabinia/Base, ' +
        'Deep42, Risk). Concurrently probes a lightweight endpoint on each service and reports ' +
        'up/down per service with latency. Returns retrievedAt timestamp.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    // `cambrian_usage` was removed: only Deep42 emits x-ratelimit-* headers.
    // Opabinia (Solana/Base) and Risk emit none, so the tool reported `null`
    // for three of four services while spending four API calls to do it.
  ];
}

export function getMaxResponseLength(args: Record<string, unknown>, fallback: number): number {
  const raw = args._maxResponseLength;
  const base = (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) ? Math.floor(raw) : fallback;
  // Clamp to the hard cap so an oversized request can't blow up memory/transport.
  return Math.min(base, MAX_RESPONSE_LENGTH_CAP);
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n\n---\nResponse truncated at ${maxLength} characters. Narrow the query or increase _maxResponseLength.`;
}

function stringifyResult(value: unknown, maxLength: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return truncateText(text, maxLength);
}

export interface StructuredError {
  code: string;
  message: string;
  status: number;
  retryable: boolean;
}

/**
 * Strip HTML so an upstream error page (e.g. a gateway 502 served as
 * `<!DOCTYPE html>...`) never leaks into a tool result. This is a PERMANENT
 * defensive layer: it stays even after `cambrian` itself normalizes errors,
 * so the MCP remains safe even if an upstream/client error carries raw HTML as
 * its message.
 */
function sanitizeErrorMessage(message: string): string {
  const trimmed = message.trim();
  const looksLikeHtml =
    /^<!doctype html/i.test(trimmed) ||
    /^<html[\s>]/i.test(trimmed) ||
    /<\/html>/i.test(trimmed) ||
    /<body[\s>]/i.test(trimmed);
  if (looksLikeHtml) {
    return 'Upstream service returned an unexpected (non-JSON) error response.';
  }
  return message;
}

const STATUS_CODE_MAP: Record<number, string> = {
  401: 'AUTH_REQUIRED',
  403: 'AUTH_FORBIDDEN',
  404: 'NOT_FOUND',
  408: 'TIMEOUT',
  429: 'RATE_LIMITED',
  400: 'BAD_REQUEST',
  422: 'BAD_REQUEST',
};

function mapStatusToCode(status: number, parsedCode?: string | null): string {
  if (parsedCode) return parsedCode;
  if (STATUS_CODE_MAP[status]) return STATUS_CODE_MAP[status];
  if (status >= 500) return 'UPSTREAM_ERROR';
  if (status > 0) return 'HTTP_ERROR';
  return 'MCP_ERROR';
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Match the published `cambrian` ApiError via a real `instanceof` (no local
 * duplicate class). cambrian@0.2.4+ re-exports `ApiError` as a value+type that
 * resolves cleanly under NodeNext and carries `status`/`code`/`retryable`.
 */
function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/**
 * Normalize any thrown value into a structured `{code,message,status,retryable}`.
 *
 * `ApiError` is matched via `instanceof` against the constructor from the
 * `cambrian` package ROOT (no local duplicate). When the published client
 * eventually carries its own `code`/`retryable`, those are preferred; until
 * then we derive them defensively from `status`. The message is always run
 * through `sanitizeErrorMessage` so HTML bodies never surface.
 */
export function toStructuredError(error: unknown): StructuredError {
  if (isApiError(error)) {
    const status = typeof error.status === 'number' ? error.status : 0;
    return {
      code: mapStatusToCode(status, error.code),
      message: sanitizeErrorMessage(error.message || 'Cambrian API error.'),
      status,
      retryable: typeof error.retryable === 'boolean' ? error.retryable : isRetryable(status),
    };
  }
  const message = error instanceof Error ? error.message : 'Unknown Cambrian MCP error.';
  return {
    code: 'MCP_ERROR',
    message: sanitizeErrorMessage(message),
    status: 0,
    retryable: false,
  };
}

/**
 * Coerce and validate a single argument against its ParamSpec.
 *
 * Mirrors the CLI's coerceValue (cambrian_cli/src/cli/dynamic-handler.ts:35-77)
 * for enum (case-insensitive -> canonical casing), integer/number with min/max,
 * and array splitting. Unlike the CLI, MCP arguments arrive already typed
 * (JSON), so this accepts BOTH string and number inputs and normalizes them.
 *
 * TODO(dedupe): once `cambrian` exports a shared coerceValue, import it from the
 * package instead of maintaining this parallel copy.
 */
function coerceValue(value: unknown, spec: ParamSpec, name: string): unknown {
  // Enum: case-insensitive match against the canonical list. Accepts string or
  // number inputs (e.g. interval enums supplied as numbers) by stringifying.
  if (spec.enum) {
    const asString = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : null;
    if (asString === null) {
      throw new Error(`${name} must be one of: ${spec.enum.join(', ')}.`);
    }
    const match = spec.enum.find((e) => e.toLowerCase() === asString.toLowerCase());
    if (!match) {
      throw new Error(`${name} must be one of: ${spec.enum.join(', ')}.`);
    }
    return match;
  }

  switch (spec.type) {
    case 'integer': {
      const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
      if (!Number.isInteger(n)) {
        throw new Error(`${name} must be an integer.`);
      }
      if (spec.min !== undefined && n < spec.min) {
        throw new Error(`${name} must be at least ${spec.min}.`);
      }
      if (spec.max !== undefined && n > spec.max) {
        throw new Error(`${name} must be at most ${spec.max}.`);
      }
      return n;
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) {
        throw new Error(`${name} must be a number.`);
      }
      if (spec.min !== undefined && n < spec.min) {
        throw new Error(`${name} must be at least ${spec.min}.`);
      }
      if (spec.max !== undefined && n > spec.max) {
        throw new Error(`${name} must be at most ${spec.max}.`);
      }
      return n;
    }
    case 'array': {
      if (Array.isArray(value)) return value.map((item) => String(item).trim());
      return String(value).split(',').map((s) => s.trim());
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      const asString = String(value).toLowerCase();
      if (asString === 'true') return true;
      if (asString === 'false') return false;
      throw new Error(`${name} must be a boolean.`);
    }
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

export function validateAndBuildParams(tool: CambrianToolMetadata, args: Record<string, unknown>): Record<string, unknown> {
  const allowed = new Set(tool.params.map((param) => param.name));
  const params: Record<string, unknown> = {};
  for (const key of Object.keys(args)) {
    if (key === '_maxResponseLength') continue;
    if (!allowed.has(key)) {
      throw new Error(`Unknown parameter for ${tool.name}: ${key}`);
    }
  }

  for (const param of tool.params) {
    const value = args[param.name];
    const defaults = CAMBRIAN_METADATA_GROUPS[tool.group].cliDefaults[tool.resource] ?? {};
    if (value !== undefined && value !== null) {
      params[param.name] = coerceValue(value, param.spec, param.name);
    } else if (param.name in defaults) {
      params[param.name] = defaults[param.name];
    } else if (param.spec.default !== undefined) {
      params[param.name] = param.spec.default;
    } else if (param.required) {
      throw new Error(`Missing required parameter for ${tool.name}: ${param.name}`);
    }
  }
  return params;
}

/**
 * WS1: Fetch documentation for a given endpoint path.
 *
 * Resolution order:
 *  1. If `pathArg` is non-empty, normalize it (strip api/v1, alias base->evm)
 *     and try the per-endpoint llms.txt.
 *     Also skip per-endpoint results that look like HTML (docs site landing page).
 *  2. On any per-endpoint miss (network error, non-200, HTML body), fall back to
 *     the root llms.txt and filter lines containing the path.
 *  3. If no pathArg, return the root llms.txt directly.
 *  4. If both per-endpoint and root are unreachable, throw with "unreachable".
 */
async function fetchDocumentation(
  fetchFn: typeof globalThis.fetch,
  args: Record<string, unknown>,
  maxLength: number,
): Promise<string> {
  const rawPath = typeof args.path === 'string' ? args.path : '';
  const pathArg = rawPath.trim();

  async function fetchRoot(): Promise<string> {
    const response = await fetchFn(DOCS_ROOT_URL, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      throw new Error(`Documentation unreachable: root request failed with HTTP ${response.status}.`);
    }
    return response.text();
  }

  if (!pathArg) {
    return truncateText(await fetchRoot(), maxLength);
  }

  const normalized = normalizeDocPath(pathArg);

  try {
    const perEndpointUrl = endpointDocsUrl(normalized);
    const response = await fetchFn(perEndpointUrl, {
      headers: { Accept: 'text/plain' },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok) {
      const body = await response.text();
      // Treat HTML responses (docs site landing page) as a miss.
      const looksLikeHtml = /^<!doctype html/i.test(body.trimStart()) || /^<html[\s>]/i.test(body.trimStart());
      if (!looksLikeHtml) {
        return truncateText(body, maxLength);
      }
    }
    // Fall through to root-fallback on non-200 or HTML.
  } catch {
    // Network error — fall through to root-fallback.
  }

  // Root fallback: fetch root and filter lines containing the normalized path
  // (or the original path arg, to match both base and evm aliases).
  let rootText: string;
  try {
    rootText = await fetchRoot();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Documentation unreachable: ${msg}`);
  }
  const lines = rootText.split('\n');
  const filtered = lines.filter((line) => {
    const lower = line.toLowerCase();
    return (
      lower.includes(normalized.toLowerCase()) ||
      lower.includes(pathArg.toLowerCase().replace(/^\/+|\/+$/g, ''))
    );
  });
  return truncateText(filtered.length > 0 ? filtered.join('\n') : rootText, maxLength);
}

/**
 * Exported alias for `fetchDocumentation` (for unit tests that need to inject
 * a mock fetch without going through the full MCP request lifecycle).
 */
export const fetchDocumentationForTest = fetchDocumentation;

export async function callCambrianTool(
  client: CambrianData,
  tool: CambrianToolMetadata,
  args: Record<string, unknown>,
): Promise<unknown> {
  const params = validateAndBuildParams(tool, args);
  switch (tool.group) {
    case 'solana':
    case 'base':
      return client.opabinia.query(tool.apiPath, params);
    case 'deep42':
      return client.deep42.query(tool.apiPath, params as Record<string, string | number | boolean | undefined>);
    case 'risk':
      return client.risk.query(tool.apiPath, params);
  }
}

// ---------------------------------------------------------------------------
// WS2: Structured MCP content
// ---------------------------------------------------------------------------

/** Matches the shape of `TableResponse` from `cambrian/types.ts`. */
interface TableResponse {
  columns: Array<{ name: string; type: string }>;
  data: unknown[][];
  rows: number;
  _rateLimit?: {
    limit: number | null;
    remaining: number | null;
    resetAt: string | null;
    retryAfterSeconds: number | null;
  } | null;
}

function isTableResponse(value: unknown): value is TableResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    Array.isArray(v.columns) &&
    Array.isArray(v.data) &&
    typeof v.rows === 'number'
  );
}

export interface StructuredTableResult {
  records: Record<string, unknown>[];
  schema: Array<{ name: string; type: string }>;
  rowCount: number;
  retrievedAt: string;
  rateLimit?: { limit: number | null; remaining: number | null; resetAt: string | null } | null;
}

/**
 * Convert a `TableResponse` to the structured content payload:
 * - `records`: array of objects (columns zipped with each row).
 * - `schema`: column definitions.
 * - `rowCount`: the server-reported row count.
 * - `retrievedAt`: ISO timestamp of when this request was made.
 * - `rateLimit`: optional rate-limit metadata from the response, if present.
 */
export function tableResponseToStructured(
  table: TableResponse,
  retrievedAt: string,
): StructuredTableResult {
  const columnNames = table.columns.map((col) => col.name);
  const records = table.data.map((row) => {
    const record: Record<string, unknown> = {};
    columnNames.forEach((name, idx) => {
      record[name] = row[idx];
    });
    return record;
  });
  const result: StructuredTableResult = {
    records,
    schema: table.columns.map((col) => ({ name: col.name, type: col.type })),
    rowCount: table.rows,
    retrievedAt,
  };
  if (table._rateLimit !== undefined) {
    const rl = table._rateLimit;
    result.rateLimit = rl
      ? { limit: rl.limit, remaining: rl.remaining, resetAt: rl.resetAt }
      : null;
  }
  return result;
}

type ToolResultContent = Array<{ type: string; text?: string; [key: string]: unknown }>;

/**
 * Build the MCP CallTool response for a result value.
 *
 * - `TableResponse` -> structuredContent with records/schema/rowCount/retrievedAt
 *   + compact text fallback (truncated by maxLength).
 * - JSON arrays -> structuredContent wrapped in an object required by the MCP schema.
 * - Deep42 / Risk JSON objects -> structuredContent with the raw object + compact text fallback.
 * - Strings pass through as plain text.
 */
export function buildToolResult(
  result: unknown,
  maxLength: number,
  retrievedAt: string,
): { content: ToolResultContent; structuredContent?: Record<string, unknown> } {
  if (isTableResponse(result)) {
    const structured = tableResponseToStructured(result, retrievedAt);
    // Compact text fallback: first few records + schema.
    const previewRecords = structured.records.slice(0, 10);
    const compactText = truncateText(
      JSON.stringify({ records: previewRecords, schema: structured.schema, rowCount: structured.rowCount, retrievedAt }, null, 2),
      maxLength,
    );
    return {
      content: [{ type: 'text', text: compactText }],
      structuredContent: { ...structured },
    };
  }

  if (Array.isArray(result)) {
    const structuredContent = result.length > 0 && result.every(isTableResponse)
      ? {
          tables: result.map((table) => tableResponseToStructured(table, retrievedAt)),
          tableCount: result.length,
          retrievedAt,
        }
      : { items: result, itemCount: result.length, retrievedAt };
    return {
      content: [{ type: 'text', text: truncateText(JSON.stringify(structuredContent, null, 2), maxLength) }],
      structuredContent,
    };
  }

  if (typeof result === 'object' && result !== null) {
    // Deep42 / Risk or any other JSON object — pass through as structuredContent.
    const text = truncateText(JSON.stringify(result, null, 2), maxLength);
    return {
      content: [{ type: 'text', text }],
      structuredContent: result as Record<string, unknown>,
    };
  }

  // Plain string or primitive.
  return {
    content: [{ type: 'text', text: stringifyResult(result, maxLength) }],
  };
}

// ---------------------------------------------------------------------------
// WS3: Composite tools
// ---------------------------------------------------------------------------

type SectionResult<T> =
  | { data: T; error?: never }
  | { data?: never; error: StructuredError & { section: string } };

/** Wrap a concurrent call so a partial failure is captured per-section. */
async function trySection<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<SectionResult<T>> {
  try {
    return { data: await fn() };
  } catch (err) {
    return { error: { ...toStructuredError(err), section: label } };
  }
}

export async function callSolanaTokenSnapshot(
  client: CambrianData,
  tokenAddress: string,
  tokenSymbol: string | undefined,
  retrievedAt: string,
): Promise<unknown> {
  // price-volume/single only accepts the intraday enum 1h|2h|4h|8h|24h. Asking
  // for "7d"/"30d" is a 400, so the multi-day windows are not available here.
  const [details, price, pv1h, pv4h, pv24h, holders, pools, social] = await Promise.all([
    trySection('token-details', () =>
      client.opabinia.query('/api/v1/solana/token-details', { token_address: tokenAddress })
    ),
    trySection('price-current', () =>
      client.opabinia.query('/api/v1/solana/price-current', { token_address: tokenAddress })
    ),
    trySection('price-volume-1h', () =>
      client.opabinia.query('/api/v1/solana/price-volume/single', { token_address: tokenAddress, timeframe: '1h' })
    ),
    trySection('price-volume-4h', () =>
      client.opabinia.query('/api/v1/solana/price-volume/single', { token_address: tokenAddress, timeframe: '4h' })
    ),
    trySection('price-volume-24h', () =>
      client.opabinia.query('/api/v1/solana/price-volume/single', { token_address: tokenAddress, timeframe: '24h' })
    ),
    // The holders endpoint keys on `program_id` (the mint address), not
    // `token_address`. Passing `token_address` is a 400.
    trySection('token-holders', () =>
      client.opabinia.query('/api/v1/solana/tokens/holders', { program_id: tokenAddress, limit: 20 })
    ),
    trySection('token-pool-search', () =>
      client.opabinia.query('/api/v1/solana/token-pool-search', { token_address: tokenAddress })
    ),
    // sentiment-shifts has no token filter, so it is market-wide. Only
    // token-analysis is token-scoped, and it keys on the ticker.
    tokenSymbol
      ? trySection('deep42-token-analysis', () =>
          client.deep42.query('/api/v1/deep42/social-data/token-analysis', { token_symbol: tokenSymbol })
        )
      : trySection('deep42-sentiment-shifts', () =>
          client.deep42.query('/api/v1/deep42/social-data/sentiment-shifts', {})
        ),
  ]);
  return {
    tokenAddress,
    tokenSymbol,
    retrievedAt,
    details,
    price,
    priceVolume: { h1: pv1h, h4: pv4h, h24: pv24h },
    holders,
    pools,
    deep42: tokenSymbol
      ? { scope: 'token', tokenAnalysis: social }
      : { scope: 'market-wide', sentimentShifts: social },
  };
}

export async function callCambrianHealth(
  client: CambrianData,
  retrievedAt: string,
): Promise<unknown> {
  async function probe(label: string, fn: () => Promise<unknown>) {
    const start = Date.now();
    try {
      await fn();
      return { service: label, status: 'up', latencyMs: Date.now() - start };
    } catch (err) {
      return {
        service: label,
        status: 'down',
        latencyMs: Date.now() - start,
        error: toStructuredError(err),
      };
    }
  }

  const [solana, base, deep42, risk] = await Promise.all([
    probe('solana', () => client.opabinia.query('/api/v1/solana/latest-block', {})),
    probe('base', () => client.opabinia.query('/api/v1/evm/dexes', {})),
    probe('deep42', () => client.deep42.query('/api/v1/deep42/social-data/sentiment-shifts', {})),
    // Probe the risk service's own /health, NOT perp-risk-engine. The engine
    // runs Monte Carlo simulations (~14 s observed), and Promise.all makes the
    // whole health check as slow as its slowest probe.
    probe('risk', () => client.risk.query('/health', {})),
  ]);

  const services = [solana, base, deep42, risk] as Array<{
    service: string;
    status: string;
    latencyMs: number;
    error?: StructuredError;
  }>;
  const allUp = services.every((s) => s.status === 'up');
  return { status: allUp ? 'healthy' : 'degraded', services, retrievedAt };
}

// ---------------------------------------------------------------------------
// WS5: Risk tool bounded timeout
// ---------------------------------------------------------------------------

// Marker symbol so synthetic timeouts are distinguishable from real errors.
const SYNTHETIC_TIMEOUT = Symbol('SYNTHETIC_TIMEOUT');

interface SyntheticTimeoutError extends Error {
  [SYNTHETIC_TIMEOUT]: true;
}

/**
 * Race a Promise against a timeout. On timeout, throws a SyntheticTimeoutError
 * that toTimeoutError() converts to a TIMEOUT/retryable structured error.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(
        `${label} timed out after ${ms} ms. ` +
        'The perp-risk-engine runs Monte Carlo simulations — ' +
        'try a shorter risk_horizon (e.g. "1h" instead of "1w" or "1mo") for faster results.',
      ) as SyntheticTimeoutError;
      err[SYNTHETIC_TIMEOUT] = true;
      reject(err);
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function toTimeoutError(err: unknown): StructuredError | null {
  if (
    err instanceof Error &&
    (err as SyntheticTimeoutError)[SYNTHETIC_TIMEOUT] === true
  ) {
    return {
      code: 'TIMEOUT',
      message: sanitizeErrorMessage(err.message),
      status: 408,
      retryable: true,
    };
  }
  return null;
}

export function createCambrianMcpServer(options: CambrianMcpServerOptions): Server {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const responseMaxLength = options.responseMaxLength ?? DEFAULT_RESPONSE_MAX_LENGTH;
  const client = new CambrianData({
    apiKey: options.apiKey,
    fetch: fetchFn,
  });
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      ...(options.instructions ? { instructions: options.instructions } : {}),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listMcpTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const maxLength = getMaxResponseLength(args, responseMaxLength);
    const retrievedAt = new Date().toISOString();
    try {
      if (name === DOCS_TOOL_NAME) {
        const docs = await fetchDocumentation(fetchFn, args, maxLength);
        return { content: [{ type: 'text', text: docs }] };
      }

      // WS3: composite tools
      if (name === 'cambrian_solana_token_snapshot') {
        const tokenAddress = typeof args.token_address === 'string' ? args.token_address : '';
        if (!tokenAddress) throw new Error('Missing required parameter: token_address');
        const tokenSymbol = typeof args.token_symbol === 'string' ? args.token_symbol : undefined;
        const result = await callSolanaTokenSnapshot(client, tokenAddress, tokenSymbol, retrievedAt);
        return buildToolResult(result, maxLength, retrievedAt);
      }

      if (name === 'cambrian_health') {
        const result = await callCambrianHealth(client, retrievedAt);
        return buildToolResult(result, maxLength, retrievedAt);
      }

      const tool = CAMBRIAN_MCP_TOOLS.find((candidate) => candidate.name === name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);

      // WS5: bounded timeout for the risk tool.
      const callPromise = callCambrianTool(client, tool, args);
      const result =
        tool.group === 'risk'
          ? await withTimeout(callPromise, RISK_TOOL_TIMEOUT_MS, 'cambrian_risk_perp_risk_engine')
          : await callPromise;

      // WS2: structured content
      return buildToolResult(result, maxLength, retrievedAt);
    } catch (error) {
      // Check for synthetic timeout before the generic structured error path.
      const timeoutErr = toTimeoutError(error);
      const structured = timeoutErr ?? toStructuredError(error);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: structured }, null, 2) }],
        isError: true,
      };
    }
  });

  return server;
}
