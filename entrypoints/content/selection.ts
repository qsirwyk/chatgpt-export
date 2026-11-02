// 页面内的「选择消息 → 导出图片」模式：
// - 每个对话轮次左侧浮出一个勾选框（放在独立的 Shadow DOM 覆盖层里，不改动 ChatGPT 的 React 节点结构）；
// - 底部浮动工具栏：全选 / 全不选 / 最后一轮、清晰度、隐藏操作按钮、裁剪两侧空白、下载 / 复制。
import { browser } from 'wxt/browser';
import { fileStamp, sanitizeFilename } from '@/utils/conversation';
import {
  DEFAULT_IMAGE_OPTIONS,
  IMAGE_OPTIONS_KEY,
  type BackgroundRequest,
  type ImageOptions,
  type MessageResponse,
} from '@/utils/types';
import {
  ATTR_CAPTURING,
  ATTR_EXCLUDED,
  ATTR_UNIT,
  captureTurns,
  findConversationDom,
  boxOf,
  domDiagnostics,
  type ConversationDom,
  type Turn,
} from './capture';

const PAGE_STYLE = `
[${ATTR_EXCLUDED}] { opacity: .3 !important; transition: opacity .15s; }
html[${ATTR_CAPTURING}] [${ATTR_UNIT}] { content-visibility: visible !important; }
/* 截图期间不显示「未选中」的半透明效果 */
html[${ATTR_CAPTURING}] [${ATTR_EXCLUDED}] { opacity: 1 !important; }
`;

const UI_STYLE = `
:host { all: initial; }
* { box-sizing: border-box; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483646; }
.check {
  position: fixed; width: 22px; height: 22px; margin: 0; pointer-events: auto; cursor: pointer;
  accent-color: #10a37f;
}
.bar {
  position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%);
  max-width: calc(100vw - 24px); pointer-events: auto; z-index: 2147483647;
  display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px;
  padding: 10px 14px; border-radius: 14px;
  background: #1f1f1f; color: #f2f2f2; box-shadow: 0 8px 30px rgba(0,0,0,.35);
  font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.title { font-weight: 600; }
.count { color: #6ee7b7; font-variant-numeric: tabular-nums; }
.sep { width: 1px; height: 20px; background: #444; }
button {
  padding: 5px 10px; border: 1px solid #4a4a4a; border-radius: 8px; background: #2c2c2c; color: inherit;
  font: inherit; cursor: pointer; white-space: nowrap;
}
button:hover:not(:disabled) { background: #383838; }
button:disabled { opacity: .5; cursor: progress; }
button.primary { background: #10a37f; border-color: #10a37f; color: #fff; font-weight: 600; }
button.primary:hover:not(:disabled) { background: #0e8f6f; }
label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; white-space: nowrap; }
select { padding: 3px 4px; border-radius: 6px; border: 1px solid #4a4a4a; background: #2c2c2c; color: inherit; font: inherit; }
input[type=checkbox] { accent-color: #10a37f; }
.status { flex-basis: 100%; min-height: 0; color: #bdbdbd; font-size: 12px; }
.status:empty { display: none; }
.status.error { color: #ff8a80; }
`;

let active: SelectionMode | null = null;

export function startSelectionMode(): number {
  if (active) {
    active.refresh();
    return active.turnCount;
  }
  const dom = findConversationDom();
  if (!dom || dom.turns.length === 0) throw new Error(`页面上没有找到对话节点，请等待对话加载完成后重试。（${domDiagnostics()}）`);
  active = new SelectionMode(dom);
  return active.turnCount;
}

class SelectionMode {
  private dom: ConversationDom;
  private excluded = new WeakSet<HTMLElement>();
  private checks = new Map<HTMLElement, HTMLInputElement>();
  private options: ImageOptions = { ...DEFAULT_IMAGE_OPTIONS };
  private host: HTMLElement;
  private shadow: ShadowRoot;
  private layer: HTMLElement;
  private pageStyle: HTMLStyleElement;
  private statusEl!: HTMLElement;
  private countEl!: HTMLElement;
  private raf = 0;
  private rescanTimer = 0;
  private busy = false;
  private readonly pathname = location.pathname;

  constructor(dom: ConversationDom) {
    this.dom = dom;
    this.pageStyle = document.createElement('style');
    this.pageStyle.textContent = PAGE_STYLE;
    document.head.appendChild(this.pageStyle);

    this.host = document.createElement('cge-image-export');
    this.shadow = this.host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = UI_STYLE;
    this.layer = document.createElement('div');
    this.layer.className = 'layer';
    this.shadow.append(style, this.layer, this.buildToolbar());
    document.documentElement.appendChild(this.host);

    this.syncTurns();
    this.loadOptions();
    this.tick();
    // ChatGPT 是单页应用：定期重新扫描（新消息、懒加载），切换对话时自动退出
    this.rescanTimer = window.setInterval(() => {
      if (location.pathname !== this.pathname) return this.destroy();
      if (!this.busy) this.refresh();
    }, 1000);
    document.addEventListener('keydown', this.onKeydown, true);
  }

  get turnCount() {
    return this.dom.turns.length;
  }

  refresh() {
    const dom = findConversationDom();
    if (dom) {
      this.dom = dom;
      this.syncTurns();
    }
  }

  // ---------- 工具栏 ----------

  private buildToolbar(): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.innerHTML = `
      <span class="title">导出图片</span><span class="count"></span>
      <button data-act="all">全选</button>
      <button data-act="none">全不选</button>
      <button data-act="last">最后一轮</button>
      <span class="sep"></span>
      <label>清晰度 <select data-opt="scale"><option value="1">1x</option><option value="2">2x</option><option value="3">3x</option></select></label>
      <label><input type="checkbox" data-opt="hideActions"> 隐藏操作按钮</label>
      <label><input type="checkbox" data-opt="cropSides"> 裁剪两侧空白</label>
      <span class="sep"></span>
      <button data-act="download" class="primary">下载 PNG</button>
      <button data-act="copy">复制</button>
      <button data-act="exit" title="退出（Esc）">退出</button>
      <div class="status" role="status"></div>`;
    this.countEl = bar.querySelector('.count')!;
    this.statusEl = bar.querySelector('.status')!;

    bar.addEventListener('click', (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
      if (!act || this.busy) return;
      if (act === 'all') this.select(() => true);
      else if (act === 'none') this.select(() => false);
      else if (act === 'last') {
        const lastUser = this.dom.turns.map((t) => t.role).lastIndexOf('user');
        const start = lastUser >= 0 ? lastUser : Math.max(0, this.dom.turns.length - 1);
        this.select((_, i) => i >= start);
      } else if (act === 'download') this.download();
      else if (act === 'copy') this.copy();
      else if (act === 'exit') this.destroy();
    });
    bar.addEventListener('change', (e) => {
      const el = e.target as HTMLInputElement | HTMLSelectElement;
      const key = el.dataset.opt as keyof ImageOptions | undefined;
      if (!key) return;
      if (key === 'scale') this.options.scale = Number(el.value) as ImageOptions['scale'];
      else this.options[key] = (el as HTMLInputElement).checked;
      browser.storage.local.set({ [IMAGE_OPTIONS_KEY]: this.options });
    });
    return bar;
  }

  private async loadOptions() {
    const stored = (await browser.storage.local.get(IMAGE_OPTIONS_KEY))[IMAGE_OPTIONS_KEY] as Partial<ImageOptions> | undefined;
    this.options = { ...DEFAULT_IMAGE_OPTIONS, ...stored };
    const bar = this.shadow.querySelector('.bar')!;
    bar.querySelector<HTMLSelectElement>('[data-opt="scale"]')!.value = String(this.options.scale);
    bar.querySelector<HTMLInputElement>('[data-opt="hideActions"]')!.checked = this.options.hideActions;
    bar.querySelector<HTMLInputElement>('[data-opt="cropSides"]')!.checked = this.options.cropSides;
  }

  private setStatus(text: string, isError = false) {
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle('error', isError);
  }

  private setBusy(busy: boolean) {
    this.busy = busy;
    this.shadow.querySelectorAll<HTMLButtonElement>('button').forEach((b) => (b.disabled = busy && b.dataset.act !== 'exit'));
    this.layer.style.visibility = busy ? 'hidden' : '';
  }

  // ---------- 选择 ----------

  private syncTurns() {
    const current = new Set(this.dom.turns.map((t) => t.unit));
    for (const [unit, check] of this.checks) {
      if (!current.has(unit)) {
        check.remove();
        this.checks.delete(unit);
      }
    }
    for (const { unit } of this.dom.turns) {
      if (!this.checks.has(unit)) {
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'check';
        check.title = '是否包含在图片中';
        check.checked = !this.excluded.has(unit);
        check.addEventListener('change', () => this.setIncluded(unit, check.checked));
        this.layer.appendChild(check);
        this.checks.set(unit, check);
      }
      unit.toggleAttribute(ATTR_EXCLUDED, this.excluded.has(unit));
    }
    this.updateCount();
  }

  private setIncluded(unit: HTMLElement, included: boolean) {
    if (included) this.excluded.delete(unit);
    else this.excluded.add(unit);
    unit.toggleAttribute(ATTR_EXCLUDED, !included);
    const check = this.checks.get(unit);
    if (check) check.checked = included;
    this.updateCount();
  }

  private select(predicate: (turn: Turn, index: number) => boolean) {
    this.dom.turns.forEach((t, i) => this.setIncluded(t.unit, predicate(t, i)));
  }

  private selectedTurns(): Turn[] {
    return this.dom.turns.filter((t) => !this.excluded.has(t.unit));
  }

  private updateCount() {
    this.countEl.textContent = `${this.selectedTurns().length}/${this.dom.turns.length}`;
  }

  /** 勾选框跟随页面滚动：放在每个轮次中消息内容的左侧 */
  private tick = () => {
    for (const { unit } of this.dom.turns) {
      const check = this.checks.get(unit);
      if (!check) continue;
      const rect = boxOf(unit).getBoundingClientRect();
      const msg = unit.querySelector('[data-message-author-role]')?.getBoundingClientRect();
      const visible = rect.bottom > 0 && rect.top < innerHeight && rect.height > 0;
      check.style.display = visible ? '' : 'none';
      if (!visible) continue;
      const anchorLeft = msg && msg.width > 0 ? Math.min(msg.left, rect.left + rect.width / 2) : rect.left + 8;
      check.style.left = `${Math.max(rect.left + 4, anchorLeft - 34)}px`;
      check.style.top = `${Math.max(rect.top + 8, Math.min((msg?.top ?? rect.top) + 4, rect.bottom - 30))}px`;
    }
    this.raf = requestAnimationFrame(this.tick);
  };

  private onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !this.busy) this.destroy();
  };

  // ---------- 导出 ----------

  private async capture(): Promise<Blob[]> {
    this.refresh();
    return captureTurns(this.dom, this.selectedTurns(), this.options, (text) => this.setStatus(text));
  }

  private baseName(): string {
    const title = document.title.replace(/\s*[-|]\s*ChatGPT\s*$/i, '').trim() || 'ChatGPT';
    return `ChatGPT/${sanitizeFilename(title)}_${fileStamp()}`;
  }

  private async download() {
    this.setBusy(true);
    try {
      const blobs = await this.capture();
      const base = this.baseName();
      for (const [i, blob] of blobs.entries()) {
        const filename = blobs.length > 1 ? `${base}_${i + 1}of${blobs.length}.png` : `${base}.png`;
        this.setStatus(`正在保存 ${filename.split('/').pop()}…`);
        await saveBlob(blob, filename);
      }
      this.setStatus(
        blobs.length > 1
          ? `对话较长，已切分为 ${blobs.length} 张图片保存到「下载/ChatGPT」目录。`
          : '已保存到「下载/ChatGPT」目录。',
      );
    } catch (err) {
      console.error('[ChatGPT Export]', err);
      this.setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.setBusy(false);
    }
  }

  private async copy() {
    this.setBusy(true);
    try {
      // 在点击事件中同步创建 ClipboardItem，截图完成后再填充内容（避免用户手势过期）
      const pngPromise = this.capture().then((blobs) => {
        if (blobs.length !== 1 || !blobs[0]) {
          throw new Error(`内容过长需要切分为 ${blobs.length} 张图片，无法复制，请使用「下载 PNG」或减少选中的消息。`);
        }
        return blobs[0];
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngPromise })]);
      this.setStatus('图片已复制到剪贴板。');
    } catch (err) {
      console.error('[ChatGPT Export]', err);
      this.setStatus(err instanceof Error ? err.message : String(err), true);
    } finally {
      this.setBusy(false);
    }
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.rescanTimer);
    document.removeEventListener('keydown', this.onKeydown, true);
    document.querySelectorAll(`[${ATTR_EXCLUDED}], [${ATTR_UNIT}]`).forEach((el) => {
      el.removeAttribute(ATTR_EXCLUDED);
      el.removeAttribute(ATTR_UNIT);
    });
    this.pageStyle.remove();
    this.host.remove();
    active = null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** 通过后台脚本调用 downloads API，统一保存到「下载/ChatGPT」子目录 */
async function saveBlob(blob: Blob, filename: string) {
  const res = (await browser.runtime.sendMessage({
    type: 'CGE_DOWNLOAD',
    url: await blobToDataUrl(blob),
    filename,
  } satisfies BackgroundRequest)) as MessageResponse<number> | undefined;
  if (!res?.ok) throw new Error(res?.error || '保存文件失败');
}
