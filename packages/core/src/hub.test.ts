import { describe, it, expect } from 'vitest';
import { Hub } from './hub.js';
import type { Sink, DevEvent } from './types.js';

describe('Hub', () => {
  it('should stamp id and timestamp on emitted events and push to buffer', () => {
    const hub = new Hub(10);
    const event = hub.emit({ type: 'log', level: 'info', message: 'Hello', args: [] });

    expect(event.id).toBeDefined();
    expect(event.ts).toBeLessThanOrEqual(Date.now());
    expect(event.type).toBe('log');
    expect(hub.snapshot()).toContainEqual(event);
  });

  it('should dispatch events to registered sinks', () => {
    const hub = new Hub();
    const received: DevEvent[] = [];
    const mockSink: Sink = {
      name: 'mock',
      send: (e) => received.push(e),
    };

    const unsub = hub.addSink(mockSink);
    const event = hub.emit({ type: 'log', level: 'warn', message: 'Warning', args: [] });

    expect(received).toEqual([event]);

    unsub();
    hub.emit({ type: 'log', level: 'error', message: 'Error', args: [] });
    expect(received).toHaveLength(1); // Should not receive post-unsubscribe events
  });

  it('should be resilient to crashing sinks', () => {
    const hub = new Hub();
    const received: DevEvent[] = [];

    const brokenSink: Sink = {
      name: 'broken',
      send: () => {
        throw new Error('Crash!');
      },
    };
    const goodSink: Sink = {
      name: 'good',
      send: (e) => received.push(e),
    };

    hub.addSink(brokenSink);
    hub.addSink(goodSink);

    // This should not throw
    const event = hub.emit({ type: 'log', level: 'info', message: 'Safe message', args: [] });
    expect(received).toEqual([event]); // Good sink still receives the event
  });
});
