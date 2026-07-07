import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Request, Response } from 'express';
import {
  createCorsOptions,
  extractApiKey,
  getAllowedOrigins,
  isDirectEntrypoint,
  isOriginAllowed,
  validateOrigin,
} from '../src/index.js';

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
