'use strict';

const { renderMarkdown, escapeHtml } = window.CGERender;

// Chrome 单个 canvas 边长上限约 32767px，留出余量；超出时按消息切分为多张图片
const MAX_CANVAS_PX = 30000;
const OPTIONS_KEY = 'cge:previewOptions';
const IMAGE_TOKEN_RE = /!\[([^\]]*)\]\(cge-image:([^)\s]+)\)/g;

const $ = id => document.getElementById(id);
const card = $('card');
const messagesEl = $('messages');
const statusEl = $('status');
const opt = {
    theme: $('opt-theme'),
    width: $('opt-width'),
    scale: $('opt-scale'),
    header: $('opt-header'),
    footer: $('opt-footer')
};

let conversation = null;
let messageEls = [];

function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', isError);
}

function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function sanitizeFilename(name) {
    return String(name || '').replace(/[\/\\?%*:|"<>\x00-\x1f~]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80)
        || 'ChatGPT Conversation';
}

function fileStamp() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ---------- 渲染 ----------

function imageHtml(img) {
    if (img.dataUrl && /^data:image\//i.test(img.dataUrl)) {
        return `<img class="msg-image" src="${escapeHtml(img.dataUrl)}" alt="${escapeHtml(img.alt || 'image')}">`;
    }
    return `<div class="msg-image missing">图片无法加载：${escapeHtml(img.alt || img.fileId || '')}</div>`;
}

function buildMessage(msg, index) {
    const el = document.createElement('section');
    el.className = `msg msg-${msg.role}`;
    el.dataset.index = String(index);

    const parts = [];
    if (msg.role === 'user' && msg.images.length) {
        parts.push(`<div class="msg-images">${msg.images.map(imageHtml).join('')}</div>`);
    }
    if (msg.text) {
        if (msg.role === 'user') {
            parts.push(`<div class="msg-text plain">${escapeHtml(msg.text)}</div>`);
        } else {
            // 助手消息中的图片占位符 → data: 图片（加载失败时显示文字说明）
            const text = msg.text.replace(IMAGE_TOKEN_RE, (_, alt, fileId) => {
                const img = msg.images.find(i => i.fileId === fileId);
                return img?.dataUrl ? `![${alt}](${img.dataUrl})` : `*［图片无法加载：${alt}］*`;
            });
            const defs = msg.footnotes.map(n => `[${n.index}]: ${n.url}`).join('\n');
            parts.push(`<div class="msg-text markdown">${renderMarkdown(defs ? `${text}\n\n${defs}` : text)}</div>`);
        }
    }
    if (msg.files.length) {
        parts.push(`<div class="msg-files">${msg.files.map(f => `<span class="file-chip">📎 ${escapeHtml(f)}</span>`).join('')}</div>`);
    }

    el.innerHTML = `
        <label class="msg-check" title="是否包含在图片中"><input type="checkbox" checked></label>
        <div class="msg-body">${parts.join('')}</div>`;

    // Markdown 中被过滤掉 src 的外链图片，改为文字占位
    el.querySelectorAll('.markdown img:not([src])').forEach(img => {
        const span = document.createElement('span');
        span.className = 'link';
        span.textContent = `[图片: ${img.alt || ''}]`;
        img.replaceWith(span);
    });

    const checkbox = el.querySelector('.msg-check input');
    checkbox.addEventListener('change', () => {
        el.classList.toggle('excluded', !checkbox.checked);
        updateSelectionCount();
    });
    return el;
}

function renderConversation() {
    $('card-title').textContent = conversation.title;
    const meta = [formatDate(conversation.createTime), `${conversation.messages.length} 条消息`].filter(Boolean);
    $('card-meta').textContent = meta.join(' · ');
    $('card-footer-date').textContent = `导出于 ${formatDate(new Date().toISOString())}`;

    messagesEl.textContent = '';
    messageEls = conversation.messages.map(buildMessage);
    messageEls.forEach(el => messagesEl.appendChild(el));
    if (messageEls.length === 0) {
        messagesEl.innerHTML = '<p class="empty">这个对话没有可导出的消息。</p>';
    }
    updateSelectionCount();
}

function updateSelectionCount() {
    const selected = messageEls.filter(el => !el.classList.contains('excluded')).length;
    $('sel-count').textContent = `${selected}/${messageEls.length}`;
}

function setSelection(predicate) {
    messageEls.forEach((el, i) => {
        const on = predicate(i);
        el.querySelector('.msg-check input').checked = on;
        el.classList.toggle('excluded', !on);
    });
    updateSelectionCount();
}

// ---------- 外观选项 ----------

function applyOptions() {
    const dark = opt.theme.value === 'dark';
    card.classList.toggle('theme-dark', dark);
    card.classList.toggle('theme-light', !dark);
    document.body.classList.toggle('stage-dark', dark);
    $('hljs-light').disabled = dark;
    $('hljs-dark').disabled = !dark;
    card.style.width = `${opt.width.value}px`;
    $('card-header').hidden = !opt.header.checked;
    $('card-footer').hidden = !opt.footer.checked;
}

async function loadOptions() {
    const stored = (await chrome.storage.local.get(OPTIONS_KEY))[OPTIONS_KEY] || {};
    for (const [key, el] of Object.entries(opt)) {
        if (!(key in stored)) continue;
        if (el.type === 'checkbox') el.checked = Boolean(stored[key]);
        else if ([...el.options].some(o => o.value === String(stored[key]))) el.value = String(stored[key]);
    }
}

function saveOptions() {
    const values = {};
    for (const [key, el] of Object.entries(opt)) values[key] = el.type === 'checkbox' ? el.checked : el.value;
    chrome.storage.local.set({ [OPTIONS_KEY]: values });
}

// ---------- 截图 ----------

function backgroundColor() {
    return getComputedStyle(card).backgroundColor || '#ffffff';
}

async function captureCard(scale) {
    await document.fonts.ready;
    return modernScreenshot.domToCanvas(card, {
        scale,
        backgroundColor: backgroundColor(),
        filter: node => !(node instanceof Element && node.classList.contains('msg-check'))
    });
}

function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('生成 PNG 失败（图片可能过大）')), 'image/png');
    });
}

/**
 * 生成图片：总高度不超过上限时输出一张；否则按消息边界切分成多张，
 * 单条消息本身过长时自动降低该张图片的缩放比例。
 */
async function captureImages(onProgress) {
    const selected = messageEls.filter(el => !el.classList.contains('excluded'));
    if (selected.length === 0) throw new Error('请至少选择一条消息。');

    const scale = Number(opt.scale.value) || 2;
    const partLabel = $('card-part');
    document.body.classList.add('capturing');
    try {
        const fullHeight = card.offsetHeight;
        if (fullHeight * scale <= MAX_CANVAS_PX) {
            onProgress?.('正在生成图片…');
            return [await canvasToBlob(await captureCard(scale))];
        }

        const gap = parseFloat(getComputedStyle(messagesEl).rowGap) || 0;
        const chromeHeight = fullHeight - messagesEl.offsetHeight;
        const budget = MAX_CANVAS_PX / scale - chromeHeight;
        const groups = [];
        let current = [];
        let height = 0;
        for (const el of selected) {
            const h = el.offsetHeight + gap;
            if (current.length && height + h > budget) {
                groups.push(current);
                current = [];
                height = 0;
            }
            current.push(el);
            height += h;
        }
        if (current.length) groups.push(current);

        const blobs = [];
        for (let i = 0; i < groups.length; i++) {
            onProgress?.(`正在生成第 ${i + 1}/${groups.length} 张图片…`);
            const inGroup = new Set(groups[i]);
            selected.forEach(el => el.classList.toggle('chunk-hidden', !inGroup.has(el)));
            partLabel.textContent = `(${i + 1}/${groups.length})`;
            const partScale = Math.min(scale, MAX_CANVAS_PX / card.offsetHeight);
            blobs.push(await canvasToBlob(await captureCard(partScale)));
        }
        return blobs;
    } finally {
        selected.forEach(el => el.classList.remove('chunk-hidden'));
        partLabel.textContent = '';
        document.body.classList.remove('capturing');
    }
}

async function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
        await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    } finally {
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
}

async function withBusy(task) {
    const buttons = document.querySelectorAll('.toolbar .btn');
    buttons.forEach(b => { b.disabled = true; });
    try {
        await task();
    } catch (err) {
        console.error(err);
        setStatus(err?.message || String(err), true);
    } finally {
        buttons.forEach(b => { b.disabled = false; });
    }
}

$('btn-download').addEventListener('click', () => withBusy(async () => {
    const blobs = await captureImages(setStatus);
    const base = `ChatGPT/${sanitizeFilename(conversation.title)}_${fileStamp()}`;
    for (let i = 0; i < blobs.length; i++) {
        const name = blobs.length > 1 ? `${base}_${i + 1}of${blobs.length}.png` : `${base}.png`;
        await downloadBlob(blobs[i], name);
    }
    setStatus(blobs.length > 1
        ? `对话较长，已切分为 ${blobs.length} 张图片下载到「下载/ChatGPT」目录。`
        : '已下载到「下载/ChatGPT」目录。');
}));

$('btn-copy').addEventListener('click', () => withBusy(async () => {
    const blobs = await captureImages(setStatus);
    if (blobs.length > 1) {
        throw new Error(`内容过长需要切分为 ${blobs.length} 张图片，无法复制，请使用「下载 PNG」或减少选中的消息。`);
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blobs[0] })]);
    setStatus('图片已复制到剪贴板。');
}));

$('sel-all').addEventListener('click', () => setSelection(() => true));
$('sel-none').addEventListener('click', () => setSelection(() => false));
$('sel-last').addEventListener('click', () => {
    const msgs = conversation?.messages || [];
    let start = msgs.map(m => m.role).lastIndexOf('user');
    if (start < 0) start = Math.max(0, msgs.length - 1);
    setSelection(i => i >= start);
});

Object.values(opt).forEach(el => el.addEventListener('change', () => {
    applyOptions();
    saveOptions();
}));

// ---------- 初始化 ----------

(async function init() {
    const key = new URLSearchParams(location.search).get('key');
    const stored = key ? (await chrome.storage.local.get(key))[key] : null;
    if (!stored?.data) {
        document.body.classList.add('no-data');
        $('card-title').textContent = '没有找到对话数据';
        $('card-meta').textContent = '预览数据只保留 24 小时，请回到 ChatGPT 页面重新点击「导出图片」。';
        document.querySelectorAll('.toolbar .btn').forEach(b => { b.disabled = true; });
        return;
    }
    conversation = stored.data;
    document.title = `导出图片 · ${conversation.title}`;
    await loadOptions();
    applyOptions();
    renderConversation();
})();
