import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export const UPSTREAM_COMMIT = 'c389f96bf3a9b6807cb71ed6bdad5849be0df6d8';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const plugin = path.join(root, 'assets/plugins/dsh-aio-ui-compat');
const require = createRequire(path.join(root, 'package.json'));
const { build } = createRequire(path.join(root, 'tauri-app/package.json'))('esbuild');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const upstreamFiles = [
  'packages/client/ui-attachment/src/MessageImage.tsx',
  'packages/client/ui-attachment/src/ImageLightbox.tsx',
  'packages/client/ui-attachment/src/MessageImage.module.css',
  'packages/client/ui-attachment/src/ImageLightbox.module.css',
  'LICENSE',
];

export async function buildCompat(upstream, { check = false } = {}) {
  if (!upstream) throw new Error('Required: --upstream <official source checkout>');
  upstream = path.resolve(upstream);
  const git = (...args) => execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' });
  if (git('rev-parse', 'HEAD').trim() !== UPSTREAM_COMMIT) {
    throw new Error(`Upstream must be pinned to ${UPSTREAM_COMMIT}`);
  }
  const sources = new Map();
  const hashes = {};
  for (const file of upstreamFiles) {
    const committed = git('show', `${UPSTREAM_COMMIT}:${file}`);
    const working = await fs.readFile(path.join(upstream, file), 'utf8');
    if (working.replace(/\r\n/g, '\n') !== committed.replace(/\r\n/g, '\n')) {
      throw new Error(`Modified upstream source: ${file}`);
    }
    sources.set(path.resolve(upstream, file), committed);
    hashes[file] = sha256(committed);
  }
  const surfacePath = require.resolve('@deepseek-ai/dsh-session/surface');
  const surfacePackage = require('@deepseek-ai/dsh-session/package.json');
  const result = await build({
    entryPoints: [path.join(plugin, 'src/client.tsx')],
    outfile: path.join(plugin, 'lib/client.js'),
    absWorkingDir: plugin,
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    minify: true,
    sourcemap: false,
    legalComments: 'none',
    write: false,
    metafile: true,
    external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'],
    plugins: [{
      name: 'pinned-upstream',
      setup(api) {
        api.onResolve({ filter: /^aio-upstream-gallery$/ }, () => ({
          path: path.resolve(upstream, upstreamFiles[0]),
        }));
        api.onResolve({ filter: /^@deepseek-ai\/dsh-session\/surface$/ }, () => ({
          path: surfacePath,
        }));
        api.onLoad({ filter: /\.(tsx|module\.css)$/ }, ({ path: file }) => {
          const contents = sources.get(file);
          if (contents === undefined) return;
          return { contents, loader: file.endsWith('.css') ? 'local-css' : 'tsx',
            resolveDir: path.dirname(file) };
        });
      },
    }],
  });
  const css = result.outputFiles.find(file => file.path.endsWith('.css'))?.text;
  const js = result.outputFiles.find(file => file.path.endsWith('.js'))?.text;
  if (!css || !js || js.split('"__AIO_CSS_PAYLOAD__"').length !== 2) {
    throw new Error('Missing CSS payload or unexpected bundle shape');
  }
  const allowed = new Set(['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives']);
  for (const output of Object.values(result.metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !allowed.has(dependency.path)) {
        throw new Error(`Unexpected client dependency: ${dependency.path}`);
      }
    }
  }
  const body = js.replace('"__AIO_CSS_PAYLOAD__"', () => JSON.stringify(css));
  const client = `/*! MIT - Copyright (c) 2026 DeepSeek. See LICENSE and PROVENANCE.json. */\nwindow.__ModuleLoader__.load({id:"dsh-aio-ui-compat",factory:(require)=>{var module={exports:{}};var exports=module.exports;\n${body}\nreturn module.exports;}});\n`;
  if (/sourceMappingURL|sourceURL|[A-Za-z]:[\\/]|packages\/client\/|node_modules\//.test(client)) {
    throw new Error('Source path or source map leaked into client');
  }
  const bundledSources = {};
  for (const input of Object.keys(result.metafile.inputs).sort()) {
    const absolute = path.resolve(plugin, input);
    if (absolute.startsWith(path.join(root, 'node_modules') + path.sep)) {
      bundledSources[path.relative(root, absolute).split(path.sep).join('/')] =
        sha256(await fs.readFile(absolute));
    }
  }
  const provenance = JSON.stringify({
    upstream: 'https://github.com/deepseek-ai/deepseek-harness',
    commit: UPSTREAM_COMMIT,
    license: 'MIT',
    upstreamSources: hashes,
    session: { name: surfacePackage.name, version: surfacePackage.version, bundledSources },
    clientSha256: sha256(client),
  }, null, 2) + '\n';
  const outputs = new Map([
    ['lib/client.js', client],
    ['LICENSE', sources.get(path.join(upstream, 'LICENSE'))],
    ['PROVENANCE.json', provenance],
  ]);
  if (!check) await fs.mkdir(path.join(plugin, 'lib'), { recursive: true });
  for (const [file, contents] of outputs) {
    if (check) {
      if (await fs.readFile(path.join(plugin, file), 'utf8') !== contents) {
        throw new Error(`Stale compatibility artifact: ${file}`);
      }
    } else {
      await fs.writeFile(path.join(plugin, file), contents);
    }
  }
  return { bytes: Buffer.byteLength(client) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== '--upstream') {
      throw new Error('Usage: node scripts/build-aio-ui-compat.mjs --upstream <official source checkout>');
    }
    console.log(await buildCompat(args[1]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
