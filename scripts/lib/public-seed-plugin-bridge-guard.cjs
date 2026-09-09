'use strict';

// Preload only in the disposable smoke children, never in a running desktop.
const fs = require('node:fs');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');
const root = fs.realpathSync(process.env.DSH_BRIDGE_SMOKE_ROOT || '');
if (!path.basename(root).startsWith('public-seed-plugin-bridge-')) {
  throw new Error('Missing isolated plugin bridge smoke root');
}
function inside(value) {
  const target = path.resolve(value instanceof URL ? fileURLToPath(value) : String(value));
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`SMOKE_WRITE_OUTSIDE_ROOT: ${target}`);
  }
  let ancestor = target;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const actual = fs.realpathSync(ancestor);
  const actualRel = path.relative(root, actual);
  if (actualRel.startsWith('..') || path.isAbsolute(actualRel)) {
    throw new Error(`SMOKE_WRITE_THROUGH_LINK: ${target}`);
  }
}
for (const name of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'rmdirSync']) {
  const original = fs[name];
  fs[name] = function (target, ...args) {
    inside(target);
    return original.call(this, target, ...args);
  };
}
for (const name of ['copyFileSync', 'cpSync', 'renameSync']) {
  const original = fs[name];
  fs[name] = function (source, destination, ...args) {
    if (name === 'renameSync') inside(source);
    inside(destination);
    return original.call(this, source, destination, ...args);
  };
}
function deny(kind) {
  return function () {
    process.stderr.write(`SMOKE_BLOCKED:${kind}\n`);
    throw new Error(`SMOKE_OFFLINE: ${kind} is forbidden`);
  };
}
globalThis.fetch = deny('fetch');
require('node:net').Socket.prototype.connect = deny('socket');
require('node:net').Server.prototype.listen = deny('server');
require('node:tls').connect = deny('tls');
for (const protocol of ['node:http', 'node:https']) {
  const module = require(protocol);
  module.request = deny('http');
  module.get = deny('http');
}
const processes = require('node:child_process');
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  processes[name] = deny(`child_process.${name}`);
}
syncBuiltinESMExports();
