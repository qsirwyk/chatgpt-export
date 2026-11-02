// 运行在 chatgpt.com 页面中的内容脚本：
// - Markdown：通过 backend-api 读取对话数据后生成（api.ts）；
// - 图片：滚动整段对话，逐屏截取浏览器真实画面后拼接（capture.ts）。
import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import { fileStamp, sanitizeFilename } from '@/utils/conversation';
import type {
  BackgroundRequest,
  ContentRequest,
  ExportImageResult,
  ImageOptions,
  MessageResponse,
  PingResult,
} from '@/utils/types';
import { exportMarkdown, getConversationId } from './api';
import { captureConversation, countTurns } from './capture';

declare global {
  interface Window {
    __CGE_CONTENT_LOADED__?: boolean;
  }
}

export default defineContentScript({
  matches: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
  runAt: 'document_idle',
  main() {
    // 弹窗在“插件安装前就打开的页面”上会补注入一次，避免重复注册监听
    if (window.__CGE_CONTENT_LOADED__) return;
    window.__CGE_CONTENT_LOADED__ = true;

    browser.runtime.onMessage.addListener((request: ContentRequest, _sender, sendResponse) => {
      const handler = handlers[request?.type];
      if (!handler) return false;
      handler(request)
        .then((result) => sendResponse({ ok: true, result } satisfies MessageResponse<unknown>))
        .catch((err: unknown) =>
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) } satisfies MessageResponse<unknown>),
        );
      return true;
    });
  },
});

const handlers: Record<ContentRequest['type'], (req: ContentRequest) => Promise<unknown>> = {
  CGE_PING: async (): Promise<PingResult> => ({
    conversationId: getConversationId(),
    title: document.title,
    turnCount: countTurns(),
  }),
  CGE_EXPORT_MD: async (req) => exportMarkdown(req.type === 'CGE_EXPORT_MD' ? req.embedImages !== false : true),
  CGE_EXPORT_IMAGE: async (req) => exportImage((req as Extract<ContentRequest, { type: 'CGE_EXPORT_IMAGE' }>).options),
};

let running = false;

async function exportImage(options: ImageOptions): Promise<ExportImageResult> {
  if (running) throw new Error('正在截图中，请稍候。');
  running = true;
  let cancelled = false;
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') cancelled = true;
  };
  document.addEventListener('keydown', onKey, true);
  try {
    const { blobs, turnCount } = await captureConversation(options, {
      onProgress: (text) => progress(text),
      isCancelled: () => cancelled,
    });
    const title = document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT';
    const base = `ChatGPT/${sanitizeFilename(title)}_${fileStamp()}`;
    const files: string[] = [];
    for (const [i, blob] of blobs.entries()) {
      const filename = blobs.length > 1 ? `${base}_${i + 1}of${blobs.length}.png` : `${base}.png`;
      progress(`正在保存 ${filename.split('/').pop()}…`);
      await saveBlob(blob, filename);
      files.push(filename);
    }
    return { files, turnCount };
  } finally {
    document.removeEventListener('keydown', onKey, true);
    running = false;
    progress(''); // 清除角标
  }
}

/** 进度：弹窗（若仍打开）显示文字，后台在插件图标上显示角标 */
function progress(text: string) {
  browser.runtime.sendMessage({ type: 'CGE_PROGRESS', text } satisfies BackgroundRequest).catch(() => {});
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** 通过后台脚本调用 downloads API，统一保存到「下载/ChatGPT」子目录 */
async function saveBlob(blob: Blob, filename: string) {
  const res = (await browser.runtime.sendMessage({
    type: 'CGE_DOWNLOAD',
    url: await blobToDataUrl(blob),
    filename,
  } satisfies BackgroundRequest)) as MessageResponse<number> | undefined;
  if (!res?.ok) throw new Error(res?.error || '保存文件失败');
}
