/**
 * Flow storage: persist a snapshot of network calls as a named, replayable
 * artifact on disk. One flow = one `<id>.json` file in the flows directory.
 *
 * Kept free of any HTTP concern so it can be unit-tested against a temp dir;
 * the server's index.ts is the thin routing glue on top.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

export interface FlowCall {
  seq: number;
  method?: string;
  url?: string;
  status?: number;
  ok?: boolean;
  duration?: number;
  request: { headers?: Record<string, string>; body?: unknown };
  response: { headers?: Record<string, string>; body?: unknown };
}

export interface Flow {
  id: string;
  name: string;
  createdAt: number;
  notes?: string;
  calls: FlowCall[];
}

/** Lightweight list item — no call bodies. */
export interface FlowSummary {
  id: string;
  name: string;
  createdAt: number;
  count: number;
}

export interface SaveFlowInput {
  name: string;
  notes?: string;
  calls: FlowCall[];
  /** Override the save timestamp (server stamps Date.now() by default). */
  createdAt?: number;
}

/** Turn a human name into a filesystem-safe slug. Never empty. */
export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'flow';
}

/** Accept an id only if it is a bare slug — blocks path traversal. */
export function safeId(id: string): string | null {
  return /^[a-z0-9-]+$/.test(id) ? id : null;
}

function fileFor(dir: string, id: string): string {
  return path.join(dir, `${id}.json`);
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function saveFlow(dir: string, input: SaveFlowInput): Promise<Flow> {
  await fs.mkdir(dir, { recursive: true });

  const base = slugify(input.name);
  let id = base;
  for (let n = 2; await exists(fileFor(dir, id)); n++) {
    id = `${base}-${n}`;
  }

  const flow: Flow = {
    id,
    name: input.name,
    createdAt: input.createdAt ?? Date.now(),
    notes: input.notes,
    calls: input.calls,
  };

  await fs.writeFile(fileFor(dir, id), JSON.stringify(flow, null, 2), 'utf8');
  return flow;
}

export async function listFlows(dir: string): Promise<FlowSummary[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return [];
  }

  const summaries: FlowSummary[] = [];
  for (const name of names) {
    if (name.startsWith('.') || !name.endsWith('.json')) continue; // skip dotfiles (e.g. .mock-state.json)
    try {
      const raw = await fs.readFile(path.join(dir, name), 'utf8');
      const flow = JSON.parse(raw) as Flow;
      summaries.push({
        id: flow.id,
        name: flow.name,
        createdAt: flow.createdAt,
        count: Array.isArray(flow.calls) ? flow.calls.length : 0,
      });
    } catch {
      // skip unreadable / malformed files
    }
  }

  return summaries.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getFlow(dir: string, id: string): Promise<Flow | null> {
  const clean = safeId(id);
  if (!clean) return null;
  try {
    const raw = await fs.readFile(fileFor(dir, clean), 'utf8');
    return JSON.parse(raw) as Flow;
  } catch {
    return null;
  }
}

/**
 * Adapter: an api-ui-mapper mock map -> a Rebynx flow (the inverse of
 * `flowToMockOverrides`). The map is `{ [path]: { endpoint?, statusCode, resBody } }`
 * with no method (the mock matcher's path-only fallback handles that). A JSON-string
 * `resBody` is parsed; anything else is kept verbatim. Non-object entries are skipped.
 */
export function mocksToFlow(
  mocks: Record<string, unknown>,
  name: string,
): { name: string; calls: FlowCall[] } {
  const calls: FlowCall[] = [];
  let seq = 1;
  for (const [key, raw] of Object.entries(mocks ?? {})) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const e = raw as { endpoint?: string; statusCode?: string | number; resBody?: unknown };
    const url = typeof e.endpoint === 'string' && e.endpoint ? e.endpoint : key;
    const status = parseInt(String(e.statusCode), 10) || 200;
    let body: unknown = e.resBody ?? null;
    if (typeof e.resBody === 'string') {
      try { body = JSON.parse(e.resBody); } catch { body = e.resBody; }
    }
    calls.push({
      seq: seq++,
      method: 'GET',
      url,
      status,
      ok: status < 400,
      request: { headers: {}, body: null },
      response: { headers: {}, body },
    });
  }
  return { name, calls };
}

/** Fields of a single call that can be edited in place. */
export interface CallPatch {
  method?: string;
  url?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  status?: number;
}

/**
 * Edit one call of a saved flow in place and persist it. Applies only the fields
 * present in `patch` (bodies are presence-checked so they can be set to null);
 * a new `status` recomputes `ok`. Returns the updated Flow, or null if the id or
 * seq is unknown.
 */
export async function updateCall(dir: string, id: string, seq: number, patch: CallPatch): Promise<Flow | null> {
  const clean = safeId(id);
  if (!clean) return null;
  const flow = await getFlow(dir, clean);
  if (!flow) return null;
  const call = flow.calls.find((c) => c.seq === seq);
  if (!call) return null;

  if (typeof patch.method === 'string') call.method = patch.method;
  if (typeof patch.url === 'string') call.url = patch.url;
  if ('requestBody' in patch) call.request = { ...call.request, body: patch.requestBody };
  if (patch.requestHeaders !== undefined) call.request = { ...call.request, headers: patch.requestHeaders };
  if ('responseBody' in patch) call.response = { ...call.response, body: patch.responseBody };
  if (patch.responseHeaders !== undefined) call.response = { ...call.response, headers: patch.responseHeaders };
  if (typeof patch.status === 'number') {
    call.status = patch.status;
    call.ok = patch.status < 400;
  }

  await fs.writeFile(fileFor(dir, clean), JSON.stringify(flow, null, 2), 'utf8');
  return flow;
}

export async function deleteFlow(dir: string, id: string): Promise<boolean> {
  const clean = safeId(id);
  if (!clean) return false;
  try {
    await fs.unlink(fileFor(dir, clean));
    return true;
  } catch {
    return false;
  }
}
