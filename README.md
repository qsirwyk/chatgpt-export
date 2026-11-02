# ChatGPT 对话导出（Markdown / 图片）

基于 [WXT](https://wxt.dev) + TypeScript 的浏览器插件（Manifest V3），把当前打开的 ChatGPT 对话导出为：

- **Markdown**：带 YAML front matter，保留代码块、公式、表格；联网搜索的引用转成脚注链接；对话中的图片可选择以 base64 内嵌。
- **图片（PNG 长图）**：自动滚动整段对话，逐屏截取浏览器真实画出的页面后拼接，与网页显示效果完全一致（主题、字体、公式、代码块、图片都是页面原样）。

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
| 导出图片 | 自动加载完整对话并从上到下滚动截图，保存到「下载/ChatGPT」。可选「隐藏复制、点赞等操作按钮」「裁剪两侧空白」。截图期间请保持该标签页在前台、不要滚动页面，按 Esc 取消。 |

### 图片导出的实现

1. 滚动到顶部，直到 ChatGPT 不再加载更早的历史（新版页面只挂载视口附近的几轮，历史是懒加载的）；
2. 再从上到下完整滚动一遍，让每轮的高度都测量好，避免截图时布局跳动；
3. 隐藏盖在对话区域上的悬浮元素（顶栏、输入框等）和滚动条，可选隐藏操作按钮；
4. 逐屏滚动，用 `tabs.captureVisibleTab` 截取浏览器画面，按滚动距离拼接；滚到底部时才确定结束位置；
5. 超过 canvas 上限（30000px）时自动切分成多张（`_1of2.png` …），最后回到原来的阅读位置。

清晰度等于屏幕本身的像素密度（高分屏为 2x）。`captureVisibleTab` 每秒最多调用 2 次，长对话需要几十秒。截图需要 `activeTab` 权限：点击插件图标打开弹窗时自动获得。

## 目录结构

```
wxt.config.ts                 # manifest 配置（权限、名称等）
entrypoints/
  background.ts               # 后台：截取标签页画面、调用 downloads API 保存 PNG
  content/
    index.ts                  # 内容脚本入口与消息分发
    api.ts                    # 取 token、请求对话、生成并下载 Markdown
    capture.ts                # 滚动截图：加载完整历史、逐屏截取并拼接/切分
  popup/                      # 工具栏弹窗
utils/
  types.ts                    # 共享类型与常量
  conversation.ts             # 纯函数：对话分支整理、引用处理、Markdown 生成
public/icon/                  # 插件图标
```

## 已知限制

- 只导出当前对话中 user / assistant 的可见文本和图片；代码解释器的执行过程、推理过程等工具消息不导出（生成的图片会保留）。
- Markdown 依赖 ChatGPT 的非公开接口，接口变化时需要调整 `entrypoints/content/api.ts` 和 `utils/conversation.ts`。
- 图片依赖 ChatGPT 页面的 DOM 结构来定位对话和滚动容器（`data-turn-key`、`data-turn-id-container`、`data-message-author-role` 等），页面改版时需要调整 `entrypoints/content/capture.ts`。识别失败时会显示各类节点的数量，便于排查。
- 截图期间切换标签页、最小化窗口或手动滚动会导致截图错误；对话中代码块等内容自身的 sticky 标题可能在接缝处重复出现。
- Team / Enterprise 工作区通过 `_account` cookie 识别，若请求返回 404 请先在页面中切换到对应工作区。
