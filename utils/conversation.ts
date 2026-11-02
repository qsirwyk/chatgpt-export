// 纯函数：把 /backend-api/conversation/<id> 的原始数据整理成统一结构，并生成 Markdown。
// 不依赖 DOM 与扩展 API，内容脚本和测试都可以直接使用。
import {
  IMAGE_TOKEN_RE,
  type Conversation,
  type ConversationImage,
  type ConversationMessage,
  type Footnote,
} from './types';

// ---------- 原始接口数据（只声明用到的字段） ----------

interface RawContentReference {
  type?: string;
  matched_text?: string;
  start_idx?: number | null;
  end_idx?: number | null;
  alt?: string;
  safe_urls?: string[];
  items?: Array<{ url?: string; title?: string; attribution?: string }>;
}

type RawPart =
  | string
  | { content_type?: string; asset_pointer?: string; text?: string; [key: string]: unknown }
  | null;

interface RawMessage {
  id: string;
  author?: { role?: string };
  recipient?: string;
  create_time?: number | null;
  content?: { content_type?: string; parts?: RawPart[] };
  metadata?: {
    is_visually_hidden_from_conversation?: boolean;
    is_contextual_answers_system_message?: boolean;
    content_references?: RawContentReference[];
    attachments?: Array<{ id?: string; file_id?: string; name?: string; mime_type?: string }>;
  };
}

interface RawNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: RawMessage | null;
}

export interface RawConversation {
  title?: string;
  conversation_id?: string;
  id?: string;
  create_time?: number | string | null;
  update_time?: number | string | null;
  current_node?: string;
  mapping?: Record<string, RawNode>;
}

// ---------- 通用工具 ----------

export function sanitizeFilename(name: string): string {
  return (
    String(name || '')
      .replace(/[\/\\?%*:|"<>~\x00-\x1f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'ChatGPT Conversation'
  );
}

export function fileStamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
}

function toIso(value: number | string | null | undefined): string | null {
  if (!value) return null;
  let seconds: number;
  if (typeof value === 'number') {
    seconds = value > 1e12 ? value / 1000 : value;
  } else {
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) return null;
    seconds = parsed / 1000;
  }
  return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
}

function extractFileId(pointer: unknown): string | null {
  if (typeof pointer !== 'string') return null;
  const match = pointer.match(/file[-_][0-9a-zA-Z]+/);
  return match ? match[0] : null;
}

function isImagePart(part: RawPart): part is Exclude<RawPart, string | null> & { asset_pointer: string } {
  return !!part && typeof part === 'object' && typeof part.asset_pointer === 'string' && /image/i.test(part.content_type || '');
}

// ---------- 分支与文本处理 ----------

/** 从 current_node 沿 parent 回溯，得到当前显示的分支（忽略被编辑/重新生成掉的分支） */
export function getActiveNodes(conv: RawConversation): RawNode[] {
  const mapping = conv.mapping;
  if (!mapping || typeof mapping !== 'object') return [];
  let nodeId: string | null | undefined = conv.current_node;
  if (!nodeId || !mapping[nodeId]) {
    const leaves = Object.entries(mapping)
      .filter(([, n]) => !n?.children?.length)
      .sort(([, a], [, b]) => (b?.message?.create_time || 0) - (a?.message?.create_time || 0));
    nodeId = leaves[0]?.[0];
  }
  const path: RawNode[] = [];
  const seen = new Set<string>();
  let node = nodeId ? mapping[nodeId] : undefined;
  while (nodeId && node && !seen.has(nodeId)) {
    seen.add(nodeId);
    path.push(node);
    nodeId = node.parent;
    node = nodeId ? mapping[nodeId] : undefined;
  }
  return path.reverse();
}

/** 去掉 ChatGPT 内部使用的私有区引用标记（如 citeturn0search1） */
export function cleanText(text: string): string {
  if (!text) return '';
  return text
    .replace(/[^]*/g, '')
    .replace(/[-]/g, '')
    .replace(/cite(?:turn\d+(?:search|view|news|image)\d+)+/gi, '')
    .trim();
}

/** 把 content_references（联网搜索引用）替换为 Markdown 引用式链接，并返回脚注 */
export function processContentReferences(
  text: string,
  refs: RawContentReference[] | undefined,
  startIndex: number,
): { text: string; footnotes: Footnote[]; next: number } {
  const list = (Array.isArray(refs) ? refs : []).filter(
    (r): r is RawContentReference & { matched_text: string } => !!r && typeof r.matched_text === 'string' && !!r.matched_text,
  );
  if (!text || list.length === 0) return { text, footnotes: [], next: startIndex };

  const infoOf = (ref: RawContentReference) => {
    const item = Array.isArray(ref.items) ? ref.items[0] : undefined;
    const url = item?.url || (Array.isArray(ref.safe_urls) ? ref.safe_urls[0] : '') || '';
    const title = item?.title || '';
    let label = item?.attribution || '';
    if (!label && typeof ref.alt === 'string') {
      const m = ref.alt.match(/\[([^\]]+)\]\([^)]+\)/);
      if (m?.[1]) label = m[1];
    }
    return { url, title, label: label || title || url };
  };

  const footnotes: Footnote[] = [];
  const indexByKey = new Map<string, number>();
  list
    .filter((r) => r.type === 'grouped_webpages')
    .sort((a, b) => (a.start_idx ?? Infinity) - (b.start_idx ?? Infinity))
    .forEach((ref) => {
      const info = infoOf(ref);
      if (!info.url) return;
      const key = `${info.url}|${info.title}`;
      if (indexByKey.has(key)) return;
      const index = startIndex + footnotes.length;
      indexByKey.set(key, index);
      footnotes.push({ index, ...info });
    });

  let out = text;
  list
    .slice()
    .sort((a, b) => (b.start_idx ?? -1) - (a.start_idx ?? -1) || b.matched_text.length - a.matched_text.length)
    .forEach((ref) => {
      if (ref.type === 'sources_footnote') return;
      let replacement = ref.alt || '';
      if (ref.type === 'grouped_webpages') {
        const info = infoOf(ref);
        const index = info.url ? indexByKey.get(`${info.url}|${info.title}`) : undefined;
        if (index) replacement = ` ([${info.label.replace(/[\[\]]/g, '')}][${index}])`;
      }
      const { start_idx: start, end_idx: end } = ref;
      if (typeof start === 'number' && typeof end === 'number' && out.slice(start, end) === ref.matched_text) {
        out = out.slice(0, start) + replacement + out.slice(end);
      } else {
        out = out.split(ref.matched_text).join(replacement);
      }
    });

  return { text: out, footnotes, next: startIndex + footnotes.length };
}

function inlineImageTokens(images: ConversationImage[]): string {
  return images
    .map((img) => `![${(img.alt || 'image').replace(/[\[\]]/g, '')}](cge-image:${img.fileId})`)
    .join('\n\n');
}

// ---------- 整理 ----------

export function normalizeConversation(conv: RawConversation, fallback: { id: string | null; origin: string }): Conversation {
  const id = conv.conversation_id || conv.id || fallback.id;
  const messages: ConversationMessage[] = [];
  let refIndex = 1;

  // 连续的助手消息（工具调用前后分段输出）合并为一条，更符合页面上的观感
  const pushMessage = (m: ConversationMessage) => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'assistant' && m.role === 'assistant') {
      last.text = [last.text, m.text].filter(Boolean).join('\n\n');
      last.images.push(...m.images);
      last.files.push(...m.files);
      last.footnotes.push(...m.footnotes);
      return;
    }
    messages.push(m);
  };

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
        .filter(isImagePart)
        .map((p) => ({ fileId: extractFileId(p.asset_pointer), alt: 'generated image' }))
        .filter((img): img is ConversationImage => !!img.fileId);
      if (images.length) {
        pushMessage({ id: msg.id, role: 'assistant', text: inlineImageTokens(images), images, files: [], footnotes: [] });
      }
      continue;
    }
    if (role !== 'user' && role !== 'assistant') continue;
    if (role === 'assistant' && msg.recipient && msg.recipient !== 'all') continue; // 工具调用
    if (content.content_type !== 'text' && content.content_type !== 'multimodal_text') continue;

    const texts: string[] = [];
    const images: ConversationImage[] = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        texts.push(part);
      } else if (isImagePart(part)) {
        const fileId = extractFileId(part.asset_pointer);
        if (fileId) images.push({ fileId, alt: 'image' });
      } else if (part && typeof part.text === 'string') {
        texts.push(part.text);
      }
    }

    let text = texts.filter(Boolean).join('\n');
    let footnotes: Footnote[] = [];
    if (role === 'assistant' && meta.content_references?.length) {
      const processed = processContentReferences(text, meta.content_references, refIndex);
      text = processed.text;
      footnotes = processed.footnotes;
      refIndex = processed.next;
    }
    text = cleanText(text);
    if (role === 'assistant' && images.length) {
      text = [text, inlineImageTokens(images)].filter(Boolean).join('\n\n');
    }

    const files: string[] = [];
    if (role === 'user') {
      for (const att of meta.attachments || []) {
        const fileId = att?.id || att?.file_id;
        const img = fileId ? images.find((i) => i.fileId === fileId) : undefined;
        if (img) {
          if (att.name) img.alt = att.name;
        } else if (att?.name) {
          files.push(att.name);
        }
      }
    }

    if (!text && images.length === 0 && files.length === 0) continue;
    pushMessage({ id: msg.id, role, text, images, files, footnotes });
  }

  return {
    id,
    title: conv.title || 'Untitled Conversation',
    url: id ? `${fallback.origin}/c/${id}` : fallback.origin,
    createTime: toIso(conv.create_time),
    updateTime: toIso(conv.update_time),
    messages,
  };
}

// ---------- Markdown ----------

export function buildMarkdown(data: Conversation, { embedImages }: { embedImages: boolean }, exportedAt = new Date()): string {
  const q = (value: string) => JSON.stringify(String(value));
  const lines: string[] = [
    '---',
    `title: ${q(data.title)}`,
    ...(data.id ? [`conversation_id: ${q(data.id)}`] : []),
    ...(data.createTime ? [`created: ${q(data.createTime)}`] : []),
    ...(data.updateTime ? [`updated: ${q(data.updateTime)}`] : []),
    `url: ${q(data.url)}`,
    `exported: ${q(exportedAt.toISOString())}`,
    `exported_by: ${q('ChatGPT Export')}`,
    '---',
    '',
    `# ${data.title}`,
    '',
  ];

  if (data.messages.length === 0) lines.push('_（没有可导出的消息）_', '');

  for (const msg of data.messages) {
    lines.push(msg.role === 'user' ? '## 🧑 User' : '## 🤖 ChatGPT', '');
    const imageMd = (alt: string, fileId: string) => {
      const img = msg.images.find((i) => i.fileId === fileId);
      return embedImages && img?.dataUrl ? `![${alt}](${img.dataUrl})` : `_[图片: ${alt} (${fileId})]_`;
    };
    if (msg.role === 'user') {
      for (const img of msg.images) lines.push(imageMd((img.alt || 'image').replace(/[\[\]]/g, ''), img.fileId), '');
    }
    if (msg.text) lines.push(msg.text.replace(IMAGE_TOKEN_RE, (_, alt: string, fileId: string) => imageMd(alt, fileId)), '');
    for (const name of msg.files) lines.push(`📎 ${name}`, '');
    if (msg.footnotes.length) {
      for (const n of msg.footnotes) {
        const title = n.title ? ` "${n.title.replace(/"/g, "'")}"` : '';
        lines.push(`[${n.index}]: ${n.url}${title}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
