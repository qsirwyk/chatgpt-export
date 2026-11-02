# ChatGPT 对话导出（Markdown / 图片）

一个 Chrome / Edge（Manifest V3）浏览器插件，把当前打开的 ChatGPT 对话导出为：

- **Markdown**：带 YAML front matter，保留代码块、公式、表格；联网搜索的引用转成脚注链接；对话中的图片可选择以 base64 内嵌。
- **图片（PNG 长图）**：在独立的预览页里重新排版对话，支持公式（KaTeX）、代码高亮、表格、上传/生成的图片。

思路参考 [huhusmang/ChatGPT-Exporter](https://github.com/huhusmang/ChatGPT-Exporter)：通过 `/api/auth/session` 获取 Access Token，调用 `/backend-api/conversation/<id>` 取完整对话，再沿 `current_node` 回溯出当前显示的分支。

## 安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」。
2. 点击「加载已解压的扩展程序」，选择本目录。
3. 打开 https://chatgpt.com 上的任意对话，点击工具栏中的插件图标。

## 使用

| 按钮 | 说明 |
|---|---|
| 导出 Markdown | 直接下载 `标题_时间.md`。勾选「内嵌对话图片」时图片会以 base64 写入文件（文件会变大）；不勾选时只保留占位说明。 |
| 导出图片 | 打开预览页，可以：切换浅色/深色、调整宽度（480–1100px）和清晰度（1x–3x）、显示/隐藏标题和页脚、勾选要导出的消息（或一键「最后一轮」）。然后「下载 PNG」或「复制图片到剪贴板」。 |

长对话：浏览器单个 canvas 的高度上限约 32767px，超出时会按消息边界自动切分成多张图片（`_1of3.png` …），保存在下载目录的 `ChatGPT/` 子文件夹中。

## 目录结构

```
manifest.json
src/content/content.js     # 页面内：取 token、请求对话、整理结构、生成 Markdown、下载图片
src/popup/                 # 工具栏弹窗
src/preview/render.js      # Markdown → HTML（marked + KaTeX + highlight.js + DOMPurify）
src/preview/preview.*      # 图片预览、选项与截图（modern-screenshot）
vendor/                    # 第三方库（本地打包，MV3 不允许加载远程脚本）
icons/
```

## 第三方库

marked 12.0.2 · DOMPurify 3.1.6 · KaTeX 0.16.11（仅保留 woff2 字体）· highlight.js 11.10.0 · modern-screenshot 4.4.39，均为 MIT / Apache-2.0 / BSD 许可。

## 已知限制

- 只导出当前对话中 user / assistant 的可见文本和图片；代码解释器的执行过程、推理过程等工具消息不导出（生成的图片会保留）。
- 依赖 ChatGPT 的非公开接口，接口变化时可能需要调整 `src/content/content.js`。
- Team / Enterprise 工作区通过 `_account` cookie 识别，若请求返回 404 请先在页面中切换到对应工作区。
