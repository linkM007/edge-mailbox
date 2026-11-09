import { JobError, validateJob } from '../src/protocol.js';
import { publicHostname, publicHttpsUrl } from '../src/url-policy.js';

export function gatewayConfig(env) {
  if (typeof env.EGRESS_TOKEN !== 'string' || env.EGRESS_TOKEN.length < 32) throw new JobError('egress_token_missing', 503);
  let proxy;
  try { proxy = new URL(env.EGRESS_PROXY_SERVER); } catch { throw new JobError('egress_proxy_required', 503); }
  if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search ||
      proxy.hash || proxy.pathname !== '/' || !env.EGRESS_PROXY_USERNAME || !env.EGRESS_PROXY_PASSWORD) {
    throw new JobError('invalid_egress_proxy', 503);
  }
  const maps = {};
  for (const name of ['HTTP_TARGETS', 'SSH_TARGETS', 'BROWSER_TARGETS']) {
    try { maps[name] = JSON.parse(env[name] || '{}'); } catch { throw new JobError('invalid_server_config', 503); }
    if (!maps[name] || typeof maps[name] !== 'object' || Array.isArray(maps[name])) throw new JobError('invalid_server_config', 503);
  }
  return { token: env.EGRESS_TOKEN, ...maps, secrets: env,
    executablePath: env.BROWSER_EXECUTABLE_PATH || undefined,
    proxy: { server: proxy.origin, username: env.EGRESS_PROXY_USERNAME, password: env.EGRESS_PROXY_PASSWORD } };
}

function targetConfig(targets, name) {
  if (!Object.hasOwn(targets, name)) throw new JobError('target_not_allowed', 403);
  const target = targets[name];
  if (!target || typeof target !== 'object' || Array.isArray(target)) throw new JobError('invalid_server_config', 503);
  return target;
}

export function resolveGatewayJob(input, config) {
  const job = validateJob(input);
  if (job.type === 'browse') return { job, ...resolveBrowserJob(job, config) };
  if (job.type === 'http') {
    const url = publicHttpsUrl(targetConfig(config.HTTP_TARGETS, job.target).url);
    if (url.hash) throw new JobError('invalid_server_config', 503);
    return { job, url: url.href };
  }
  const target = targetConfig(config.SSH_TARGETS, job.target);
  if (!publicHostname(target.hostname || '') ||
      typeof target.username !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_-]{0,31}$/.test(target.username) ||
      !/^SHA256:[a-zA-Z0-9+/]{43}$/.test(target.fingerprint || '') ||
      !/^[A-Z][A-Z0-9_]{0,63}$/.test(target.keySecret || '') ||
      (target.port !== undefined && target.port !== 22)) throw new JobError('invalid_server_config', 503);
  if (!target.actions || !Object.hasOwn(target.actions, job.action)) throw new JobError('action_not_allowed', 403);
  const command = target.actions[job.action];
  if (typeof command !== 'string' || !command.length || command.length > 1024 || command.includes('\u0000')) {
    throw new JobError('invalid_server_config', 503);
  }
  const pem = config.secrets[target.keySecret];
  if (typeof pem !== 'string' || !pem.includes('PRIVATE KEY')) throw new JobError('ssh_key_missing', 503);
  return { job, target, command, pem };
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
  return { url: url.href, origin: base.origin, resourceOrigins: new Set(origins),
    scrollY: job.scrollY ?? 0, waitForSelector: target.waitForSelector, settleMs: target.settleMs ?? 1000 };
}

export function requestAllowed(url, method, type, topNavigation, target) {
  if (!['GET', 'HEAD'].includes(method) || ['media', 'websocket', 'manifest'].includes(type)) return false;
  try {
    const parsed = publicHttpsUrl(url);
    return topNavigation ? parsed.origin === target.origin : target.resourceOrigins.has(parsed.origin);
  } catch { return false; }
}
