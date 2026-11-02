// ChatGPT 接口访问与 Markdown 导出：取 token、请求对话、下载对话图片、生成并下载 .md。
import { buildMarkdown, fileStamp, normalizeConversation, sanitizeFilename, type RawConversation } from '@/utils/conversation';
import type { Conversation, ExportMarkdownResult } from '@/utils/types';

const IMAGE_CONCURRENCY = 3;

// ---------- 页面信息 ----------

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name.replace(/[-.]/g, '\\$&') + '=([^;]+)'));
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

export function getConversationId(): string | null {
  const match = location.pathname.match(/\/c\/([0-9a-zA-Z-]{8,})/);
  return match?.[1] ?? null;
}

// ---------- 鉴权与请求 ----------

let accessToken: string | null = null;

async function ensureAccessToken(force = false): Promise<string> {
  if (accessToken && !force) return accessToken;
  const res = await fetch('/api/auth/session', { credentials: 'include' });
  if (!res.ok) throw new Error(`获取登录状态失败 (HTTP ${res.status})`);
  const session = (await res.json()) as { accessToken?: string };
  if (!session?.accessToken) throw new Error('未获取到 Access Token，请确认已登录 ChatGPT 后刷新页面重试。');
  accessToken = session.accessToken;
  return accessToken;
}

function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  const deviceId = getCookie('oai-did');
  if (deviceId) headers['oai-device-id'] = deviceId;
  // Team / Enterprise 工作区：页面会把当前工作区 ID 写入 _account cookie
  const account = getCookie('_account');
  if (account && /^[0-9a-f-]{20,}$/i.test(account)) headers['ChatGPT-Account-Id'] = account;
  return headers;
}

async function apiFetch(path: string): Promise<Response> {
  await ensureAccessToken();
  let res = await fetch(path, { credentials: 'include', headers: buildHeaders() });
  if (res.status === 401) {
    await ensureAccessToken(true);
    res = await fetch(path, { credentials: 'include', headers: buildHeaders() });
  }
  if (!res.ok) {
    const hint =
      res.status === 404 ? '（对话不存在，或属于其他工作区）' : res.status === 429 ? '（请求过于频繁，请稍后再试）' : '';
    throw new Error(`请求失败 HTTP ${res.status}${hint}`);
  }
  return res;
}

// ---------- 图片下载 ----------

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function fetchImageDataUrl(fileId: string, conversationId: string | null): Promise<string> {
  const query = conversationId ? `?conversation_id=${encodeURIComponent(conversationId)}&inline=false` : '?inline=false';
  const metaRes = await apiFetch(`/backend-api/files/download/${encodeURIComponent(fileId)}${query}`);
  let blob: Blob;
  if ((metaRes.headers.get('content-type') || '').includes('json')) {
    const meta = (await metaRes.json()) as { download_url?: string; url?: string };
    const url = meta.download_url || meta.url;
    if (!url) throw new Error('download_url 缺失');
    const target = new URL(url, location.origin);
    const res = await fetch(
      target.href,
      target.origin === location.origin ? { credentials: 'include', headers: buildHeaders() } : {},
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    blob = await res.blob();
  } else {
    blob = await metaRes.blob();
  }
  return blobToDataUrl(blob);
}

/** 为所有图片补充 dataUrl（失败时为 null），并发受限，同一文件只下载一次 */
async function resolveImages(data: Conversation): Promise<void> {
  const all = data.messages.flatMap((m) => m.images);
  const cache = new Map<string, Promise<string | null>>();
  let cursor = 0;
  const worker = async () => {
    while (cursor < all.length) {
      const img = all[cursor++];
      if (!img) break;
      if (!cache.has(img.fileId)) {
        cache.set(
          img.fileId,
          fetchImageDataUrl(img.fileId, data.id).catch((err) => {
            console.warn('[ChatGPT Export] 图片下载失败', img.fileId, err);
            return null;
          }),
        );
      }
      img.dataUrl = await cache.get(img.fileId)!;
    }
  };
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, all.length) }, worker));
}

// ---------- 导出 ----------

async function loadCurrentConversation(withImages: boolean): Promise<Conversation> {
  const id = getConversationId();
  if (!id) throw new Error('当前页面不是一个对话（URL 中应包含 /c/<id>）。');
  const res = await apiFetch(`/backend-api/conversation/${encodeURIComponent(id)}`);
  const data = normalizeConversation((await res.json()) as RawConversation, { id, origin: location.origin });
  if (withImages) await resolveImages(data);
  return data;
}

function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

export async function exportMarkdown(embedImages: boolean): Promise<ExportMarkdownResult> {
  const data = await loadCurrentConversation(embedImages);
  const md = buildMarkdown(data, { embedImages });
  const filename = `${sanitizeFilename(data.title)}_${fileStamp()}.md`;
  downloadBlob(new Blob([md], { type: 'text/markdown;charset=utf-8' }), filename);
  return { filename, messageCount: data.messages.length };
}
