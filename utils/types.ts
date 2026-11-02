/** 对话中的一张图片。dataUrl 在内容脚本下载成功后填充，失败为 null。 */
export interface ConversationImage {
  fileId: string;
  alt: string;
  dataUrl?: string | null;
}

export interface Footnote {
  index: number;
  url: string;
  title: string;
  label: string;
}

/**
 * 统一后的消息（用于 Markdown 导出）。
 * - user 消息的图片单独输出在文字之前；
 * - assistant 消息的图片以 `![alt](cge-image:<fileId>)` 占位符内联在 text 中，保持与文字的先后顺序。
 */
export interface ConversationMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images: ConversationImage[];
  files: string[];
  footnotes: Footnote[];
}

export interface Conversation {
  id: string | null;
  title: string;
  url: string;
  createTime: string | null;
  updateTime: string | null;
  messages: ConversationMessage[];
}

/** 弹窗 → 内容脚本 */
export type ContentRequest =
  | { type: 'CGE_PING' }
  | { type: 'CGE_EXPORT_MD'; embedImages: boolean }
  | { type: 'CGE_EXPORT_IMAGE'; options: ImageOptions };

/** 内容脚本 → 后台（CGE_PROGRESS 同时会发给打开着的弹窗） */
export type BackgroundRequest =
  | { type: 'CGE_CAPTURE_TAB' }
  | { type: 'CGE_DOWNLOAD'; url: string; filename: string }
  | { type: 'CGE_PROGRESS'; text: string };

export interface PingResult {
  conversationId: string | null;
  title: string;
  /** 页面上找到的对话轮次（DOM 节点）数量 */
  turnCount: number;
}

export interface ExportMarkdownResult {
  filename: string;
  messageCount: number;
}

export interface ExportImageResult {
  files: string[];
  turnCount: number;
}

export type MessageResponse<T> = { ok: true; result: T } | { ok: false; error: string };

/** 图片导出选项（保存在 storage.local）。清晰度即屏幕本身的像素密度 */
export interface ImageOptions {
  hideActions: boolean;
  cropSides: boolean;
}

export const DEFAULT_IMAGE_OPTIONS: ImageOptions = { hideActions: true, cropSides: true };

export const EMBED_IMAGES_KEY = 'cge:embedImages';
export const IMAGE_OPTIONS_KEY = 'cge:imageOptions';

export const IMAGE_TOKEN_RE = /!\[([^\]]*)\]\(cge-image:([^)\s]+)\)/g;
