// 直接基于 ChatGPT 页面自身的 DOM 生成图片：不重新排版，截图结果与页面显示一致。
//
// ChatGPT 的对话列表是虚拟滚动的：每轮对话外层有一个 div[data-turn-id-container] 占位，
// 只有滚动到视口附近时才渲染真正的内容（section[data-testid="conversation-turn-N"]）。
// 因此截图流程是：逐个把选中的轮次滚动到视口 → 等 ChatGPT 渲染完成 → 截取该轮次的真实 DOM →
// 最后按顺序把各轮次拼接成长图（超过 canvas 上限时切分成多张）。
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

const TURN_CONTENT_SELECTOR = '[data-testid^="conversation-turn-"], [data-message-author-role]';

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
    unit.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role');
  return attr === 'user' || attr === 'assistant' ? attr : 'unknown';
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
  // 新版页面：每轮外层的虚拟列表容器
  let anchors = outermost([...document.querySelectorAll<HTMLElement>('[data-turn-id-container]')]);
  // 旧版页面：article / section[data-testid^="conversation-turn-"]，或按消息节点兜底
  if (anchors.length === 0) anchors = outermost([...document.querySelectorAll<HTMLElement>(TURN_CONTENT_SELECTOR)]);
  // 注意：不能按 getClientRects() 过滤——外层容器可能是 display: contents，本身没有盒子
  anchors = anchors.filter((el) => el.isConnected && !el.closest('cge-image-export'));
  if (anchors.length === 0) return null;

  const root = commonAncestor(anchors);
  if (!root) return null;
  const turns: Turn[] = [];
  const seen = new Set<HTMLElement>();
  for (const anchor of anchors) {
    let unit = anchor;
    while (unit.parentElement && unit.parentElement !== root) unit = unit.parentElement;
    if (seen.has(unit)) continue;
    seen.add(unit);
    unit.setAttribute(ATTR_UNIT, '');
    turns.push({ unit, role: roleOf(unit) });
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
function collectActionBars(unit: HTMLElement): Set<Node> {
  const nodes = new Set<Node>();
  unit.querySelectorAll<HTMLElement>('[data-testid$="turn-action-button"]').forEach((button) => {
    let node: HTMLElement = button;
    while (
      node.parentElement &&
      node.parentElement !== unit &&
      node.parentElement !== boxOf(unit) &&
      !node.parentElement.textContent?.trim() &&
      !node.parentElement.querySelector('img, video, canvas, [data-message-author-role]')
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
  const targets = unit.querySelectorAll<HTMLElement>('[data-message-author-role]');
  const nodes = targets.length ? [...targets] : [unit.querySelector<HTMLElement>(TURN_CONTENT_SELECTOR) ?? unit];
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
  canvas: HTMLCanvasElement;
  /** 该截图使用的缩放比例（极长的单轮会低于目标比例） */
  scale: number;
  /** 截图时的 CSS 宽度 */
  width: number;
  /** 与上一个轮次之间的间距（CSS px，页面中的真实间距） */
  gapBefore: number;
  range: { left: number; right: number } | null;
}

/** 把多个轮次截图按顺序拼接；超过 canvas 上限时切分成多张 */
function stitch(shots: Shot[], scale: number, background: string, cropSides: boolean): HTMLCanvasElement[] {
  const width = Math.max(...shots.map((s) => s.width));
  let left = 0;
  let right = width;
  if (cropSides) {
    const ranges = shots.map((s) => s.range).filter((r): r is NonNullable<Shot['range']> => !!r);
    if (ranges.length) {
      left = Math.max(0, Math.min(...ranges.map((r) => r.left)) - CROP_MARGIN);
      right = Math.min(width, Math.max(...ranges.map((r) => r.right)) + CROP_MARGIN);
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
    if (current.length && pad * 2 + height + gap + shot.canvas.height > MAX_CANVAS_PX) {
      groups.push(current);
      current = [];
      height = 0;
    }
    height += (current.length ? gap : 0) + shot.canvas.height;
    current.push(shot);
  }
  if (current.length) groups.push(current);

  return groups.map((group) => {
    const s = group[0]!.scale;
    const p = Math.round(EDGE_PADDING * s);
    const gaps = group.map((shot, i) => (i ? Math.round(shot.gapBefore * s) : 0));
    const out = document.createElement('canvas');
    out.width = Math.round((right - left) * s);
    out.height = Math.min(
      MAX_CANVAS_PX,
      p * 2 + group.reduce((sum, shot, i) => sum + shot.canvas.height + gaps[i]!, 0),
    );
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, out.width, out.height);
    let y = p;
    group.forEach((shot, i) => {
      y += gaps[i]!;
      ctx.drawImage(shot.canvas, Math.round(-left * s), y);
      y += shot.canvas.height;
    });
    return out;
  });
}

// ---------- 截图 ----------

export async function captureTurns(
  dom: ConversationDom,
  selected: Turn[],
  options: ImageOptions,
  onProgress: (text: string) => void,
): Promise<Blob[]> {
  if (selected.length === 0) throw new Error('请至少选择一条消息。');
  const background = backgroundColorOf(dom.root);
  const order = new Map(dom.turns.map((t, i) => [t.unit, i]));
  const units = selected.map((t) => t.unit).sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));

  // 记录滚动位置，截图结束后恢复
  const scrollers: Array<[Element, number]> = [];
  for (let el: HTMLElement | null = dom.root; el; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight) scrollers.push([el, el.scrollTop]);
  }
  const windowScroll = scrollY;

  document.documentElement.setAttribute(ATTR_CAPTURING, '');
  const shots: Shot[] = [];
  try {
    await document.fonts.ready;
    let prevIndex = -2;
    for (const [i, unit] of units.entries()) {
      onProgress(`正在截取第 ${i + 1}/${units.length} 轮…`);
      await ensureRendered(unit);
      const box = boxOf(unit);
      const rect = box.getBoundingClientRect();
      const index = order.get(unit) ?? -1;
      // 与上一轮在页面中相邻时沿用真实间距；中间隔着未选中的轮次时不留额外空隙
      const prev = index === prevIndex + 1 ? dom.turns[index - 1]?.unit : undefined;
      const gapBefore = prev ? Math.min(Math.max(0, rect.top - boxOf(prev).getBoundingClientRect().bottom), 48) : 0;
      prevIndex = index;

      const actionBars = options.hideActions ? collectActionBars(unit) : new Set<Node>();
      const scale = Math.min(options.scale, MAX_CANVAS_PX / Math.max(1, rect.height));
      const canvas = await domToCanvas(box, {
        scale,
        backgroundColor: background,
        filter: (node) => !actionBars.has(node),
        fetchFn: fetchViaBackground,
      });
      shots.push({ canvas, scale, width: rect.width, gapBefore, range: contentRange(unit, actionBars) });
    }

    onProgress('正在拼接图片…');
    const canvases = stitch(shots, options.scale, background, options.cropSides);
    const blobs: Blob[] = [];
    for (const canvas of canvases) blobs.push(await canvasToBlob(canvas));
    return blobs;
  } finally {
    document.documentElement.removeAttribute(ATTR_CAPTURING);
    scrollers.forEach(([el, top]) => (el.scrollTop = top));
    window.scrollTo({ top: windowScroll, behavior: 'instant' as ScrollBehavior });
  }
}

