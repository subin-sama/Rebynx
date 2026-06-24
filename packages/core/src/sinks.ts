import type { DevCommand, DevEvent, Sink, WireMessage } from './types.js';

/**
 * In-process sink for the in-app overlay. The overlay subscribes and receives
 * every event synchronously — no socket involved. This is the "in-app" half of
 * the hybrid setup.
 */
export class MemorySink implements Sink {
  name = 'memory';
  private listeners = new Set<(e: DevEvent) => void>();
  private cmdListeners = new Set<(c: DevCommand) => void>();

  send(event: DevEvent): void {
    for (const l of this.listeners) l(event);
  }

  subscribe(listener: (e: DevEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onCommand(cmd: DevCommand): void {
    for (const l of this.cmdListeners) l(cmd);
  }

  subscribeCommand(listener: (c: DevCommand) => void): () => void {
    this.cmdListeners.add(listener);
    return () => this.cmdListeners.delete(listener);
  }

  dispose(): void {
    this.listeners.clear();
    this.cmdListeners.clear();
  }
}

/**
 * Streams events to the relay server over WebSocket — the "browser" half.
 * Uses the global WebSocket (built into React Native, browsers and Node 22+).
 *
 * Resilience: auto-reconnect with backoff, and a bounded outbound queue so
 * events emitted while disconnected are flushed on reconnect rather than lost.
 */
export class WebSocketSink implements Sink {
  name = 'ws';
  private ws?: WebSocket;
  private queue: DevEvent[] = [];
  private retry = 0;
  private disposed = false;

  constructor(
    private readonly url: string,
    private readonly onCommand?: (cmd: DevCommand) => void,
    private readonly maxQueue = 1000,
  ) {
    this.connect();
  }

  private connect(): void {
    try {
      this.ws = new WebSocket(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.retry = 0;
      this.raw({ kind: 'hello', role: 'app' });
      const pending = this.queue;
      this.queue = [];
      for (const e of pending) this.raw({ kind: 'event', event: e });
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as WireMessage;
        if (msg.kind === 'command') this.onCommand?.(msg.command);
      } catch {
        /* ignore malformed */
      }
    };

    this.ws.onclose = () => {
      if (!this.disposed) this.scheduleReconnect();
    };
    this.ws.onerror = () => {
      try {
        this.ws?.close();
      } catch {
        /* noop */
      }
    };
  }

  private scheduleReconnect(): void {
    const delay = Math.min(1000 * 2 ** this.retry++, 10_000);
    setTimeout(() => {
      if (!this.disposed) this.connect();
    }, delay);
  }

  private raw(msg: WireMessage): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  send(event: DevEvent): void {
    if (this.ws && this.ws.readyState === 1) {
      this.raw({ kind: 'event', event });
    } else {
      this.queue.push(event);
      if (this.queue.length > this.maxQueue) this.queue.shift();
    }
  }

  dispose(): void {
    this.disposed = true;
    try {
      this.ws?.close();
    } catch {
      /* noop */
    }
  }
}
