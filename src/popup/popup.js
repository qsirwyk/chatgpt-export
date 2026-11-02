'use strict';

const PREVIEW_PREFIX = 'cge:preview:';
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const CHATGPT_URL = /^https:\/\/(chatgpt\.com|chat\.openai\.com)\//;

const $ = id => document.getElementById(id);
const targetEl = $('target');
const statusEl = $('status');
const btnMd = $('btn-md');
const btnImg = $('btn-img');
const optEmbed = $('opt-embed');

let tabId = null;

function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
}

function setBusy(busy) {
    btnMd.disabled = busy;
    btnImg.disabled = busy;
}

async function sendToTab(message) {
    let response;
    try {
        response = await chrome.tabs.sendMessage(tabId, message);
    } catch (err) {
        // 插件安装/更新前打开的页面没有内容脚本，补注入一次后重试
        await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
        response = await chrome.tabs.sendMessage(tabId, message);
    }
    if (!response) throw new Error('页面没有响应，请刷新 ChatGPT 页面后重试。');
    if (!response.ok) throw new Error(response.error || '未知错误');
    return response.result;
}

async function cleanupOldPreviews() {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const stale = Object.keys(all).filter(key =>
        key.startsWith(PREVIEW_PREFIX) && !(now - (all[key]?.createdAt || 0) < PREVIEW_TTL_MS));
    if (stale.length) await chrome.storage.local.remove(stale);
}

async function init() {
    const stored = await chrome.storage.local.get('cge:embedImages');
    optEmbed.checked = stored['cge:embedImages'] !== false;
    optEmbed.addEventListener('change', () => chrome.storage.local.set({ 'cge:embedImages': optEmbed.checked }));

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !CHATGPT_URL.test(tab.url || '')) {
        targetEl.textContent = '请在 chatgpt.com 的对话页面中使用。';
        return;
    }
    tabId = tab.id;
    try {
        const info = await sendToTab({ type: 'CGE_PING' });
        if (!info.conversationId) {
            targetEl.textContent = '请先打开一个具体的对话。';
            return;
        }
        targetEl.textContent = `当前对话：${(info.title || '').replace(/\s*[-|]\s*ChatGPT\s*$/i, '') || info.conversationId}`;
        targetEl.title = targetEl.textContent;
        setBusy(false);
    } catch (err) {
        targetEl.textContent = '无法连接页面，请刷新 ChatGPT 页面后重试。';
        setStatus(err.message, true);
    }
}

btnMd.addEventListener('click', async () => {
    setBusy(true);
    setStatus(optEmbed.checked ? '正在读取对话并下载图片…' : '正在读取对话…');
    try {
        const result = await sendToTab({ type: 'CGE_EXPORT_MD', embedImages: optEmbed.checked });
        setStatus(`已导出 ${result.messageCount} 条消息：${result.filename}`);
    } catch (err) {
        setStatus(err.message, true);
    } finally {
        setBusy(false);
    }
});

btnImg.addEventListener('click', async () => {
    setBusy(true);
    setStatus('正在读取对话与图片…');
    try {
        const data = await sendToTab({ type: 'CGE_GET_DATA' });
        await cleanupOldPreviews();
        const key = PREVIEW_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        await chrome.storage.local.set({ [key]: { createdAt: Date.now(), data } });
        await chrome.tabs.create({
            url: chrome.runtime.getURL(`src/preview/preview.html?key=${encodeURIComponent(key)}`)
        });
    } catch (err) {
        setStatus(err.message, true);
        setBusy(false);
    }
});

init();
