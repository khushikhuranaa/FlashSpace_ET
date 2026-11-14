/**
 * Central redaction for anything written to logs or returned as diagnostics.
 *
 * Module 14: request bodies, headers and provider errors must never put
 * passwords, JWTs, refresh tokens, reset/invite tokens, API keys or connection
 * strings into the log stream. Activity metadata already has its own filter;
 * this module covers the server log path.
 */

const SENSITIVE_KEY =
  /(password|passwd|pwd|secret|token|authorization|cookie|credential|api[-_]?key|signed[-_]?url|connection[-_]?string|database[-_]?url|refresh|access[-_]?key|private[-_]?key|session)/i;

/** Maximum depth we will redact; deeper structures are replaced wholesale. */
const MAX_DEPTH = 6;
const REDACTED = '[REDACTED]';

/** Patterns that identify secret material inside free-form strings. */
const STRING_PATTERNS: Array<[RegExp, string]> = [
  // Query-string / header tokens: ?token=... , token=..., access_token=...
  [/([?&](?:token|access_token|refresh_token|signature|sig|apikey|api_key)=)[^&\s"']+/gi, `$1${REDACTED}`],
  // Authorization headers embedded in a message
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  // JWTs (three base64url segments, the first decoding to a JSON header)
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED],
  // Postgres/MySQL URLs with an inline password
  [/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:@\s]+:[^@\s]+@/gi, `$1://${REDACTED}@`],
  // SMTP/API style keys
  [/\b(sk|pk|rk)_(live|test)_[A-Za-z0-9]{8,}\b/g, REDACTED],
];

/** Mask secret-looking values inside a single string. */
export function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of STRING_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** Deep-redact an arbitrary value for logging (never throws). */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (value instanceof Error) return redactError(value);
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].slice(0, 50).map(([k, v]) => [String(k), redact(v, depth + 1)]));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    let seen = 0;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (seen++ >= 50) break;
      out[key] = SENSITIVE_KEY.test(key) ? REDACTED : redact(entry, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Errors are reduced to name/message/code/status plus a redacted stack. The
 * stack is kept for developers but scrubbed of URLs and tokens, which is what
 * usually leaks credentials in provider errors.
 */
export interface SafeError {
  name: string;
  message: string;
  code?: string;
  status?: number;
  stack?: string[];
}

export function redactError(err: unknown): SafeError {
  if (!(err instanceof Error)) {
    return { name: 'UnknownError', message: redactString(String(err)) };
  }
  const extra = err as Error & { code?: unknown; status?: unknown };
  const stack = typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 8).map(redactString) : undefined;
  return {
    name: err.name,
    message: redactString(err.message),
    ...(typeof extra.code === 'string' ? { code: extra.code } : {}),
    ...(typeof extra.status === 'number' ? { status: extra.status } : {}),
    ...(stack ? { stack } : {}),
  };
}
