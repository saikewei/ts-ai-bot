'use strict';

const fs = require('fs');
const path = require('path');

function pickExisting(paths) {
  for (const p of paths) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const root = __dirname ? path.resolve(__dirname, '..') : process.cwd();
const candidates = [
  path.join(root, 'target', 'debug', 'libtsclientlib_node.so'),
  path.join(root, 'target', 'release', 'libtsclientlib_node.so'),
  path.join(root, 'target', 'debug', 'libtsclientlib_node.dylib'),
  path.join(root, 'target', 'release', 'libtsclientlib_node.dylib'),
  path.join(root, 'target', 'debug', 'tsclientlib_node.dll'),
  path.join(root, 'target', 'release', 'tsclientlib_node.dll'),
];

const src = pickExisting(candidates);
if (!src) {
  console.error('Native library not found. Build first with cargo build.');
  process.exit(1);
}

const dst = path.join(root, 'index.node');
fs.copyFileSync(src, dst);
console.log(`Copied native addon: ${src} -> ${dst}`);
