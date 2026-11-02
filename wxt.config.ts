import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'ChatGPT 对话导出 (Markdown / 图片)',
    short_name: 'ChatGPT Export',
    description: '将当前 ChatGPT 对话导出为 Markdown 文件，或按页面原样截取为 PNG 长图。',
    // activeTab：点击插件图标后允许截取当前标签页（captureVisibleTab）
    permissions: ['storage', 'downloads', 'scripting', 'activeTab'],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      // Markdown 内嵌图片时下载对话中的图片
      'https://*.oaiusercontent.com/*',
    ],
    action: {
      default_title: '导出 ChatGPT 对话',
    },
  },
});
