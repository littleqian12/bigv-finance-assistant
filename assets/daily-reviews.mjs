function element(doc, tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

// Markdown is rendered as DOM nodes; archived prose never executes HTML.
function inline(doc, parent, text) {
  const tokens = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;
  let offset = 0;
  for (const match of text.matchAll(tokens)) {
    parent.append(doc.createTextNode(text.slice(offset, match.index)));
    const value = match[0];
    if (value.startsWith('**')) parent.append(element(doc, 'strong', value.slice(2, -2)));
    else if (value.startsWith('`')) parent.append(element(doc, 'code', value.slice(1, -1)));
    else {
      const link = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(value);
      const node = element(doc, 'a', link[1]);
      node.href = link[2]; node.target = '_blank'; node.rel = 'noopener noreferrer'; parent.append(node);
    }
    offset = match.index + value.length;
  }
  parent.append(doc.createTextNode(text.slice(offset)));
}

export function renderDailyReviewMarkdown(doc, container, markdown, {highlights=[]} = {}) {
  container.replaceChildren();
  let module = 0;
  const marked = new Set();
  const highlight = (node, content, subject = null) => {
    if (![2,3,4,5].includes(module)) return;
    const result = highlights.find(h => !marked.has(`${module}:${h.id}`) && (subject===null || module!==2 || h.id?.startsWith('stock:')) && h.evidencePostIds?.some(id=>content.includes(String(id))) && (subject ?? content).toLowerCase().includes(String(h.title || '').split('：')[0].toLowerCase()));
    if (!result) return;
    const kind=['confirmation','verification','revision','new','evolution'].includes(result.kind)?result.kind:'evolution';
    node.className=`review-inline-result review-inline-result-${kind}`;
    node.title=`${result.title}；${result.boundary || ''}${result.retrospective ? '；后续复核或历史重建，不计事前预测。' : ''}`;
    marked.add(`${module}:${result.id}`);
  };
  const lines = String(markdown || '').split(/\r?\n/);
  for (let i = 0; i < lines.length;) {
    const line = lines[i].trim();
    if (!line || /^# /.test(line) || /^<!--.*-->$/.test(line)) { i++; continue; }
    if (/^```/.test(line)) {
      const code = []; i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      container.append(element(doc, 'pre', code.join('\n'))); i++; continue;
    }
    if (/^\|/.test(line) && /^\|[\s:|\-]+\|$/.test((lines[i + 1] || '').trim())) {
      const table = element(doc, 'table'); const wrap = element(doc, 'div', undefined, 'daily-review-table');
      let header = true;
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        const row = lines[i++].trim();
        if (/^\|[\s:|\-]+\|$/.test(row)) continue;
        const tr = element(doc, 'tr');
        for (const cell of row.replace(/^\||\|$/g, '').split('|')) { const td = element(doc, header ? 'th' : 'td'); inline(doc, td, cell.trim()); tr.append(td); }
        if (!header) highlight(tr,row,row.replace(/^\|/,'').split('|')[0]);
        table.append(tr); header = false;
      }
      wrap.append(table); container.append(wrap); continue;
    }
    const heading = /^(#{2,6})\s+(.+)$/.exec(line);
    if (heading) { if(heading[1].length===2)module=Number(heading[2].match(/^(\d+)\./)?.[1] || 0);const h = element(doc, `h${Math.min(heading[1].length + 1, 6)}`); inline(doc, h, heading[2]); container.append(h); i++; continue; }
    if (/^(?:[-*]\s|\d+\.\s)/.test(line)) {
      const ordered = /^\d+\./.test(line); const list = element(doc, ordered ? 'ol' : 'ul');
      while (i < lines.length && (ordered ? /^\d+\.\s/ : /^[-*]\s/).test(lines[i].trim())) {
        const li = element(doc, 'li'); inline(doc, li, lines[i++].trim().replace(/^(?:[-*]|\d+\.)\s+/, '')); list.append(li);
      }
      container.append(list); continue;
    }
    const quote = /^>\s?/.test(line);
    const block = element(doc, quote ? 'blockquote' : 'p');
    const parts = [line.replace(/^>\s?/, '')]; i++;
    while (!quote && i < lines.length && lines[i].trim() && !/^(?:#|>|\||[-*]\s|\d+\.\s|```|<!--)/.test(lines[i].trim())) parts.push(lines[i++].trim());
    inline(doc, block, parts.join(' ')); if(!quote) highlight(block,parts.join(' ')); container.append(block);
  }
}

export function renderStructuredDailyReview(doc, container, view, markdown = '') {
  renderDailyReviewMarkdown(doc, container, markdown, {highlights:view.highlights || []});
}

export function bindDailyReviews({ doc = document, fetchImpl = fetch } = {}) {
  const panel = doc.getElementById('today-daily-review');
  if (!panel) return;
  const picker = doc.getElementById('daily-review-picker');
  const body = doc.getElementById('daily-review-body');
  const status = doc.getElementById('daily-review-status');
  let requestId = 0;
  async function load(date = '') {
    const id = ++requestId;
    status.textContent = '正在读取日报…';
    try {
      const response = await fetchImpl(`/api/daily-reviews${date ? `?date=${encodeURIComponent(date)}` : ''}`);
      if (!response.ok) throw new Error('日报暂时无法读取');
      const data = await response.json(); if (id !== requestId) return;
      picker.replaceChildren();
      const dates = [...new Set([data.today, ...data.reports.map(r => r.date)])].sort().reverse();
      for (const value of dates) {
        const saved = data.reports.some(r => r.date === value);
        const option = element(doc, 'option', `${value}${value === data.today ? ' · 今天' : ''}${saved ? '' : ' · 待生成'}`);
        option.value = value; picker.append(option);
      }
      picker.value = data.selectedDate;
      if (data.report) {
        status.textContent = `${data.selectedDate === data.today ? '今日日报' : '历史日报'} · ${data.selectedDate} · 更新 ${new Date(data.report.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}`;
        if (data.report.structured) renderStructuredDailyReview(doc, body, data.report.structured, data.report.markdown);
        else renderDailyReviewMarkdown(doc, body, data.report.markdown);
      } else {
        status.textContent = `${data.selectedDate} 日报尚未生成`;
        body.replaceChildren(element(doc, 'p', '今天的日报生成后会显示在这里，也可以从上方选择历史日报。', 'empty-state'));
      }
      if (id === 1 && ['', '#xiaomajia/today', '#xiaomajia'].includes(globalThis.location?.hash || '')) void 0;
    } catch (error) { if (id === requestId) { status.textContent = error.message; body.replaceChildren(element(doc, 'p', '请点击刷新日报重试。', 'empty-state')); } }
  }
  picker.addEventListener('change', () => { void load(picker.value); });
  doc.getElementById('daily-review-refresh').addEventListener('click', () => { void load(picker.value); });
  void load();
}
