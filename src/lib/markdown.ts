/**
 * 极简 Markdown → HTML 渲染器（零依赖）。
 *
 * 覆盖划词助手场景常见的格式：代码块（```）、行内代码、粗体、斜体、
 * 列表（- / *）、有序列表（1.）、标题、链接、段落、换行。
 * 输出前先 HTML 转义，防注入。
 *
 * 不追求完整 GFM；够用且体积小（不引 marked / markdown-it 几十 KB）。
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(s: string): string {
  // 行内代码（优先，避免内部被其他规则破坏）
  s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  // 粗体
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // 斜体
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  // 链接 [text](url)
  s = s.replace(
    /\[([^\]]+)\]\((https?:[^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>',
  );
  return s;
}

export function renderMarkdown(src: string): string {
  if (!src) return "";
  const lines = escapeHtml(src).split("\n");
  const out: string[] = [];
  let i = 0;
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) {
      out.push("</ul>");
      inUl = false;
    }
    if (inOl) {
      out.push("</ol>");
      inOl = false;
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // 代码块 ```
    if (/^```/.test(line)) {
      closeLists();
      const lang = line.replace(/^```/, "").trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // 跳过结束的 ```
      out.push(
        `<pre><code${lang ? ` class="lang-${lang}"` : ""}>${buf.join("\n")}</code></pre>`,
      );
      continue;
    }

    // 标题
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      closeLists();
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // 无序列表
    if (/^\s*[-*]\s+/.test(line)) {
      if (!inUl) {
        closeLists();
        out.push("<ul>");
        inUl = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ""))}</li>`);
      i++;
      continue;
    }

    // 有序列表
    if (/^\s*\d+\.\s+/.test(line)) {
      if (!inOl) {
        closeLists();
        out.push("<ol>");
        inOl = true;
      }
      out.push(`<li>${inline(line.replace(/^\s*\d+\.\s+/, ""))}</li>`);
      i++;
      continue;
    }

    // 空行
    if (line.trim() === "") {
      closeLists();
      i++;
      continue;
    }

    // 普通段落
    closeLists();
    out.push(`<p>${inline(line)}</p>`);
    i++;
  }
  closeLists();
  return out.join("\n");
}
