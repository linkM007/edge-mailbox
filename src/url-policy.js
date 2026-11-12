import { JobError, validateRelativePath } from './protocol.js';
export { validateRelativePath };

export function publicHostname(hostname) {
  return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname) &&
    !/\.(localhost|local|internal|test|invalid)$/i.test(hostname);
}

export function publicIpv4(value) {
  if (typeof value !== 'string') return false;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((n, i) => n > 255 || String(n) !== match[i + 1])) return false;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

export function publicHostOrIp(value) {
  return publicHostname(value) || publicIpv4(value);
}

export function publicHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new JobError('invalid_server_config', 503); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.port || !publicHostname(url.hostname)) throw new JobError('invalid_server_config', 503);
  return url;
}

export function publicJobHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new JobError('invalid_job', 400); }
  if (url.protocol !== 'https:' || url.username || url.password ||
      url.port || !publicHostname(url.hostname)) {
    throw new JobError('target_not_allowed', 403);
  }
  url.hash = '';
  return url;
}
