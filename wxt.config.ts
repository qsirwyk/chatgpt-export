import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifest: {
    name: 'ChatGPT 对话导出 (Markdown / 图片)',
    short_name: 'ChatGPT Export',
    description: '将当前 ChatGPT 对话导出为 Markdown 文件，或按页面原样截取为 PNG 长图。',
    permissions: ['storage', 'downloads', 'scripting'],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      // 对话中的图片、页面字体等资源所在域名：截图时由后台脚本代为下载
      'https://*.oaiusercontent.com/*',
      'https://*.oaistatic.com/*',
      'https://*.openai.com/*', // images.openai.com：回复中的图片
      'https://www.google.com/s2/favicons*', // 引用来源的网站图标（会重定向到 gstatic）
      'https://*.gstatic.com/*',
    ],
    action: {
      default_title: '导出 ChatGPT 对话',
    },
  },
});
