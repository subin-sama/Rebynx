// Tiny network helpers for the desktop main process. No Electron import, so this
// module is unit-testable under vitest (see test/net-util.test.js).
import net from 'node:net';
import os from 'node:os';

/**
 * Resolve whether something is already listening on `port` by attempting a
 * connection. Resolves true on connect, false on refusal/timeout.
 */
export function portInUse(port, host = '127.0.0.1', timeout = 500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

/** First non-internal IPv4 address (what a device/emulator should dial), or 'localhost'. */
export function lanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}
