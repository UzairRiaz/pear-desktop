// Bundles the smooth-crossfade tests with esbuild (no test runner in the repo handles
// plain TS unit tests) and runs them with Node's built-in runner.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const pnpmDir = join(root, 'node_modules/.pnpm');
const esbuildDir = readdirSync(pnpmDir).find((d) => d.startsWith('esbuild@'));
const require = createRequire(
  join(pnpmDir, esbuildDir, 'node_modules/esbuild/'),
);
const esbuild = require('esbuild');

const pluginDir = join(root, 'src/plugins/smooth-crossfade');
const testFiles = readdirSync(pluginDir, { recursive: true })
  .filter((file) => file.endsWith('.test.ts'))
  .map((file) => join(pluginDir, file));

const outdir = mkdtempSync(join(tmpdir(), 'crossfade-tests-'));
esbuild.buildSync({
  entryPoints: testFiles,
  bundle: true,
  platform: 'node',
  format: 'esm',
  outdir,
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
});

const bundles = readdirSync(outdir, { recursive: true })
  .filter((file) => file.endsWith('.mjs'))
  .map((file) => join(outdir, file));
execFileSync(process.execPath, ['--test', ...bundles], { stdio: 'inherit' });
