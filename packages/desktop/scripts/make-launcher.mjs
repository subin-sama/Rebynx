// Generate a double-clickable Rebynx.app that launches the Electron devtools —
// no electron-builder needed. It wraps the electron binary already in the repo's
// node_modules, so it's a lightweight, personal-use launcher (tied to this repo
// path). For a self-contained, distributable bundle, use `npm run dist` instead.
//
//   node scripts/make-launcher.mjs [outputDir]   (default: ~/Applications)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoRoot = path.resolve(here, '..', '..', '..');

// Point at Electron's NATIVE binary, not node_modules/.bin/electron. The latter
// is a `#!/usr/bin/env node` script, and Finder launches apps with a minimal PATH
// that doesn't include a version-managed (nvm/asdf) node — so the app would fail
// to open. The native binary needs no node on PATH. `path.txt` holds its location
// inside dist (macOS: Electron.app/Contents/MacOS/Electron).
const electronDist = path.join(repoRoot, 'node_modules', 'electron', 'dist');
let binRel = 'Electron.app/Contents/MacOS/Electron';
try {
  const p = fs.readFileSync(path.join(repoRoot, 'node_modules', 'electron', 'path.txt'), 'utf8').trim();
  if (p) binRel = p;
} catch {
  /* fall back to the default macOS path */
}
const electronBin = path.join(electronDist, binRel);

if (!fs.existsSync(electronBin)) {
  console.error(`✗ Electron isn't installed (looked for ${electronBin}). Run \`npm install\` at the repo root first.`);
  process.exit(1);
}

const outDir = process.argv[2] || path.join(os.homedir(), 'Applications');
const appPath = path.join(outDir, 'Rebynx.app');
const macosDir = path.join(appPath, 'Contents', 'MacOS');
fs.mkdirSync(macosDir, { recursive: true });

// Launch script: exec the repo's electron on the desktop package.
fs.writeFileSync(
  path.join(macosDir, 'Rebynx'),
  `#!/bin/bash\nexec "${electronBin}" "${desktopDir}" "$@"\n`,
  { mode: 0o755 },
);

fs.writeFileSync(
  path.join(appPath, 'Contents', 'Info.plist'),
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Rebynx</string>
  <key>CFBundleDisplayName</key><string>Rebynx</string>
  <key>CFBundleIdentifier</key><string>com.bynx.rebynx.launcher</string>
  <key>CFBundleExecutable</key><string>Rebynx</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>10.13.0</string>
</dict>
</plist>
`,
);

// Ad-hoc code-sign so the bundle has a valid signature (Apple Silicon dislikes
// "no usable signature"). It's still unsigned-by-a-developer, so the FIRST launch
// needs a one-time Gatekeeper approval — see the note below.
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'ignore' });
} catch {
  /* codesign unavailable (non-macOS or Xcode CLT missing) — the app still runs */
}

console.log(`✔ Created ${appPath}`);
console.log(`  First launch: right-click Rebynx.app → Open (one-time Gatekeeper OK`);
console.log(`  for an unsigned app). After that, double-click / Launchpad / Spotlight work.`);
console.log(`  Note: tied to this repo path — re-run this if you move the repo.`);
