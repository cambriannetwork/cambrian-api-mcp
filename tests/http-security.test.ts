import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import { pathToFileURL } from 'node:url';
import type { Request, Response } from 'express';
import { resetCalls, setUseBoundaryFetch } from './fixtures/cambrian.js';
import {
  createCorsOptions,
  createHttpApp,
  extractApiKey,
  getAllowedOrigins,
  isDirectEntrypoint,
  isOriginAllowed,
  mcpProfileForPath,
  parseArgs,
  validateOrigin,
} from '../src/index.js';

async function withHttpApp(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createHttpApp().listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('HTTP JSON boundary', () => {
  beforeEach(() => resetCalls());

  it('rejects an unauthenticated request before parsing its body', async () => {
    await withHttpApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ value: 'x'.repeat(300 * 1024) }),
      });

      expect(response.status).toBe(401);
    });
  });

  it('returns a JSON-RPC parse error for malformed JSON', async () => {
    await withHttpApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: '{',
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32700 },
        id: null,
      });
    });
  });

  it('rejects an oversized JSON body before MCP handling', async () => {
    await withHttpApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ value: 'x'.repeat(300 * 1024) }),
      });

      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Request body is too large.' },
        id: null,
      });
    });
  });

  it.each(['/mcp', '/mcp/compact', '/mcp/full'])('accepts a valid initialize request at %s', async (path) => {
    await withHttpApp(async (baseUrl) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-key',
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'http-test', version: '1.0.0' },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"serverInfo"');
    });
  });

  it('rate-limits each API key independently', async () => {
    const originalMax = process.env.RATE_LIMIT_MAX;
    process.env.RATE_LIMIT_MAX = '1';
    try {
      await withHttpApp(async (baseUrl) => {
        const send = (key: string) => fetch(`${baseUrl}/mcp`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'rate-limit-test', version: '1.0.0' },
            },
          }),
        });

        expect((await send('key-a')).status).toBe(200);
        expect((await send('key-a')).status).toBe(429);
        expect((await send('key-b')).status).toBe(200);
      });
    } finally {
      if (originalMax === undefined) delete process.env.RATE_LIMIT_MAX;
      else process.env.RATE_LIMIT_MAX = originalMax;
    }
  });

  it('stops upstream requests when the HTTP client disconnects', async () => {
    const originalFetch = globalThis.fetch;
    let active = 0;
    let aborted = 0;
    globalThis.fetch = vi.fn(async (
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
    try {
      await withHttpApp(async (baseUrl) => {
        const url = new URL('/mcp', baseUrl);
        const body = JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'cambrian_solana_token_snapshot',
            arguments: {
              token_address: 'So11111111111111111111111111111111111111112',
              token_symbol: 'SOL',
            },
          },
        });
        const request = httpRequest({
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          method: 'POST',
          headers: {
            Authorization: 'Bearer test-key',
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(body),
          },
        });
        request.on('error', () => undefined);
        request.end(body);
        await vi.waitFor(() => expect(active).toBe(3));
        request.destroy();
        await vi.waitFor(() => {
          expect(active).toBe(0);
          expect(aborted).toBe(8);
        });
      });
    } finally {
      globalThis.fetch = originalFetch;
      resetCalls();
    }
  });
});

describe('MCP profile selection', () => {
  it('uses progressive by default and accepts the compact and full CLI profiles', () => {
    expect(parseArgs([]).profile).toBe('progressive');
    expect(parseArgs(['--profile', 'compact']).profile).toBe('compact');
    expect(parseArgs(['--profile', 'progressive']).profile).toBe('progressive');
    expect(parseArgs(['--profile', 'full']).profile).toBe('full');
  });

  it('maps each HTTP path to its tool profile', () => {
    expect(mcpProfileForPath('/mcp')).toBe('progressive');
    expect(mcpProfileForPath('/mcp/compact')).toBe('compact');
    expect(mcpProfileForPath('/mcp/full')).toBe('full');
  });
});

// Minimal Request stub with just the headers the helpers read.
function req(headers: Record<string, string | string[] | undefined>): Request {
  return { headers } as unknown as Request;
}

// Response stub capturing status()/json() for validateOrigin assertions.
function res(): Response & { _status?: number; _body?: unknown } {
  const stub: Partial<Response> & { _status?: number; _body?: unknown } = {};
  stub.status = vi.fn((code: number) => {
    stub._status = code;
    return stub as Response;
  }) as unknown as Response['status'];
  stub.json = vi.fn((body: unknown) => {
    stub._body = body;
    return stub as Response;
  }) as unknown as Response['json'];
  return stub as Response & { _status?: number; _body?: unknown };
}

describe('CORS origin policy', () => {
  const original = process.env.ALLOWED_ORIGINS;

  afterEach(() => {
    if (original === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = original;
  });

  it('parses ALLOWED_ORIGINS into a trimmed, non-empty list', () => {
    process.env.ALLOWED_ORIGINS = ' https://a.com , https://b.com ,,';
    expect(getAllowedOrigins()).toEqual(['https://a.com', 'https://b.com']);
  });

  it('treats empty/unset ALLOWED_ORIGINS as an empty list', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(getAllowedOrigins()).toEqual([]);
    process.env.ALLOWED_ORIGINS = '   ';
    expect(getAllowedOrigins()).toEqual([]);
  });

  it('DENIES cross-origin browser requests when ALLOWED_ORIGINS is empty (default-deny)', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(isOriginAllowed('https://evil.example')).toBe(false);
  });

  it('ALWAYS allows requests with no Origin header (server-to-server)', () => {
    delete process.env.ALLOWED_ORIGINS;
    expect(isOriginAllowed(undefined)).toBe(true);
    process.env.ALLOWED_ORIGINS = 'https://only.this';
    expect(isOriginAllowed(undefined)).toBe(true);
  });

  it('allows only origins on an explicit allowlist', () => {
    process.env.ALLOWED_ORIGINS = 'https://app.cambrian.org,https://studio.cambrian.org';
    expect(isOriginAllowed('https://app.cambrian.org')).toBe(true);
    expect(isOriginAllowed('https://studio.cambrian.org')).toBe(true);
    expect(isOriginAllowed('https://attacker.test')).toBe(false);
  });

  it('supports explicit wildcard opt-in (ALLOWED_ORIGINS=*)', () => {
    process.env.ALLOWED_ORIGINS = '*';
    expect(isOriginAllowed('https://anything.test')).toBe(true);
    expect(isOriginAllowed('https://other.test')).toBe(true);
  });

  it('validateOrigin returns 403 for a disallowed origin and true otherwise', () => {
    delete process.env.ALLOWED_ORIGINS;
    const denied = res();
    expect(validateOrigin(req({ origin: 'https://evil.example' }), denied)).toBe(false);
    expect(denied._status).toBe(403);
    expect(denied._body).toEqual({ error: 'Origin not allowed.' });

    const allowed = res();
    expect(validateOrigin(req({}), allowed)).toBe(true);
    expect(allowed._status).toBeUndefined();
  });

  it('CORS middleware callback denies without surfacing an Express error', async () => {
    delete process.env.ALLOWED_ORIGINS;
    const options = createCorsOptions();
    const origin = options.origin;
    expect(typeof origin).toBe('function');

    await new Promise<void>((resolve) => {
      (origin as Exclude<typeof origin, string | boolean | RegExp | Array<string | RegExp> | undefined>)(
        'https://evil.example',
        (err, allow) => {
          expect(err).toBeNull();
          expect(allow).toBe(false);
          resolve();
        },
      );
    });
  });
});

describe('extractApiKey precedence', () => {
  it('prefers a non-empty Authorization: Bearer over X-Cambrian-Api-Key', () => {
    const key = extractApiKey(req({
      authorization: 'Bearer bearer-key',
      'x-cambrian-api-key': 'header-key',
    }));
    expect(key).toBe('bearer-key');
  });

  it('falls back to X-Cambrian-Api-Key when the Bearer value is empty/whitespace', () => {
    const key = extractApiKey(req({
      authorization: 'Bearer    ',
      'x-cambrian-api-key': 'header-key',
    }));
    expect(key).toBe('header-key');
  });

  it('uses X-Cambrian-Api-Key when no Authorization header is present', () => {
    expect(extractApiKey(req({ 'x-cambrian-api-key': 'header-key' }))).toBe('header-key');
  });

  it('handles a duplicated X-Cambrian-Api-Key header (array) by taking the first', () => {
    expect(extractApiKey(req({ 'x-cambrian-api-key': ['first', 'second'] }))).toBe('first');
  });

  it('returns null when neither header yields a key', () => {
    expect(extractApiKey(req({}))).toBeNull();
    expect(extractApiKey(req({ authorization: 'Bearer   ' }))).toBeNull();
  });
});

describe('entrypoint detection', () => {
  it('treats an npm-style symlink to the built bin as direct invocation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cambrian-bin-'));
    try {
      const target = join(dir, 'dist-index.js');
      const link = join(dir, 'cambrian-api-mcp');
      writeFileSync(target, '#!/usr/bin/env node\n');
      symlinkSync(target, link);
      expect(isDirectEntrypoint(link, pathToFileURL(realpathSync(target)).href)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
