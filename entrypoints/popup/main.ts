import './style.css';
import { browser } from 'wxt/browser';
import {
  EMBED_IMAGES_KEY,
  type ContentRequest,
  type ExportMarkdownResult,
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

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !CHATGPT_URL.test(tab.url || '')) {
    targetEl.textContent = '请在 chatgpt.com 的对话页面中使用。';
    return;
  }
  tabId = tab.id;
  try {
    const info = await sendToTab<PingResult>({ type: 'CGE_PING' });
    // Markdown 需要对话 ID 调接口；图片只要页面上有对话节点即可（也支持分享页）
    canExportMd = !!info.conversationId;
    canExportImage = info.turnCount > 0;
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

btnImg.addEventListener('click', async () => {
  setBusy(true);
  try {
    // 在页面中进入选择模式（勾选消息 + 底部工具栏），弹窗随即关闭
    await sendToTab<number>({ type: 'CGE_START_IMAGE_MODE' });
    window.close();
  } catch (err) {
    setStatus((err as Error).message, true);
    setBusy(false);
  }
});

init();
