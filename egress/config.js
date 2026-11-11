import { HTTP_METHODS, JOB_TIMEOUT_MS, JobError, MAX_SSH_TIMEOUT_MS, validateJob } from '../src/protocol.js';
import { publicHostOrIp, publicHttpsUrl } from '../src/url-policy.js';

const HEADER_NAME_PATTERN = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const SECRET_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

function parseProxyEntry(raw, env) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new JobError('invalid_egress_proxy', 503);
  let proxy;
  try { proxy = new URL(raw.server); } catch { throw new JobError('egress_proxy_required', 503); }
  const username = raw.username ?? (raw.usernameSecret ? env[raw.usernameSecret] : undefined);
  const password = raw.password ?? (raw.passwordSecret ? env[raw.passwordSecret] : undefined);
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search ||
      proxy.hash || proxy.pathname !== '/' || !username || !password) {
    throw new JobError('invalid_egress_proxy', 503);
  }
  return { server: proxy.origin, username, password };
}

export function gatewayConfig(env) {
  if (typeof env.EGRESS_TOKEN !== 'string' || env.EGRESS_TOKEN.length < 32) throw new JobError('egress_token_missing', 503);
  if (!env.EGRESS_PROXY_SERVER) throw new JobError('egress_proxy_required', 503);
  const defaultProxy = parseProxyEntry({
    server: env.EGRESS_PROXY_SERVER,
    username: env.EGRESS_PROXY_USERNAME,
    password: env.EGRESS_PROXY_PASSWORD,
  }, env);
  const proxies = {};
  if (env.EGRESS_PROXIES) {
    let parsed;
    try { parsed = JSON.parse(env.EGRESS_PROXIES); } catch { throw new JobError('invalid_server_config', 503); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new JobError('invalid_server_config', 503);
    for (const [name, entry] of Object.entries(parsed)) {
      if (!/^[a-zA-Z0-9_-]{1,48}$/.test(name)) throw new JobError('invalid_server_config', 503);
      proxies[name] = parseProxyEntry(entry, env);
    }
  }
  const maps = {};
  for (const name of ['HTTP_TARGETS', 'SSH_TARGETS', 'BROWSER_TARGETS']) {
    try { maps[name] = JSON.parse(env[name] || '{}'); } catch { throw new JobError('invalid_server_config', 503); }
    if (!maps[name] || typeof maps[name] !== 'object' || Array.isArray(maps[name])) throw new JobError('invalid_server_config', 503);
  }
  return {
    token: env.EGRESS_TOKEN,
    ...maps,
    secrets: env,
    allowDirectSsh: env.ALLOW_DIRECT_SSH === '1',
    executablePath: env.BROWSER_EXECUTABLE_PATH || undefined,
    proxy: defaultProxy,
    proxies,
  };
}

export function resolveProxy(config, proxyName) {
  if (proxyName === undefined) {
    if (!config?.proxy?.server || !config.proxy.username || !config.proxy.password) {
      throw new JobError('egress_proxy_required', 503);
    }
    return config.proxy;
  }
  if (typeof proxyName !== 'string' || !config?.proxies || !Object.hasOwn(config.proxies, proxyName)) {
    throw new JobError('invalid_server_config', 503);
  }
  return config.proxies[proxyName];
}

function targetConfig(targets, name) {
  if (!targets || !Object.hasOwn(targets, name)) throw new JobError('target_not_allowed', 403);
  const target = targets[name];
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new JobError('invalid_server_config', 503);
  return target;
}

function parseRedirectPolicy(target, defaultMax) {
  const follow = target.followRedirects ?? false;
  if (typeof follow !== 'boolean') throw new JobError('invalid_server_config', 503);
  const maxRedirects = target.maxRedirects ?? (follow ? defaultMax : 0);
  if (!Number.isInteger(maxRedirects) || maxRedirects < 0 || maxRedirects > 5 || (!follow && maxRedirects > 0)) {
    throw new JobError('invalid_server_config', 503);
  }
  return { followRedirects: follow, maxRedirects };
}

function resolveHttpHeaders(target, job, secrets = {}) {
  const headers = { accept: '*/*', 'user-agent': 'edge-mailbox/0.3' };
  if (target.headers !== undefined) {
    if (!target.headers || typeof target.headers !== 'object' || Array.isArray(target.headers)) {
      throw new JobError('invalid_server_config', 503);
    }
    for (const [k, v] of Object.entries(target.headers)) {
      if (!HEADER_NAME_PATTERN.test(k) || typeof v !== 'string' || v.length > 1024 || /[\r\n\x00]/.test(v)) {
        throw new JobError('invalid_server_config', 503);
      }
      headers[k.toLowerCase()] = v;
    }
  }
  if (target.headerSecrets !== undefined) {
    if (!target.headerSecrets || typeof target.headerSecrets !== 'object' || Array.isArray(target.headerSecrets)) {
      throw new JobError('invalid_server_config', 503);
    }
    for (const [k, secretRef] of Object.entries(target.headerSecrets)) {
      if (!HEADER_NAME_PATTERN.test(k) || typeof secretRef !== 'string') {
        throw new JobError('invalid_server_config', 503);
      }
      let secretName = secretRef;
      let prefix = '';
      if (secretRef.startsWith('Bearer $')) {
        prefix = 'Bearer ';
        secretName = secretRef.slice('Bearer $'.length);
      }
      if (!SECRET_KEY_PATTERN.test(secretName)) throw new JobError('invalid_server_config', 503);
      const secretVal = secrets[secretName];
      if (typeof secretVal !== 'string' || !secretVal.length || /[\r\n\x00]/.test(secretVal)) {
        throw new JobError('upstream_secret_missing', 503);
      }
      headers[k.toLowerCase()] = prefix + secretVal;
    }
  }
  if (job.contentType !== undefined) {
    headers['content-type'] = job.contentType;
  } else if (job.body !== undefined && !headers['content-type']) {
    headers['content-type'] = 'application/json; charset=utf-8';
  }
  return headers;
}

export function resolveGatewayJob(input, config) {
  const job = validateJob(input);
  if (job.type === 'browse') return { job, ...resolveBrowserJob(job, config) };
  if (job.type === 'http') {
    const target = targetConfig(config.HTTP_TARGETS, job.target);
    const base = publicHttpsUrl(target.url);
    if (base.hash) throw new JobError('invalid_server_config', 503);
    const url = job.path === undefined ? base : publicHttpsUrl(new URL(job.path, base).href);
    if (url.origin !== base.origin || url.hash) throw new JobError('target_not_allowed', 403);
    const allowedMethods = target.methods ?? ['GET'];
    if (!Array.isArray(allowedMethods) || !allowedMethods.length ||
        allowedMethods.some(m => !HTTP_METHODS.includes(m))) {
      throw new JobError('invalid_server_config', 503);
    }
    const method = job.method ?? 'GET';
    if (!allowedMethods.includes(method)) throw new JobError('method_not_allowed', 405);
    const { followRedirects, maxRedirects } = parseRedirectPolicy(target, 5);
    const extraOrigins = target.allowedOrigins ?? [];
    if (!Array.isArray(extraOrigins) || extraOrigins.length > 10) throw new JobError('invalid_server_config', 503);
    const allowedOrigins = new Set([base.origin, ...extraOrigins.map(o => publicHttpsUrl(o).origin)]);
    const headers = resolveHttpHeaders(target, job, config.secrets);
    const body = job.body === undefined
      ? undefined
      : job.bodyEncoding === 'base64'
        ? Uint8Array.from(Buffer.from(job.body, 'base64'))
        : new TextEncoder().encode(job.body);
    const proxy = resolveProxy(config, target.proxy);
    return {
      job,
      url: url.href,
      method,
      headers,
      body,
      followRedirects,
      maxRedirects,
      allowedOrigins,
      proxy,
      timeoutMs: JOB_TIMEOUT_MS,
    };
  }
  const ALLOWED_HOST_KEY_ALGS = new Set([
    'ssh-ed25519', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'rsa-sha2-512', 'rsa-sha2-256',
  ]);
  const target = targetConfig(config.SSH_TARGETS, job.target);
  const port = target.port ?? 22;
  const egress = target.egress ?? 'proxy';
  const timeoutMs = target.actionTimeouts?.[job.action] ?? target.timeoutMs ?? JOB_TIMEOUT_MS;
  const fps = target.fingerprints ?? (target.fingerprint ? [target.fingerprint] : []);
  const hostKeyAlgorithms = target.hostKeyAlgorithms;
  if (!publicHostOrIp(target.hostname || '') ||
      typeof target.username !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(target.username) ||
      !Array.isArray(fps) || !fps.length || fps.length > 5 ||
      fps.some(fp => typeof fp !== 'string' || !/^SHA256:[a-zA-Z0-9+/]{43}$/.test(fp)) ||
      (hostKeyAlgorithms !== undefined && (!Array.isArray(hostKeyAlgorithms) || !hostKeyAlgorithms.length ||
        hostKeyAlgorithms.length > 6 || hostKeyAlgorithms.some(a => !ALLOWED_HOST_KEY_ALGS.has(a)))) ||
      !SECRET_KEY_PATTERN.test(target.keySecret || '') ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      !['proxy', 'direct'].includes(egress) ||
      (target.allowStdin !== undefined && typeof target.allowStdin !== 'boolean') ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_SSH_TIMEOUT_MS) {
    throw new JobError('invalid_server_config', 503);
  }
  if (egress === 'direct' && !config.allowDirectSsh) {
    throw new JobError('direct_ssh_not_enabled', 503);
  }
  if (job.stdin !== undefined && target.allowStdin !== true) {
    throw new JobError('stdin_not_allowed', 403);
  }
  if (!target.actions || !Object.hasOwn(target.actions, job.action)) throw new JobError('action_not_allowed', 403);
  const command = target.actions[job.action];
  if (typeof command !== 'string' || !command.length || command.length > 16384 || command.includes('\u0000')) {
    throw new JobError('invalid_server_config', 503);
  }
  const pem = config.secrets?.[target.keySecret];
  if (typeof pem !== 'string' || !pem.includes('PRIVATE KEY')) throw new JobError('ssh_key_missing', 503);
  const proxy = egress === 'proxy' ? resolveProxy(config, target.proxy) : null;
  return {
    job,
    target,
    fingerprints: new Set(fps),
    hostKeyAlgorithms,
    port,
    egress,
    proxy,
    command,
    pem,
    stdin: job.stdin,
    timeoutMs,
  };
}

export function resolveBrowserJob(input, config) {
  const job = validateJob(input);
  if (job.type !== 'browse') throw new JobError('invalid_job');
  const target = targetConfig(config.BROWSER_TARGETS, job.target);
  const base = publicHttpsUrl(target.url);
  const url = job.path === undefined ? base : publicHttpsUrl(new URL(job.path, base).href);
  if (url.origin !== base.origin) throw new JobError('target_not_allowed', 403);
  const resourceOrigins = target.resourceOrigins ?? [];
  if (!Array.isArray(resourceOrigins) || resourceOrigins.length > 10) throw new JobError('invalid_server_config', 503);
  const origins = [base.origin, ...resourceOrigins.map(value => {
    const resource = publicHttpsUrl(value);
    if (resource.pathname !== '/' || resource.search || resource.hash) throw new JobError('invalid_server_config', 503);
    return resource.origin;
  })];
  if ((target.waitForSelector !== undefined && (typeof target.waitForSelector !== 'string' ||
      !target.waitForSelector.length || target.waitForSelector.length > 200)) ||
      (target.settleMs !== undefined && (!Number.isInteger(target.settleMs) || target.settleMs < 0 || target.settleMs > 3000))) {
    throw new JobError('invalid_server_config', 503);
  }
  const { followRedirects, maxRedirects } = parseRedirectPolicy(target, 3);
  const proxy = resolveProxy(config, target.proxy);
  return {
    url: url.href,
    origin: base.origin,
    resourceOrigins: new Set(origins),
    scrollY: job.scrollY ?? 0,
    selector: job.selector,
    waitForSelector: target.waitForSelector,
    settleMs: target.settleMs ?? 1000,
    followRedirects,
    maxRedirects,
    proxy,
  };
}

export function requestAllowed(url, method, type, topNavigation, target) {
  if (!['GET', 'HEAD'].includes(method) || ['media', 'websocket', 'manifest'].includes(type)) return false;
  try {
    const parsed = publicHttpsUrl(url);
    return topNavigation ? parsed.origin === target.origin : target.resourceOrigins.has(parsed.origin);
  } catch { return false; }
}

export function listConfiguredTargets(config) {
  const http = Object.entries(config.HTTP_TARGETS || {}).map(([name, t]) => {
    const url = publicHttpsUrl(t.url);
    return {
      name,
      origin: url.origin,
      basePath: url.pathname,
      methods: t.methods ?? ['GET'],
      followRedirects: Boolean(t.followRedirects),
      proxy: t.proxy ?? 'default',
    };
  });
  const browse = Object.entries(config.BROWSER_TARGETS || {}).map(([name, t]) => {
    const url = publicHttpsUrl(t.url);
    return {
      name,
      origin: url.origin,
      resourceOrigins: (t.resourceOrigins ?? []).map(o => publicHttpsUrl(o).origin),
      followRedirects: Boolean(t.followRedirects),
      proxy: t.proxy ?? 'default',
    };
  });
  const ssh = Object.entries(config.SSH_TARGETS || {}).map(([name, t]) => ({
    name,
    hostname: t.hostname,
    port: t.port ?? 22,
    egress: t.egress ?? 'proxy',
    allowStdin: Boolean(t.allowStdin),
    timeoutMs: t.timeoutMs ?? JOB_TIMEOUT_MS,
    actions: Object.keys(t.actions || {}),
    proxy: (t.egress ?? 'proxy') === 'proxy' ? (t.proxy ?? 'default') : null,
  }));
  return { http, browse, ssh };
}
