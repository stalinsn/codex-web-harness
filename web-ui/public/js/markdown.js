// Minimal, escape-first Markdown renderer for assistant messages.
import { escapeHtml } from './dom.js';

export function markdown(text) {
  const blocks = [];
  let safe = escapeHtml(text);
  safe = safe.replace(/```([\w.+-]*)\n?([\s\S]*?)```/g, (_, language, code) => {
    const index = blocks.push(`<pre><code${language ? ` class="language-${escapeHtml(language)}"` : ''}>${code.replace(/\n$/, '')}</code></pre>`) - 1;
    return `\u0000${index}\u0000`;
  });
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
  return output.join('');
}
