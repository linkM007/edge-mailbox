import { HTTP_METHODS, JobError } from '../src/protocol.js';
import { publicJobHttpsUrl } from '../src/url-policy.js';
import { resolveProxy } from './config.js';
import { createProxySession } from './proxy.js';

const MAX_CONCURRENT_REQUESTS = 6;
const MAX_TOTAL_BYTES = 25165824; // 24 MiB per interactive turn
const MAX_RESOURCE_BYTES = 8388608; // 8 MiB per individual asset
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const DROP_REQ_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-connection', 'proxy-authorization',
  'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length',
]);
const DROP_RESP_HEADERS = new Set([
  'content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive',
]);

function parseSetCookieForPlaywright(raw, targetUrl) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = raw.split(';').map(p => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const eq = parts[0].indexOf('=');
  if (eq <= 0) return null;
  const name = parts[0].slice(0, eq).trim();
  const value = parts[0].slice(eq + 1).trim();
  if (!name) return null;

  let domain = null;
  let path = null;
  let secure = targetUrl.protocol === 'https:';
  let httpOnly = false;
  let sameSite;
  let expires;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const idx = part.indexOf('=');
    const k = (idx >= 0 ? part.slice(0, idx) : part).trim().toLowerCase();
    const v = idx >= 0 ? part.slice(idx + 1).trim() : '';
    if (k === 'domain' && v) {
      const clean = v.replace(/^\.+/, '').toLowerCase();
      const host = targetUrl.hostname.toLowerCase();
      if (host === clean || host.endsWith(`.${clean}`)) domain = `.${clean}`;
      else return null;
    } else if (k === 'path' && v.startsWith('/')) {
      path = v;
    } else if (k === 'secure') {
      secure = true;
    } else if (k === 'httponly') {
      httpOnly = true;
    } else if (k === 'samesite') {
      const low = v.toLowerCase();
      if (low === 'none') sameSite = 'None';
      else if (low === 'strict') sameSite = 'Strict';
      else if (low === 'lax') sameSite = 'Lax';
    } else if (k === 'max-age') {
      const sec = Number(v);
      if (Number.isFinite(sec)) {
        expires = sec <= 0 ? 1 : Math.floor(Date.now() / 1000) + Math.min(sec, 34560000);
      }
    } else if (k === 'expires' && expires === undefined) {
      const ms = Date.parse(v);
      if (Number.isFinite(ms)) {
        expires = ms <= 0 ? 1 : Math.min(Math.floor(ms / 1000), Math.floor(Date.now() / 1000) + 34560000);
      }
    }
  }

  if (sameSite === 'None') secure = true;
  const cookie = {
    name,
    value,
    secure,
    httpOnly,
    ...(sameSite ? { sameSite } : {}),
    ...(expires !== undefined ? { expires } : {}),
  };
  if (domain) {
    cookie.domain = domain;
    cookie.path = path || '/';
  } else if (path && path !== '/') {
    cookie.domain = targetUrl.hostname;
    cookie.path = path;
  } else {
    cookie.url = targetUrl.origin;
  }
  return cookie;
}

function resolveLocator(page, step) {
  const idx = Number.isInteger(step.index) && step.index >= 0 ? step.index : 0;
  if (typeof step.selector === 'string' && step.selector.length) {
    return page.locator(step.selector).nth(idx);
  }
  if (typeof step.role === 'string' && step.role.length) {
    return page.getByRole(step.role, {
      ...(step.name !== undefined ? { name: String(step.name), exact: Boolean(step.exact) } : {}),
    }).nth(idx);
  }
  if (typeof step.label === 'string' && step.label.length) {
    return page.getByLabel(step.label, { exact: Boolean(step.exact) }).nth(idx);
  }
  if (typeof step.placeholder === 'string' && step.placeholder.length) {
    return page.getByPlaceholder(step.placeholder, { exact: Boolean(step.exact) }).nth(idx);
  }
  if (typeof step.text === 'string' && step.text.length) {
    return page.getByText(step.text, { exact: Boolean(step.exact) }).nth(idx);
  }
  throw new JobError('invalid_browser_step', 400);
}

export async function runBrowserSession(
  input,
  config,
  { acquireSession, connectSession, makeProxySession, disconnectAfterTurn = true, timeoutMs = 50000, signal } = {},
) {
  if (!config.allowDynamicUrls) throw new JobError('dynamic_url_not_enabled', 403);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new JobError('invalid_job', 400);
  if (typeof acquireSession !== 'function' || typeof connectSession !== 'function') {
    throw new JobError('browser_not_configured', 503);
  }
  const steps = input.steps ?? [];
  if (!Array.isArray(steps) || steps.length > 25) throw new JobError('invalid_job', 400);
  const proxy = makeProxySession ? null : resolveProxy(config, input.proxy);
  const keepAliveMs = Number.isInteger(input.keepAliveMs)
    ? Math.min(600000, Math.max(30000, input.keepAliveMs))
    : 300000;
  const settleMs = Number.isInteger(input.settleMs)
    ? Math.min(10000, Math.max(0, input.settleMs))
    : 1000;

  let sessionId = typeof input.sessionId === 'string' && input.sessionId.length ? input.sessionId : undefined;
  const isNewSession = !sessionId;
  let browser;
  let context;
  let proxySession;
  let stopped = false;
  let timer;
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
  const onSignalAbort = () => controller.abort();
  signal?.addEventListener('abort', onSignalAbort, { once: true });
  if (signal?.aborted) controller.abort();

  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      stopped = true;
      controller.abort();
      reject(new JobError('browser_timeout', 504));
    }, timeoutMs);
  });

  const run = async () => {
    proxySession = makeProxySession ? makeProxySession(input.proxy) : createProxySession(proxy);
    let reusedIdle = false;
    if (!sessionId) {
      const acquired = await acquireSession({ keepAliveMs });
      sessionId = acquired.sessionId;
      reusedIdle = Boolean(acquired.reused);
    }
    browser = await connectSession(sessionId);
    context = browser.contexts()[0] ?? await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: DEFAULT_UA,
    });
    if (reusedIdle) {
      await context.clearCookies().catch(() => {});
      const existingPages = context.pages();
      for (let i = 1; i < existingPages.length; i++) {
        await existingPages[i].close().catch(() => {});
      }
      if (existingPages[0]) {
        await existingPages[0].goto('about:blank').catch(() => {});
      }
    }
    let page = context.pages()[0];
    if (!page) {
      page = await context.newPage();
    }
    if (isNewSession) {
      await page.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
      await context.addInitScript(() => {
        for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
          try { Object.defineProperty(window, name, { value: undefined, configurable: true, writable: false }); } catch {}
        }
        try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch {}
      }).catch(() => {});
    }

    page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });

    const networkLog = [];
    await context.route('**/*', route => withSlot(async () => {
      if (stopped) { await route.abort().catch(() => {}); return; }
      const req = route.request();
      const rawUrl = req.url();
      if (rawUrl.startsWith('data:') || rawUrl.startsWith('blob:') || rawUrl === 'about:blank') {
        await route.continue().catch(() => {});
        return;
      }
      const method = req.method().toUpperCase();
      if (!HTTP_METHODS.includes(method)) {
        if (networkLog.length < 30) networkLog.push({ method, url: rawUrl.slice(0, 180), error: 'method_blocked' });
        await route.abort('blockedbyclient').catch(() => {});
        return;
      }
      let targetUrl;
      try {
        targetUrl = publicJobHttpsUrl(rawUrl);
      } catch (e) {
        if (networkLog.length < 30) networkLog.push({ method, url: rawUrl.slice(0, 180), error: e?.code || 'url_blocked' });
        await route.abort('blockedbyclient').catch(() => {});
        return;
      }
      if (byteBudget.used >= byteBudget.max) {
        if (networkLog.length < 30) networkLog.push({ method, url: rawUrl.slice(0, 180), error: 'budget_exceeded' });
        await route.abort('blockedbyclient').catch(() => {});
        return;
      }
      try {
        const topNavigation = req.isNavigationRequest() && req.frame() === page.mainFrame();
        const resType = req.resourceType();
        const rawHeaders = req.headers() ?? {};
        const allHeaders = await req.allHeaders().catch(() => rawHeaders);
        const mergedHeaders = { ...rawHeaders, ...allHeaders };
        const outHeaders = {};
        for (const [k, v] of Object.entries(mergedHeaders)) {
          const lower = k.toLowerCase();
          if (DROP_REQ_HEADERS.has(lower) || typeof v !== 'string' || /[\r\n\x00]/.test(v)) continue;
          if (lower === 'user-agent') {
            outHeaders[lower] = v.replaceAll('HeadlessChrome', 'Chrome');
          } else if (lower === 'sec-ch-ua') {
            outHeaders[lower] = v.replaceAll('HeadlessChrome', 'Google Chrome');
          } else {
            outHeaders[lower] = v;
          }
        }
        if (!outHeaders['user-agent']) outHeaders['user-agent'] = DEFAULT_UA;
        if (!outHeaders['accept-language']) outHeaders['accept-language'] = 'en-US,en;q=0.9';
        if (!outHeaders['sec-ch-ua']) {
          outHeaders['sec-ch-ua'] = '"Chromium";v="136", "Google Chrome";v="136", "Not.A/Brand";v="99"';
        }
        if (!outHeaders['sec-ch-ua-mobile']) outHeaders['sec-ch-ua-mobile'] = '?0';
        if (!outHeaders['sec-ch-ua-platform']) outHeaders['sec-ch-ua-platform'] = '"Windows"';

        let frameUrl = null;
        try {
          const candidate = req.frame()?.url() || page.url();
          if (candidate && candidate.startsWith('https://')) frameUrl = new URL(candidate);
        } catch {}

        const destMap = { script: 'script', stylesheet: 'style', image: 'image', font: 'font', document: 'iframe' };
        if (!outHeaders['sec-fetch-dest']) {
          outHeaders['sec-fetch-dest'] = topNavigation ? 'document' : (destMap[resType] ?? 'empty');
        }
        if (!outHeaders['sec-fetch-mode']) {
          outHeaders['sec-fetch-mode'] = topNavigation
            ? 'navigate'
            : (outHeaders['origin'] || resType === 'xhr' || resType === 'fetch' || resType === 'font' ? 'cors' : 'no-cors');
        }
        if (!outHeaders['sec-fetch-site']) {
          if (topNavigation && !outHeaders['referer'] && !frameUrl) {
            outHeaders['sec-fetch-site'] = 'none';
          } else if (frameUrl && frameUrl.origin === targetUrl.origin) {
            outHeaders['sec-fetch-site'] = 'same-origin';
          } else if (frameUrl && frameUrl.hostname.split('.').slice(-2).join('.') === targetUrl.hostname.split('.').slice(-2).join('.')) {
            outHeaders['sec-fetch-site'] = 'same-site';
          } else {
            outHeaders['sec-fetch-site'] = 'cross-site';
          }
        }
        if (topNavigation) {
          if (!outHeaders['sec-fetch-user']) outHeaders['sec-fetch-user'] = '?1';
          if (!outHeaders['upgrade-insecure-requests']) outHeaders['upgrade-insecure-requests'] = '1';
        } else if (frameUrl) {
          if (!outHeaders['referer']) outHeaders['referer'] = frameUrl.href;
          if (!outHeaders['origin'] && (!['GET', 'HEAD'].includes(method) || outHeaders['sec-fetch-mode'] === 'cors')) {
            outHeaders['origin'] = frameUrl.origin;
          }
        }

        if (!outHeaders['cookie']) {
          const jarCookies = await context.cookies(targetUrl.href).catch(() => []);
          if (jarCookies.length) {
            outHeaders['cookie'] = jarCookies.map(c => `${c.name}=${c.value}`).join('; ');
          }
        }

        const isNav = req.isNavigationRequest();
        const postBuf = req.postDataBuffer();
        const remaining = Math.max(1024, byteBudget.max - byteBudget.used);
        const upstream = await proxySession.fetch(targetUrl.href, {
          signal: controller.signal,
          limit: Math.min(MAX_RESOURCE_BYTES, remaining),
          budget: byteBudget,
          truncate: false,
          method,
          body: postBuf ? new Uint8Array(postBuf) : undefined,
          headers: outHeaders,
          maxRedirects: isNav ? 0 : 5,
          returnOnRedirect: isNav,
        });
        const setCookies = typeof upstream.headers.getSetCookie === 'function'
          ? upstream.headers.getSetCookie()
          : (upstream.headers.get('set-cookie') ? [upstream.headers.get('set-cookie')] : []);
        if (setCookies.length) {
          const parsed = setCookies.map(raw => parseSetCookieForPlaywright(raw, targetUrl)).filter(Boolean);
          if (parsed.length) await context.addCookies(parsed).catch(() => {});
        }
        if ((upstream.status >= 300 || method !== 'GET' || /auth|login|api|graphql/i.test(targetUrl.pathname)) && networkLog.length < 30) {
          const ct = upstream.headers.get('content-type') || '';
          const bodyPreview = upstream.status >= 400 && /json|text/i.test(ct) && upstream.bytes.byteLength > 0
            ? new TextDecoder().decode(upstream.bytes.subarray(0, 160))
            : undefined;
          networkLog.push({
            method,
            url: targetUrl.href.slice(0, 180),
            status: upstream.status,
            ...(upstream.headers.get('location') ? { location: upstream.headers.get('location').slice(0, 180) } : {}),
            ...(setCookies.length ? { setCookies: setCookies.length } : {}),
            ...(bodyPreview ? { bodyPreview } : {}),
          });
        }
        const fulfillHeaders = {};
        for (const [k, v] of upstream.headers) {
          const lower = k.toLowerCase();
          if (DROP_RESP_HEADERS.has(lower) || lower === 'set-cookie') continue;
          fulfillHeaders[lower] = v;
        }
        if (setCookies.length) {
          fulfillHeaders['set-cookie'] = setCookies.join('\n');
        }
        if (isNav && [301, 302, 303, 307, 308].includes(upstream.status) && upstream.headers.get('location')) {
          const nextUrl = publicJobHttpsUrl(new URL(upstream.headers.get('location'), targetUrl.href).href);
          const redirectHtml = `<!doctype html><html data-edge-redirect="1"><head><meta charset="utf-8"><script>location.replace(${JSON.stringify(nextUrl.href)})</script></head><body></body></html>`;
          await route.fulfill({
            status: 200,
            headers: {
              'content-type': 'text/html; charset=utf-8',
              'cache-control': 'no-store',
              ...(setCookies.length ? { 'set-cookie': setCookies.join('\n') } : {}),
            },
            body: Buffer.from(redirectHtml, 'utf8'),
          });
          return;
        }
        await route.fulfill({
          status: upstream.status,
          headers: fulfillHeaders,
          body: Buffer.from(upstream.bytes),
        });
      } catch (err) {
        if (networkLog.length < 30) {
          networkLog.push({ method, url: targetUrl.href.slice(0, 180), error: String(err?.code || err?.message || 'fetch_failed').slice(0, 100) });
        }
        await route.abort('failed').catch(() => {});
      }
    }));

    const waitOutRedirects = async maxMs => {
      const end = Date.now() + maxMs;
      while (Date.now() < end) {
        const isRedirectShim = await page.evaluate(() => Boolean(document.documentElement?.dataset?.edgeRedirect)).catch(() => true);
        if (!isRedirectShim) {
          await page.waitForLoadState('domcontentloaded', { timeout: Math.max(500, end - Date.now()) }).catch(() => {});
          const stillShim = await page.evaluate(() => Boolean(document.documentElement?.dataset?.edgeRedirect)).catch(() => false);
          if (!stillShim) break;
        }
        await new Promise(r => setTimeout(r, 200));
      }
    };

    const stepResults = [];
    let stepError = null;
    try {
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step || typeof step !== 'object') throw new JobError('invalid_browser_step', 400);
        const act = step.action;
        const stepTimeout = Number.isInteger(step.timeoutMs) ? Math.min(35000, Math.max(500, step.timeoutMs)) : 15000;
        if (act === 'goto') {
          const dest = publicJobHttpsUrl(step.url);
          const resp = await page.goto(dest.href, {
            waitUntil: ['load', 'domcontentloaded', 'networkidle', 'commit'].includes(step.waitUntil)
              ? step.waitUntil
              : 'domcontentloaded',
            timeout: stepTimeout,
          });
          await waitOutRedirects(stepTimeout);
          if (step.waitUntil === 'load') {
            await page.waitForLoadState('load', { timeout: Math.min(15000, stepTimeout) }).catch(() => {});
          }
          stepResults.push({ step: i, action: act, status: resp?.status() ?? null, url: page.url() });
        } else if (act === 'wait') {
          if (typeof step.selector === 'string' && step.selector.length) {
            await page.locator(step.selector).first().waitFor({
              state: ['visible', 'attached', 'hidden', 'detached'].includes(step.state) ? step.state : 'visible',
              timeout: stepTimeout,
            });
          }
          if (Number.isInteger(step.ms) && step.ms > 0) {
            await new Promise(r => setTimeout(r, Math.min(15000, step.ms)));
          }
          stepResults.push({ step: i, action: act, url: page.url() });
        } else if (act === 'click') {
          const loc = resolveLocator(page, step);
          await loc.click({ timeout: stepTimeout, force: Boolean(step.force) });
          await waitOutRedirects(5000);
          stepResults.push({ step: i, action: act, url: page.url() });
        } else if (act === 'fill') {
          const loc = resolveLocator(page, step);
          await loc.fill(String(step.value ?? ''), { timeout: stepTimeout });
          stepResults.push({ step: i, action: act });
        } else if (act === 'type') {
          const loc = resolveLocator(page, step);
          await loc.click({ timeout: stepTimeout });
          await loc.pressSequentially(String(step.value ?? ''), {
            delay: Number.isInteger(step.delayMs) ? Math.min(250, Math.max(0, step.delayMs)) : 35,
            timeout: stepTimeout,
          });
          stepResults.push({ step: i, action: act });
        } else if (act === 'press') {
          if (step.selector || step.role || step.label || step.placeholder || step.text) {
            const loc = resolveLocator(page, step);
            await loc.press(String(step.key || 'Enter'), { timeout: stepTimeout });
          } else {
            await page.keyboard.press(String(step.key || 'Enter'));
          }
          await waitOutRedirects(5000);
          stepResults.push({ step: i, action: act, url: page.url() });
        } else if (act === 'select') {
          const loc = resolveLocator(page, step);
          await loc.selectOption(step.value, { timeout: stepTimeout });
          stepResults.push({ step: i, action: act });
        } else {
          throw new JobError('invalid_browser_step', 400);
        }
      }
    } catch (err) {
      if (err instanceof JobError) throw err;
      stepError = String(err?.message || err).split('\n')[0].slice(0, 240);
    }

    if (settleMs > 0) {
      await new Promise(r => setTimeout(r, settleMs));
    }

    const activePages = context.pages();
    if (activePages.length > 1) {
      page = activePages[activePages.length - 1];
    }

    const title = (await page.title().catch(() => '')).slice(0, 512);
    const snapshot = await page.evaluate(() => {
      const visible = el => {
        if (!el || !el.getBoundingClientRect) return false;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const cssEscape = s => (window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, '\\$&'));
      const buildSelector = el => {
        if (el.id) return `#${cssEscape(el.id)}`;
        const tag = el.tagName.toLowerCase();
        if (el.name) return `${tag}[name="${el.name.replace(/"/g, '\\"')}"]`;
        if (el.getAttribute('aria-label')) return `${tag}[aria-label="${el.getAttribute('aria-label').replace(/"/g, '\\"')}"]`;
        if (el.getAttribute('placeholder')) return `${tag}[placeholder="${el.getAttribute('placeholder').replace(/"/g, '\\"')}"]`;
        return tag;
      };
      const nodes = Array.from(document.querySelectorAll(
        'input, textarea, select, button, [role="button"], [role="link"], [role="combobox"], [role="option"], [role="checkbox"], [role="radio"], [role="tab"], a[href]',
      ));
      const elements = [];
      for (const el of nodes) {
        if (!visible(el)) continue;
        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute('type') || '').toLowerCase();
        const labelEl = el.id ? document.querySelector(`label[for="${cssEscape(el.id)}"]`) : el.closest('label');
        elements.push({
          tag,
          ...(type ? { type } : {}),
          ...(el.name ? { name: el.name.slice(0, 80) } : {}),
          ...(el.id ? { id: el.id.slice(0, 80) } : {}),
          ...(el.getAttribute('role') ? { role: el.getAttribute('role').slice(0, 40) } : {}),
          ...(el.getAttribute('placeholder') ? { placeholder: el.getAttribute('placeholder').slice(0, 120) } : {}),
          ...(el.getAttribute('aria-label') ? { ariaLabel: el.getAttribute('aria-label').slice(0, 120) } : {}),
          ...(labelEl?.innerText ? { label: labelEl.innerText.trim().replace(/\s+/g, ' ').slice(0, 120) } : {}),
          text: (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 140),
          ...(tag === 'a' && el.href ? { href: el.href.slice(0, 240) } : {}),
          ...(type === 'password' ? { hasValue: Boolean(el.value) } : (el.value ? { value: String(el.value).slice(0, 120) } : {})),
          selector: buildSelector(el),
        });
        if (elements.length >= 80) break;
      }
      return {
        text: (document.body?.innerText ?? '').replace(/\u0000/g, '').slice(0, 16384),
        elements,
      };
    }).catch(() => ({ text: '', elements: [] }));

    const shot = await page.screenshot({ type: 'jpeg', quality: 78, animations: 'disabled', scale: 'css' });
    const cookies = await context.cookies().catch(() => []);

    await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    if (input.close === true) {
      try {
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send('Browser.close');
      } catch {}
    }

    return {
      type: 'browser_session',
      sessionId: input.close === true ? null : sessionId,
      closed: Boolean(input.close),
      url: page.url(),
      title,
      text: snapshot.text,
      elements: snapshot.elements,
      stepResults,
      ...(stepError ? { stepError } : {}),
      networkLog,
      cookiesCount: cookies.length,
      bytesFetched: byteBudget.used,
      proxyUsed: true,
      screenshot: {
        mimeType: 'image/jpeg',
        encoding: 'base64',
        data: Buffer.from(shot).toString('base64'),
      },
    };
  };

  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onSignalAbort);
    if (context) await context.unrouteAll({ behavior: 'ignoreErrors' }).catch(() => {});
    if (browser && (disconnectAfterTurn || input.close === true)) await browser.close().catch(() => {});
    if (proxySession) await proxySession.close().catch(() => {});
  }
}
