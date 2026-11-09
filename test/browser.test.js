import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browse } from '../egress/browser.js';
import { validateBrowserResult } from '../src/browser-result.js';
import { saveBrowserResult } from '../cli/artifacts.js';

const config = { proxy: { server: 'http://proxy.example.com:10001', username: 'test', password: 'test' },
  BROWSER_TARGETS: { example: { url: 'https://example.com/', settleMs: 0 } } };
const result = { type: 'browse', proxyUsed: true, status: 200, url: 'https://example.com/',
  title: 'Rendered <script>alert(1)</script>', text: '<img src=x onerror=alert(1)>', links: [],
  screenshot: { width: 1280, height: 800, mimeType: 'image/jpeg', encoding: 'base64', data: '/9j/2Q==' } };

function fixture() {
  let handler; let closed = false; let fulfilled = false; let websocketBlocked = false;
  const frame = {};
  const page = { on() {}, mainFrame: () => frame, setDefaultTimeout() {},
    async goto() {
      await handler({ request: () => ({ url: () => 'https://example.com/', method: () => 'GET',
        resourceType: () => 'document', isNavigationRequest: () => true, frame: () => frame,
        headers: () => ({ accept: 'text/html' }) }),
      fulfill: async options => { fulfilled = options.body.toString() === '<h1>Rendered</h1>'; },
      abort: async () => { throw new Error('aborted'); } });
      return { status: () => 200 };
    },
    async evaluate(_fn, arg) { if (arg !== undefined) return; return { url: result.url, title: result.title, text: result.text, links: [] }; },
    async screenshot() { return Buffer.from('/9j/2Q==', 'base64'); } };
  const context = { on() {}, async addInitScript() {}, async newPage() { return page; },
    async route(_pattern, callback) { handler = callback; },
    async routeWebSocket(_pattern, callback) { callback({ close() { websocketBlocked = true; } }); } };
  const browser = { async newContext(options) { assert.equal(options.serviceWorkers, 'block'); return context; },
    async close() { closed = true; } };
  return { browser, state: () => ({ closed, fulfilled, websocketBlocked }) };
}

test('browser uses proxy resource fetch, closes sessions and produces bounded screenshots', async () => {
  const { browser, state } = fixture();
  const data = await browse({ type: 'browse', target: 'example' }, config, {
    launch: async options => { assert.deepEqual(options.proxy, config.proxy); return browser; },
    requestResource: async (url, proxy) => {
      assert.equal(url, 'https://example.com/'); assert.deepEqual(proxy, config.proxy);
      return { status: 200, headers: new Headers(), bytes: Buffer.from('<h1>Rendered</h1>') };
    },
  });
  assert.equal(data.proxyUsed, true);
  assert.deepEqual(state(), { closed: true, fulfilled: true, websocketBlocked: true });
});

test('late browser launch closes without navigation after deadline', async () => {
  let complete; let closed = false; let used = false;
  const task = browse({ type: 'browse', target: 'example' }, config, {
    timeoutMs: 5, launch: () => new Promise(resolve => { complete = resolve; }),
  });
  await assert.rejects(task, /browser_timeout/);
  complete({ close: async () => { closed = true; }, newContext: async () => { used = true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, true); assert.equal(used, false);
});

test('browser artifacts escape remote text, contain no remote HTML and never overwrite captures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'edge-mailbox-'));
  try {
    const out = await saveBrowserResult(result, join(root, 'capture'));
    const html = await readFile(out.preview, 'utf8');
    assert.equal(html.includes('<script>alert'), false);
    assert.ok(html.includes('&lt;script&gt;'));
    assert.ok(html.includes("default-src 'none'"));
    await assert.rejects(saveBrowserResult(result, join(root, 'capture')), { code: 'EEXIST' });
    assert.throws(() => validateBrowserResult({ ...result, proxyUsed: false }), /invalid_browser_result/);
    assert.throws(() => validateBrowserResult({ ...result, screenshot: { ...result.screenshot, data: 'bad' } }), /invalid_browser_result/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
