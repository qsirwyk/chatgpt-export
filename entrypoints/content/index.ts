// 运行在 chatgpt.com 页面中的内容脚本：
// - Markdown：通过 backend-api 读取对话数据后生成（api.ts）；
// - 图片：直接截取页面上 ChatGPT 自己渲染的对话 DOM（capture.ts / selection.ts）。
import { defineContentScript } from 'wxt/utils/define-content-script';
import { browser } from 'wxt/browser';
import type { ContentRequest, MessageResponse, PingResult } from '@/utils/types';
import { exportMarkdown, getConversationId } from './api';
import { findConversationDom } from './capture';
import { startSelectionMode } from './selection';

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
    turnCount: findConversationDom()?.turns.length ?? 0,
  }),
  CGE_EXPORT_MD: async (req) => exportMarkdown(req.type === 'CGE_EXPORT_MD' ? req.embedImages !== false : true),
  CGE_START_IMAGE_MODE: async () => startSelectionMode(),
};
