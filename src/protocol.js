export function validateRelativePath(path) {
  return typeof path === 'string' && path.length >= 1 && path.length <= 1024 &&
    path.startsWith('/') && !path.startsWith('//') && !/[\\\x00-\x20\x7f]/.test(path);
}

export const VERSION = '0.4.0';
export const INPUT_LIMIT = 4096;
export const RUN_INPUT_LIMIT = 131072;
export const MAX_HTTP_BODY_CHARS = 65536;
export const OUTPUT_LIMIT = 32768;
export const MAX_HTTP_BYTES = 1048576;
export const JOB_TIMEOUT_MS = 15000;
export const MAX_SSH_TIMEOUT_MS = 60000;
export const BROWSER_TIMEOUT_MS = 45000;
export const RESULT_LIMIT = 524288;
export const ID_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
export const HTTP_METHODS = ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'];
export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed', 'expired', 'unknown'];
export const DYNAMIC_URL_TARGET = '_url';
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,48}$/;
const HEADER_NAME_RE = /^[a-zA-Z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FORBIDDEN_JOB_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length',
]);

export class JobError extends Error {
  constructor(code, status = 400, detail = undefined) {
    super(code);
    this.code = code;
    this.status = status;
    if (typeof detail === 'string' && /^[A-Za-z0-9_:-]{1,80}$/.test(detail)) {
      this.detail = detail;
    }
  }
}

function validateJobHeaders(headers) {
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) throw new JobError('invalid_job');
  const entries = Object.entries(headers);
  if (entries.length > 20) throw new JobError('invalid_job');
  const normalized = {};
  for (const [k, v] of entries) {
    if (!HEADER_NAME_RE.test(k) || FORBIDDEN_JOB_HEADERS.has(k.toLowerCase()) ||
        typeof v !== 'string' || v.length > 1024 || /[\r\n\x00]/.test(v)) {
      throw new JobError('invalid_job');
    }
    normalized[k] = v;
  }
  return normalized;
}

export function validateJob(job) {
  if (!job || typeof job !== 'object' || Array.isArray(job)) throw new JobError('invalid_job');
  const keys = job.type === 'browse'
    ? ['type', 'target', 'url', 'path', 'scrollY', 'selector', 'waitForSelector', 'settleMs', 'followRedirects', 'proxy']
    : job.type === 'http'
      ? ['type', 'target', 'url', 'path', 'method', 'headers', 'body', 'bodyEncoding', 'contentType', 'followRedirects', 'maxBytes', 'truncate', 'proxy']
      : ['type', 'target', 'action', 'stdin'];
  if (!['http', 'ssh', 'browse'].includes(job.type) ||
      Object.keys(job).some(key => !keys.includes(key)) ||
      typeof job.target !== 'string' || !NAME_PATTERN.test(job.target) ||
      (job.type === 'ssh' && (typeof job.action !== 'string' || !NAME_PATTERN.test(job.action)))) {
    throw new JobError('invalid_job');
  }
  const isDynamicUrl = job.target === DYNAMIC_URL_TARGET;
  if (job.type === 'ssh') {
    if (isDynamicUrl) throw new JobError('invalid_job');
  } else if (isDynamicUrl) {
    if (typeof job.url !== 'string' || job.url.length < 8 || job.url.length > 2048 ||
        /[\x00-\x20\x7f]/.test(job.url) || job.path !== undefined) {
      throw new JobError('invalid_job');
    }
    try { new URL(job.url); } catch { throw new JobError('invalid_job'); }
  } else if (job.url !== undefined) {
    throw new JobError('invalid_job');
  }
  if (job.proxy !== undefined && (typeof job.proxy !== 'string' || !NAME_PATTERN.test(job.proxy))) {
    throw new JobError('invalid_job');
  }
  if (job.followRedirects !== undefined && typeof job.followRedirects !== 'boolean') {
    throw new JobError('invalid_job');
  }
  if (job.type === 'browse') {
    if ((job.path !== undefined && !validateRelativePath(job.path)) ||
        (job.scrollY !== undefined && (!Number.isInteger(job.scrollY) || job.scrollY < 0 || job.scrollY > 20000)) ||
        (job.selector !== undefined && (typeof job.selector !== 'string' || !job.selector.length ||
          job.selector.length > 200 || /[\x00-\x1f\x7f]/.test(job.selector))) ||
        (job.waitForSelector !== undefined && (typeof job.waitForSelector !== 'string' || !job.waitForSelector.length ||
          job.waitForSelector.length > 200 || /[\x00-\x1f\x7f]/.test(job.waitForSelector))) ||
        (job.settleMs !== undefined && (!Number.isInteger(job.settleMs) || job.settleMs < 0 || job.settleMs > 5000))) {
      throw new JobError('invalid_job');
    }
    return {
      type: 'browse',
      target: job.target,
      ...(job.url !== undefined ? { url: job.url } : {}),
      ...(job.path !== undefined ? { path: job.path } : {}),
      ...(job.scrollY !== undefined ? { scrollY: job.scrollY } : {}),
      ...(job.selector !== undefined ? { selector: job.selector } : {}),
      ...(job.waitForSelector !== undefined ? { waitForSelector: job.waitForSelector } : {}),
      ...(job.settleMs !== undefined ? { settleMs: job.settleMs } : {}),
      ...(job.followRedirects !== undefined ? { followRedirects: job.followRedirects } : {}),
      ...(job.proxy !== undefined ? { proxy: job.proxy } : {}),
    };
  }
  if (job.type === 'http') {
    const method = job.method ?? 'GET';
    if ((job.path !== undefined && !validateRelativePath(job.path)) ||
        (job.method !== undefined && !HTTP_METHODS.includes(job.method)) ||
        (job.bodyEncoding !== undefined && !['utf8', 'base64'].includes(job.bodyEncoding)) ||
        (job.contentType !== undefined && (typeof job.contentType !== 'string' || !job.contentType.length ||
          job.contentType.length > 128 || /[\x00-\x1f\x7f]/.test(job.contentType))) ||
        (job.maxBytes !== undefined && (!Number.isInteger(job.maxBytes) || job.maxBytes < 1 || job.maxBytes > MAX_HTTP_BYTES)) ||
        (job.truncate !== undefined && typeof job.truncate !== 'boolean')) {
      throw new JobError('invalid_job');
    }
    const headers = job.headers !== undefined ? validateJobHeaders(job.headers) : undefined;
    if (job.body !== undefined) {
      if (typeof job.body !== 'string' || job.body.length > MAX_HTTP_BODY_CHARS || ['GET', 'HEAD'].includes(method)) {
        throw new JobError('invalid_job');
      }
      if (job.bodyEncoding === 'base64' && (!/^[A-Za-z0-9+/]*={0,2}$/.test(job.body) || job.body.length % 4 !== 0)) {
        throw new JobError('invalid_job');
      }
    } else if (job.bodyEncoding !== undefined || job.contentType !== undefined) {
      throw new JobError('invalid_job');
    }
    return {
      type: 'http',
      target: job.target,
      ...(job.url !== undefined ? { url: job.url } : {}),
      ...(job.path !== undefined ? { path: job.path } : {}),
      ...(job.method !== undefined ? { method: job.method } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(job.body !== undefined ? { body: job.body } : {}),
      ...(job.bodyEncoding !== undefined ? { bodyEncoding: job.bodyEncoding } : {}),
      ...(job.contentType !== undefined ? { contentType: job.contentType } : {}),
      ...(job.followRedirects !== undefined ? { followRedirects: job.followRedirects } : {}),
      ...(job.maxBytes !== undefined ? { maxBytes: job.maxBytes } : {}),
      ...(job.truncate !== undefined ? { truncate: job.truncate } : {}),
      ...(job.proxy !== undefined ? { proxy: job.proxy } : {}),
    };
  }
  if (job.stdin !== undefined && (typeof job.stdin !== 'string' ||
      new TextEncoder().encode(job.stdin).byteLength > 3584)) {
    throw new JobError('invalid_job');
  }
  return {
    type: 'ssh',
    target: job.target,
    action: job.action,
    ...(job.stdin !== undefined ? { stdin: job.stdin } : {}),
  };
}

export function validateId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw new JobError('invalid_job_id');
  return id;
}

export async function readLimitedWithMeta(stream, limit = OUTPUT_LIMIT, budget = null, { truncate = false } = {}) {
  if (!stream) return { bytes: new Uint8Array(), truncated: false };
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (budget) {
        budget.used += value.byteLength;
        if (budget.used > budget.max) {
          void reader.cancel().catch(() => {});
          throw new JobError('size_limit_exceeded', 413);
        }
      }
      if (size + value.byteLength > limit) {
        if (truncate) {
          const keep = limit - size;
          if (keep > 0) {
            chunks.push(value.subarray(0, keep));
            size += keep;
          }
          truncated = true;
          void reader.cancel().catch(() => {});
          break;
        }
        void reader.cancel().catch(() => {});
        throw new JobError('size_limit_exceeded', 413);
      }
      size += value.byteLength;
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated };
}

export async function readLimited(stream, limit = OUTPUT_LIMIT, budget = null) {
  const { bytes } = await readLimitedWithMeta(stream, limit, budget, { truncate: false });
  return bytes;
}

export function publicError(error) {
  return error instanceof JobError ? error.code : 'upstream_failed';
}

export function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id, status: row.status, createdAt: row.created_at,
    completedAt: row.completed_at, result: row.result ? JSON.parse(row.result) : null,
    error: row.error ?? null,
  };
}

export function publicJobSummary(row) {
  if (!row) return null;
  let parsed = null;
  try { parsed = row.payload ? JSON.parse(row.payload) : null; } catch { parsed = null; }
  return {
    id: row.id,
    type: parsed?.type ?? null,
    target: (parsed?.target === DYNAMIC_URL_TARGET ? parsed?.url : parsed?.target) ?? null,
    ...(parsed?.action ? { action: parsed.action } : {}),
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at ?? null,
    error: row.error ?? null,
  };
}
