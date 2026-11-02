// 后台脚本：
// - 截取当前标签页的可见区域（captureVisibleTab 只能在扩展页面 / 后台调用）；
// - 调用 downloads API 保存导出的图片到「下载/ChatGPT」目录；
// - 截图进度显示在插件图标的角标上。
import { defineBackground } from 'wxt/utils/define-background';
import { browser, type Browser } from 'wxt/browser';
import type { BackgroundRequest, MessageResponse } from '@/utils/types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function captureTab(tab: Browser.tabs.Tab | undefined): Promise<string> {
  if (!tab?.id || tab.windowId == null) throw new Error('找不到要截图的标签页。');
  const [active] = await browser.tabs.query({ active: true, windowId: tab.windowId });
  if (active?.id !== tab.id) throw new Error('截图期间请保持 ChatGPT 标签页在前台，不要切换标签页。');
  for (let attempt = 0; ; attempt++) {
    try {
      return await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (err) {
      // 超过每秒调用次数上限时稍等重试
      if (attempt < 3 && /MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(String(err))) {
        await sleep(600);
        continue;
      }
      throw err;
    }
  }
}

function setBadge(text: string, tabId?: number) {
  const percent = text.match(/(\d+)%/)?.[1];
  const badge = !text ? '' : percent ? `${percent}%` : '…';
  browser.action.setBadgeBackgroundColor({ color: '#10a37f' }).catch(() => {});
  browser.action.setBadgeText({ text: badge, tabId }).catch(() => {});
}

export default defineBackground(() => {
  browser.runtime.onMessage.addListener((request: BackgroundRequest, sender, sendResponse) => {
    // 只处理本扩展内容脚本发来的消息
    if (sender.id !== browser.runtime.id || !sender.tab) return false;
    let task: Promise<unknown>;
    if (request?.type === 'CGE_PROGRESS') {
      setBadge(request.text, sender.tab.id);
      return false;
    } else if (request?.type === 'CGE_CAPTURE_TAB') {
      task = captureTab(sender.tab);
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
