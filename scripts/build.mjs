/**
 * Build the deployable Worker bundle.
 *
 * Produces:
 *   dist/worker.js      single-file ES module bundle (no imports, no Node APIs)
 *   dist/public/        the static assets to upload
 *   dist/manifest.json  deployment manifest
 *
 * Bundling to one file keeps the deployment simple and makes it impossible to
 * ship a half-resolved import graph.
 */

import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');

const COMPATIBILITY_DATE = '2026-05-23';

async function main() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });

  const result = await build({
    entryPoints: [join(root, 'worker', 'index.js')],
    outfile: join(dist, 'worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    minify: false,
    sourcemap: false,
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
  });

  const outputs = Object.keys(result.metafile.outputs);
  if (outputs.length !== 1) {
    throw new Error(`Expected a single bundle output, got: ${outputs.join(', ')}`);
  }

  const bundleSize = (await stat(join(dist, 'worker.js'))).size;
  await assertNoNodeBuiltins(join(dist, 'worker.js'));

  await cp(join(root, 'public'), join(dist, 'public'), { recursive: true });

  const manifest = {
    entrypoint: 'worker.js',
    compatibilityDate: COMPATIBILITY_DATE,
    modules: [{ name: 'worker.js', type: 'esm', path: './worker.js' }],
    assetsDirectory: './public',
    spa: true,
  };
  await writeFile(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  const assets = await listFiles(join(dist, 'public'));
  console.log(`bundle     dist/worker.js  ${(bundleSize / 1024).toFixed(1)} KiB (${result.metafile.inputs ? Object.keys(result.metafile.inputs).length : '?'} inputs)`);
  console.log(`assets     ${assets.length} file(s)`);
  for (const asset of assets) console.log(`           - ${asset}`);
  console.log(`manifest   dist/manifest.json`);
}

/** The Worker runtime has no Node built-ins; fail loudly if one sneaks in. */
async function assertNoNodeBuiltins(bundlePath) {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(bundlePath, 'utf8');
  const offenders = ['require(', 'process.env', 'node:fs', 'node:path', '__dirname'].filter((needle) => source.includes(needle));
  if (offenders.length > 0) {
    throw new Error(`Bundle references Node-only APIs: ${offenders.join(', ')}`);
  }
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full)));
    else files.push(full.slice(dist.length + 1).replace(/\\/g, '/'));
  }
  return files.sort();
}

main().catch((error) => {
  console.error('Build failed:', error.message);
  process.exitCode = 1;
});
