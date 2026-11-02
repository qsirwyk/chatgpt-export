// 运行在 chatgpt.com 页面中的内容脚本：
// 负责读取当前对话数据（backend-api）、整理成统一结构、生成 Markdown 并下载。
// 图片导出所需的数据也由这里提供，渲染与截图在扩展的预览页中完成。
(() => {
    'use strict';
    if (window.__CGE_CONTENT_LOADED__) return;
    window.__CGE_CONTENT_LOADED__ = true;

    const EXPORTER_NAME = 'ChatGPT Export';
    const IMAGE_CONCURRENCY = 3;
    let accessToken = null;

    // ---------- 通用工具 ----------

    function getCookie(name) {
        const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[-.]/g, '\\$&') + '=([^;]+)'));
        return match ? decodeURIComponent(match[1]) : null;
    }

    function getConversationId() {
        const match = location.pathname.match(/\/c\/([0-9a-zA-Z-]{8,})/);
        return match ? match[1] : null;
    }

    function sanitizeFilename(name) {
        return String(name || '')
            .replace(/[\/\\?%*:|"<>\x00-\x1f]/g, '-')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80) || 'ChatGPT Conversation';
    }

    function toSeconds(value) {
        if (!value) return 0;
        if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value / 1000 : value;
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? 0 : parsed / 1000;
    }

    function toIso(value) {
        const s = toSeconds(value);
        return s ? new Date(s * 1000).toISOString() : null;
    }

    function localStamp(date = new Date()) {
        const p = n => String(n).padStart(2, '0');
        return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
    }

    function downloadBlob(blob, filename) {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    }

    function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    // ---------- 鉴权与请求 ----------

    async function ensureAccessToken(force = false) {
        if (accessToken && !force) return accessToken;
        const res = await fetch('/api/auth/session', { credentials: 'include' });
        if (!res.ok) throw new Error(`获取登录状态失败 (HTTP ${res.status})`);
        const session = await res.json();
        if (!session?.accessToken) throw new Error('未获取到 Access Token，请确认已登录 ChatGPT 后刷新页面重试。');
        accessToken = session.accessToken;
        return accessToken;
    }

    function buildHeaders() {
        const headers = { Authorization: `Bearer ${accessToken}` };
        const deviceId = getCookie('oai-did');
        if (deviceId) headers['oai-device-id'] = deviceId;
        // Team / Enterprise 工作区：页面会把当前工作区 ID 写入 _account cookie
        const account = getCookie('_account');
        if (account && /^[0-9a-f-]{20,}$/i.test(account)) headers['ChatGPT-Account-Id'] = account;
        return headers;
    }

    async function apiFetch(path) {
        await ensureAccessToken();
        let res = await fetch(path, { credentials: 'include', headers: buildHeaders() });
        if (res.status === 401) {
            await ensureAccessToken(true);
            res = await fetch(path, { credentials: 'include', headers: buildHeaders() });
        }
        if (!res.ok) {
            const hint = res.status === 404 ? '（对话不存在，或属于其他工作区）'
                : res.status === 429 ? '（请求过于频繁，请稍后再试）' : '';
            throw new Error(`请求失败 HTTP ${res.status}${hint}`);
        }
        return res;
    }

    async function fetchConversation(id) {
        const res = await apiFetch(`/backend-api/conversation/${encodeURIComponent(id)}`);
        return res.json();
    }

    // ---------- 对话结构整理 ----------

    // 从 current_node 沿 parent 回溯，得到当前显示的分支（忽略被编辑/重新生成掉的分支）
    function getActiveNodes(conv) {
        const mapping = conv?.mapping;
        if (!mapping || typeof mapping !== 'object') return [];
        let nodeId = conv.current_node;
        if (!nodeId || !mapping[nodeId]) {
            const leaves = Object.entries(mapping)
                .filter(([, n]) => !n?.children?.length)
                .sort(([, a], [, b]) => (b?.message?.create_time || 0) - (a?.message?.create_time || 0));
            nodeId = leaves[0]?.[0];
        }
        const path = [];
        const seen = new Set();
        while (nodeId && !seen.has(nodeId) && mapping[nodeId]) {
            seen.add(nodeId);
            path.push(mapping[nodeId]);
            nodeId = mapping[nodeId].parent;
        }
        return path.reverse();
    }

    function extractFileId(pointer) {
        if (typeof pointer !== 'string') return null;
        const match = pointer.match(/file[-_][0-9a-zA-Z]+/);
        return match ? match[0] : null;
    }

    // 去掉 ChatGPT 内部使用的私有区引用标记（如 citeturn0search1）
    function cleanText(text) {
        if (!text) return '';
        return text
            .replace(/[^]*/g, '')
            .replace(/[-]/g, '')
            .replace(/cite(?:turn\d+(?:search|view|news|image)\d+)+/gi, '')
            .trim();
    }

    // 把 content_references（联网搜索引用）替换为 Markdown 引用式链接，并返回脚注
    function processContentReferences(text, refs, startIndex) {
        const list = (Array.isArray(refs) ? refs : []).filter(r => r && typeof r.matched_text === 'string' && r.matched_text);
        if (!text || list.length === 0) return { text, footnotes: [], next: startIndex };

        const infoOf = (ref) => {
            const item = Array.isArray(ref.items) ? ref.items[0] : null;
            const url = item?.url || (Array.isArray(ref.safe_urls) ? ref.safe_urls[0] : '') || '';
            const title = item?.title || '';
            let label = item?.attribution || '';
            if (!label && typeof ref.alt === 'string') {
                const m = ref.alt.match(/\[([^\]]+)\]\([^)]+\)/);
                if (m) label = m[1];
            }
            return { url, title, label: label || title || url };
        };

        const footnotes = [];
        const indexByKey = new Map();
        list.filter(r => r.type === 'grouped_webpages')
            .sort((a, b) => (a.start_idx ?? Infinity) - (b.start_idx ?? Infinity))
            .forEach(ref => {
                const info = infoOf(ref);
                if (!info.url) return;
                const key = `${info.url}|${info.title}`;
                if (indexByKey.has(key)) return;
                const index = startIndex + footnotes.length;
                indexByKey.set(key, index);
                footnotes.push({ index, ...info });
            });

        let out = text;
        list.slice()
            .sort((a, b) => (b.start_idx ?? -1) - (a.start_idx ?? -1) || b.matched_text.length - a.matched_text.length)
            .forEach(ref => {
                if (ref.type === 'sources_footnote') return;
                let replacement = ref.alt || '';
                if (ref.type === 'grouped_webpages') {
                    const info = infoOf(ref);
                    const index = info.url ? indexByKey.get(`${info.url}|${info.title}`) : null;
                    if (index) replacement = ` ([${info.label.replace(/[\[\]]/g, '')}][${index}])`;
                }
                if (Number.isFinite(ref.start_idx) && Number.isFinite(ref.end_idx)
                    && out.slice(ref.start_idx, ref.end_idx) === ref.matched_text) {
                    out = out.slice(0, ref.start_idx) + replacement + out.slice(ref.end_idx);
                } else {
                    out = out.split(ref.matched_text).join(replacement);
                }
            });

        return { text: out, footnotes, next: startIndex + footnotes.length };
    }

    // 助手消息中的图片在 text 里用 ![alt](cge-image:<fileId>) 占位，导出时再替换为真实图片
    const IMAGE_TOKEN_RE = /!\[([^\]]*)\]\(cge-image:([^)\s]+)\)/g;

    function inlineImageTokens(images) {
        return images.map(img => `![${(img.alt || 'image').replace(/[\[\]]/g, '')}](cge-image:${img.fileId})`).join('\n\n');
    }

    /**
     * 统一的对话结构：
     * { id, title, url, createTime, updateTime,
     *   messages: [{ id, role: 'user'|'assistant', text, images: [{fileId, alt, dataUrl?}], files: [name], footnotes }] }
     * user 消息的图片单独展示在文字之前；assistant 消息的图片以占位符内联在 text 中。
     */
    function normalizeConversation(conv) {
        const id = conv.conversation_id || conv.id || getConversationId();
        const messages = [];
        let refIndex = 1;

        for (const node of getActiveNodes(conv)) {
            const msg = node?.message;
            if (!msg) continue;
            const role = msg.author?.role;
            const meta = msg.metadata || {};
            if (meta.is_visually_hidden_from_conversation || meta.is_contextual_answers_system_message) continue;

            const content = msg.content || {};
            const parts = Array.isArray(content.parts) ? content.parts : [];

            // 工具消息里只保留生成的图片（DALL·E / 图像生成），合并到助手回答中
            if (role === 'tool') {
                const images = parts
                    .filter(p => p && typeof p === 'object' && p.asset_pointer && /image/i.test(p.content_type || ''))
                    .map(p => ({ fileId: extractFileId(p.asset_pointer), alt: 'generated image' }))
                    .filter(img => img.fileId);
                if (images.length) {
                    pushMessage({ id: msg.id, role: 'assistant', text: inlineImageTokens(images), images, files: [], footnotes: [] });
                }
                continue;
            }
            if (role !== 'user' && role !== 'assistant') continue;
            if (role === 'assistant' && msg.recipient && msg.recipient !== 'all') continue; // 工具调用
            if (content.content_type !== 'text' && content.content_type !== 'multimodal_text') continue;

            const texts = [];
            const images = [];
            for (const part of parts) {
                if (typeof part === 'string') {
                    texts.push(part);
                } else if (part && typeof part === 'object') {
                    if (part.asset_pointer && /image/i.test(part.content_type || '')) {
                        const fileId = extractFileId(part.asset_pointer);
                        if (fileId) images.push({ fileId, alt: 'image' });
                    } else if (typeof part.text === 'string') {
                        texts.push(part.text);
                    }
                }
            }

            let text = texts.filter(Boolean).join('\n');
            let footnotes = [];
            if (role === 'assistant' && Array.isArray(meta.content_references) && meta.content_references.length) {
                const processed = processContentReferences(text, meta.content_references, refIndex);
                text = processed.text;
                footnotes = processed.footnotes;
                refIndex = processed.next;
            }
            text = cleanText(text);
            // 助手消息中的图片以占位符形式内联，保持与文字的先后顺序
            if (role === 'assistant' && images.length) {
                text = [text, inlineImageTokens(images)].filter(Boolean).join('\n\n');
            }

            const imageIds = new Set(images.map(i => i.fileId));
            const files = [];
            if (role === 'user') {
                for (const att of meta.attachments || []) {
                    const fileId = att?.id || att?.file_id;
                    if (fileId && imageIds.has(fileId)) {
                        const img = images.find(i => i.fileId === fileId);
                        if (img && att.name) img.alt = att.name;
                        continue;
                    }
                    if (att?.name) files.push(att.name);
                }
            }

            if (!text && images.length === 0 && files.length === 0) continue;
            pushMessage({ id: msg.id, role, text, images, files, footnotes });
        }

        // 连续的助手消息（工具调用前后分段输出）合并为一条，更符合页面上的观感
        function pushMessage(m) {
            const last = messages[messages.length - 1];
            if (last && last.role === 'assistant' && m.role === 'assistant') {
                last.text = [last.text, m.text].filter(Boolean).join('\n\n');
                last.images.push(...m.images);
                last.files.push(...m.files);
                last.footnotes.push(...m.footnotes);
                return;
            }
            messages.push(m);
        }

        return {
            id,
            title: conv.title || 'Untitled Conversation',
            url: id ? `${location.origin}/c/${id}` : location.href,
            createTime: toIso(conv.create_time),
            updateTime: toIso(conv.update_time),
            messages
        };
    }

    // ---------- 图片下载 ----------

    async function fetchImageDataUrl(fileId, conversationId) {
        const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}&inline=false` : '?inline=false';
        const metaRes = await apiFetch(`/backend-api/files/download/${encodeURIComponent(fileId)}${query}`);
        let blob;
        if ((metaRes.headers.get('content-type') || '').includes('json')) {
            const meta = await metaRes.json();
            const url = meta.download_url || meta.url;
            if (!url) throw new Error('download_url 缺失');
            const target = new URL(url, location.origin);
            const res = await fetch(target.href, target.origin === location.origin
                ? { credentials: 'include', headers: buildHeaders() } : {});
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            blob = await res.blob();
        } else {
            blob = await metaRes.blob();
        }
        return blobToDataUrl(blob);
    }

    // 为所有图片补充 dataUrl 字段（失败时为 null），并发受限
    async function resolveImages(data) {
        const all = data.messages.flatMap(m => m.images);
        const cache = new Map();
        let cursor = 0;
        async function worker() {
            while (cursor < all.length) {
                const img = all[cursor++];
                if (!cache.has(img.fileId)) {
                    cache.set(img.fileId, fetchImageDataUrl(img.fileId, data.id).catch(err => {
                        console.warn('[ChatGPT Export] 图片下载失败', img.fileId, err);
                        return null;
                    }));
                }
                img.dataUrl = await cache.get(img.fileId);
            }
        }
        await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, all.length) }, worker));
        return data;
    }

    // ---------- Markdown 生成 ----------

    function yamlString(value) {
        return JSON.stringify(String(value));
    }

    function buildMarkdown(data, { embedImages }) {
        const lines = [
            '---',
            `title: ${yamlString(data.title)}`,
            data.id && `conversation_id: ${yamlString(data.id)}`,
            data.createTime && `created: ${yamlString(data.createTime)}`,
            data.updateTime && `updated: ${yamlString(data.updateTime)}`,
            `url: ${yamlString(data.url)}`,
            `exported: ${yamlString(new Date().toISOString())}`,
            `exported_by: ${yamlString(EXPORTER_NAME)}`,
            '---',
            '',
            `# ${data.title}`,
            ''
        ].filter(line => line !== null && line !== undefined && line !== false);

        if (data.messages.length === 0) lines.push('_（没有可导出的消息）_', '');

        for (const msg of data.messages) {
            lines.push(msg.role === 'user' ? '## 🧑 User' : '## 🤖 ChatGPT', '');
            const imageMd = (alt, fileId) => {
                const img = msg.images.find(i => i.fileId === fileId);
                return embedImages && img?.dataUrl ? `![${alt}](${img.dataUrl})` : `_[图片: ${alt} (${fileId})]_`;
            };
            if (msg.role === 'user') {
                for (const img of msg.images) {
                    lines.push(imageMd((img.alt || 'image').replace(/[\[\]]/g, ''), img.fileId), '');
                }
            }
            if (msg.text) lines.push(msg.text.replace(IMAGE_TOKEN_RE, (_, alt, fileId) => imageMd(alt, fileId)), '');
            for (const name of msg.files) lines.push(`📎 ${name}`, '');
            if (msg.footnotes.length) {
                msg.footnotes.forEach(n => {
                    const title = n.title ? ` "${n.title.replace(/"/g, "'")}"` : '';
                    lines.push(`[${n.index}]: ${n.url}${title}`);
                });
                lines.push('');
            }
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }

    // ---------- 对外接口 ----------

    async function loadCurrentConversation({ withImages }) {
        const id = getConversationId();
        if (!id) throw new Error('当前页面不是一个对话（URL 中应包含 /c/<id>）。');
        const data = normalizeConversation(await fetchConversation(id));
        if (withImages) await resolveImages(data);
        return data;
    }

    async function exportMarkdown({ embedImages }) {
        const data = await loadCurrentConversation({ withImages: embedImages });
        const md = buildMarkdown(data, { embedImages });
        const filename = `${sanitizeFilename(data.title)}_${localStamp()}.md`;
        downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), filename);
        return { filename, messageCount: data.messages.length };
    }

    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
        const handlers = {
            CGE_PING: async () => ({ conversationId: getConversationId(), title: document.title }),
            CGE_EXPORT_MD: async () => exportMarkdown({ embedImages: request.embedImages !== false }),
            CGE_GET_DATA: async () => loadCurrentConversation({ withImages: true })
        };
        const handler = handlers[request?.type];
        if (!handler) return false;
        handler()
            .then(result => sendResponse({ ok: true, result }))
            .catch(err => sendResponse({ ok: false, error: err?.message || String(err) }));
        return true;
    });
})();
