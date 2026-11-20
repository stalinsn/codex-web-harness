// Minimal, escape-first Markdown renderer for assistant messages.
import { escapeHtml } from './dom.js';
import { PREFIX } from './config.js';

const copyCodeIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>';

function localFilePath(destination) {
  if (destination.startsWith('file://')) {
    try {
      const url = new URL(destination);
      if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) return '';
      destination = decodeURIComponent(url.pathname);
    } catch { return ''; }
  }
  return destination.startsWith('/home/') ? destination : '';
}

function localFileAnchor(label, destination) {
  const path = localFilePath(destination);
  if (!path) return '';
  const href = `${PREFIX}/api/local-files?path=${encodeURIComponent(path)}`;
  return `<a class="local-file-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="Abrir arquivo do projeto">${escapeHtml(label)}</a>`;
}

export function markdown(text) {
  const blocks = [];
  const localLinks = [];
  let source = String(text ?? '');
  source = source.replace(/```([\w.+-]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = blocks.push(`<div class="code-block"><button type="button" class="code-copy-button" data-copy-code title="Copiar código" aria-label="Copiar bloco de código">${copyCodeIcon}</button><pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${escapeHtml(code.replace(/\n$/, ''))}</code></pre></div>`) - 1;
    return `\u0000${index}\u0000`;
  });
  const stashLocalLink = (_, label, destination) => {
    const html = localFileAnchor(label, destination);
    if (!html) return _;
    const index = localLinks.push(html) - 1;
    return `\u0001local-file-${index}\u0001`;
  };
  source = source
    .replace(/\[([^\]]+)\]\(\s*<((?:file:\/\/\/|\/home\/)[^>\n]+)>\s*\)/g, stashLocalLink)
    .replace(/\[([^\]]+)\]\(\s*(file:\/\/\/[^\s)]+|\/home\/[^\s)]+)\s*\)/g, stashLocalLink);
  const safe = escapeHtml(source);
  const inline = (line) => line
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\\\|/g, '|');
  const tableCells = (line) => {
    let value = line.trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
    const cells = [];
    let cell = '';
    let inCode = false;
    for (let index = 0; index < value.length; index += 1) {
      const char = value[index];
      if (char === '`' && value[index - 1] !== '\\') inCode = !inCode;
      if (char === '|' && !inCode && value[index - 1] !== '\\') {
        cells.push(cell.trim()); cell = '';
      } else cell += char;
    }
    cells.push(cell.trim());
    return cells;
  };
  const tableAlignment = (cell) => {
    const value = cell.trim();
    if (!/^:?-{3,}:?$/.test(value)) return null;
    if (value.startsWith(':') && value.endsWith(':')) return 'center';
    if (value.endsWith(':')) return 'right';
    return 'left';
  };
  const lines = safe.split('\n');
  const output = [];
  let paragraph = [];
  let list = '';
  let listItems = [];
  let quote = [];
  const flushParagraph = () => { if (paragraph.length) { output.push(`<p>${paragraph.map(inline).join('<br>')}</p>`); paragraph = []; } };
  const flushList = () => { if (listItems.length) { output.push(`<${list}>${listItems.map((item) => `<li>${inline(item)}</li>`).join('')}</${list}>`); listItems = []; list = ''; } };
  const flushQuote = () => { if (quote.length) { output.push(`<blockquote><p>${quote.map(inline).join('<br>')}</p></blockquote>`); quote = []; } };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const headerCells = tableCells(line);
    const delimiterCells = lines[index + 1] ? tableCells(lines[index + 1]) : [];
    const alignments = delimiterCells.map(tableAlignment);
    const isTable = headerCells.length > 1 && alignments.length === headerCells.length && alignments.every(Boolean);
    if (isTable) {
      flushParagraph(); flushList(); flushQuote();
      const renderCell = (cell, tag, column) => `<${tag}${alignments[column] ? ` style="text-align:${alignments[column]}"` : ''}>${inline(cell)}</${tag}>`;
      const head = `<thead><tr>${headerCells.map((cell, column) => renderCell(cell, 'th', column)).join('')}</tr></thead>`;
      const rows = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
        const cells = tableCells(lines[index]);
        if (cells.length === 1) break;
        while (cells.length < headerCells.length) cells.push('');
        rows.push(`<tr>${cells.slice(0, headerCells.length).map((cell, column) => renderCell(cell, 'td', column)).join('')}</tr>`);
        index += 1;
      }
      output.push(`<div class="table-wrap"><table>${head}<tbody>${rows.join('')}</tbody></table></div>`);
      index -= 1;
      continue;
    }
    // NUL characters mark stashed code blocks.
    const code = line.match(/^\u0000(\d+)\u0000$/);
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const quoteLine = line.match(/^\s*&gt;\s?(.*)$/);
    const rule = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(line);
    if (!line.trim() || code || heading || bullet || ordered || quoteLine || rule) {
      flushParagraph();
      if (!bullet && !ordered) flushList();
      if (!quoteLine) flushQuote();
      if (!line.trim()) continue;
      if (code) { output.push(blocks[Number(code[1])] || ''); continue; }
      if (rule) { output.push('<hr>'); continue; }
      if (heading) { const level = heading[1].length; output.push(`<h${level}>${inline(heading[2])}</h${level}>`); continue; }
      if (bullet || ordered) {
        const type = bullet ? 'ul' : 'ol';
        if (list && list !== type) flushList();
        list = type; listItems.push((bullet || ordered)[1]); continue;
      }
      if (quoteLine) { quote.push(quoteLine[1]); continue; }
    }
    paragraph.push(line);
  }
  flushParagraph(); flushList(); flushQuote();
  return output.join('').replace(/\u0001local-file-(\d+)\u0001/g, (_, index) => localLinks[Number(index)] || '');
}
