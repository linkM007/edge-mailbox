import { JobError } from '../src/protocol.js';
import { validateBrowserResult } from '../src/browser-result.js';
import { resolveBrowserJob, requestAllowed } from './config.js';
import { proxyFetch } from './proxy.js';

export async function browse(input, config, { launch, timeoutMs = 40000, signal, requestResource = proxyFetch } = {}) {
  if (typeof launch !== 'function') throw new JobError('browser_not_configured', 503);
  const target = resolveBrowserJob(input, config);
  let browser;
  let stopped = false;
  let timer;
  let blockedRequests = 0;
  let topBlocked = false;
  let routeFailed = false;
  let requestCount = 0;
  let transferred = 0;
  let requests = Promise.resolve();
  const controller = new AbortController();
  const close = () => { if (browser) void browser.close().catch(() => {}); };
  const deadline = new Promise((_, reject) => {
    const abort = () => { stopped = true; controller.abort(); close(); reject(new JobError('browser_timeout', 504)); };
    timer = setTimeout(abort, timeoutMs);
    controller.signal.addEventListener('abort', () => { if (!stopped) abort(); }, { once: true });
  });
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) controller.abort();
  const operation = async () => {
    if (stopped) throw new JobError('browser_timeout', 504);
    browser = await launch({ headless: true, executablePath: config.executablePath,
      proxy: { ...config.proxy }, chromiumSandbox: true, timeout: 15000,
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] });
    if (stopped) { close(); throw new JobError('browser_timeout', 504); }
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1, serviceWorkers: 'block', acceptDownloads: false, ignoreHTTPSErrors: false });
    await context.addInitScript(() => {
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker']) {
        Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false });
      }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}); });
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    await context.route('**/*', route => {
      const current = requests.then(async () => {
      if (stopped) { await route.abort(); return; }
      const request = route.request();
      try {
        const topNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
        if (requestAllowed(request.url(), request.method(), request.resourceType(), topNavigation, target)) {
          // Explicit dispatch applies the same proxy and redirect policy to every resource.
          try {
            if (++requestCount > 100 || transferred >= 8388608) throw new JobError('size_limit_exceeded', 413);
            const response = await requestResource(request.url(), config.proxy, { signal: controller.signal,
              limit: Math.min(2097152, 8388608 - transferred), headers: { accept: request.headers().accept ?? '*/*' } });
            transferred += response.bytes.byteLength;
            const headers = Object.fromEntries(response.headers);
            for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'set-cookie']) delete headers[name];
            await route.fulfill({ status: response.status, headers, body: Buffer.from(response.bytes) });
          } catch (error) {
            if (topNavigation) topBlocked = true;
            routeFailed = true;
            await route.abort('blockedbyclient');
          }
        } else {
          blockedRequests++;
          if (topNavigation) topBlocked = true;
          await route.abort('blockedbyclient');
        }
      } catch { routeFailed = true; void route.abort().catch(() => {}); }
      });
      requests = current.catch(() => {});
      return current;
    });
    page.setDefaultTimeout(5000);
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (target.waitForSelector) await page.waitForSelector(target.waitForSelector, { state: 'visible' });
    if (target.settleMs) await new Promise(resolve => setTimeout(resolve, target.settleMs));
    await page.evaluate(y => window.scrollTo(0, y), target.scrollY);
    const snapshot = await page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 200)
        .filter(link => link.getClientRects().length && /^https:\/\//.test(link.href) && link.href.length <= 1024)
        .slice(0, 30).map(link => {
          const url = new URL(link.href);
          return { text: (link.innerText || link.getAttribute('aria-label') || '').trim().slice(0, 120),
            href: url.href, path: (url.pathname + url.search + url.hash).slice(0, 1024),
            allowed: url.origin === location.origin && !url.username && !url.password };
        });
      return { url: location.href, title: document.title.slice(0, 512), text: text.slice(0, 18000),
        textTruncated: text.length > 18000, links, scrollY: Math.round(window.scrollY),
        documentHeight: document.documentElement.scrollHeight };
    });
    let screenshot;
    for (const quality of [55, 30, 15]) {
      screenshot = await page.screenshot({ type: 'jpeg', quality, fullPage: false, timeout: 5000 });
      if (screenshot.byteLength <= 245760) break;
    }
    if (topBlocked || routeFailed || new URL(snapshot.url).origin !== target.origin) throw new JobError('navigation_blocked', 403);
    if (screenshot.byteLength > 245760) throw new JobError('size_limit_exceeded', 413);
    return validateBrowserResult({ type: 'browse', status: response?.status() ?? 200, ...snapshot,
      blockedRequests, proxyUsed: true, screenshot: { mimeType: 'image/jpeg', encoding: 'base64',
        width: 1280, height: 800, data: screenshot.toString('base64') } });
  };
  try { return await Promise.race([operation(), deadline]); }
  catch (error) {
    if (stopped) throw new JobError('browser_timeout', 504);
    if (topBlocked) throw new JobError('navigation_blocked', 403);
    if (error instanceof JobError) throw error;
    if (/\b429\b/.test(String(error?.message))) throw new JobError('browser_rate_limited', 429);
    throw new JobError(error?.name === 'TimeoutError' ? 'browser_timeout' : 'browser_navigation_failed', 502);
  } finally {
    stopped = true;
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
    clearTimeout(timer);
    if (browser) await Promise.race([browser.close().catch(() => {}),
      new Promise(resolve => { const cleanup = setTimeout(resolve, 2000); cleanup.unref?.(); })]);
  }
}
