import { JobError } from '../src/protocol.js';
import { validateBrowserResult } from '../src/browser-result.js';
import { resolveBrowserJob, requestAllowed } from './config.js';
import { createProxySession } from './proxy.js';

const MAX_CONCURRENT_REQUESTS = 6;
const MAX_TOTAL_BYTES = 8388608;
const MAX_RESOURCE_BYTES = 2097152;
const DEFAULT_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';

export async function browse(input, config, { launch, timeoutMs = 40000, signal, requestResource } = {}) {
  if (typeof launch !== 'function') throw new JobError('browser_not_configured', 503);
  const target = resolveBrowserJob(input, config);
  let browser;
  let session;
  let stopped = false;
  let timer;
  let blockedRequests = 0;
  let failedSubresources = 0;
  let redirectCount = 0;
  let topBlocked = false;
  let budgetExceeded = false;
  let requestCount = 0;
  const byteBudget = { used: 0, max: MAX_TOTAL_BYTES };
  let active = 0;
  const waitQueue = [];
  const withSlot = async fn => {
    if (active >= MAX_CONCURRENT_REQUESTS) await new Promise(resolve => waitQueue.push(resolve));
    active++;
    try { return await fn(); }
    finally {
      active--;
      const next = waitQueue.shift();
      if (next) next();
    }
  };
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
  const dispatchResource = requestResource ?? (() => {
    session = createProxySession(target.proxy);
    return (url, _proxy, options) => session.fetch(url, options);
  })();
  const operation = async () => {
    if (stopped) throw new JobError('browser_timeout', 504);
    browser = await launch({
      headless: true,
      executablePath: config.executablePath,
      proxy: { ...target.proxy },
      chromiumSandbox: true,
      timeout: 15000,
      args: ['--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
    });
    if (stopped) { close(); throw new JobError('browser_timeout', 504); }
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      userAgent: DEFAULT_BROWSER_UA,
      serviceWorkers: 'block',
      acceptDownloads: false,
      ignoreHTTPSErrors: false,
    });
    await context.addInitScript(() => {
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'Worker', 'SharedWorker']) {
        Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false });
      }
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    const page = await context.newPage();
    context.on('page', popup => { if (popup !== page) void popup.close().catch(() => {}); });
    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
    await context.route('**/*', route => withSlot(async () => {
      if (stopped) { await route.abort().catch(() => {}); return; }
      const request = route.request();
      const topNavigation = request.isNavigationRequest() && request.frame() === page.mainFrame();
      try {
        if (requestAllowed(request.url(), request.method(), request.resourceType(), topNavigation, target)) {
          try {
            if (++requestCount > 100 || byteBudget.used >= byteBudget.max) {
              if (topNavigation) {
                budgetExceeded = true;
                throw new JobError('size_limit_exceeded', 413);
              }
              blockedRequests++;
              await route.abort('blockedbyclient');
              return;
            }
            const remaining = Math.max(1, byteBudget.max - byteBudget.used);
            const reqHeaders = request.headers() ?? {};
            const outboundHeaders = {
              accept: reqHeaders.accept ?? '*/*',
              'user-agent': (reqHeaders['user-agent'] ?? DEFAULT_BROWSER_UA).replace('HeadlessChrome/', 'Chrome/'),
              'accept-language': reqHeaders['accept-language'] ?? 'zh-CN,zh;q=0.9,en;q=0.8',
            };
            if (reqHeaders.referer && reqHeaders.referer.length <= 512) {
              try {
                const refUrl = new URL(reqHeaders.referer);
                if (refUrl.protocol === 'https:' && target.resourceOrigins.has(refUrl.origin)) {
                  outboundHeaders.referer = refUrl.href;
                }
              } catch {}
            }
            const response = await dispatchResource(request.url(), target.proxy, {
              signal: controller.signal,
              limit: Math.min(MAX_RESOURCE_BYTES, remaining),
              budget: byteBudget,
              maxRedirects: target.maxRedirects,
              allowedOrigins: topNavigation ? new Set([target.origin]) : target.resourceOrigins,
              headers: outboundHeaders,
            });
            redirectCount += response.redirectCount ?? 0;
            const headers = Object.fromEntries(response.headers);
            for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'set-cookie']) delete headers[name];
            await route.fulfill({ status: response.status, headers, body: Buffer.from(response.bytes) });
          } catch (error) {
            if (topNavigation) {
              if (error?.code === 'size_limit_exceeded') budgetExceeded = true;
              topBlocked = true;
              await route.abort('blockedbyclient');
            } else {
              failedSubresources++;
              await route.abort('failed');
            }
          }
        } else {
          blockedRequests++;
          if (topNavigation) topBlocked = true;
          await route.abort('blockedbyclient');
        }
      } catch {
        if (topNavigation) topBlocked = true;
        else failedSubresources++;
        void route.abort().catch(() => {});
      }
    }));
    page.setDefaultTimeout(5000);
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    if (budgetExceeded) throw new JobError('size_limit_exceeded', 413);
    if (topBlocked) throw new JobError('navigation_blocked', 403);
    if (target.waitForSelector) await page.waitForSelector(target.waitForSelector, { state: 'visible' });
    if (target.settleMs) await new Promise(resolve => setTimeout(resolve, target.settleMs));
    await page.evaluate(y => window.scrollTo(0, y), target.scrollY);
    const snapshot = await page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      const links = Array.from(document.querySelectorAll('a[href]')).slice(0, 200)
        .filter(link => link.getClientRects().length && /^https:\/\//.test(link.href) && link.href.length <= 1024)
        .slice(0, 30).map(link => {
          const url = new URL(link.href);
          return {
            text: (link.innerText || link.getAttribute('aria-label') || '').trim().slice(0, 120),
            href: url.href,
            path: (url.pathname + url.search + url.hash).slice(0, 1024),
            allowed: url.origin === location.origin && !url.username && !url.password,
          };
        });
      return {
        url: location.href,
        title: document.title.slice(0, 512),
        text: text.slice(0, 18000),
        textTruncated: text.length > 18000,
        links,
        scrollY: Math.round(window.scrollY),
        documentHeight: document.documentElement.scrollHeight,
      };
    });
    let selectedText;
    if (target.selector !== undefined) {
      selectedText = await page.evaluate(sel => {
        const el = document.querySelector(sel);
        return el ? (el.innerText ?? el.textContent ?? '').slice(0, 18000) : null;
      }, target.selector);
    }
    let screenshot;
    for (const quality of [55, 30, 15]) {
      screenshot = await page.screenshot({ type: 'jpeg', quality, fullPage: false, timeout: 5000 });
      if (screenshot.byteLength <= 245760) break;
    }
    if (budgetExceeded) throw new JobError('size_limit_exceeded', 413);
    if (topBlocked || new URL(snapshot.url).origin !== target.origin) throw new JobError('navigation_blocked', 403);
    if (screenshot.byteLength > 245760) throw new JobError('size_limit_exceeded', 413);
    return validateBrowserResult({
      type: 'browse',
      status: response?.status() ?? 200,
      ...snapshot,
      ...(selectedText !== undefined ? { selectedText } : {}),
      blockedRequests,
      failedSubresources,
      redirectCount,
      proxyUsed: true,
      screenshot: {
        mimeType: 'image/jpeg',
        encoding: 'base64',
        width: 1280,
        height: 800,
        data: screenshot.toString('base64'),
      },
    });
  };
  try { return await Promise.race([operation(), deadline]); }
  catch (error) {
    if (stopped) throw new JobError('browser_timeout', 504);
    if (budgetExceeded) throw new JobError('size_limit_exceeded', 413);
    if (topBlocked) throw new JobError('navigation_blocked', 403);
    if (error instanceof JobError) throw error;
    if (/\b429\b/.test(String(error?.message))) throw new JobError('browser_rate_limited', 429);
    throw new JobError(error?.name === 'TimeoutError' ? 'browser_timeout' : 'browser_navigation_failed', 502);
  } finally {
    stopped = true;
    signal?.removeEventListener('abort', onAbort);
    controller.abort();
    clearTimeout(timer);
    await session?.close().catch(() => {});
    if (browser) await Promise.race([browser.close().catch(() => {}),
      new Promise(resolve => { const cleanup = setTimeout(resolve, 2000); cleanup.unref?.(); })]);
  }
}
