import { createRequire } from 'node:module';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

await rm(resolve('dist'), { recursive: true, force: true });

// 1. Preserve ssh2's Poly1305 implementation, compiling its Wasm as a Worker ES module.
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

// 2. Compile tunnelfetch's Chrome profile crypto + codec Wasm blobs as Worker ES modules.
const tfVendorDir = join(dirname(require.resolve('tunnelfetch/profile/chrome')), 'vendor');
for (const name of ['chacha20poly1305', 'mlkem768', 'brotli-dec', 'zstd-dec']) {
  const jsPath = join(tfVendorDir, `${name}.js`);
  const jsSource = await readFile(jsPath, 'utf8');
  const wasmB64 = jsSource.match(/const B64 = "([A-Za-z0-9+/=]+)";/)?.[1];
  if (!wasmB64) throw new Error(`Pinned tunnelfetch Wasm source changed for ${name}.js`);
  await writeFile(join(tfVendorDir, `${name}.worker.wasm`), Buffer.from(wasmB64, 'base64'));
  const adapted = jsSource
    .replace(/const B64 = "[A-Za-z0-9+/=]+";/, `import _wasmModule from './${name}.worker.wasm';`)
    .replace('new WebAssembly.Module(fromBase64(B64))', '_wasmModule');
  if (!adapted.includes('_wasmModule') || adapted.includes('new WebAssembly.Module(')) {
    throw new Error(`Failed to adapt WebAssembly.Module instantiation in ${name}.js`);
  }
  await writeFile(join(tfVendorDir, `${name}.worker.js`), adapted);
}
