// Markdown → 安全 HTML：marked 解析，KaTeX 渲染公式，highlight.js 高亮代码，DOMPurify 过滤。
'use strict';

(function (global) {
    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function renderTex(tex, displayMode) {
        try {
            return katex.renderToString(tex, { displayMode, throwOnError: false, output: 'html', strict: 'ignore' });
        } catch (_) {
            return `<code>${escapeHtml(tex)}</code>`;
        }
    }

    // 块级公式：$$...$$ 或 \[...\]，独占若干行
    const blockMath = {
        name: 'blockMath',
        level: 'block',
        start(src) {
            const m = src.match(/(^|\n)[ \t]*(\$\$|\\\[)/);
            return m ? m.index + m[1].length : undefined;
        },
        tokenizer(src) {
            const m = /^[ \t]*(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n+|$)/.exec(src);
            if (m) return { type: 'blockMath', raw: m[0], text: (m[1] ?? m[2]).trim() };
        },
        renderer(token) {
            return `<div class="math-block">${renderTex(token.text, true)}</div>\n`;
        }
    };

    // 行内公式：\(...\)、\[...\]（行内出现时）、$$...$$、$...$
    const inlineMath = {
        name: 'inlineMath',
        level: 'inline',
        start(src) {
            const m = src.match(/\$|\\\(|\\\[/);
            return m ? m.index : undefined;
        },
        tokenizer(src) {
            let m = /^\\\(([\s\S]+?)\\\)/.exec(src);
            if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: false };
            m = /^\\\[([\s\S]+?)\\\]/.exec(src);
            if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: true };
            m = /^\$\$([\s\S]+?)\$\$/.exec(src);
            if (m) return { type: 'inlineMath', raw: m[0], text: m[1].trim(), display: true };
            // 单个 $：内容两端不能是空白，结束符后不能紧跟数字（避免把 "$5 和 $10" 当成公式）
            m = /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src);
            if (m) return { type: 'inlineMath', raw: m[0], text: m[1], display: false };
        },
        renderer(token) {
            return renderTex(token.text, token.display);
        }
    };

    const md = new marked.Marked({
        gfm: true,
        breaks: false,
        extensions: [blockMath, inlineMath],
        renderer: {
            code(code, infostring) {
                const lang = String(infostring || '').trim().split(/\s+/)[0].toLowerCase();
                let body;
                if (lang && hljs.getLanguage(lang)) {
                    body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
                } else {
                    body = escapeHtml(code);
                }
                const label = lang ? `<div class="code-lang">${escapeHtml(lang)}</div>` : '';
                return `<div class="code-block">${label}<pre><code class="hljs">${body}</code></pre></div>\n`;
            },
            link(href, title, text) {
                // 图片中链接不可点击，仅保留样式
                return `<span class="link"${title ? ` title="${escapeHtml(title)}"` : ''}>${text}</span>`;
            }
        }
    });

    function renderMarkdown(text) {
        const html = md.parse(text || '');
        return DOMPurify.sanitize(html, {
            FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'textarea', 'select'],
            // 对话里的外链图片在截图时会跨域失败，只允许 data: 图片
            ALLOWED_URI_REGEXP: /^data:image\//i
        });
    }

    global.CGERender = { renderMarkdown, escapeHtml };
})(window);
