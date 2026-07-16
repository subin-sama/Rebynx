/**
 * Resolve *which line of your code* fired an API call.
 *
 * The RN collector captures `new Error().stack` when a request starts, but under
 * Hermes/Metro those frames point at the **bundle** (index.bundle:1:12345), not
 * your source — Metro doesn't source-map Error.stack (that's why LogBox
 * symbolicates explicitly). So: parse the stack, pick the first frame that isn't
 * library code, and ask Metro's /symbolicate endpoint to map it back to a real
 * file:line. The relay runs on the same machine as Metro, so it can just ask.
 *
 * Pure parsing + a single fetch, kept out of server.ts so it unit-tests on its own.
 */

export interface Frame {
  methodName: string;
  file: string;
  lineNumber: number;
  column: number;
}

// "    at fn (file:line:col)" / "    at fn (address at file:line:col)"  (V8, Hermes)
const V8_FN = /^\s*at\s+(.+?)\s+\((?:address at\s+)?(.+?):(\d+):(\d+)\)\s*$/;
// "    at file:line:col"                                                (V8, anonymous)
const V8_BARE = /^\s*at\s+(?:address at\s+)?(.+?):(\d+):(\d+)\s*$/;
// "fn@file:line:col"                                                    (JSC, Hermes)
const JSC = /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/;

/** Parse an Error.stack into frames. Unrecognised lines are skipped. */
export function parseStack(stack: string): Frame[] {
  const out: Frame[] = [];
  for (const line of String(stack ?? '').split('\n')) {
    let m = line.match(V8_FN);
    if (m) {
      out.push({ methodName: m[1], file: m[2], lineNumber: Number(m[3]), column: Number(m[4]) });
      continue;
    }
    m = line.match(V8_BARE);
    if (m) {
      out.push({ methodName: '', file: m[1], lineNumber: Number(m[2]), column: Number(m[3]) });
      continue;
    }
    m = line.match(JSC);
    if (m) {
      out.push({ methodName: m[1], file: m[2], lineNumber: Number(m[3]), column: Number(m[4]) });
    }
  }
  return out;
}

// Frames we never want to blame: the devtools itself, deps (axios/fetch wrappers),
// RN internals, and native/bytecode frames.
const LIB = /node_modules|rebynx|react-native[/\\]Libraries|\[native code\]|InternalBytecode/i;

/** The first frame that looks like the app's own code (else the first frame). */
export function firstAppFrame(frames: Frame[]): Frame | null {
  if (!frames.length) return null;
  return frames.find((f) => !LIB.test(f.file)) ?? frames[0];
}

/**
 * Ask Metro to map bundle frames back to source frames. Returns null on any
 * failure (Metro not running, error, timeout) — a missing call site must never
 * break event relaying.
 */
export async function symbolicate(frames: Frame[], metroUrl: string, timeoutMs = 1500): Promise<Frame[] | null> {
  if (!frames.length) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${metroUrl.replace(/\/+$/, '')}/symbolicate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ stack: frames }),
      signal: ctl.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { stack?: Frame[] };
    return Array.isArray(json?.stack) ? json.stack : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
