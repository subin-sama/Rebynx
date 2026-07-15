import { describe, it, expect, afterEach } from 'vitest';
import { RingBuffer, sanitize, formatArg, uid, configureRedaction } from './util.js';

describe('RingBuffer', () => {
  it('should keep size bounded', () => {
    const buffer = new RingBuffer<number>(3);
    expect(buffer.length).toBe(0);
    expect(buffer.toArray()).toEqual([]);

    buffer.push(1);
    buffer.push(2);
    buffer.push(3);
    expect(buffer.length).toBe(3);
    expect(buffer.toArray()).toEqual([1, 2, 3]);

    buffer.push(4);
    expect(buffer.length).toBe(3);
    expect(buffer.toArray()).toEqual([2, 3, 4]);
  });

  it('should support clearing', () => {
    const buffer = new RingBuffer<number>(3);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.length).toBe(2);
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.toArray()).toEqual([]);
  });
});

describe('sanitize redaction', () => {
  it('redacts deny-list keys but honours the allow-list exceptions', () => {
    const out = sanitize(
      { authorization: 'Bearer x', passwordPolicy: 'strong', normal: 1 },
      { allowKeys: ['passwordPolicy'] },
    ) as Record<string, unknown>;
    expect(out.authorization).toBe('[REDACTED]');
    expect(out.passwordPolicy).toBe('strong'); // exempted despite containing "password"
    expect(out.normal).toBe(1);
  });

  it('redacts common auth patterns by default', () => {
    const out = sanitize({ bearer: 'x', credential: 'y', api_key: 'z', jwt: 'w' }) as Record<string, unknown>;
    expect(out).toEqual({ bearer: '[REDACTED]', credential: '[REDACTED]', api_key: '[REDACTED]', jwt: '[REDACTED]' });
  });
});

describe('configureRedaction', () => {
  afterEach(() => configureRedaction({ redactKeys: [], allowKeys: [] })); // reset global state

  it('extends the deny list and applies the allow list to every sanitize() call', () => {
    configureRedaction({ redactKeys: ['deviceId'], allowKeys: ['passwordPolicy'] });
    const out = sanitize({ deviceId: 'x', authorization: 'y', passwordPolicy: 'z', name: 'n' }) as Record<string, unknown>;
    expect(out.deviceId).toBe('[REDACTED]');       // custom deny key
    expect(out.authorization).toBe('[REDACTED]');  // built-in defaults still apply
    expect(out.passwordPolicy).toBe('z');           // allow-list exception
    expect(out.name).toBe('n');
  });
});

describe('sanitize', () => {
  it('should convert primitive values correctly', () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(123)).toBe(123);
    expect(sanitize(true)).toBe(true);
    expect(sanitize('hello')).toBe('hello');
    expect(sanitize(undefined)).toBe('[undefined]');
    expect(sanitize(123n)).toBe('123n');
  });

  it('should format functions and symbols', () => {
    function testFn() {}
    expect(sanitize(testFn)).toBe('[Function testFn]');
    expect(sanitize(Symbol('test'))).toBe('Symbol(test)');
  });

  it('should handle array and string length bounds', () => {
    const longString = 'a'.repeat(20);
    expect(sanitize(longString, { maxString: 10 })).toBe('aaaaaaaaaa…(+10)');

    const largeArray = [1, 2, 3, 4, 5];
    expect(sanitize(largeArray, { maxArray: 3 })).toEqual([1, 2, 3, '…(+2 more)']);
  });

  it('should handle nested objects and circular references', () => {
    const obj: any = { a: 1, nested: { b: 2 } };
    obj.self = obj;

    const sanitized: any = sanitize(obj);
    expect(sanitized.a).toBe(1);
    expect(sanitized.nested.b).toBe(2);
    expect(sanitized.self).toBe('[Circular]');
  });

  it('should handle depth limits', () => {
    const deepObj = { level1: { level2: { level3: { level4: { val: 4 } } } } };
    const sanitized = sanitize(deepObj, { maxDepth: 2 }) as any;
    expect(sanitized.level1.level2).toBe('[…max depth]');
  });

  it('should redact sensitive keys case-insensitively', () => {
    const sensitive = {
      username: 'john_doe',
      authorization: 'Bearer token123',
      cookie: 'sess=abc',
      apiToken: 'secret_val',
      myPassword: 'password123',
      apiKey: 'key_123',
    };

    const sanitized = sanitize(sensitive) as any;
    expect(sanitized.username).toBe('john_doe');
    expect(sanitized.authorization).toBe('[REDACTED]');
    expect(sanitized.cookie).toBe('[REDACTED]');
    expect(sanitized.apiToken).toBe('[REDACTED]');
    expect(sanitized.myPassword).toBe('[REDACTED]');
    expect(sanitized.apiKey).toBe('[REDACTED]');
  });

  it('should support custom redaction keys', () => {
    const obj = {
      username: 'john',
      customSecretField: 'mySecret',
      normalField: 'val',
    };

    const sanitized = sanitize(obj, { redactKeys: ['customSecretField'] }) as any;
    expect(sanitized.username).toBe('john');
    expect(sanitized.customSecretField).toBe('[REDACTED]');
    expect(sanitized.normalField).toBe('val');
  });
});

describe('formatArg', () => {
  it('should format simple arguments', () => {
    expect(formatArg('hello')).toBe('hello');
    expect(formatArg({ a: 1 })).toBe('{"a":1}');
  });

  it('should format error objects', () => {
    const err = new Error('something failed');
    expect(formatArg(err)).toBe('Error: something failed');
  });
});

describe('uid', () => {
  it('should generate prefix based unique id', () => {
    const id1 = uid('test');
    const id2 = uid('test');
    expect(id1.startsWith('test')).toBe(true);
    expect(id1).not.toBe(id2);
  });
});
