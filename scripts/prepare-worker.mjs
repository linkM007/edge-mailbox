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
const tfProfileDir = dirname(require.resolve('tunnelfetch/profile/chrome'));
const tfRoot = resolve(tfProfileDir, '../..');
const tfVendorDir = join(tfProfileDir, 'vendor');
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

// 3. Patch tunnelfetch@1.13.1 RFC 8446 §4.2.8 & §4.1.2 Chrome GREASE + HelloRetryRequest interop:
//    - Share the same GREASE group value between supported_groups[0] and key_share[0] (OpenSSL 3
//      rejects a key_share GREASE entry absent from supported_groups with fatal illegal_parameter).
//    - Preserve GREASE seed + shuffled extension order across HelloRetryRequest ClientHello2, and
//      send only the single HRR-selected key_share entry in ClientHello2.
const hsMessagesPath = join(tfRoot, 'src/tls/handshake-messages.js');
let hsMessages = await readFile(hsMessagesPath, 'utf8');
if (!hsMessages.includes('emittedExtensionOrder:')) {
  const beforeSeed = [
    '  grease = false,',
    '  randomBytes = defaultRandom,',
    '}) {',
    '  // A seed rather than ambient randomness: repo-hygiene forbids Math.random in src/ so that every',
    '  // byte this package puts on the wire is reproducible in a test, and a fingerprint that cannot be',
    '  // reproduced cannot be asserted byte-for-byte.',
    '  const g = grease === false || grease == null',
    '    ? null',
    "    : greaseSource(typeof grease === 'number' ? grease : ((randomBytes(4)[0] << 24) |",
    '        (randomBytes(4)[1] << 16) | (randomBytes(4)[2] << 8) | randomBytes(4)[3]) >>> 0);',
  ].join('\n');
  const afterSeed = [
    '  grease = false,',
    '  isRetry = false,',
    '  randomBytes = defaultRandom,',
    '}) {',
    '  const greaseSeed = grease === false || grease == null',
    '    ? null',
    "    : (typeof grease === 'number' ? grease >>> 0 : (((randomBytes(4)[0] << 24) |",
    '        (randomBytes(4)[1] << 16) | (randomBytes(4)[2] << 8) | randomBytes(4)[3]) >>> 0));',
    '  const g = greaseSeed === null ? null : greaseSource(greaseSeed);',
  ].join('\n');

  const beforeGroups = [
    '  const omit = new Set(omitExtensions);',
    '  const extensionParts = [',
    '    encodeServerName(hostname),',
    '    // Offered by default for either version: without it a server may not staple (RFC 6066 s8), and',
    '    // a stapled OCSP response is the only revocation signal this package can consume. It is also',
    '    // the one extension this package sends that curl does not, so an identity matching a sample',
    '    // without it needs a way to drop it — `omitExtensions` is the subtractive counterpart to',
    '    // `extraExtensions`, and dropping this one gives up stapling.',
    '    omit.has(EXTENSION.status_request) ? null : encodeStatusRequest(),',
    '    encodeSupportedGroups(g ? [g.take(), ...groups] : groups),',
    '    encodeSignatureAlgorithms(sigSchemes),',
    '    alpn.length ? encodeAlpn(alpn) : null,',
    '    offersTls13 ? encodeSupportedVersions(g ? [g.take(), ...versions] : versions) : null,',
    '    offersTls13',
    '      ? encodeKeyShare([',
    '          ...(g ? [greaseKeyShare(g.take())] : []),',
    '          ...keyShares.map(({ group, keyExchange }) => ({ group, keyExchange })),',
    '        ])',
    '      : null,',
  ].join('\n');
  const afterGroups = [
    '  const omit = new Set(omitExtensions);',
    '  const greaseGroup = g ? g.take() : null;',
    '  const extensionParts = [',
    '    encodeServerName(hostname),',
    '    omit.has(EXTENSION.status_request) ? null : encodeStatusRequest(),',
    '    encodeSupportedGroups(greaseGroup !== null ? [greaseGroup, ...groups] : groups),',
    '    encodeSignatureAlgorithms(sigSchemes),',
    '    alpn.length ? encodeAlpn(alpn) : null,',
    '    offersTls13 ? encodeSupportedVersions(g ? [g.take(), ...versions] : versions) : null,',
    '    offersTls13',
    '      ? encodeKeyShare([',
    '          ...(greaseGroup !== null && !isRetry ? [greaseKeyShare(greaseGroup)] : []),',
    '          ...keyShares.map(({ group, keyExchange }) => ({ group, keyExchange })),',
    '        ])',
    '      : null,',
  ].join('\n');

  const beforeLaid = [
    '  const laidReal =',
    '    extensionOrder === SHUFFLE_EXTENSIONS',
    '      ? shuffleExtensions(extensionParts.filter(Boolean), g ?? greaseSource(1), typeOf,',
    '          EXTENSION.pre_shared_key)',
    '      : orderExtensions(extensionParts, extensionOrder);',
    '',
    '  let laid = laidReal;',
    '  if (g) {',
    '    // Leading GREASE is empty, trailing carries a single zero byte — as captured from Chromium.',
    '    // The trailing one goes BEFORE any pre_shared_key, which must stay last of all.',
    '    const head = encodeRawExtension(g.take(), new Uint8Array(0));',
    '    const tail = encodeRawExtension(g.take(), Uint8Array.of(0));',
    '    const pskAt = laidReal.findIndex((e) => typeOf(e) === EXTENSION.pre_shared_key);',
    '    laid = pskAt === -1',
    '      ? [head, ...laidReal, tail]',
    '      : [head, ...laidReal.slice(0, pskAt), tail, ...laidReal.slice(pskAt)];',
    '  }',
  ].join('\n');
  const afterLaid = [
    '  const greaseHead = g ? g.take() : null;',
    '  const greaseTail = g ? g.take() : null;',
    '  const laidReal =',
    '    extensionOrder === SHUFFLE_EXTENSIONS',
    '      ? shuffleExtensions(extensionParts.filter(Boolean), g ?? greaseSource(1), typeOf,',
    '          EXTENSION.pre_shared_key)',
    '      : orderExtensions(extensionParts, extensionOrder);',
    '',
    '  let laid = laidReal;',
    '  if (g && greaseHead !== null && greaseTail !== null) {',
    '    const head = encodeRawExtension(greaseHead, new Uint8Array(0));',
    '    const tail = encodeRawExtension(greaseTail, Uint8Array.of(0));',
    '    const pskAt = laidReal.findIndex((e) => typeOf(e) === EXTENSION.pre_shared_key);',
    '    laid = pskAt === -1',
    '      ? [head, ...laidReal, tail]',
    '      : [head, ...laidReal.slice(0, pskAt), tail, ...laidReal.slice(pskAt)];',
    '  }',
  ].join('\n');

  const beforeOut = [
    '    offeredExtensions: offered,',
    '    offeredAlpn: alpn,',
    '  };',
  ].join('\n');
  const afterOut = [
    '    offeredExtensions: offered,',
    '    offeredAlpn: alpn,',
    '    greaseSeed,',
    '    emittedExtensionOrder: laidReal.map(typeOf),',
    '  };',
  ].join('\n');

  if (!hsMessages.includes(beforeSeed) || !hsMessages.includes(beforeGroups) ||
      !hsMessages.includes(beforeLaid) || !hsMessages.includes(beforeOut)) {
    throw new Error('Pinned tunnelfetch handshake-messages.js changed; review GREASE/HRR patch.');
  }
  hsMessages = hsMessages
    .replace(beforeSeed, afterSeed)
    .replace(beforeGroups, afterGroups)
    .replace(beforeLaid, afterLaid)
    .replace(beforeOut, afterOut);
  await writeFile(hsMessagesPath, hsMessages);
}

const hsPath = join(tfRoot, 'src/tls/handshake.js');
let hsDriver = await readFile(hsPath, 'utf8');
if (!hsDriver.includes('isRetry: true,')) {
  const beforeRetry = [
    '      extensionOrder: options.extensionOrder,',
    '      sigSchemes: options.sigSchemes,',
    '      grease: options.grease ?? false,',
    '      random: hello.clientRandom,',
  ].join('\n');
  const afterRetry = [
    '      extensionOrder: hello.emittedExtensionOrder ?? options.extensionOrder,',
    '      sigSchemes: options.sigSchemes,',
    '      grease: hello.greaseSeed ?? (options.grease ?? false),',
    '      isRetry: true,',
    '      random: hello.clientRandom,',
  ].join('\n');
  if (!hsDriver.includes(beforeRetry)) {
    throw new Error('Pinned tunnelfetch handshake.js changed; review HRR patch.');
  }
  hsDriver = hsDriver.replace(beforeRetry, afterRetry);
  await writeFile(hsPath, hsDriver);
}
