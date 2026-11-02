# ChatGPT 对话导出（Markdown / 图片）

基于 [WXT](https://wxt.dev) + TypeScript 的浏览器插件（Manifest V3），把当前打开的 ChatGPT 对话导出为：

- **Markdown**：带 YAML front matter，保留代码块、公式、表格；联网搜索的引用转成脚注链接；对话中的图片可选择以 base64 内嵌。
- **图片（PNG 长图）**：直接截取 ChatGPT 页面自身渲染的对话 DOM，与网页显示效果一致（主题、字体、公式、代码块、图片都是页面原样），不做任何重新排版。

Markdown 的思路参考 [huhusmang/ChatGPT-Exporter](https://github.com/huhusmang/ChatGPT-Exporter)：通过 `/api/auth/session` 获取 Access Token，调用 `/backend-api/conversation/<id>` 取完整对话，再沿 `current_node` 回溯出当前显示的分支。

## 开发与构建

需要 Node.js 18+。

```bash
npm install          # 安装依赖（会自动执行 wxt prepare 生成类型）
npm run dev          # 开发模式：自动打开加载了插件的 Chrome，改代码自动重载
npm run build        # 生产构建，产物在 .output/chrome-mv3
npm run zip          # 打包成 zip，可上传到 Chrome 应用商店
npm run compile      # TypeScript 类型检查
npm run build:firefox / zip:firefox   # Firefox 版本
```

## 安装（手动加载）

1. `npm install && npm run build`
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」。
3. 点击「加载已解压的扩展程序」，选择 `.output/chrome-mv3` 目录。
4. 打开 https://chatgpt.com 上的任意对话，点击工具栏中的插件图标。

## 使用

| 按钮 | 说明 |
|---|---|
| 导出 Markdown | 直接下载 `标题_时间.md`。勾选「内嵌对话图片」时图片以 base64 写入文件（文件会变大）；不勾选时只保留占位说明。 |
| 导出图片 | 页面进入选择模式：每轮对话左侧出现勾选框，底部出现工具栏（全选 / 全不选 / 最后一轮、清晰度 1x–3x、隐藏操作按钮、裁剪两侧空白），然后「下载 PNG」或「复制」。按 Esc 或「退出」恢复页面。 |

### 图片导出的实现

ChatGPT 的对话列表是**虚拟滚动**的：每轮对话外层是一个 `div[data-turn-id-container]` 占位，只有滚动到视口附近才会渲染真正的内容（`section[data-testid="conversation-turn-N"]`）。因此导出流程是：

1. 逐个把选中的轮次滚动到视口，等 ChatGPT 渲染完成、图片加载完、高度稳定；
2. 用 [modern-screenshot](https://github.com/qq15725/modern-screenshot) 截取该轮次的真实 DOM（SVG foreignObject，由浏览器自己绘制，支持 oklch 等现代 CSS）；跨域图片由后台脚本代为下载，避免 CORS 导致空白；
3. 按页面中的真实间距把各轮次拼接成长图，恢复原来的滚动位置。

浏览器单个 canvas 的高度上限约 32767px，超出时按轮次边界自动切分成多张（`_1of2.png` …），保存在下载目录的 `ChatGPT/` 子文件夹中。图片导出也支持 `chatgpt.com/share/...` 分享页。

## 目录结构

```
wxt.config.ts                 # manifest 配置（权限、名称等）
entrypoints/
  background.ts               # 后台：代理下载跨域图片、调用 downloads API 保存 PNG
  content/
    index.ts                  # 内容脚本入口与消息分发
    api.ts                    # 取 token、请求对话、生成并下载 Markdown
    capture.ts                # 识别对话 DOM、逐轮渲染并截图、拼接/切分
    selection.ts              # 页面内选择模式：勾选框覆盖层 + 底部工具栏（Shadow DOM）
  popup/                      # 工具栏弹窗
utils/
  types.ts                    # 共享类型与常量
  conversation.ts             # 纯函数：对话分支整理、引用处理、Markdown 生成
public/icon/                  # 插件图标
```

## 已知限制

- 只导出当前对话中 user / assistant 的可见文本和图片；代码解释器的执行过程、推理过程等工具消息不导出（生成的图片会保留）。
- Markdown 依赖 ChatGPT 的非公开接口，接口变化时需要调整 `entrypoints/content/api.ts` 和 `utils/conversation.ts`。
- 图片依赖 ChatGPT 页面的 DOM 结构（`data-turn-id-container`、`data-testid="conversation-turn-N"`、`data-turn`、`data-message-author-role`、`*-turn-action-button`），页面改版时需要调整 `entrypoints/content/capture.ts`。
- 截图时页面会快速滚动一遍选中的轮次，结束后恢复原位置；对话很长时需要几秒到几十秒。
- Team / Enterprise 工作区通过 `_account` cookie 识别，若请求返回 404 请先在页面中切换到对应工作区。
