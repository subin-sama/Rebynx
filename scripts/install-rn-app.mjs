#!/usr/bin/env node
import { access, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function usage(exitCode = 0) {
  const stream = exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`Usage:
  npm run install:rn-app -- /path/to/react-native-app
  npm run install:rn-app -- /path/to/react-native-app --dest rebynx

Copies @rebynx/core and @rebynx/rn into the app and adds local file dependencies.

Options:
  --dest <dir>            Destination folder inside the app. Default: rebynx
  --no-package-json       Copy packages only; do not edit the app package.json
  -h, --help              Show this help
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    target: undefined,
    dest: 'rebynx',
    updatePackageJson: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '-h' || arg === '--help') usage(0);
    if (arg === '--no-package-json') {
      opts.updatePackageJson = false;
      continue;
    }
    if (arg === '--dest') {
      const value = argv[i + 1];
      if (!value || value.startsWith('-')) {
        throw new Error('--dest needs a folder name');
      }
      opts.dest = value;
      i += 1;
      continue;
    }
    if (arg.startsWith('--dest=')) {
      opts.dest = arg.slice('--dest='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    }
    if (opts.target) {
      throw new Error(`Unexpected extra path: ${arg}`);
    }
    opts.target = arg;
  }

  if (!opts.target) usage(1);
  if (opts.dest.includes('..') || path.isAbsolute(opts.dest)) {
    throw new Error('--dest must be a relative folder inside the app');
  }

  return opts;
}

async function assertDirectory(dir, label) {
  try {
    const info = await stat(dir);
    if (!info.isDirectory()) throw new Error(`${label} is not a directory: ${dir}`);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${label} does not exist: ${dir}`);
    throw error;
  }
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function packageFilePath(dest, packageName) {
  return `file:./${path.posix.join(dest.split(path.sep).join(path.posix.sep), 'packages', packageName)}`;
}

function shouldCopy(source, packageRoot) {
  const rel = path.relative(packageRoot, source);
  if (!rel) return true;
  const parts = rel.split(path.sep);
  if (parts.includes('node_modules')) return false;
  if (parts.includes('.turbo')) return false;
  if (rel.endsWith('.tsbuildinfo')) return false;
  return true;
}

async function copyPackage(packageName, destPackagesRoot) {
  const source = path.join(repoRoot, 'packages', packageName);
  const dest = path.join(destPackagesRoot, packageName);

  await assertDirectory(source, `packages/${packageName}`);
  await rm(dest, { recursive: true, force: true });
  await mkdir(path.dirname(dest), { recursive: true });
  await cp(source, dest, {
    recursive: true,
    filter: (item) => shouldCopy(item, source),
  });

  return dest;
}

async function patchCopiedRnPackage(rnDest) {
  const rnPackageJson = path.join(rnDest, 'package.json');
  const pkg = await readJson(rnPackageJson);
  pkg.dependencies = {
    ...pkg.dependencies,
    '@rebynx/core': 'file:../core',
  };
  await writeJson(rnPackageJson, pkg);
}

async function patchAppPackageJson(appRoot, dest) {
  const appPackageJson = path.join(appRoot, 'package.json');
  const pkg = await readJson(appPackageJson);
  pkg.dependencies = {
    ...pkg.dependencies,
    '@rebynx/core': packageFilePath(dest, 'core'),
    '@rebynx/rn': packageFilePath(dest, 'rn'),
  };
  await writeJson(appPackageJson, pkg);
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function installCommand(appRoot) {
  if (await exists(path.join(appRoot, 'package-lock.json'))) return 'npm install';
  if (await exists(path.join(appRoot, 'yarn.lock'))) return 'yarn install';
  return 'npm install # or yarn install';
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const appRoot = path.resolve(process.cwd(), opts.target);
  const appPackageJson = path.join(appRoot, 'package.json');
  const destPackagesRoot = path.join(appRoot, opts.dest, 'packages');

  await assertDirectory(appRoot, 'React Native app');
  await readJson(appPackageJson);

  const coreDest = await copyPackage('core', destPackagesRoot);
  const rnDest = await copyPackage('rn', destPackagesRoot);
  await patchCopiedRnPackage(rnDest);

  if (opts.updatePackageJson) {
    await patchAppPackageJson(appRoot, opts.dest);
  }

  const command = await installCommand(appRoot);
  process.stdout.write(`Rebynx packages installed into ${path.join(appRoot, opts.dest)}

Updated:
  - ${path.relative(appRoot, coreDest)}
  - ${path.relative(appRoot, rnDest)}
${opts.updatePackageJson ? `  - package.json\n` : ''}
Next:
  cd ${appRoot}
  ${command}

Then add initDevTools() and <DevToolsOverlay /> in your app root if they are not there yet.
`);
}

main().catch((error) => {
  process.stderr.write(`install-rn-app failed: ${error.message}\n`);
  process.exit(1);
});
