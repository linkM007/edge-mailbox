import { JobError, RESULT_LIMIT } from './protocol.js';

// D1 stores the same bounded result used by the synchronous API.
export function validateBrowserResult(result) {
  const image = result?.screenshot;
  if (result?.type !== 'browse' || result.proxyUsed !== true || typeof result.url !== 'string' || result.url.length > 2048 ||
      !Number.isInteger(result.status) || result.status < 100 || result.status > 599 ||
      typeof result.title !== 'string' || result.title.length > 512 ||
      typeof result.text !== 'string' || result.text.length > 18000 ||
      (result.selectedText !== undefined && result.selectedText !== null &&
        (typeof result.selectedText !== 'string' || result.selectedText.length > 18000)) ||
      (result.failedSubresources !== undefined && (!Number.isInteger(result.failedSubresources) || result.failedSubresources < 0)) ||
      (result.redirectCount !== undefined && (!Number.isInteger(result.redirectCount) || result.redirectCount < 0)) ||
      !Array.isArray(result.links) || result.links.length > 30 ||
      !result.links.every(link => typeof link?.text === 'string' && link.text.length <= 120 &&
        typeof link.href === 'string' && link.href.length <= 1024 && typeof link.path === 'string' &&
        link.path.length <= 1024 && typeof link.allowed === 'boolean') ||
      typeof image?.data !== 'string' || image.mimeType !== 'image/jpeg' || image.encoding !== 'base64' ||
      image.width !== 1280 || image.height !== 800 || image.data.length > 327680 ||
      !/^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(image.data) || image.data.length % 4 !== 0) {
    throw new JobError('invalid_browser_result', 502);
  }
  let url;
  try { url = new URL(result.url); } catch { throw new JobError('invalid_browser_result', 502); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new JobError('invalid_browser_result', 502);
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > RESULT_LIMIT) {
    throw new JobError('size_limit_exceeded', 413);
  }
  return result;
}
