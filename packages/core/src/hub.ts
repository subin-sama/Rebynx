import type { DevEvent, Emittable, Sink } from './types.js';
import { RingBuffer } from './util.js';

let seq = 0;

/**
 * The single point every collector talks to. It stamps id/ts, keeps a bounded
 * history (so a late-joining sink can be replayed), and fans each event out to
 * all registered sinks. Sinks are isolated: one throwing never blocks others.
 */
export class Hub {
  private sinks: Sink[] = [];
  private readonly buffer: RingBuffer<DevEvent>;

  constructor(bufferSize = 500) {
    this.buffer = new RingBuffer<DevEvent>(bufferSize);
  }

  /** Register a destination. Returns an unsubscribe fn. */
  addSink(sink: Sink): () => void {
    this.sinks.push(sink);
    return () => this.removeSink(sink);
  }

  removeSink(sink: Sink): void {
    this.sinks = this.sinks.filter((s) => s !== sink);
    sink.dispose?.();
  }

  /** Called by collectors. */
  emit(partial: Emittable): DevEvent {
    const event = { id: `e${++seq}`, ts: Date.now(), ...partial } as DevEvent;
    this.buffer.push(event);
    for (const sink of this.sinks) {
      try {
        sink.send(event);
      } catch {
        // never let a broken sink take down the app
      }
    }
    return event;
  }

  /** History for replay on (re)connect. */
  snapshot(): DevEvent[] {
    return this.buffer.toArray();
  }

  clear(): void {
    this.buffer.clear();
  }
}
