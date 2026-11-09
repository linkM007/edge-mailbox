import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Preserve ssh2's Poly1305 implementation, but compile its Wasm at deployment time.
const require = createRequire(import.meta.url);
const root = join(dirname(require.resolve('ssh2/package.json')), 'lib/protocol/crypto');
const source = await readFile(join(root, 'poly1305.js'), 'utf8');
const base64 = source.match(/W="data:application\/octet-stream;base64,([A-Za-z0-9+/=]+)"/)?.[1];
if (!base64) throw new Error('Pinned ssh2 Wasm source changed; review the Worker adapter.');
await writeFile(join(root, 'poly1305.worker.wasm'), Buffer.from(base64, 'base64'));
await writeFile(join(root, 'poly1305.worker.js'), [
  "import wasm from './poly1305.worker.wasm';",
  "const create = require('./poly1305.js');",
  'module.exports = function(options = {}) {',
  '  return create({ ...options, instantiateWasm(imports, receive) {',
  '    const instance = new WebAssembly.Instance(wasm, imports);',
  '    receive(instance, wasm); return instance.exports;',
  '  } });',
  '}',
].join('\n'));
