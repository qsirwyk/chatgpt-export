// 直接基于 ChatGPT 页面自身的 DOM 生成图片：不重新排版，截图结果与页面显示一致。
//
// ChatGPT 的对话列表是虚拟滚动的，且有两种形态：
// - 2026 版：滑动窗口，只挂载视口附近的约 7 轮（div[data-turn-key]），窗口外的轮次连占位节点都没有；
//   滚动到顶部时还会懒加载更早的历史并重新分组。
// - 2025 版：每轮都有占位容器 div[data-turn-id-container]，只在视口附近渲染内容。
// 因此导出流程是：先滚到顶部加载完整历史 → 自上而下逐屏滚动，按消息 ID 去重，
// 截取每个选中轮次的真实 DOM（截完立即压缩成 PNG 释放内存）→ 最后按顺序拼接成长图（超过上限时切分）。
import { domToCanvas } from 'modern-screenshot';
import { browser } from 'wxt/browser';
import type { BackgroundRequest, ImageOptions, MessageResponse } from '@/utils/types';

/** Chrome 单个 canvas 边长上限约 32767px，留出余量 */
const MAX_CANVAS_PX = 30000;
/** 裁剪两侧空白时，内容列左右保留的边距（CSS px） */
const CROP_MARGIN = 28;
/** 图片上下留白（CSS px） */
const EDGE_PADDING = 16;
/** 等待单个轮次渲染完成的最长时间 */
const RENDER_TIMEOUT = 6000;

export const ATTR_UNIT = 'data-cge-unit';
export const ATTR_EXCLUDED = 'data-cge-excluded';
export const ATTR_CAPTURING = 'data-cge-capturing';

export type Role = 'user' | 'assistant' | 'unknown';

export interface Turn {
  /**
   * 稳定标识（data-turn-key / data-turn-id-container 的值）。ChatGPT 懒加载历史或重新渲染列表时
   * 会替换、复用占位节点，节点引用不可靠，选择状态和截图都按 id 重新定位。
   */
  id: string;
  /** 该轮次包含的消息 ID（m:<id>）；分组变化时用来去重。旧版未渲染的占位节点为空 */
  messageIds: string[];
  /** 轮次在公共容器下的直接子节点（虚拟列表的占位容器），截图与选择都以它为单位 */
  unit: HTMLElement;
  role: Role;
}

export interface ConversationDom {
  /** 所有轮次的公共父节点 */
  root: HTMLElement;
  turns: Turn[];
}

// ---------- 查找对话节点 ----------

/**
 * 轮次锚点，按优先级尝试：
 * - 2026 版：div[data-turn-key]（一问一答为一轮，外层是虚拟列表的定高占位 div）
 * - 2025 版：div[data-turn-id-container] / section[data-testid="conversation-turn-N"]
 */
const ANCHOR_SELECTORS = ['[data-turn-key]', '[data-turn-id-container]'];
const TURN_CONTENT_SELECTOR =
  '[data-turn-key], [data-testid^="conversation-turn-"], [data-message-author-role], [data-content-search-unit-key]';
/** 单条消息（用户气泡 / 助手回复）的节点 */
const MESSAGE_SELECTOR = '[data-message-author-role], [data-content-search-unit-key]';

function outermost(elements: HTMLElement[]): HTMLElement[] {
  const set = new Set(elements);
  return elements.filter((el) => {
    for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
    return true;
  });
}

function commonAncestor(elements: HTMLElement[]): HTMLElement | null {
  const [first, ...rest] = elements;
  if (!first) return null;
  let node: HTMLElement | null = rest.length === 0 ? first.parentElement : first;
  while (node && !rest.every((el) => node!.contains(el))) node = node.parentElement;
  return node;
}

/**
 * 轮次实际占据布局的节点：外层容器若是 display: contents（自身没有盒子，无法测量、滚动和截图），
 * 就向下找到第一个真正渲染的子节点。
 */
export function boxOf(unit: HTMLElement): HTMLElement {
  let node = unit;
  while (getComputedStyle(node).display === 'contents') {
    const child = [...node.children].find(
      (c): c is HTMLElement => c instanceof HTMLElement && (c.getClientRects().length > 0 || getComputedStyle(c).display === 'contents'),
    );
    if (!child) break;
    node = child;
  }
  return node;
}

/** 页面结构诊断信息：找不到对话节点时附在错误提示里 */
export function domDiagnostics(): string {
  const count = (sel: string) => document.querySelectorAll(sel).length;
  return [
    `data-turn-id-container=${count('[data-turn-id-container]')}`,
    `data-turn-key=${count('[data-turn-key]')}`,
    `conversation-role=${count('[data-conversation-role]')}`,
    `conversation-turn=${count('[data-testid^="conversation-turn-"]')}`,
    `data-turn=${count('[data-turn]')}`,
    `author-role=${count('[data-message-author-role]')}`,
    `article=${count('article')}`,
  ].join(', ');
}

/** 当前已渲染内容中的角色；未渲染（虚拟列表占位）时为 unknown */
function readRole(unit: HTMLElement): Role {
  const attr =
    unit.querySelector('[data-turn]')?.getAttribute('data-turn') ||
    unit.getAttribute('data-turn') ||
    unit.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role') ||
    unit.querySelector('[data-conversation-role]')?.getAttribute('data-conversation-role');
  return attr === 'user' || attr === 'assistant' ? attr : 'unknown';
}


/** 从当前渲染的内容中读取轮次 id；内容被虚拟列表卸载时返回 null */
function liveIdOf(unit: HTMLElement): string | null {
  const key = unit.closest('[data-turn-key]') ?? unit.querySelector('[data-turn-key]');
  if (key) return `k:${key.getAttribute('data-turn-key')}`;
  const container = unit.matches('[data-turn-id-container]') ? unit : unit.querySelector('[data-turn-id-container]');
  if (container) return `c:${container.getAttribute('data-turn-id-container')}`;
  return null;
}

/** 轮次中所有消息的 ID（新版的 data-chatgpt-search-message-ids 等，旧版的 data-message-id） */
function messageIdsOf(unit: HTMLElement): string[] {
  const ids = new Set<string>();
  const add = (value: string | null) => value?.split(/[\s,]+/).forEach((v) => v && ids.add(`m:${v}`));
  unit.querySelectorAll('[data-chatgpt-search-message-ids]').forEach((el) => add(el.getAttribute('data-chatgpt-search-message-ids')));
  unit.querySelectorAll('[data-chatgpt-selection-message-id]').forEach((el) => add(el.getAttribute('data-chatgpt-selection-message-id')));
  unit.querySelectorAll('[data-message-id]').forEach((el) => add(el.getAttribute('data-message-id')));
  return [...ids];
}

/** 轮次的所有标识：选择状态与去重都基于它们 */
export function keysOf(turn: Turn): string[] {
  return [turn.id, ...turn.messageIds];
}

export interface TurnSelection {
  /** all：全部轮次，marked 为排除项；only：只导出 marked 中的轮次 */
  mode: 'all' | 'only';
  /** 轮次 id → 该轮次的全部标识（keysOf） */
  marked: Map<string, string[]>;
}

export function isSelected(turn: Turn, selection: TurnSelection): boolean {
  const keys = new Set(keysOf(turn));
  let hit = false;
  for (const group of selection.marked.values()) if (group.some((k) => keys.has(k))) hit = true;
  return selection.mode === 'all' ? !hit : hit;
}

const knownIds = new WeakMap<HTMLElement, string>();
let fallbackSeq = 0;

function idOf(unit: HTMLElement): string {
  const live = liveIdOf(unit);
  if (live) knownIds.set(unit, live);
  else if (!knownIds.has(unit)) knownIds.set(unit, `n:${++fallbackSeq}`);
  return knownIds.get(unit)!;
}

/** 记住已经看到过的角色：轮次滚出视口被卸载后仍然可用 */
const knownRoles = new WeakMap<HTMLElement, Role>();

function roleOf(unit: HTMLElement): Role {
  const role = readRole(unit);
  if (role !== 'unknown') knownRoles.set(unit, role);
  return knownRoles.get(unit) ?? role;
}

/** 未知角色按 user / assistant 交替规律，从最近的已知轮次推断 */
function inferRoles(turns: Turn[]) {
  turns.forEach((t, i) => {
    if (t.role !== 'unknown') return;
    for (let d = 1; d < turns.length; d++) {
      for (const j of [i - d, i + d]) {
        const known = turns[j]?.role;
        if (known && known !== 'unknown') {
          t.role = d % 2 === 0 ? known : known === 'user' ? 'assistant' : 'user';
          return;
        }
      }
    }
  });
}

export function findConversationDom(): ConversationDom | null {
  let anchors: HTMLElement[] = [];
  for (const sel of ANCHOR_SELECTORS) {
    anchors = outermost([...document.querySelectorAll<HTMLElement>(sel)]);
    if (anchors.length > 0) break;
  }
  // 旧版页面：article / section[data-testid^="conversation-turn-"]，或按消息节点兜底
  if (anchors.length === 0) anchors = outermost([...document.querySelectorAll<HTMLElement>(TURN_CONTENT_SELECTOR)]);
  // 注意：不能按 getClientRects() 过滤——外层容器可能是 display: contents，本身没有盒子
  anchors = anchors.filter((el) => el.isConnected && !el.closest('cge-image-export'));
  if (anchors.length === 0) return null;

  const root = commonAncestor(anchors);
  if (!root) return null;
  const found = new Set<HTMLElement>();
  for (const anchor of anchors) {
    let unit = anchor;
    while (unit.parentElement && unit.parentElement !== root) unit = unit.parentElement;
    found.add(unit);
  }
  const turns: Turn[] = [];
  const byId = new Map<string, Turn>();
  for (const child of root.children) {
    if (!(child instanceof HTMLElement) || !found.has(child)) continue;
    const turn: Turn = { id: idOf(child), messageIds: messageIdsOf(child), unit: child, role: roleOf(child) };
    const dup = byId.get(turn.id);
    if (dup) {
      // 同一 id 出现两次：缓存的旧 id 已过时，保留内容真正属于该轮次的节点
      if (liveIdOf(child) !== turn.id) continue;
      turns.splice(turns.indexOf(dup), 1);
    }
    byId.set(turn.id, turn);
    child.setAttribute(ATTR_UNIT, '');
    turns.push(turn);
  }
  inferRoles(turns);
  return { root, turns };
}

// ---------- 截图辅助 ----------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

/** 向上找到第一个不透明的背景色，作为图片底色 */
function backgroundColorOf(el: HTMLElement): string {
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== 'transparent' && !/rgba?\(.*,\s*0\)$/.test(bg)) return bg;
  }
  return getComputedStyle(document.body).backgroundColor || '#ffffff';
}

function isRendered(unit: HTMLElement): boolean {
  const content = unit.querySelector<HTMLElement>(TURN_CONTENT_SELECTOR) ?? unit;
  return content.getBoundingClientRect().height > 0 && !!(content.textContent?.trim() || content.querySelector('img'));
}

/** 把轮次滚动到视口并等待 ChatGPT 渲染出内容、图片加载完成、高度稳定 */
async function ensureRendered(unit: HTMLElement): Promise<void> {
  boxOf(unit).scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
  const deadline = Date.now() + RENDER_TIMEOUT;
  while (!isRendered(unit) && Date.now() < deadline) await sleep(50);

  const images = [...unit.querySelectorAll('img')];
  images.forEach((img) => (img.loading = 'eager'));
  await Promise.race([
    Promise.all(images.map((img) => (img.complete ? null : img.decode().catch(() => null)))),
    sleep(Math.max(0, deadline - Date.now())),
  ]);

  // 等布局稳定（流式渲染、代码高亮、公式排版等可能还在调整高度）
  let last = -1;
  for (let i = 0; i < 20; i++) {
    await nextFrame();
    const h = boxOf(unit).getBoundingClientRect().height;
    if (h === last) break;
    last = h;
  }
}

/**
 * 每条消息下方的操作栏（复制、点赞、朗读、重新生成…）：
 * 从操作按钮向上找到不含任何文字和图片的最外层容器，整体排除。
 */
const ACTION_BUTTON_SELECTOR = '[data-testid$="turn-action-button"], .turn-action-controls button, [data-content-search-unit-key] button';
/** 消息正文内部的按钮（代码块的复制按钮、引用来源等）属于内容，不排除 */
const CONTENT_SELECTOR = '[data-markdown-text-style], [data-user-message-bubble], .markdown, pre';

function collectActionBars(unit: HTMLElement): Set<Node> {
  const nodes = new Set<Node>();
  unit.querySelectorAll<HTMLElement>(ACTION_BUTTON_SELECTOR).forEach((button) => {
    if (button.closest(CONTENT_SELECTOR)) return;
    if (button.textContent?.trim()) return; // 只处理纯图标按钮
    let node: HTMLElement = button;
    while (
      node.parentElement &&
      node.parentElement !== unit &&
      node.parentElement !== boxOf(unit) &&
      !node.parentElement.textContent?.trim() &&
      !node.parentElement.querySelector(`img, video, canvas, ${MESSAGE_SELECTOR}`)
    ) {
      node = node.parentElement;
    }
    nodes.add(node);
  });
  return nodes;
}

/** 跨域图片（如 files.oaiusercontent.com）交给后台脚本下载，避免 CORS 限制导致图片空白 */
async function fetchViaBackground(url: string): Promise<string | false> {
  if (url.startsWith('data:') || url.startsWith('blob:')) return false;
  let target: URL;
  try {
    target = new URL(url, location.href);
  } catch {
    return false;
  }
  if (target.origin === location.origin) return false; // 同源资源走默认 fetch（自动带 cookie）
  try {
    const res = (await browser.runtime.sendMessage({
      type: 'CGE_FETCH_DATA_URL',
      url: target.href,
    } satisfies BackgroundRequest)) as MessageResponse<string> | undefined;
    return res?.ok ? res.result : false;
  } catch {
    return false;
  }
}

/** 轮次中消息内容的水平范围（相对轮次节点左侧），用于裁剪两侧空白 */
function contentRange(unit: HTMLElement, exclude: Set<Node>): { left: number; right: number } | null {
  const base = boxOf(unit).getBoundingClientRect();
  let left = Infinity;
  let right = -Infinity;
  const targets = outermost([...unit.querySelectorAll<HTMLElement>(MESSAGE_SELECTOR)]);
  const nodes = targets.length ? targets : [unit.querySelector<HTMLElement>(TURN_CONTENT_SELECTOR) ?? unit];
  for (const node of nodes) {
    // 取消息内部可见子元素的范围（消息节点本身可能是整列宽度）
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT);
    for (let el = walker.currentNode as Element | null; el; el = walker.nextNode() as Element | null) {
      if (exclude.has(el)) continue;
      if (el.children.length > 0 && el !== node) continue; // 只看叶子元素即可
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      left = Math.min(left, r.left - base.left);
      right = Math.max(right, r.right - base.left);
    }
  }
  return Number.isFinite(left) && Number.isFinite(right) ? { left, right } : null;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('生成 PNG 失败（图片可能过大）'))), 'image/png');
  });
}

interface Shot {
  /** 截图压缩后的 PNG（不长期持有大画布，避免长对话占用数 GB 内存） */
  png: Blob;
  pxWidth: number;
  pxHeight: number;
  /** 该截图使用的缩放比例（极长的单轮会低于目标比例） */
  scale: number;
  /** 截图时的 CSS 宽度 */
  width: number;
  /** 与上一个轮次之间的间距（CSS px，页面中的真实间距） */
  gapBefore: number;
  range: { left: number; right: number } | null;
}

/** 把多个轮次截图按顺序拼接；超过 canvas 上限时切分成多张 */
async function stitch(shots: Shot[], scale: number, background: string, cropSides: boolean): Promise<Blob[]> {
  const width = Math.max(...shots.map((s) => s.width));
  let left = 0;
  let right = width;
  // 两侧留白：内容可能正好铺满轮次节点（没有可保留的页面空白），因此留白由画布补出来
  let side = EDGE_PADDING;
  if (cropSides) {
    const ranges = shots.map((s) => s.range).filter((r): r is NonNullable<Shot['range']> => !!r);
    if (ranges.length) {
      left = Math.max(0, Math.min(...ranges.map((r) => r.left)));
      right = Math.min(width, Math.max(...ranges.map((r) => r.right)));
      side = CROP_MARGIN;
    }
  }

  // 分组：每组总高度不超过上限；被降低缩放的超长轮次单独成图
  const groups: Shot[][] = [];
  let current: Shot[] = [];
  let height = 0;
  const pad = EDGE_PADDING * scale;
  for (const shot of shots) {
    if (shot.scale !== scale) {
      if (current.length) groups.push(current);
      groups.push([shot]);
      current = [];
      height = 0;
      continue;
    }
    const gap = current.length ? shot.gapBefore * scale : 0;
    if (current.length && pad * 2 + height + gap + shot.pxHeight > MAX_CANVAS_PX) {
      groups.push(current);
      current = [];
      height = 0;
    }
    height += (current.length ? gap : 0) + shot.pxHeight;
    current.push(shot);
  }
  if (current.length) groups.push(current);

  const blobs: Blob[] = [];
  for (const group of groups) {
    const s = group[0]!.scale;
    const p = Math.round(EDGE_PADDING * s);
    const gaps = group.map((shot, i) => (i ? Math.round(shot.gapBefore * s) : 0));
    const out = document.createElement('canvas');
    out.width = Math.round((right - left + side * 2) * s);
    out.height = Math.min(
      MAX_CANVAS_PX,
      p * 2 + group.reduce((sum, shot, i) => sum + shot.pxHeight + gaps[i]!, 0),
    );
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    let y = p;
    for (const [i, shot] of group.entries()) {
      y += gaps[i]!;
      const bitmap = await createImageBitmap(shot.png);
      ctx.drawImage(bitmap, Math.round((side - left) * s), y);
      bitmap.close();
      y += shot.pxHeight;
    }
    blobs.push(await canvasToBlob(out));
    out.width = out.height = 0;
  }
  return blobs;
}

// ---------- 截图 ----------

/**
 * 按 id 找到轮次当前的节点并等待渲染完成。滚动可能触发 ChatGPT 懒加载更早的历史、重新渲染列表，
 * 因此渲染后再校验一次内容是否仍属于该轮次，不对就重新定位。
 */
async function locateAndRender(id: string, hint: HTMLElement | undefined): Promise<HTMLElement | null> {
  let unit: HTMLElement | null = hint && hint.isConnected && idOf(hint) === id ? hint : null;
  for (let attempt = 0; attempt < 4; attempt++) {
    unit ??= findConversationDom()?.turns.find((t) => t.id === id)?.unit ?? null;
    if (!unit) return null;
    await ensureRendered(unit);
    const live = liveIdOf(unit);
    if (unit.isConnected && (live === id || (live === null && id.startsWith('n:')))) return unit;
    unit = null;
  }
  return null;
}

/** 对话列表的滚动容器 */
function scrollerOf(el: HTMLElement): HTMLElement {
  for (let node: HTMLElement | null = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if (/(auto|scroll|overlay)/.test(overflowY) && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

const atBottom = (sc: HTMLElement) => sc.scrollHeight - sc.scrollTop - sc.clientHeight < 4;

/** 滚动到顶部，直到 ChatGPT 不再加载更早的历史 */
async function loadFullHistory(scroller: HTMLElement, onProgress: (text: string) => void) {
  let lastFirst = '';
  let lastHeight = -1;
  let stable = 0;
  for (let i = 0; i < 300 && stable < 3; i++) {
    scroller.scrollTop = 0;
    await sleep(400);
    const first = findConversationDom()?.turns[0];
    const key = first ? keysOf(first).join() : '';
    if (key === lastFirst && scroller.scrollHeight === lastHeight) stable++;
    else stable = 0;
    lastFirst = key;
    lastHeight = scroller.scrollHeight;
    if (i % 5 === 4) onProgress('正在加载完整对话历史…');
  }
}

export interface CaptureResult {
  blobs: Blob[];
  turnCount: number;
}

export async function captureConversation(
  selection: TurnSelection,
  options: ImageOptions,
  onProgress: (text: string) => void,
): Promise<CaptureResult> {
  const dom0 = findConversationDom();
  if (!dom0) throw new Error(`页面上没有找到对话节点。（${domDiagnostics()}）`);
  if (selection.mode === 'only' && selection.marked.size === 0) throw new Error('请至少选择一轮对话。');
  const background = backgroundColorOf(dom0.root);
  const scroller = scrollerOf(dom0.root);

  // 记录阅读位置：结束后回到同一轮次（历史加载后 scrollTop 数值会变，不能直接恢复）
  const wasAtBottom = atBottom(scroller);
  const viewTop = scroller === document.documentElement ? 0 : scroller.getBoundingClientRect().top;
  const anchor = dom0.turns.find((t) => boxOf(t.unit).getBoundingClientRect().bottom > viewTop);
  const anchorKeys = anchor ? keysOf(anchor) : [];
  const anchorOffset = anchor ? boxOf(anchor.unit).getBoundingClientRect().top - viewTop : 0;
  const scrollBefore = scroller.scrollTop;

  // 只选了当前已挂载的轮次时无需滚动整段对话
  const targets = selection.mode === 'only' ? [...selection.marked.values()] : [];
  const mountedKeys = new Set(dom0.turns.flatMap(keysOf));
  const quick = selection.mode === 'only' && targets.every((group) => group.some((k) => mountedKeys.has(k)));

  document.documentElement.setAttribute(ATTR_CAPTURING, '');
  const processed = new Set<string>();
  const isDone = (t: Turn) =>
    processed.has(t.id) || (t.messageIds.length > 0 && t.messageIds.every((k) => processed.has(k)));
  const remainingTargets = () => targets.filter((group) => !group.some((k) => processed.has(k))).length;
  const shots: Shot[] = [];
  let prev: HTMLElement | null = null;

  const captureOne = async (turn: Turn) => {
    onProgress(`正在截取第 ${shots.length + 1} 轮…`);
    const unit = await locateAndRender(turn.id, turn.unit);
    if (!unit) throw new Error(`第 ${shots.length + 1} 轮在页面中找不到了（对话列表可能刚刚刷新），请重试。`);
    const box = boxOf(unit);
    const rect = box.getBoundingClientRect();
    // 与上一轮在页面中相邻时沿用真实间距；中间隔着未选中的轮次时不留额外空隙
    const adjacent = prev && prev.isConnected && unit.previousElementSibling === prev;
    const gapBefore = adjacent ? Math.min(Math.max(0, rect.top - boxOf(prev!).getBoundingClientRect().bottom), 48) : 0;
    const actionBars = options.hideActions ? collectActionBars(unit) : new Set<Node>();
    const scale = Math.min(options.scale, MAX_CANVAS_PX / Math.max(1, rect.height));
    const canvas = await domToCanvas(box, {
      scale,
      backgroundColor: background,
      filter: (node) => !actionBars.has(node),
      fetchFn: fetchViaBackground,
    });
    if (canvas.width === 0 || canvas.height === 0) {
      throw new Error(`第 ${shots.length + 1} 轮截图失败：尺寸 ${Math.round(rect.width)}x${Math.round(rect.height)} 的节点生成了空白画布。`);
    }
    const png = await canvasToBlob(canvas);
    shots.push({ png, pxWidth: canvas.width, pxHeight: canvas.height, scale, width: rect.width, gapBefore, range: contentRange(unit, actionBars) });
    canvas.width = canvas.height = 0;
    prev = unit;
    // 渲染后消息 ID 才完整（旧版占位节点），重新读取
    keysOf({ ...turn, messageIds: messageIdsOf(unit) }).forEach((k) => processed.add(k));
  };

  try {
    await document.fonts.ready;
    if (quick) {
      for (const turn of dom0.turns) if (isSelected(turn, selection)) await captureOne(turn);
    } else {
      onProgress('正在加载完整对话历史…');
      await loadFullHistory(scroller, onProgress);
      // 自上而下扫描：每次处理当前挂载的第一个未处理轮次，处理完滚到下一屏
      let idle = 0;
      while (idle < 30) {
        if (selection.mode === 'only' && remainingTargets() === 0) break;
        const dom = findConversationDom();
        const next = dom?.turns.find((t) => !isDone(t));
        if (!next) {
          if (atBottom(scroller)) break;
          const before = scroller.scrollTop;
          scroller.scrollTop += Math.max(200, scroller.clientHeight * 0.8);
          await sleep(250);
          idle = scroller.scrollTop === before ? idle + 1 : 0;
          continue;
        }
        idle = 0;
        if (isSelected(next, selection)) await captureOne(next);
        else {
          keysOf(next).forEach((k) => processed.add(k));
          prev = null;
        }
      }
    }
    if (shots.length === 0) throw new Error('没有截取到任何轮次，请确认已选择要导出的对话。');

    onProgress('正在拼接图片…');
    return { blobs: await stitch(shots, options.scale, background, options.cropSides), turnCount: shots.length };
  } finally {
    document.documentElement.removeAttribute(ATTR_CAPTURING);
    if (quick) scroller.scrollTop = scrollBefore;
    else await restorePosition(scroller, wasAtBottom, anchorKeys, anchorOffset, viewTop);
  }
}

/** 回到导出前的阅读位置 */
async function restorePosition(scroller: HTMLElement, wasAtBottom: boolean, keys: string[], offset: number, viewTop: number) {
  if (wasAtBottom || keys.length === 0) {
    scroller.scrollTop = scroller.scrollHeight;
    return;
  }
  // 从底部往上找原来的轮次
  scroller.scrollTop = scroller.scrollHeight;
  for (let i = 0; i < 200; i++) {
    await sleep(150);
    const turn = findConversationDom()?.turns.find((t) => keysOf(t).some((k) => keys.includes(k)));
    if (turn) {
      scroller.scrollTop += boxOf(turn.unit).getBoundingClientRect().top - viewTop - offset;
      return;
    }
    if (scroller.scrollTop === 0) return;
    scroller.scrollTop -= scroller.clientHeight * 0.8;
  }
}
