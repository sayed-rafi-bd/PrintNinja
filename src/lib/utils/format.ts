const VOID_HTML = new Set([
  "area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr",
]);

function isVoidTag(tag: string): boolean {
  const m = tag.match(/^<\s*\/?\s*([a-z0-9-]+)/i);
  if (!m) return false;
  return VOID_HTML.has(m[1].toLowerCase());
}

function isDoctypeOrComment(tag: string): boolean {
  const t = tag.trim();
  return t.startsWith("<!") || t.startsWith("<!--");
}

function isClosingTag(tag: string): boolean {
  return /^<\s*\/\s*[a-z0-9-]+/i.test(tag);
}

function isOpeningTag(tag: string): boolean {
  if (isClosingTag(tag) || isVoidTag(tag) || isDoctypeOrComment(tag)) return false;
  // <tag ...> without trailing slash
  return /^<\s*[a-z0-9-]+/i.test(tag) && !/\/\s*>$/.test(tag);
}

function isHandlebarsOpen(token: string): boolean {
  // {{#each ...}} , {{#if ...}}
  return /^\{\{\s*#/ .test(token);
}
function isHandlebarsClose(token: string): boolean {
  // {{/each}} , {{/if}}
  return /^\{\{\s*\/\s*/.test(token);
}

/**
 * Pretty-print HTML that may contain Handlebars `{{ }}`.
 * Idempotent: already formatted input stays formatted.
 * 2-space indent, keeps inline handlebars like {{name}} on the same line
 * as surrounding tag content where possible.
 */
export function formatHtml(html: string): string {
  if (!html || !html.trim()) return html;
  // Normalize: ensure tags are on separate lines, but keep handlebars intact.
  // Split by tags, keeping delimiters.
  const tagRe = /(<[^>]+>)/g;
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  tagRe.lastIndex = 0;
  while ((m = tagRe.exec(html)) !== null) {
    const text = html.slice(last, m.index);
    if (text) {
      const trimmed = text.trim();
      if (trimmed) {
        // Preserve handlebars block helpers as separate lines for indent,
        // but keep inline {{var}} on same line as surrounding text.
        const hbBlockRe = /(\{\{\s*[#/][^}]+\}\})/g;
        let tLast = 0;
        let hm: RegExpExecArray | null;
        hbBlockRe.lastIndex = 0;
        while ((hm = hbBlockRe.exec(text)) !== null) {
          const before = text.slice(tLast, hm.index).trim();
          if (before) parts.push(before);
          const hb = hm[1].trim();
          if (hb) parts.push(hb);
          tLast = hm.index + hm[1].length;
        }
        const tail = text.slice(tLast).trim();
        if (tail) parts.push(tail);
      }
    }
    const tag = m[1].trim();
    if (tag) parts.push(tag);
    last = m.index + m[1].length;
  }
  const tail = html.slice(last).trim();
  if (tail) {
    const hbBlockRe = /(\{\{\s*[#/][^}]+\}\})/g;
    let tLast = 0;
    let hm: RegExpExecArray | null;
    while ((hm = hbBlockRe.exec(tail)) !== null) {
      const before = tail.slice(tLast, hm.index).trim();
      if (before) parts.push(before);
      parts.push(hm[1].trim());
      tLast = hm.index + hm[1].length;
    }
    const rem = tail.slice(tLast).trim();
    if (rem) parts.push(rem);
  }

  // Now indent based on depth
  let depth = 0;
  const lines: string[] = [];
  const indent = (d: number) => "  ".repeat(Math.max(0, d));

  for (const token of parts) {
    if (!token) continue;
    const isHbOpen = isHandlebarsOpen(token);
    const isHbClose = isHandlebarsClose(token);
    const isClose = isClosingTag(token);
    const isOpen = isOpeningTag(token);

    // Handlebars close decreases before line
    if (isHbClose) depth = Math.max(0, depth - 1);
    else if (isClose) depth = Math.max(0, depth - 1);

    // Decide line: if token is pure text/handlebars without <, keep at current depth
    // Doctype stays at 0
    const isTag = token.startsWith("<");
    const isHb = token.startsWith("{{");

    if (isTag || isHb) {
      lines.push(indent(depth) + token);
    } else {
      lines.push(indent(depth) + token);
    }

    if (isHbOpen) depth += 1;
    else if (isOpen) depth += 1;
  }

  // Post-process: try to join simple inline content like <span>text</span> or <span>{{var}}</span>
  // For readability we keep block structure, but avoid over-splitting.
  // If we split "<span>" + "text" + "</span>" we get 3 lines; keep that for now — it's formatted.
  // Collapse: if previous line is opening tag and next is closing and middle is inline, could join.
  // Keep simple.

  // Remove empty lines and join
  return lines.join("\n");
}

export function formatCss(css: string): string {
  if (!css || !css.trim()) return css;
  // Very small formatter: break after { } ; and indent
  const tokens = css
    .replace(/\s+/g, " ")
    .replace(/\s*\{\s*/g, " {\n")
    .replace(/\s*;\s*/g, ";\n")
    .replace(/\s*\}\s*/g, "\n}\n")
    .replace(/\/\*\s*/g, "\n/* ")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);

  let depth = 0;
  const out: string[] = [];
  for (const t of tokens) {
    if (t === "}") depth = Math.max(0, depth - 1);
    out.push("  ".repeat(depth) + t);
    if (t.endsWith("{")) depth += 1;
  }
  return out.join("\n");
}
