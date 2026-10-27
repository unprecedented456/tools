'use strict';
const createAIProtocol = require('../ai/protocol.cjs');

// 同一工厂会内嵌到油猴脚本；测试与本地模型服务使用相同的数据契约。
function createCourseCore() {
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const fingerprint = value => {
    const input = typeof value === 'string' ? value : JSON.stringify(value);
    let a = 2166136261, b = 5381;
    for (let i = 0; i < input.length; i++) { a = Math.imul(a ^ input.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ input.charCodeAt(i); }
    return `${(a >>> 0).toString(36)}-${(b >>> 0).toString(36)}-${input.length}`;
  };
  function courseId(url) {
    const u = new URL(url);
    const id = u.pathname.match(/\/(?:lms-graph|iframe-exercise)\/([^/]+)/)?.[1];
    return `${u.origin}:${id || u.pathname.split('/').slice(0, 3).join('/')}`;
  }
  function resourceType(value) {
    const v = text(value).toLowerCase();
    if (/^(video|视频)$/.test(v)) return 'video';
    if (/^(article|text|document|图文)$/.test(v)) return 'article';
    if (/^(forum|discussion|讨论)$/.test(v)) return 'discussion';
    if (/^(exercise|homework|assignment|作业)$/.test(v)) return 'assignment';
    if (/^(exam|examination|test|考试)$/.test(v)) return 'exam';
    return null;
  }
  function chapterOf(el) {
    const root = el.closest?.('.nav-item.is-first, [data-chapter-id]');
    const title = text(root?.querySelector?.('.nav-item-node')?.textContent || root?.getAttribute?.('data-chapter-title'));
    if (!root || !title) return null;
    return { key: fingerprint(root.getAttribute?.('data-chapter-id') || title), title };
  }
  function createCache(get, set, course) {
    const prefix = `ykt-memory-v1:${course}:`;
    function read(chapter) {
      const saved = get(prefix + chapter.key, null);
      if (saved?.version === 1 && saved.course === course && saved.chapter?.key === chapter.key) return saved;
      return { version: 1, course, chapter, sources: {}, summaries: {}, questions: {}, drafts: {}, submissions: {}, transcripts: {} };
    }
    function update(chapter, change) {
      const data = read(chapter);
      change(data);
      set(prefix + chapter.key, data); // 写入失败必须向上传递，不能先导航或提交。
      const manifest = get(prefix + 'manifest', {});
      manifest[chapter.key] = chapter;
      set(prefix + 'manifest', manifest);
      return data;
    }
    function source(chapter, record) {
      const hash = fingerprint({ text: record.text, assets: record.assets || [], kind: record.kind, videoCaptureVersion: record.videoCaptureVersion, lecture: record.lecture,
        ...(record.articleSkip ? { articleSkip: record.articleSkip } : {}) });
      const old = read(chapter).sources[record.id];
      if (old?.hash === hash && old.text === record.text) return { record: old, changed: false };
      const result = { ...record, chapterKey: chapter.key, hash, updatedAt: Date.now() };
      update(chapter, data => { data.sources[record.id] = result; data.summaries = {}; });
      return { record: result, changed: true };
    }
    function sourceVersion(chapter) {
      return fingerprint(Object.values(read(chapter).sources).map(s => [s.id, s.hash]).sort((a, b) => a[0].localeCompare(b[0])));
    }
    function exportAll() {
      return { version: 1, course, chapters: Object.values(get(prefix + 'manifest', {})).map(read) };
    }
    return { read, update, source, sourceVersion, exportAll };
  }
  function question(doc) {
    const root = doc.querySelector('.container-problem');
    if (!root) return null;
    const label = text(root.querySelector('.item-type')?.textContent);
    const type = /多选/.test(label) ? 'multiple' : /单选/.test(label) ? 'single' : /判断/.test(label) ? 'judge'
      : /填空/.test(label) ? 'blank' : /简答|问答|论述|综合|主观|解答/.test(label) ? 'essay' : 'unsupported';
    const body = root.querySelector('.problem-body') || root.querySelector('.item-body');
    const options = [...root.querySelectorAll('.item-body label.el-radio, .item-body label.el-checkbox')].map((el, i) => ({
      id: el.querySelector('input')?.value || String(i), text: text(el.querySelector('.radioText, .checkboxText')?.textContent || el.textContent), element: el,
    }));
    const inputs = [...root.querySelectorAll('.item-body input:not([type="radio"]):not([type="checkbox"]):not([type="file"]):not([type="hidden"]), .item-body textarea, .item-body [contenteditable="true"]')]
      .filter(el => el.getAttribute('aria-hidden') !== 'true');
    for (const frame of root.querySelectorAll('.item-body iframe')) {
      try { if (frame.contentDocument?.body?.isContentEditable) inputs.push(frame.contentDocument.body); } catch { /* 跨域编辑器需独立适配 */ }
    }
    if (type === 'blank' && !inputs.length) return null;
    let blankIndex = 0;
    const promptText = node => {
      if (!node) return '';
      if (node.nodeType === 3) return node.textContent || '';
      if (node.localName === 'input') return ` [空${++blankIndex}] `;
      return node.childNodes ? [...node.childNodes].map(promptText).join('') : node.textContent || '';
    };
    const matchText = node => {
      if (!node) return '';
      if (node.nodeType === 3) return node.textContent || '';
      if (/^(img|svg|math|canvas|video|audio|iframe|object|script|style|input|textarea|button)$/i.test(node.localName || '') ||
        node.matches?.('label.el-radio, label.el-checkbox, .katex, .MathJax, .MathJax_Preview, [aria-hidden="true"], [hidden]')) return ' ';
      return node.childNodes ? [...node.childNodes].map(matchText).join('') : node.textContent || '';
    };
    const activeNumber = Number(doc.querySelector('.J_order.active')?.getAttribute('data-order'));
    const labelNumber = Number(label.match(/^\d+/)?.[0]);
    if (activeNumber && labelNumber && activeNumber !== labelNumber) return null;
    const number = activeNumber || labelNumber;
    const imageCount = root.querySelectorAll('.item-body img').length;
    const data = { type, number, prompt: text(type === 'blank' ? promptText(body) : body?.textContent), options, blankCount: type === 'blank' ? inputs.length : 0,
      hasImages: imageCount > 0, imageCount, matchPrompt: text(matchText(body)),
      encrypted: !!root.querySelector('.xuetangx-com-encrypted-font'), root, body, inputs,
      count: doc.querySelectorAll('.J_order').length };
    data.hash = fingerprint({ type, number, prompt: data.prompt, options: options.map(o => [o.id, o.text]), blankCount: data.blankCount,
      ...(imageCount ? { images: imageCount } : {}), font: [...doc.querySelectorAll('style')].map(el => el.textContent).filter(s => /exam-data-decrypt-font/.test(s)).join('') });
    return data;
  }
  function publicQuestion(q) {
    return { type: q.type, number: q.number, prompt: q.encrypted ? '[题干使用特殊字体，请以图片中的字形为准]' : q.prompt,
      matchPrompt: q.encrypted ? '' : q.matchPrompt,
      ...(q.type === 'multiple' ? { requireOptionChecks: true, selectionRule: '这是多选题。逐项核对所有选项与所选资料。额外返回optionChecks:[{id:"原选项id",selected:true或false,evidence:"所选材料中的依据"}]，每个选项恰好一次；selections必须完整列出所有selected:true的id，不得只返回第一项。若只确认一个选项，请重新检查是否漏选；不要为凑数量添加没有依据的选项。' } : {}),
      ...(q.encrypted ? { transcriptionRule: `仅转写文字。blankCount必须为${q.blankCount}（以实际输入框数为准，选择题文字中的括号和下划线不是填空输入框）。options必须逐项保留这些id：${q.options.map(option => option.id).join('、') || '无选项'}。` } : {}),
      options: q.options.map(o => ({ id: o.id, text: q.encrypted ? '' : o.text })), blankCount: q.blankCount, encrypted: q.encrypted, hasImages: !!q.hasImages };
  }
  function fuzzyText(value) {
    return String(value || '').normalize('NFKC').toLowerCase().replace(/^\s*(?:第\s*)?\d+[.、)题\s]*/, '')
      .replace(/!\[[^\]]*\]\((?:[^()]|\([^()]*\))*\)|!\[[^\]]*\]\[[^\]]*\]|!\[[^\]]*\]/g, '')
      .replace(/<img\b[^>]*>|<(svg|math|canvas)\b[^>]*>[\s\S]*?<\/\1>/g, '')
      .replace(/^\s*\[[^\]]+\]:\s*\S+\.(?:png|jpe?g|gif|webp|svg)(?:\?\S*)?.*$/gm, '')
      .replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]|\[(?:空\d+|图片[^\]]*|image[^\]]*)\]|【图片[^】]*】|输入答案|_{2,}/g, '')
      .replace(/[^\p{L}\p{N}]/gu, '');
  }
  function textSimilarity(left, right) {
    if (left === right) return 1;
    if (!left.length || !right.length || Math.max(left.length, right.length) > 1500) return 0;
    if (Math.min(left.length, right.length) / Math.max(left.length, right.length) < 0.9) return 0;
    let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
    for (let i = 1; i <= left.length; i++) {
      const row = [i];
      for (let j = 1; j <= right.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
      previous = row;
    }
    return 1 - previous[right.length] / Math.max(left.length, right.length);
  }
  function matchMarkdownAnswer(records, q, chapterTitle = '') {
    const query = fuzzyText(q.matchPrompt ?? q.prompt);
    if (query.length < 8 || q.encrypted) return null;
    const negative = value => /不正确|错误|不属于|不包括|不能|不是|不符合/.test(value);
    const hits = [];
    for (const source of records.filter(record => record.userProvided)) {
      let heading = '', current = null, offset = 0;
      const entries = [];
      for (const line of source.text.split(/\n/)) {
        const title = line.match(/^#{1,6}\s+(.+)/), numbered = line.match(/^\d+[.)、]\s*(.+)/);
        if (title || numbered) { if (current) entries.push(current); current = null; }
        if (title) heading = title[1].trim();
        else if (numbered) current = { body: numbered[1], heading, offset };
        else if (current) current.body += '\n' + line;
        offset += line.length + 1;
      }
      if (current) entries.push(current);
      for (const entry of entries) {
        const values = [...entry.body.matchAll(/\*\*([^*]+)\*\*/g)].map(match => match[1].trim());
        if (!values.length || values.some(value => !value || /!\[/.test(value))) continue;
        const stem = fuzzyText(entry.body.replace(/\*\*([^*]+)\*\*/g, '').replace(/^[ \t]+\d+[.)、][ \t]*/gm, ''));
        if (negative(stem) !== negative(query)) continue;
        const score = textSimilarity(query, stem);
        if (score < 0.9) continue;
        let answer = { type: q.type, strategy: 'fuzzy', insufficient: false, sources: [source.id] };
        if (q.type === 'blank') answer.blanks = values;
        else if (q.type === 'essay') answer.text = values.join('；');
        else if (['single', 'multiple', 'judge'].includes(q.type)) {
          answer.selections = [];
          for (const value of values) {
            const normalized = fuzzyText(value), choices = q.options.filter(option => textSimilarity(fuzzyText(option.text), normalized) >= 0.9);
            if (choices.length !== 1) { answer = null; break; }
            answer.selections.push(choices[0].id);
          }
        } else continue;
        if (q.type === 'multiple' && answer?.selections.length < 2) continue;
        try { validateAnswer(q, answer); } catch { continue; }
        hits.push({ ...answer, match: { score, textOnly: true, queryCharacters: query.length, sourceCharacters: stem.length,
          sourceId: source.id, sourceHash: source.hash || fingerprint(source.text), heading: entry.heading, offset: entry.offset }, sameChapter: fuzzyText(entry.heading) === fuzzyText(chapterTitle) });
      }
    }
    if (!hits.length) return null;
    const local = hits.filter(hit => hit.sameChapter), candidates = local.length ? local : hits;
    candidates.sort((a, b) => b.match.score - a.match.score);
    const best = candidates[0], signature = answer => JSON.stringify([answer.blanks, answer.selections, answer.text]);
    if (candidates.some(hit => best.match.score - hit.match.score < 0.02 && signature(hit) !== signature(best))) return null;
    delete best.sameChapter; return best;
  }
  function planMaterials(records, question = null, chapterTitle = '', limit = 110000) {
    const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\[空\d+\]|输入答案|_{2,}/g, '').replace(/[^\p{L}\p{N}]/gu, '');
    const query = normalize(question?.prompt || '').replace(/^\d+/, '');
    const tokens = new Set();
    for (const size of [2, 3]) for (let i = 0; i <= query.length - size; i++) tokens.add(query.slice(i, i + size));
    const chapter = normalize(chapterTitle);
    const sources = records.filter(record => typeof record.text === 'string' && record.text.trim()).slice().sort((a, b) => Number(!!b.userProvided) - Number(!!a.userProvided));
    const total = sources.reduce((n, source) => n + source.text.length, 0);
    const raw = source => ({ id: source.id, chapterKey: source.chapterKey, title: source.title, text: source.text, quality: source.quality, userProvided: !!source.userProvided, referencePriority: source.userProvided ? 1 : 2, delivery: 'full' });
    const candidates = [];
    if (query.length >= 2) for (const source of sources) {
      const starts = new Set([0]), headings = [];
      for (const match of source.text.matchAll(/^(#{1,6})\s+(.+)$/gm)) { starts.add(match.index); headings.push({ offset: match.index, title: match[2].trim() }); }
      for (const match of source.text.matchAll(/^(?:\d+[.)、]\s+)|\n[ \t]*\n/gm)) starts.add(match.index + (match[0][0] === '\n' ? match[0].length : 0));
      const boundaries = [...starts, source.text.length].sort((a, b) => a - b);
      let headingIndex = -1;
      for (let i = 0; i < boundaries.length - 1; i++) {
        const begin = boundaries[i], end = boundaries[i + 1];
        while (headingIndex + 1 < headings.length && headings[headingIndex + 1].offset <= begin) headingIndex++;
        const heading = headings[headingIndex]?.title || '';
        for (let offset = begin; offset < end; offset += 2000) {
          const finish = Math.min(offset + 2400, end), text = source.text.slice(offset, finish), normalized = normalize(text);
          let matches = 0; for (const token of tokens) if (normalized.includes(token)) matches++;
          const exact = normalized.includes(query), coverage = matches / Math.max(1, tokens.size);
          if (exact || coverage >= 0.4 && matches >= Math.min(3, tokens.size)) candidates.push({ source, start: offset, end: finish, text, heading,
            score: (exact ? 1000 : 0) + coverage * 100 + (chapter && normalize(heading) === chapter ? 20 : 0) });
          if (finish === end) break;
        }
      }
    }
    candidates.sort((a, b) => Number(!!b.source.userProvided) - Number(!!a.source.userProvided) || b.score - a.score || a.start - b.start);
    const full = total <= limit;
    const materials = full ? sources.map(raw) : [];
    const excerpts = []; let remaining = full ? Math.min(6000, limit - total) : limit;
    const spans = new Map();
    for (const hit of candidates) {
      if (excerpts.length >= (full ? 4 : 32)) break;
      const used = spans.get(hit.source.id) || [];
      if (hit.text.length > remaining || used.some(span => hit.start < span.end && hit.end > span.start)) continue;
      used.push(hit); spans.set(hit.source.id, used); remaining -= hit.text.length;
      excerpts.push({ id: `${hit.source.id}#passage:${hit.start}-${hit.end}`, chapterKey: hit.source.chapterKey,
        title: `${hit.source.title}${hit.heading ? ` · ${hit.heading}` : ''}`, text: hit.text,
        quality: hit.source.quality, userProvided: !!hit.source.userProvided, referencePriority: hit.source.userProvided ? 1 : 2, delivery: 'matched-original', sourceId: hit.source.id,
        start: hit.start, end: hit.end, relevance: Math.round(hit.score) });
    }
    // 用户资料优先；各层内先呈现命中原文，不用摘要替换逐题答案。
    materials.unshift(...excerpts);
    materials.sort((a, b) => a.referencePriority - b.referencePriority);
    return { materials, report: { version: 4, priority: 'user-first', mode: full ? 'full-original' : 'matched-original', selectedCharacters: total,
      sentCharacters: materials.reduce((n, source) => n + source.text.length, 0), matchedPassages: excerpts.length,
      questionCharacters: query.length, sources: sources.map(source => ({ id: source.id, hash: source.hash || fingerprint(source.text),
        characters: source.text.length, userProvided: !!source.userProvided, referencePriority: source.userProvided ? 1 : 2, fullTextSent: full,
        matchedPassages: excerpts.filter(excerpt => excerpt.sourceId === source.id).length })) } };
  }
  function manualAnswer(q, value) {
    const raw = String(value || '').trim();
    let answer = { type: q.type, sources: [], manual: true, insufficient: false };
    if (q.type === 'blank') answer.blanks = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    else if (q.type === 'essay') answer.text = raw;
    else {
      answer.selections = raw.toUpperCase().split(/[\s,，、;；]+/).filter(Boolean).map(token => {
        const exact = q.options.find(option => String(option.id).toUpperCase() === token);
        if (exact) return exact.id;
        return /^[A-Z]$/.test(token) ? q.options[token.charCodeAt(0) - 65]?.id : undefined;
      });
    }
    return validateAnswer(q, answer);
  }
  function createReferences(get, set, course) {
    const key = `ykt-references-v1:${course}`;
    function read() {
      const saved = get(key, null);
      return saved?.version === 1 && saved.course === course ? saved
        : { version: 1, course, items: [], useCourse: true, answers: {}, removed: null };
    }
    function update(change) { const data = JSON.parse(JSON.stringify(read())); change(data); set(key, data); return data; }
    function add({ title, text: body, scope = 'course', chapterKey = null, format = 'text' }) {
      body = String(body || '').trim(); title = String(title || '补充材料').trim().slice(0, 180);
      if (!body) throw new Error('材料没有提取到正文，扫描版文件请先转成文字');
      if (body.length > 500000) throw new Error('单份材料超过50万字，请拆分后导入');
      if (!['course', 'chapter'].includes(scope) || scope === 'chapter' && !chapterKey) throw new Error('请先打开当前章节');
      const id = `reference:${fingerprint({ body, scope, chapterKey: scope === 'chapter' ? chapterKey : null })}`;
      if (read().items.some(item => item.id === id)) return { duplicate: true, id };
      const record = { id, title, text: body, scope, chapterKey: scope === 'chapter' ? chapterKey : null,
        format, enabled: true, hash: fingerprint(body), at: Date.now() };
      update(data => {
        if (data.items.length >= 40 || data.items.reduce((n, item) => n + item.text.length, 0) + body.length > 2000000) throw new Error('材料库已满，请移除不需要的材料后重试');
        data.items.push(record);
      });
      return { duplicate: false, id };
    }
    function selected(chapter) {
      return read().items.filter(item => item.enabled && (item.scope === 'course' || item.chapterKey === chapter.key))
        .map(item => ({ ...item, chapterKey: chapter.key, kind: 'reference', quality: 'text', userProvided: true }));
    }
    function setEnabled(id, enabled) {
      return update(data => { if (id === 'course') data.useCourse = !!enabled; else { const item = data.items.find(record => record.id === id); if (item) item.enabled = !!enabled; } });
    }
    function remove(id) { return update(data => { data.removed = data.items.find(item => item.id === id) || null; data.items = data.items.filter(item => item.id !== id); }); }
    function restore() { return update(data => {
      if (data.removed && !data.items.some(item => item.id === data.removed.id)) {
        if (data.items.length >= 40 || data.items.reduce((n, item) => n + item.text.length, 0) + data.removed.text.length > 2000000) throw new Error('材料库已满，请先移除其他材料');
        data.items.push(data.removed);
      }
      data.removed = null;
    }); }
    function answer(id, q, value) {
      const parsed = manualAnswer(q, value);
      update(data => { data.answers[id] = { ...parsed, hash: q.hash, at: Date.now() }; }); return parsed;
    }
    function forgetAnswer(id) { return update(data => { delete data.answers[id]; }); }
    return { read, add, selected, setEnabled, remove, restore, answer, forgetAnswer };
  }
  function validateAnswer(q, answer) {
    if (!answer || answer.type !== q.type || answer.insufficient === true) throw new Error('答案类型不匹配或模型认为信息不足');
    if (['single', 'multiple', 'judge'].includes(q.type)) {
      const selected = answer.selections;
      if (!Array.isArray(selected) || !selected.length || new Set(selected).size !== selected.length ||
        selected.some(id => typeof id !== 'string' || !q.options.some(o => o.id === id)) ||
        (q.type !== 'multiple' && selected.length !== 1)) throw new Error('选项校验未通过');
      return { ...answer, selections: selected };
    }
    if (q.type === 'blank') {
      if (!q.blankCount || !Array.isArray(answer.blanks) || answer.blanks.length !== q.blankCount || answer.blanks.some(v => typeof v !== 'string' || !v.trim())) throw new Error('填空数量或内容校验未通过');
      return answer;
    }
    if (q.type === 'essay' && typeof answer.text === 'string' && answer.text.trim() && answer.text.length <= 15000) return answer;
    throw new Error('暂不支持此题型或答案为空');
  }
  function sampleDiscussionComments(comments, random = Math.random) {
    const unique = new Map(); let eligible = 0;
    for (const value of comments) {
      if (value?.mine) continue;
      const content = typeof value === 'string' ? value : value?.text;
      if (typeof content !== 'string' || !content.trim()) continue;
      const clean = content.trim(), key = clean.normalize('NFKC').replace(/\s/g, '').toLowerCase(); eligible++;
      if (!unique.has(key)) unique.set(key, clean);
    }
    const pool = [...unique.values()];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.min(i, Math.max(0, Math.floor(random() * (i + 1)))); [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return { samples: pool.slice(0, 3), unique: unique.size, total: eligible, allSame: unique.size === 1 };
  }

  const { endpoint, validateTask, prioritizeTask, messages, parseModel } = createAIProtocol();
  return { text, fingerprint, courseId, resourceType, chapterOf, createCache, createReferences, manualAnswer, question, publicQuestion, planMaterials, fuzzyText, matchMarkdownAnswer, sampleDiscussionComments, validateAnswer, endpoint, validateTask, prioritizeTask, messages, parseModel };
}
module.exports = createCourseCore;
