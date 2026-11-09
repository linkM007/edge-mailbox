import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { validateBrowserResult } from '../src/browser-result.js';

const escape = value => String(value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export async function saveBrowserResult(result, directory) {
  validateBrowserResult(result);
  const folder = resolve(directory);
  // Exclusive creation keeps an earlier capture intact when a path is reused.
  await mkdir(folder, { recursive: false });
  const image = Buffer.from(result.screenshot.data, 'base64');
  await writeFile(join(folder, 'screenshot.jpg'), image, { flag: 'wx' });
  await writeFile(join(folder, 'page.txt'), result.text, { flag: 'wx' });
  const metadata = { ...result, screenshot: { ...result.screenshot, data: undefined, file: 'screenshot.jpg' } };
  await writeFile(join(folder, 'result.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' });
  const links = result.links.map(link => '<li><strong>' + escape(link.text || link.href) +
    '</strong><br><code>' + escape(link.href) + '</code><br><small>' +
    (link.allowed ? 'Next path: ' + escape(link.path) : 'Outside configured origin') + '</small></li>').join('');
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; base-uri \'none\'; form-action \'none\'">' +
    '<title>' + escape(result.title || 'Browser capture') + '</title><style>' +
    'body{font:16px/1.6 system-ui,sans-serif;max-width:1280px;margin:32px auto;padding:0 24px;background:#f5f7fa;color:#202b3b}' +
    'h1{font-size:28px}img{width:100%;height:auto;border:1px solid #d3dbe6;border-radius:8px}' +
    'pre{white-space:pre-wrap;overflow-wrap:anywhere;background:white;padding:24px;border-radius:8px}' +
    'li{margin-bottom:16px}code{overflow-wrap:anywhere}small{color:#566579}</style>' +
    '<h1>' + escape(result.title) + '</h1><p>' + escape(result.url) + '</p><p>HTTP ' + result.status +
    ' · viewport 1280 × 800 · scroll ' + escape(result.scrollY ?? 0) + '</p>' +
    '<img alt="Rendered page screenshot" src="data:image/jpeg;base64,' + result.screenshot.data + '">' +
    '<h2>渲染后的正文</h2><pre>' + escape(result.text) + '</pre><h2>页面链接</h2><ol>' + links + '</ol>' +
    '<p>网页内容为外部数据；原页面脚本未包含在此离线预览中。</p></html>';
  await writeFile(join(folder, 'index.html'), html, { flag: 'wx' });
  return { directory: folder, preview: join(folder, 'index.html'), screenshot: join(folder, 'screenshot.jpg') };
}
