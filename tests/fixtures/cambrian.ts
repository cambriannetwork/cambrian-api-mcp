export const calls: Array<{ client: string; apiPath: string; params: Record<string, unknown> }> = [];

/**
 * Mirrors the shape of the real `cambrian` package-root `ApiError`
 * (status/code/message/body/rateLimit). The MCP detects ApiError via
 * `instanceof` against this exported constructor (the vitest alias makes
 * this the same `cambrian` module the server imports), so it stands in for
 * the published class. A `retryable` field is intentionally NOT set here so
 * tests confirm the server derives it defensively from `status`.
 */
export class ApiError extends Error {
  status: number;
  code: string | null;
  body: string;
  rateLimit: unknown;

  constructor(opts: { status: number; code: string | null; message: string; body: string; rateLimit?: unknown }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
    this.rateLimit = opts.rateLimit ?? null;
  }
}

export class CambrianData {
  opabinia = {
    query: async (apiPath: string, params: Record<string, unknown> = {}) => {
      calls.push({ client: 'opabinia', apiPath, params });
      return { ok: true, client: 'opabinia', apiPath, params };
    },
  };

  deep42 = {
    query: async (apiPath: string, params: Record<string, unknown> = {}) => {
      calls.push({ client: 'deep42', apiPath, params });
      return { ok: true, client: 'deep42', apiPath, params };
    },
  };

  risk = {
    query: async (apiPath: string, params: Record<string, unknown> = {}) => {
      calls.push({ client: 'risk', apiPath, params });
      return { ok: true, client: 'risk', apiPath, params };
    },
  };
}

export function resetCalls(): void {
  calls.length = 0;
}
