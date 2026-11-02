// 滚动截图：先把整段对话的历史加载完，再从上到下逐屏滚动，用 captureVisibleTab 截取浏览器真实画出的像素，
// 按滚动距离拼接成长图。截到的就是页面本身，不做任何重新排版或 DOM 克隆。
import { browser } from 'wxt/browser';
import type { BackgroundRequest, ImageOptions, MessageResponse } from '@/utils/types';

/** Chrome 单个 canvas 边长上限约 32767px，留出余量 */
const MAX_CANVAS_PX = 30000;
/** 裁剪两侧空白时，对话内容左右保留的边距（CSS px） */
const SIDE_MARGIN = 28;
/** 图片上下留白（CSS px） */
const EDGE_PADDING = 24;

const ATTR_CAPTURING = 'data-cge-capturing';
const ATTR_HIDE = 'data-cge-hide';
const ATTR_SCROLLER = 'data-cge-scroller';
const ATTR_HIDE_ACTIONS = 'data-cge-hide-actions';

const CAPTURE_STYLE = `
html[${ATTR_CAPTURING}] [${ATTR_HIDE}] { visibility: hidden !important; opacity: 0 !important; }
html[${ATTR_CAPTURING}] [${ATTR_SCROLLER}] {
  scrollbar-width: none !important; scroll-behavior: auto !important; overflow-anchor: none !important;
  pointer-events: none !important;
}
html[${ATTR_CAPTURING}] [${ATTR_SCROLLER}]::-webkit-scrollbar { display: none !important; }
html[${ATTR_CAPTURING}] *, html[${ATTR_CAPTURING}] *::before, html[${ATTR_CAPTURING}] *::after {
  transition: none !important; caret-color: transparent !important;
}
html[${ATTR_CAPTURING}][${ATTR_HIDE_ACTIONS}] :is(.turn-action-controls, [data-testid$="turn-action-button"]) {
  visibility: hidden !important;
}
`;

/** 每轮对话的锚点，按页面版本依次尝试 */
const ANCHOR_SELECTORS = [
  '[data-turn-key]', // 2026 版：一问一答为一轮
  '[data-turn-id-container]', // 2025 版
  '[data-testid^="conversation-turn-"]',
  '[data-message-author-role]',
];

/** 用来确定对话列宽度的消息节点 */
const MESSAGE_SELECTOR =
  '[data-message-author-role], [data-content-search-unit-key], [data-markdown-text-style], [data-user-message-bubble]';

// ---------- 页面结构 ----------

function outermost(elements: HTMLElement[]): HTMLElement[] {
  const set = new Set(elements);
  return elements.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });
}

/** 查找范围：截图期间限定在选中的滚动容器内 */
let scope: ParentNode = document;

/**
 * 是否真的显示在页面上。ChatGPT 会在 DOM 中保留隐藏的对话副本（高度为 0），必须排除。
 * display: contents 的节点自身没有盒子，看它的子节点。
 */
function isVisible(el: HTMLElement): boolean {
  if (el.checkVisibility()) return true;
  return getComputedStyle(el).display === 'contents' && [...el.children].some((c) => c.checkVisibility());
}

function findAnchors(): HTMLElement[] {
  for (const sel of ANCHOR_SELECTORS) {
    const found = outermost([...scope.querySelectorAll<HTMLElement>(sel)].filter(isVisible));
    if (found.length) return found;
  }
  return [];
}

export function countTurns(): number {
  return findAnchors().length;
}

/** 页面结构诊断信息：找不到对话节点时附在错误提示里 */
function domDiagnostics(): string {
  const count = (sel: string) => document.querySelectorAll(sel).length;
  return ['[data-turn-key]', '[data-conversation-role]', '[data-turn-id-container]', '[data-message-author-role]']
    .map((sel) => `${sel.slice(1, -1)}=${count(sel)}`)
    .join(', ');
}

/** 对话列表的滚动容器 */
function scrollerOf(el: HTMLElement): HTMLElement {
  // 优先选内容超出可见区域的滚动容器；对话很短、一屏放得下时退而选最近的可滚动容器
  let fallback: HTMLElement | null = null;
  for (let node: HTMLElement | null = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (!/(auto|scroll|overlay)/.test(overflowY) || node.clientHeight === 0) continue;
    if (node.scrollHeight > node.clientHeight) return node;
    fallback ??= node;
  }
  return fallback ?? (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** 向上找到第一个不透明的背景色，作为图片底色 */
function backgroundColorOf(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba?\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return getComputedStyle(document.body).backgroundColor || '#ffffff';
}

/** 滚动容器在视口中可见的区域（CSS px，取整） */
function viewportOf(scroller: HTMLElement) {
  const isDoc = scroller === document.scrollingElement || scroller === document.documentElement;
  const r = isDoc ? new DOMRect(0, 0, innerWidth, innerHeight) : scroller.getBoundingClientRect();
  const top = Math.ceil(Math.max(r.top, 0));
  const bottom = Math.floor(Math.min(r.bottom, innerHeight));
  const left = Math.ceil(Math.max(r.left, 0));
  const right = Math.floor(Math.min(r.right, innerWidth));
  return { top, bottom, left, right, height: bottom - top, rectTop: r.top };
}

/**
 * 截图期间要隐藏的元素：只保留对话滚动容器及其祖先链，其余全部隐藏（visibility，不影响布局）。
 * - 滚动容器之外：祖先链上每一层的兄弟节点，包括顶栏、输入框（absolute 浮在对话底部）、渐变遮罩、侧栏等；
 * - 滚动容器之内：对话列表之外的悬浮元素（回到底部按钮等）。对话内容自身（含代码块的 sticky 标题）保留。
 */
function markOverlays(scroller: HTMLElement) {
  const hide = (el: Element) => el.setAttribute(ATTR_HIDE, '');
  if (scroller !== document.documentElement && scroller !== document.body) {
    for (let node: HTMLElement = scroller; node.parentElement && node !== document.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling !== node && !/^(SCRIPT|STYLE|LINK|META)$/.test(sibling.tagName)) hide(sibling);
      }
    }
  }
  const anchors = findAnchors();
  const list = anchors.length > 1 ? commonAncestor(anchors) : (anchors[0]?.parentElement ?? null);
  if (!list) return;
  for (const el of scroller.querySelectorAll<HTMLElement>('*')) {
    if (list.contains(el) || el.contains(list)) continue;
    const { position } = getComputedStyle(el);
    if (position === 'fixed' || position === 'sticky' || position === 'absolute') hide(el);
  }
}

function commonAncestor(elements: HTMLElement[]): HTMLElement | null {
  let node: HTMLElement | null = elements[0] ?? null;
  while (node && !elements.every((el) => node!.contains(el))) node = node.parentElement;
  return node;
}

/** 轮次标识：用于统计轮数和恢复阅读位置 */
function keyOf(anchor: HTMLElement): string {
  return (
    anchor.getAttribute('data-turn-key') ||
    anchor.getAttribute('data-turn-id-container') ||
    anchor.getAttribute('data-testid') ||
    anchor.querySelector('[data-message-id]')?.getAttribute('data-message-id') ||
    anchor.textContent?.trim().slice(0, 60) ||
    ''
  );
}

// ---------- 等待 ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** 等视口内的图片加载完、布局稳定 */
async function settle(scroller: HTMLElement) {
  await nextFrame();
  await nextFrame();
  const view = viewportOf(scroller);
  const pending = [...document.images].filter((img) => {
    if (img.complete) return false;
    const r = img.getBoundingClientRect();
    return r.bottom > view.top && r.top < view.bottom;
  });
  if (pending.length) {
    await Promise.race([Promise.all(pending.map((img) => img.decode().catch(() => null))), sleep(3000)]);
  }
  let last = -1;
  for (let i = 0; i < 10; i++) {
    await nextFrame();
    if (scroller.scrollHeight === last) break;
    last = scroller.scrollHeight;
  }
  await sleep(80);
}

/** 滚动到顶部，直到 ChatGPT 不再加载更早的历史 */
async function loadFullHistory(scroller: HTMLElement, isCancelled: () => boolean) {
  let lastFirst: Element | null = null;
  let lastHeight = -1;
  let stable = 0;
  for (let i = 0; i < 300 && stable < 3 && !isCancelled(); i++) {
    scroller.scrollTop = 0;
    await sleep(400);
    const first = findAnchors()[0] ?? null;
    if (first === lastFirst && scroller.scrollHeight === lastHeight) stable++;
    else stable = 0;
    lastFirst = first;
    lastHeight = scroller.scrollHeight;
  }
}

// ---------- 截屏与拼接 ----------

let lastCapture = 0;

async function captureViewport(): Promise<ImageBitmap> {
  // captureVisibleTab 每秒最多调用 2 次
  const wait = lastCapture + 520 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCapture = Date.now();
  const res = (await browser.runtime.sendMessage({ type: 'CGE_CAPTURE_TAB' } satisfies BackgroundRequest)) as
    | MessageResponse<string>
    | undefined;
  if (!res?.ok) throw new Error(res?.error || '截屏失败');
  const blob = await (await fetch(res.result)).blob();
  return createImageBitmap(blob);
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('生成 PNG 失败（图片可能过大）'))), 'image/png');
  });
}

/**
 * 把一屏屏的截图写进长图。总高度事先未知（滚动过程中各轮可能才第一次渲染、高度变化），
 * 按 canvas 上限分段按需创建；写满一段就压缩成 PNG 释放内存，最后一段按实际高度裁剪。
 */
class LongImage {
  private segments = new Map<number, HTMLCanvasElement>();
  private flushed = 0;
  readonly blobs: Blob[] = [];

  constructor(
    private width: number,
    private background: string,
  ) {}

  setWidth(width: number) {
    this.width = width;
  }

  private segment(index: number): HTMLCanvasElement {
    let canvas = this.segments.get(index);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = this.width;
      canvas.height = MAX_CANVAS_PX;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = this.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.segments.set(index, canvas);
    }
    return canvas;
  }

  /** 把源图的一块画到长图的 (dx, dy) 像素位置 */
  draw(source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number) {
    for (let index = Math.floor(dy / MAX_CANVAS_PX); index * MAX_CANVAS_PX < dy + sh; index++) {
      const top = index * MAX_CANVAS_PX;
      this.segment(index).getContext('2d')!.drawImage(source, sx, sy, sw, sh, dx, dy - top, sw, sh);
    }
  }

  /** 已写到 y 像素：完整的分段输出为 PNG */
  async flushUntil(y: number) {
    while ((this.flushed + 1) * MAX_CANVAS_PX <= y) await this.output(this.flushed, MAX_CANVAS_PX);
  }

  /** 全部写完，总高度为 height 像素 */
  async finish(height: number) {
    while (this.flushed * MAX_CANVAS_PX < height) {
      await this.output(this.flushed, Math.min(MAX_CANVAS_PX, height - this.flushed * MAX_CANVAS_PX));
    }
  }

  private async output(index: number, height: number) {
    const canvas = this.segment(index);
    let target = canvas;
    if (height < canvas.height) {
      target = document.createElement('canvas');
      target.width = canvas.width;
      target.height = height;
      target.getContext('2d')!.drawImage(canvas, 0, 0);
    }
    this.blobs.push(await canvasToBlob(target));
    canvas.width = canvas.height = 0;
    target.width = target.height = 0;
    this.segments.delete(index);
    this.flushed++;
  }
}

// ---------- 主流程 ----------

export interface CaptureResult {
  blobs: Blob[];
  turnCount: number;
}

export interface CaptureControl {
  onProgress: (text: string) => void;
  isCancelled: () => boolean;
}

export async function captureConversation(options: ImageOptions, control: CaptureControl): Promise<CaptureResult> {
  const { onProgress, isCancelled } = control;
  const anchors0 = findAnchors();
  const first = anchors0[0];
  if (!first) throw new Error(`页面上没有找到对话内容，请等待对话加载完成后重试。（${domDiagnostics()}）`);
  const scroller = scrollerOf(first);
  const background = backgroundColorOf(scroller);
  // 之后只在这个滚动容器里找对话节点（忽略页面中其它隐藏的对话副本）
  scope = scroller;

  // 记录阅读位置，结束后回去
  const wasAtBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8;
  const view0 = viewportOf(scroller);
  const anchorEl = anchors0.find((a) => a.getBoundingClientRect().bottom > view0.top) ?? first;
  const anchorKey = keyOf(anchorEl);
  const anchorOffset = anchorEl.getBoundingClientRect().top - view0.top;

  const style = document.createElement('style');
  style.textContent = CAPTURE_STYLE;
  document.head.appendChild(style);
  scroller.setAttribute(ATTR_SCROLLER, '');
  document.documentElement.toggleAttribute(ATTR_HIDE_ACTIONS, options.hideActions);
  document.documentElement.setAttribute(ATTR_CAPTURING, '');
  // 透明遮罩：截图期间挡住鼠标操作（完全透明，不会出现在截图里）
  const shield = document.createElement('div');
  shield.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:transparent;cursor:progress;';
  document.documentElement.appendChild(shield);

  const checkCancelled = () => {
    if (isCancelled()) throw new Error('已取消截图。');
  };

  try {
    // 1. 加载完整历史，再完整滚一遍让每轮的高度都测量好，避免截图时布局跳动造成接缝
    onProgress('正在加载完整对话…');
    await loadFullHistory(scroller, isCancelled);
    checkCancelled();
    onProgress('正在预加载内容…');
    for (let y = 0; y < scroller.scrollHeight; y += Math.max(200, scroller.clientHeight * 0.9)) {
      scroller.scrollTop = y;
      await settle(scroller);
      await sleep(60);
      checkCancelled();
    }
    scroller.scrollTop = scroller.scrollHeight;
    await settle(scroller);

    // 2. 隐藏盖在对话区域上的悬浮元素
    markOverlays(scroller);
    await settle(scroller);

    // 3. 截取范围：第一轮顶部到最后一轮底部（滚动内容坐标）、对话列左右两侧
    const view = viewportOf(scroller);
    const toContentY = (viewportY: number) => viewportY - view.rectTop + scroller.scrollTop;
    const endAnchors = findAnchors();

    let colLeft = view.left;
    let colRight = view.right;
    let margin = 0;
    if (options.cropSides) {
      const rects = endAnchors
        .flatMap((a) => [...a.querySelectorAll(MESSAGE_SELECTOR)])
        .map((el) => el.getBoundingClientRect())
        .filter((r) => r.width > 0);
      if (rects.length) {
        colLeft = Math.max(view.left, Math.floor(Math.min(...rects.map((r) => r.left))));
        colRight = Math.min(view.right, Math.ceil(Math.max(...rects.map((r) => r.right))));
        margin = SIDE_MARGIN;
      }
    }

    scroller.scrollTop = 0;
    await settle(scroller);
    const firstAnchor = findAnchors()[0]!;
    const startY = Math.max(0, Math.floor(toContentY(firstAnchor.getBoundingClientRect().top) - EDGE_PADDING));

    // 4. 从上到下逐屏截图，直到滚动到底部
    const image = new LongImage(0, background);
    let ratio = 0;
    const turnKeys = new Set<string>();
    let y = startY;
    let endY = Number.POSITIVE_INFINITY;
    while (y < endY) {
      checkCancelled();
      scroller.scrollTop = y - (view.top - view.rectTop);
      await settle(scroller);
      findAnchors().forEach((a) => turnKeys.add(keyOf(a)));
      // 到底部后才确定结束位置：最后一轮底部再留一点边距
      if (scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1) {
        const anchors = findAnchors();
        const last = anchors[anchors.length - 1];
        endY = last ? Math.ceil(toContentY(last.getBoundingClientRect().bottom) + EDGE_PADDING) : scroller.scrollHeight;
      }
      // 当前视口能看到的内容范围
      const visibleFrom = scroller.scrollTop + (view.top - view.rectTop);
      const visibleTo = visibleFrom + view.height;
      const sliceFrom = Math.max(y, visibleFrom);
      const sliceTo = Math.min(endY, visibleTo);
      if (sliceTo <= sliceFrom) break;

      const shot = await captureViewport();
      if (!ratio) {
        ratio = shot.width / innerWidth;
        image.setWidth(Math.round((colRight - colLeft + margin * 2) * ratio));
      }
      const dy = Math.round((sliceFrom - startY) * ratio);
      const sh = Math.round((sliceTo - startY) * ratio) - dy;
      const sy = Math.round((view.top + sliceFrom - visibleFrom) * ratio);
      image.draw(shot, Math.round(colLeft * ratio), sy, Math.round((colRight - colLeft) * ratio), sh, Math.round(margin * ratio), dy);
      shot.close();
      y = sliceTo;
      await image.flushUntil(Math.round((y - startY) * ratio));
      const total = Number.isFinite(endY) ? endY : scroller.scrollHeight;
      onProgress(`正在截图… ${Math.min(99, Math.round(((y - startY) / Math.max(1, total - startY)) * 100))}%`);
    }
    if (!ratio) throw new Error('没有截取到任何内容。');
    onProgress('正在生成图片…');
    await image.finish(Math.round((y - startY) * ratio));
    return { blobs: image.blobs, turnCount: turnKeys.size };
  } finally {
    scope = document;
    shield.remove();
    document.documentElement.removeAttribute(ATTR_CAPTURING);
    document.documentElement.removeAttribute(ATTR_HIDE_ACTIONS);
    scroller.removeAttribute(ATTR_SCROLLER);
    document.querySelectorAll(`[${ATTR_HIDE}]`).forEach((el) => el.removeAttribute(ATTR_HIDE));
    style.remove();
    await restorePosition(scroller, wasAtBottom, anchorKey, anchorOffset);
  }
}

/** 回到导出前的阅读位置（历史加载后 scrollTop 数值会变，按轮次定位） */
async function restorePosition(scroller: HTMLElement, wasAtBottom: boolean, key: string, offset: number) {
  scroller.scrollTop = scroller.scrollHeight;
  if (wasAtBottom || !key) {
    // 截图样式移除后布局可能还会变化，稍后再滚到底一次
    await sleep(300);
    scroller.scrollTop = scroller.scrollHeight;
    return;
  }
  for (let i = 0; i < 200; i++) {
    await sleep(120);
    const anchor = findAnchors().find((a) => keyOf(a) === key);
    if (anchor) {
      scroller.scrollTop += anchor.getBoundingClientRect().top - viewportOf(scroller).top - offset;
      return;
    }
    if (scroller.scrollTop === 0) return;
    scroller.scrollTop -= scroller.clientHeight * 0.8;
  }
}
