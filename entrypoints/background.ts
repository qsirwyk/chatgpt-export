// 后台脚本：
// - 代替内容脚本下载跨域图片（files.oaiusercontent.com 等不一定返回 CORS 头），转成 data URL 供截图内嵌；
// - 调用 downloads API 保存导出的图片到「下载/ChatGPT」目录。
import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import type { BackgroundRequest, MessageResponse } from '@/utils/types';

/** 只代理 ChatGPT 相关域名的资源 */
const ALLOWED_HOSTS = /(^|\.)(chatgpt\.com|openai\.com|oaistatic\.com|oaiusercontent\.com)$/i;

async function fetchAsDataUrl(url: string): Promise<string> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.test(target.hostname)) {
    throw new Error(`不允许的地址：${target.hostname}`);
  }
  const res = await fetch(target.href, { credentials: 'include' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
  const bytes = new Uint8Array(await res.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${type};base64,${btoa(binary)}`;
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
    // 只处理本扩展内容脚本发来的消息
    if (sender.id !== browser.runtime.id) return false;
    let task: Promise<unknown>;
    if (request?.type === 'CGE_FETCH_DATA_URL') {
      task = fetchAsDataUrl(request.url);
    } else if (request?.type === 'CGE_DOWNLOAD') {
      if (!request.url.startsWith('data:image/png')) return false;
      task = browser.downloads.download({ url: request.url, filename: request.filename, saveAs: false, conflictAction: 'uniquify' });
    } else {
      return false;
    }
    task
      .then((result) => sendResponse({ ok: true, result } satisfies MessageResponse<unknown>))
      .catch((err: unknown) =>
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies MessageResponse<unknown>),
      );
    return true;
  });
});
