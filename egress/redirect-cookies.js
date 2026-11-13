function normalizeHost(h) {
  return String(h || '').toLowerCase().replace(/\.$/, '');
}

function domainMatches(host, cookieDomain, hostOnly) {
  const h = normalizeHost(host);
  const d = normalizeHost(cookieDomain);
  if (!h || !d) return false;
  if (hostOnly) return h === d;
  return h === d || (d.includes('.') && h.endsWith('.' + d));
}

function defaultCookiePath(pathname) {
  if (!pathname || !pathname.startsWith('/')) return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

function pathMatches(reqPath, cookiePath) {
  const p = reqPath || '/';
  const cp = cookiePath || '/';
  if (p === cp) return true;
  if (p.startsWith(cp)) return cp.endsWith('/') || p[cp.length] === '/';
  return false;
}

function sameSiteHost(hostA, hostB) {
  const a = normalizeHost(hostA);
  const b = normalizeHost(hostB);
  if (a === b) return true;
  return (b.includes('.') && a.endsWith('.' + b)) || (a.includes('.') && b.endsWith('.' + a));
}

function parseSetCookie(raw, originUrl) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = raw.split(';').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const eq = parts[0].indexOf('=');
  if (eq <= 0) return null;
  const name = parts[0].slice(0, eq).trim();
  const value = parts[0].slice(eq + 1).trim();
  if (!name || /[\r\n\x00;]/.test(name) || /[\r\n\x00;]/.test(value)) return null;

  const originHost = normalizeHost(originUrl.hostname);
  let domain = originHost;
  let hostOnly = true;
  let path = defaultCookiePath(originUrl.pathname);
  let secure = false;
  let expired = false;

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i];
    const aEq = attr.indexOf('=');
    const k = (aEq === -1 ? attr : attr.slice(0, aEq)).trim().toLowerCase();
    const v = aEq === -1 ? '' : attr.slice(aEq + 1).trim();
    if (k === 'domain' && v) {
      const clean = normalizeHost(v.replace(/^\.+/, ''));
      if (!clean || !clean.includes('.') || !domainMatches(originHost, clean, false)) return null;
      domain = clean;
      hostOnly = false;
    } else if (k === 'path' && v.startsWith('/')) {
      path = v;
    } else if (k === 'secure') {
      secure = true;
    } else if (k === 'max-age') {
      const n = Number(v);
      if (Number.isFinite(n) && n <= 0) expired = true;
    } else if (k === 'expires') {
      const ts = Date.parse(v);
      if (Number.isFinite(ts) && ts <= Date.now()) expired = true;
    }
  }

  return { name, value, domain, hostOnly, path, secure, expired };
}

function parseCookieHeaderPairs(headerVal) {
  const map = new Map();
  if (typeof headerVal !== 'string' || !headerVal.trim()) return map;
  for (const seg of headerVal.split(';')) {
    const idx = seg.indexOf('=');
    if (idx <= 0) continue;
    const k = seg.slice(0, idx).trim();
    const v = seg.slice(idx + 1).trim();
    if (k) map.set(k, v);
  }
  return map;
}

export function getSetCookieList(headers) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const single = headers.get?.('set-cookie');
  return single ? [single] : [];
}

export function createRedirectState(initialUrl, initialHeaders) {
  const u = new URL(initialUrl);
  let callerCookie;
  if (initialHeaders) {
    for (const [k, v] of Object.entries(initialHeaders)) {
      if (k.toLowerCase() === 'cookie') callerCookie = v;
    }
  }
  return {
    initialHost: normalizeHost(u.hostname),
    callerCookie,
    jar: [],
  };
}

export function applyRedirectHop(state, prevUrlStr, nextUrl, hopSetCookies, currentHeaders) {
  const prevUrl = new URL(prevUrlStr);
  for (const raw of hopSetCookies) {
    const parsed = parseSetCookie(raw, prevUrl);
    if (!parsed) continue;
    state.jar = state.jar.filter(c => !(c.name === parsed.name && c.domain === parsed.domain && c.path === parsed.path));
    if (!parsed.expired && state.jar.length < 64) state.jar.push(parsed);
  }

  const out = currentHeaders ? { ...currentHeaders } : {};
  if (nextUrl.origin !== prevUrl.origin) {
    for (const k of Object.keys(out)) {
      const lower = k.toLowerCase();
      if (lower === 'authorization' || lower === 'proxy-authorization') delete out[k];
    }
  }

  for (const k of Object.keys(out)) {
    if (k.toLowerCase() === 'cookie') delete out[k];
  }

  const merged = sameSiteHost(state.initialHost, nextUrl.hostname)
    ? parseCookieHeaderPairs(state.callerCookie)
    : new Map();

  for (const entry of state.jar) {
    if (entry.secure && nextUrl.protocol !== 'https:') continue;
    if (!domainMatches(nextUrl.hostname, entry.domain, entry.hostOnly)) continue;
    if (!pathMatches(nextUrl.pathname, entry.path)) continue;
    merged.set(entry.name, entry.value);
  }

  if (merged.size > 0) {
    out.cookie = [...merged.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
