/**
 * Relay entrypoint. Building/wiring the server lives in `server.ts`; this file
 * is the thin runnable that starts it. Kept as a side-effecting entrypoint so
 * both `node dist/index.js` and `bin/cli.mjs` (which does `import('../dist/index.js')`)
 * start the relay on import. Tests import `createRelayServer` from `server.js`
 * instead, so importing never binds a port.
 */
import { createRelayServer, DEFAULT_FLOWS_DIR } from './server.js';

const PORT = Number(process.env.DEVTOOLS_PORT ?? 9090);
const HOST = process.env.DEVTOOLS_HOST ?? '0.0.0.0';

const server = createRelayServer();

server.listen(PORT, HOST, () => {
  console.log(`\n  Rebynx relay`);
  console.log(`  ├─ browser client : http://localhost:${PORT}`);
  console.log(`  ├─ listening on    : ${HOST}:${PORT}`);
  console.log(`  ├─ flows saved to  : ${DEFAULT_FLOWS_DIR}`);
  console.log(`  └─ app connects to: ws://<your-machine-ip>:${PORT}\n`);
});
