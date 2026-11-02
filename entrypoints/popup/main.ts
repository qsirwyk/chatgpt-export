import './style.css';
import { browser } from 'wxt/browser';
import {
  DEFAULT_IMAGE_OPTIONS,
  EMBED_IMAGES_KEY,
  IMAGE_OPTIONS_KEY,
  type BackgroundRequest,
  type ContentRequest,
  type ExportImageResult,
  type ExportMarkdownResult,
  type ImageOptions,
  type MessageResponse,
  type PingResult,
} from '@/utils/types';

const CHATGPT_URL = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const targetEl = $('target');
const statusEl = $('status');
const btnMd = $<HTMLButtonElement>('btn-md');
const btnImg = $<HTMLButtonElement>('btn-img');
const optEmbed = $<HTMLInputElement>('opt-embed');
const optHideActions = $<HTMLInputElement>('opt-hide-actions');
const optCropSides = $<HTMLInputElement>('opt-crop-sides');

let tabId: number | null = null;

function setStatus(text: string, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

let canExportMd = false;
let canExportImage = false;

function setBusy(busy: boolean) {
  btnMd.disabled = busy || !canExportMd;
  btnImg.disabled = busy || !canExportImage;
}

async function sendToTab<T>(message: ContentRequest): Promise<T> {
  if (tabId == null) throw new Error('没有可用的 ChatGPT 标签页。');
  let response: MessageResponse<T> | undefined;
  try {
    response = await browser.tabs.sendMessage(tabId, message);
  } catch {
    // 插件安装/更新前打开的页面没有内容脚本，补注入一次后重试
    await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] });
    response = await browser.tabs.sendMessage(tabId, message);
  }
  if (!response) throw new Error('页面没有响应，请刷新 ChatGPT 页面后重试。');
  if (!response.ok) throw new Error(response.error || '未知错误');
  return response.result;
}

async function init() {
  const stored = await browser.storage.local.get(EMBED_IMAGES_KEY);
  optEmbed.checked = stored[EMBED_IMAGES_KEY] !== false;
  optEmbed.addEventListener('change', () => browser.storage.local.set({ [EMBED_IMAGES_KEY]: optEmbed.checked }));

  const imageOptions = {
    ...DEFAULT_IMAGE_OPTIONS,
    ...((await browser.storage.local.get(IMAGE_OPTIONS_KEY))[IMAGE_OPTIONS_KEY] as Partial<ImageOptions> | undefined),
  };
  optHideActions.checked = imageOptions.hideActions;
  optCropSides.checked = imageOptions.cropSides;
  for (const el of [optHideActions, optCropSides]) {
    el.addEventListener('change', () => browser.storage.local.set({ [IMAGE_OPTIONS_KEY]: readImageOptions() }));
  }

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !CHATGPT_URL.test(tab.url || '')) {
    targetEl.textContent = '请在 chatgpt.com 的对话页面中使用。';
    return;
  }
  tabId = tab.id;
  try {
    const info = await sendToTab<PingResult>({ type: 'CGE_PING' });
    // Markdown 需要对话 ID 调接口；图片只要页面上有对话即可（也支持分享页）。
    // 对话页上总是允许点击图片导出：识别失败时由页面返回具体原因，而不是静默禁用按钮
    canExportMd = !!info.conversationId;
    canExportImage = info.turnCount > 0 || canExportMd;
    if (!canExportMd && !canExportImage) {
      targetEl.textContent = '请先打开一个具体的对话。';
      return;
    }
    const title = (info.title || '').replace(/\s*[-|]\s*ChatGPT\s*$/i, '') || info.conversationId || '';
    targetEl.textContent = `当前对话：${title}`;
    targetEl.title = targetEl.textContent;
    setBusy(false);
  } catch (err) {
    targetEl.textContent = '无法连接页面，请刷新 ChatGPT 页面后重试。';
    setStatus((err as Error).message, true);
  }
}

btnMd.addEventListener('click', async () => {
  setBusy(true);
  setStatus(optEmbed.checked ? '正在读取对话并下载图片…' : '正在读取对话…');
  try {
    const result = await sendToTab<ExportMarkdownResult>({ type: 'CGE_EXPORT_MD', embedImages: optEmbed.checked });
    setStatus(`已导出 ${result.messageCount} 条消息：${result.filename}`);
  } catch (err) {
    setStatus((err as Error).message, true);
  } finally {
    setBusy(false);
  }
});

function readImageOptions(): ImageOptions {
  return { hideActions: optHideActions.checked, cropSides: optCropSides.checked };
}

btnImg.addEventListener('click', async () => {
  setBusy(true);
  setStatus('正在截图，期间请不要切换标签页或滚动页面（按 Esc 取消）…');
  try {
    const result = await sendToTab<ExportImageResult>({ type: 'CGE_EXPORT_IMAGE', options: readImageOptions() });
    const n = result.files.length;
    setStatus(
      n > 1
        ? `已导出 ${result.turnCount} 轮，较长，切分为 ${n} 张图片保存到「下载/ChatGPT」。`
        : `已导出 ${result.turnCount} 轮，保存到「下载/ChatGPT」。`,
    );
  } catch (err) {
    setStatus((err as Error).message, true);
  } finally {
    setBusy(false);
  }
});

// 截图进度（内容脚本广播）
browser.runtime.onMessage.addListener((message: BackgroundRequest, sender) => {
  if (message?.type === 'CGE_PROGRESS' && message.text && sender.tab?.id === tabId) setStatus(message.text);
});

init();
