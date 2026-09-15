// Markdown -> HTML for assistant text. Raw HTML inside the markdown is
// escaped rather than passed through, so transcript content cannot inject
// markup into the page.
import { marked } from "marked";
import hljs from "highlight.js/lib/common";

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const renderer = {
  html(token) {
    return escapeHtml(token.text);
  },
  code(token) {
    const language = token.lang && hljs.getLanguage(token.lang) ? token.lang : null;
    let highlighted;
    if (language) {
      highlighted = hljs.highlight(token.text, { language }).value;
    } else {
      highlighted = escapeHtml(token.text);
    }
    const languageClass = language ? ` class="language-${language}"` : "";
    return `<pre><code${languageClass}>${highlighted}</code></pre>`;
  },
  link(token) {
    const inner = this.parser.parseInline(token.tokens);
    const title = token.title ? ` title="${escapeHtml(token.title)}"` : "";
    return `<a href="${escapeHtml(token.href)}"${title} target="_blank" rel="noreferrer">${inner}</a>`;
  }
};

marked.use({ renderer, gfm: true, breaks: false });

// A SKILL.md — and many an agent definition — opens with a YAML
// frontmatter block. Markdown has no idea what that is: `---` becomes a
// rule and the line under it a giant heading, so the page starts with its
// own metadata shouted at the reader. It is taken off before rendering;
// what it says (the name, the description) is already in the header above.
export function withoutFrontmatter(text) {
  return String(text || "").replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, "");
}

export function renderMarkdown(text) {
  try {
    return marked.parse(text || "");
  } catch (error) {
    return `<pre>${escapeHtml(text || "")}</pre>`;
  }
}
