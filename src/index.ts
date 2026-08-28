#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { createHash } from 'crypto';
import { pathToFileURL } from 'url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  baseServerInstructions,
  createCambrianMcpServer,
  listCompactMcpTools,
  listMcpTools,
  listProgressiveMcpTools,
  parseToolsets,
  SERVER_NAME,
  SERVER_VERSION,
  TOOLSETS,
  type Toolset,
} from './server.js';

const DEFAULT_PORT = 8080;
const DEFAULT_HTTP_HOST = '127.0.0.1';

interface CliOptions {
  transport: 'stdio' | 'http';
  profile: 'compact' | 'progressive' | 'full';
  host: string;
  port: number;
  toolsets: Toolset[];
  help: boolean;
  version: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    transport: 'stdio',
    profile: 'progressive',
    host: DEFAULT_HTTP_HOST,
    port: Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT,
    toolsets: parseToolsets(process.env.CAMBRIAN_TOOLSETS),
    help: false,
    version: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    switch (token) {
      case '--transport': {
        const value = argv[++index];
        if (value !== 'stdio' && value !== 'http') {
          throw new Error('--transport must be one of: stdio, http');
        }
        options.transport = value;
        break;
      }
      case '--host':
        options.host = argv[++index] ?? options.host;
        break;
      case '--profile': {
        const value = argv[++index];
        if (value !== 'compact' && value !== 'progressive' && value !== 'full') {
          throw new Error('--profile must be one of: compact, progressive, full');
        }
        options.profile = value;
        break;
      }
      case '--port':
        options.port = Number.parseInt(argv[++index] ?? '', 10);
        if (!Number.isInteger(options.port) || options.port < 1) {
          throw new Error('--port must be a positive integer');
        }
        break;
      case '--toolsets':
        options.toolsets = parseToolsets(argv[++index]);
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      case '--version':
      case '-v':
        options.version = true;
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }
  return options;
}

export function mcpProfileForPath(path: string): CliOptions['profile'] {
  if (path === '/mcp/compact') return 'compact';
  return path === '/mcp/full' ? 'full' : 'progressive';
}

function usage(): string {
  return [
    `${SERVER_NAME} ${SERVER_VERSION}`,
    '',
    'Usage:',
    '  cambrian-api-mcp                         Run stdio MCP server',
    '  cambrian-api-mcp --transport http        Run Streamable HTTP server',
    '',
    'Options:',
    '  --transport <stdio|http>   Transport mode. Default: stdio.',
    '  --profile <compact|progressive|full>   Stdio tool profile. HTTP uses the endpoint path. Default: progressive.',
    `  --host <host>              HTTP host. Default: ${DEFAULT_HTTP_HOST}. Use 0.0.0.0 only in hosted deployments.`,
    `  --port <port>              HTTP port. Default: ${DEFAULT_PORT}.`,
    `  --toolsets <list>          Comma list of ${TOOLSETS.join(', ')}, or all. Default: all.`,
    '                             Env: CAMBRIAN_TOOLSETS. HTTP: ?toolsets=solana,risk.',
    '  --version                  Print version.',
    '  --help                     Show help.',
    '',
    'Authentication:',
    '  stdio: set CAMBRIAN_API_KEY in the process environment.',
    '  http: send Authorization: Bearer <key> or X-Cambrian-Api-Key.',
  ].join('\n');
}

/**
 * Extract the caller's Cambrian API key from request headers.
 *
 * Auth precedence (Bearer-first): a non-empty `Authorization: Bearer <key>`
 * wins. An empty/whitespace-only Bearer value falls back to the
 * `X-Cambrian-Api-Key` header. Returns `null` when neither yields a key.
 */
export function extractApiKey(req: Request): string | null {
  const authHeader = req.headers.authorization;
  const bearerKey = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : null;
  const headerKey = req.headers['x-cambrian-api-key'];
  const fallbackKey = Array.isArray(headerKey) ? headerKey[0] : headerKey;
  return (bearerKey || fallbackKey || null) || null;
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

/**
 * Parse the `ALLOWED_ORIGINS` env var into a trimmed, non-empty list.
 * Empty list means "no cross-origin browser requests allowed" (default-deny).
 * A single `*` entry means "allow any origin" (explicit opt-in).
 */
export function getAllowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Central origin policy shared by the cors() middleware and validateOrigin().
 *
 * - No `Origin` header (server-to-server / non-browser clients) → allowed.
 * - `ALLOWED_ORIGINS` empty → DENY all cross-origin (browser) requests.
 * - `ALLOWED_ORIGINS=*` (or contains `*`) → allow any origin (explicit opt-in).
 * - Otherwise → allow only origins on the explicit allowlist.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  const allowedOrigins = getAllowedOrigins();
  if (allowedOrigins.length === 0) return false;
  if (allowedOrigins.includes('*')) return true;
  return allowedOrigins.includes(origin);
}

export function validateOrigin(req: Request, res: Response): boolean {
  if (isOriginAllowed(req.headers.origin)) return true;
  res.status(403).json({ error: 'Origin not allowed.' });
  return false;
}

function validateMcpAccess(req: Request, res: Response, next: NextFunction): void {
  if (!validateOrigin(req, res)) return;
  if (extractApiKey(req)) {
    next();
    return;
  }
  res.status(401).json({
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: 'CAMBRIAN_API_KEY required. Provide Authorization: Bearer <key> or X-Cambrian-Api-Key.',
    },
    id: null,
  });
}

export function createCorsOptions(): cors.CorsOptions {
  return {
    origin: (origin, callback) => {
      if (isOriginAllowed(origin ?? undefined)) return callback(null, true);
      return callback(null, false);
    },
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'X-Cambrian-Api-Key', 'Mcp-Session-Id'],
    methods: ['GET', 'POST', 'OPTIONS'],
  };
}

async function runStdio(profile: CliOptions['profile'], toolsets: Toolset[]): Promise<void> {
  const apiKey = process.env.CAMBRIAN_API_KEY;
  if (!apiKey) {
    console.error('CAMBRIAN_API_KEY is required for stdio mode.');
    process.exitCode = 2;
    return;
  }
  const instructions = baseServerInstructions();
  const server = createCambrianMcpServer({ apiKey, instructions, profile, toolsets });
  await server.connect(new StdioServerTransport());
}

export function createHttpApp(): express.Express {
  const app = express();
  app.set('trust proxy', 1);

  const instructions = baseServerInstructions();

  // CORS uses the same central origin policy as validateOrigin() so the
  // preflight and the actual request never disagree. With ALLOWED_ORIGINS
  // empty, browser cross-origin requests are denied (default-deny); set
  // ALLOWED_ORIGINS to a comma list (or `*`) to opt back in.
  const corsOptions = createCorsOptions();
  app.use(cors(corsOptions));

  const limiter = rateLimit({
    windowMs: Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '', 10) || 10 * 60 * 1000,
    limit: Number.parseInt(process.env.RATE_LIMIT_MAX ?? '', 10) || 5000,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
      const apiKey = extractApiKey(req);
      return apiKey ? `key_${hashKey(apiKey)}` : `ip_${req.ip}`;
    },
    skip: (req) => req.path === '/health' || req.path === '/',
  });

  app.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      server: SERVER_NAME,
      version: SERVER_VERSION,
      authMode: 'api-key',
      toolCount: listProgressiveMcpTools().length,
      compactToolCount: listCompactMcpTools().length,
      fullToolCount: listMcpTools().length,
      transport: 'streamable-http',
    });
  });

  app.get('/', (_req, res) => {
    res.json({
      service: SERVER_NAME,
      version: SERVER_VERSION,
      defaultProfile: 'progressive',
      mcpEndpoint: '/mcp',
      compactMcpEndpoint: '/mcp/compact',
      fullMcpEndpoint: '/mcp/full',
      auth: 'Cambrian API key via Authorization: Bearer <key> or X-Cambrian-Api-Key',
      toolCount: listProgressiveMcpTools().length,
      progressiveToolCount: listProgressiveMcpTools().length,
      compactToolCount: listCompactMcpTools().length,
      fullToolCount: listMcpTools().length,
    });
  });

  app.post(
    ['/mcp', '/mcp/compact', '/mcp/full'],
    limiter,
    validateMcpAccess,
    express.json({ limit: '256kb' }),
    async (req: Request, res: Response) => {
      const apiKey = extractApiKey(req)!;
      let toolsets: Toolset[];
      try {
        const raw = req.query.toolsets;
        toolsets = parseToolsets(typeof raw === 'string' ? raw : undefined);
      } catch (error) {
        res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32602, message: (error as Error).message },
          id: null,
        });
        return;
      }

      const requestController = new AbortController();
      const server = createCambrianMcpServer({
        apiKey,
        instructions,
        profile: mcpProfileForPath(req.path),
        toolsets,
        signal: requestController.signal,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      let closed = false;
      const closeServer = (): void => {
        if (closed) return;
        closed = true;
        requestController.abort();
        void server.close().catch(() => undefined);
      };
      res.once('close', closeServer);
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
      } catch {
        closeServer();
        if (!res.headersSent) {
          res.status(500).json({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error.' },
            id: null,
          });
        }
      }
    },
  );

  app.get(['/mcp', '/mcp/compact', '/mcp/full'], limiter, (req: Request, res: Response) => {
    if (!validateOrigin(req, res)) return;
    res.status(405).json({
      error: `Use POST ${req.path} for Streamable HTTP JSON-RPC requests.`,
    });
  });

  // Preflight must enforce the same origin policy as the real request,
  // otherwise the default cors() would reflect arbitrary origins.
  app.options(['/mcp', '/mcp/compact', '/mcp/full'], (req: Request, res: Response) => {
    if (!validateOrigin(req, res)) return;
    cors(corsOptions)(req, res, () => res.sendStatus(204));
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const bodyError = error as { status?: number; type?: string };
    const oversized = bodyError.type === 'entity.too.large' || bodyError.status === 413;
    res.status(oversized ? 413 : 400).json({
      jsonrpc: '2.0',
      error: {
        code: oversized ? -32600 : -32700,
        message: oversized ? 'Request body is too large.' : 'Invalid JSON.',
      },
      id: null,
    });
  });

  return app;
}

async function runHttp(options: CliOptions): Promise<void> {
  const app = createHttpApp();
  app.listen(options.port, options.host, () => {
    console.error(`${SERVER_NAME} listening on http://${options.host}:${options.port}/mcp (compact: /mcp/compact, full: /mcp/full)`);
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (options.version) {
    console.log(SERVER_VERSION);
    return;
  }
  if (options.transport === 'stdio') {
    await runStdio(options.profile, options.toolsets);
  } else {
    await runHttp(options);
  }
}

// Only auto-run when invoked as the entrypoint (e.g. `node dist/index.js`),
// not when imported by tests for the exported helpers.
export function isDirectEntrypoint(argv1: string | undefined, moduleUrl = import.meta.url): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return moduleUrl === pathToFileURL(argv1).href;
  }
}

const invokedDirectly = isDirectEntrypoint(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
