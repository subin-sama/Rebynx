// Rebynx desktop app: run the relay in Electron's Node main process and show the
// existing browser client in a window. The RN app on an emulator/device connects
// to ws://<LAN-IP>:9090 exactly as it would with `npm run server`.
import { app, BrowserWindow, shell } from 'electron';
import { createRelayServer } from '@rebynx/server/server';
import { lanIp, portInUse } from './lib/net-util.mjs';

const PORT = Number(process.env.DEVTOOLS_PORT ?? 9090);
let relay = null;

// Start our own relay unless one is already listening (e.g. `npm run server`).
async function ensureRelay() {
  if (await portInUse(PORT)) {
    console.log(`↺ Rebynx: reusing relay already on :${PORT}`);
    return;
  }
  relay = createRelayServer();
  await new Promise((resolve) => relay.listen(PORT, '0.0.0.0', resolve));
  console.log(`▶ Rebynx: relay started on :${PORT}`);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#16181d',
    title: `Rebynx  ·  app connects to  ws://${lanIp()}:${PORT}`,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://localhost:${PORT}`);
  // Keep our title (which shows the LAN address to point the RN app at) instead
  // of letting the page's <title>Rebynx</title> overwrite it.
  win.on('page-title-updated', (e) => e.preventDefault());
  // Open any external link in the real browser, not a bare Electron window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  return win;
}

app.whenReady().then(async () => {
  await ensureRelay();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (relay) {
    try { relay.close(); } catch { /* noop */ }
  }
  app.quit();
});
