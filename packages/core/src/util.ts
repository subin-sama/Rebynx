/** Fixed-size FIFO. Keeps memory bounded so a chatty app never bloats the heap. */
export class RingBuffer<T> {
  private buf: T[] = [];
  constructor(private readonly size: number) {}
  push(item: T): void {
    this.buf.push(item);
    if (this.buf.length > this.size) this.buf.shift();
  }
  toArray(): T[] {
    return this.buf.slice();
  }
  clear(): void {
    this.buf = [];
  }
  get length(): number {
    return this.buf.length;
  }
}

export interface SanitizeOpts {
  maxDepth?: number;
  maxString?: number;
  maxArray?: number;
  redactKeys?: string[];
}

const DEFAULT_REDACT_KEYS = [
  'authorization',
  'cookie',
  'token',
  'password',
  'secret',
  'apikey',
  'pwd',
  'privatekey',
  'passphrase',
  'ssn'
];

/**
 * Turn an arbitrary value into a JSON-safe clone.
 * Handles the three things that crash a naive JSON.stringify over a socket:
 * circular references, functions/symbols, and unbounded size.
 */
export function sanitize(value: unknown, opts: SanitizeOpts = {}): unknown {
  const { maxDepth = 6, maxString = 10_000, maxArray = 200 } = opts;
  const redactList = opts.redactKeys || DEFAULT_REDACT_KEYS;
  const seen = new WeakSet<object>();

  function walk(v: unknown, depth: number): unknown {
    if (v === null) return null;
    const t = typeof v;
    if (t === 'number' || t === 'boolean') return v;
    if (t === 'string') {
      const s = v as string;
      return s.length > maxString ? s.slice(0, maxString) + `…(+${s.length - maxString})` : s;
    }
    if (t === 'bigint') return `${v as bigint}n`;
    if (t === 'undefined') return '[undefined]';
    if (t === 'function') return `[Function ${(v as Function).name || 'anonymous'}]`;
    if (t === 'symbol') return (v as symbol).toString();
    if (depth >= maxDepth) return '[…max depth]';

    if (Array.isArray(v)) {
      const out = v.slice(0, maxArray).map((x) => walk(x, depth + 1));
      if (v.length > maxArray) out.push(`…(+${v.length - maxArray} more)`);
      return out;
    }
    if (v instanceof Error) {
      return { __error: true, name: v.name, message: v.message, stack: v.stack };
    }
    if (t === 'object') {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) return '[Circular]';
      seen.add(obj);
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj)) {
        try {
          const lowerK = k.toLowerCase();
          const shouldRedact = redactList.some(rk => lowerK.includes(rk.toLowerCase()));
          if (shouldRedact) {
            out[k] = '[REDACTED]';
          } else {
            out[k] = walk(obj[k], depth + 1);
          }
        } catch {
          out[k] = '[Unserializable]';
        }
      }
      return out;
    }
    return String(v);
  }

  return walk(value, 0);
}

/** Compact one-line representation for console.* messages. */
export function formatArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  try {
    return JSON.stringify(sanitize(a));
  } catch {
    return String(a);
  }
}

export function uid(prefix = 'e'): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}
