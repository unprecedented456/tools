'use strict';

// 作业对象：材料库、讲稿、题目读取、填写校验、判分与逐题流程。
function createAssignmentAutomation(ports, options = {}) {
  const Course = ports.core;
  let lastQuestionRender = null;

  let courseMaterialContext = null;
  const questionTypeKey = `course-question-types:${ports.app.memoryCourse}`;
  const questionTypeNames = { single: '单选', multiple: '多选', judge: '判断', blank: '填空', essay: '问答' };
  const savedQuestionTypes = GM_getValue(questionTypeKey, null);
  let questionTypes = Array.isArray(savedQuestionTypes) ? [...new Set(savedQuestionTypes.filter(type => Object.keys(questionTypeNames).includes(type)))] : Object.keys(questionTypeNames);
  let videoCapture = null;

  function selectedQuestionTypes() { return [...questionTypes]; }

  function assignmentCompleted(item, chapterData = null, indexedQuestions = null) {
    if (item?.type !== 'assignment' || !item.chapter) return false;
    const data = chapterData || ports.app.chapterCache.read(item.chapter);
    const questions = indexedQuestions || Object.entries(data.questions).filter(([key]) => key.startsWith(`${item.id}:`) && /^\d+$/.test(key.slice(item.id.length + 1))).map(([, value]) => value);
    const total = Math.max(0, ...questions.map(q => Number(q.count) || 0));
    if (!total || questions.length !== total) return false;
    return Array.from({ length: total }, (_, index) => index + 1).every(number => {
      const q = data.questions[`${item.id}:${number}`];
      if (!q || Number(q.count) !== total) return false;
      if (Object.keys(questionTypeNames).includes(q.type) && !questionTypes.includes(q.type)) return true;
      const sent = data.submissions[`${item.id}:${number}:${q.hash}`];
      return sent?.phase === 'confirmed' && sent.outcome !== 'wrong';
    });
  }

  function setQuestionTypes(types) {
    const next = [...new Set((Array.isArray(types) ? types : []).filter(type => Object.keys(questionTypeNames).includes(type)))];
    GM_setValue(questionTypeKey, next); questionTypes = next;
    ports.app.releaseCourse(); ports.ai.clearTaskStatus();
    const stage = ports.app.courseStage();
    ports.app.saveStage({ assignmentsDone: false, processed: { ...(stage.processed || {}), assignments: {} } });
    ports.ui.invalidateProgress();
    ports.ui.courseStatus(next.length ? `作答题型已更新：${next.map(type => questionTypeNames[type]).join('、')}；其他题型直接跳过` : '未选择作答题型：所有题目都会跳过，不调用模型或提交');
  }

  function skipExcludedType(doc, item, q, run, catalog) {
    if (!Object.keys(questionTypeNames).includes(q.type) || questionTypes.includes(q.type)) return false;
    if (courseInputHold || ports.platform.pauseBlocker(ports.platform.documents())) { ports.ui.courseStatus('当前题型未勾选，等待编辑或弹窗结束后跳过'); return true; }
    if (run.changingFrom === q.hash) return true;
    let activeRun = run;
    if (run.pending) {
      activeRun = { ...run, pending: false, filling: false, error: null };
      ports.app.courseRun = activeRun; ports.ai.cancelTask();
    }
    activeRun.changingFrom = null; activeRun.waitingWrong = null; activeRun.waitingReview = false;
    recordQuestionSkip(item, q, `题型未勾选：${questionTypeNames[q.type]}`);
    ports.ui.courseStatus(`第${q.number}题为${questionTypeNames[q.type]}，未勾选，直接跳过`);
    nextQuestion(doc, item, q, activeRun, catalog); return true;
  }

  function captureVideoMaterial(item, docs) {
    if (!item?.chapter || item.type !== 'video') return { ready: true, record: null };
    if (videoCapture?.route !== location.href || videoCapture.item !== item.id) videoCapture = { route: location.href, item: item.id, since: Date.now(), changedAt: Date.now(), hash: null, opened: false };
    const candidate = materialRecord(item, docs);
    if (!candidate) return { ready: true, record: null };
    const hash = Course.fingerprint(candidate);
    if (hash !== videoCapture.hash) { videoCapture.hash = hash; videoCapture.changedAt = Date.now(); }
    if (candidate.lecture?.status === 'pending' && !videoCapture.opened) {
      const tab = docs.map(doc => lectureSnapshot(doc).tab).find(node => node && ports.platform.available(node));
      if (tab && !tab.classList.contains('active')) { tab.click(); videoCapture.opened = true; }
    }
    const timeout = Date.now() - videoCapture.since >= 20000;
    const ready = timeout || candidate.lecture?.status !== 'pending' && Date.now() - videoCapture.changedAt >= 2000;
    if (!ready && candidate.lecture?.status === 'captured') candidate.lecture.status = 'pending';
    if (timeout && candidate.lecture?.status === 'pending') { candidate.lecture.status = 'timeout'; candidate.quality = candidate.text.trim() ? 'partial' : 'missing'; }
    const old = ports.app.chapterCache.read(item.chapter).sources[item.id];
    if (!ready && old?.lecture?.status === 'captured') return { ready: true, record: old };
    const result = ports.app.chapterCache.source(item.chapter, candidate);
    if (result.changed) { ports.ui.noteCourseAction(ready ? '已缓存当前视频知识导引与讲稿，后续作业可复用' : '正在记录当前视频材料，等待文本加载稳定'); ports.app.trace('memory.video.capture', { id: item.id, ready, lecture: candidate.lecture?.status }); }
    return { ready, record: result.record };
  }

  function pdfOnlyArticle(item, docs) {
    if (item?.type !== 'article') return null;
    const doc = docs.find(doc => doc.querySelector('.main-text-attachment'));
    const root = doc?.querySelector('.main-text-attachment'); if (!root) return null;
    const nodes = [...root.querySelectorAll('a[href], iframe[src], embed[src], object[data], [data-file-name], .file-name, .attachment-name')];
    const label = node => Course.text(node.getAttribute?.('data-file-name') || node.getAttribute?.('title') || node.textContent);
    const pdfs = nodes.filter(node => {
      let value = [node.getAttribute?.('href'), node.getAttribute?.('src'), node.getAttribute?.('data'), node.getAttribute?.('download'), label(node)].filter(Boolean).join(' ');
      try { value = decodeURIComponent(value); } catch { /* 非编码文件名也可识别 */ }
      return /\.pdf(?:$|[\s?#&）)])/i.test(value) || /application\/pdf/i.test(node.getAttribute?.('type') || '');
    });
    if (!pdfs.length) return null;
    const bodies = [...doc.querySelectorAll('.main-text-attachment .custom-ueditor')];
    if (bodies.some(body => body.querySelectorAll('img, svg, canvas, video, audio').length)) return null;
    let prose = bodies.map(body => body.innerText || body.textContent || '').join('\n');
    for (const pdf of pdfs) if (label(pdf)) prose = prose.split(label(pdf)).join('');
    prose = prose.replace(/\s/g, '').replace(/^(?:附件|下载|预览|查看附件|点击下载|点击预览|暂无正文|暂无内容|正文加载中|正在加载|加载中|[.。:：…])+$/g, '');
    if (prose) return null;
    return { id: item.id, title: item.title, kind: 'article', text: '', quality: 'attachment-only', articleSkip: 'pdf-only',
      assets: pdfs.map(node => ({ kind: 'attachment', format: 'pdf', label: label(node).slice(0, 160) })),
      readObserved: /已读|已完成/.test(ports.app.moduleStateText()) };
  }

  function recordPdfSkip(item, record) {
    ports.app.chapterCache.source(item.chapter, record);
    ports.ui.noteCourseAction('图文仅含PDF附件，已跳过；附件正文未读取');
    ports.app.trace('course.article.pdf-only', { id: item.id, attachments: record.assets.length });
  }

  function materialRecord(item, docs) {
    if (!item.chapter) return null;
    const main = docs.find(doc => item.type === 'video' ? doc.querySelector('.guidance-content') || doc.querySelector('.draft-list') || doc.querySelector('#js-tab-bar .ai-tabs-item') : doc.querySelector('.main-text-attachment .custom-ueditor')) || document;
    let body = '', roots = [];
    let lecture;
    if (item.type === 'video') {
      roots = [...main.querySelectorAll('.guidance-content')];
      const guidance = roots.map(el => `${Course.text(el.querySelector('h2')?.textContent)}\n${Course.text(el.querySelector('.guidance-detail')?.textContent)}`).filter(value => value.trim()).join('\n\n');
      const snapshot = lectureSnapshot(main); lecture = snapshot.meta;
      roots.push(...snapshot.roots);
      body = [guidance && `【知识导引】\n${guidance}`, snapshot.text && `【视频讲稿】\n${snapshot.text}`].filter(Boolean).join('\n\n');
      if (!roots.length && !snapshot.tab) return null;
    } else if (item.type === 'article') {
      roots = [...main.querySelectorAll('.main-text-attachment .custom-ueditor')];
      body = roots.map(el => el.innerText || el.textContent || '').join('\n\n').trim();
    }
    if (item.type !== 'video' && !roots.length) return null;
    const assets = roots.flatMap(el => [...el.querySelectorAll('img, a[href]')].map(node => ({
      kind: node.localName === 'img' ? 'image' : 'attachment',
      label: Course.text(node.getAttribute('alt') || node.textContent).slice(0, 160),
      // 不缓存签名URL；保留“含未解析图片/附件”的事实，防止摘要冒充已读附件。
    })));
    return { id: item.id, title: item.title, kind: item.type === 'video' ? 'guidance' : 'article', text: body,
      ...(item.type === 'video' ? { videoCaptureVersion: 1, lecture } : {}),
      assets, quality: body.length >= 30 && !assets.length ? 'text' : assets.length ? 'partial' : body ? 'short' : 'missing',
      readObserved: item.type === 'article' && /已读|已完成/.test(ports.app.moduleStateText()) };
  }

  function rememberMaterial(item, docs) {
    const record = pdfOnlyArticle(item, docs) || materialRecord(item, docs);
    if (!record) return null;
    const old = ports.app.chapterCache.read(item.chapter).sources[item.id];
    if (record.lecture?.status === 'pending' && old?.lecture?.status === 'captured') return old;
    const result = ports.app.chapterCache.source(item.chapter, record);
    if (result.changed) { ports.ui.noteCourseAction('已将当前材料保存到本地'); ports.app.trace('memory.source.saved', { type: record.kind, chapter: item.chapter.key, characters: record.text.length, quality: record.quality }); }
    return result.record;
  }

  function questionDoc(docs) { return docs.find(doc => doc.querySelector('.container-problem')) || null; }

  function collectQuestion(item, q) {
    const key = `${item.id}:${q.number}`;
    if (ports.app.chapterCache.read(item.chapter).questions[key]?.hash === q.hash) return key;
    ports.app.chapterCache.update(item.chapter, data => {
      if (data.scans) delete data.scans[item.id];
      data.questions[key] = { task: item.id, number: q.number, count: q.count, type: q.type, hash: q.hash, encrypted: q.encrypted,
        blankCount: q.blankCount, prompt: q.prompt, options: q.options.map(o => ({ id: o.id, text: o.text })), updatedAt: Date.now() };
    });
    ports.ui.noteCourseAction(`已记住第${q.number}题`);
    return key;
  }

  function nextQuestion(doc, item, q, run, catalog, manual = false) {
    const saved = ports.app.chapterCache.read(item.chapter);
    const orders = [...doc.querySelectorAll('.J_order')].sort((a, b) => Number(a.getAttribute('data-order')) - Number(b.getAttribute('data-order')));
    const ordered = [...orders.filter(el => Number(el.getAttribute('data-order')) > q.number), ...orders.filter(el => Number(el.getAttribute('data-order')) < q.number)];
    const next = manual ? orders.find(el => Number(el.getAttribute('data-order')) > q.number) : ordered.find(el => {
      const number = Number(el.getAttribute('data-order'));
      if (number === q.number) return false;
      const record = saved.questions[`${item.id}:${number}`];
      if (ports.app.courseMode === 'collect') return !record || record.count !== q.count;
      const outcome = orderOutcome(el);
      const sent = record && saved.submissions[`${item.id}:${number}:${record.hash}`];
      if (record && skippedQuestion(saved, item, number, record.hash)) return false;
      if (outcome === 'wrong') return !sent?.acknowledged;
      if (['correct', 'answered'].includes(outcome)) return false;
      return !record || saved.submissions[`${item.id}:${number}:${record.hash}`]?.phase !== 'confirmed';
    });
    if (next) {
      run.staleResult = { number: Number(next.getAttribute('data-order')), signature: resultPanelSignature(q) };
      run.changingFrom = q.hash; run.transitionAt = Date.now(); next.click(); run.nextAt = Date.now() + 1200; run.filled = null; run.waitingReview = false; run.waitingWrong = null; run.submitting = null;
    }
    else {
      if (ports.app.courseMode === 'collect') ports.app.chapterCache.update(item.chapter, data => { data.scans ??= {}; data.scans[item.id] = { count: q.count, at: Date.now() }; });
      const progress = assignmentProgress(doc, item);
      run.outcome = progress && (progress.skipped || progress.pending || progress.untouched) ? 'skipped' : 'processed';
      run.advanced = false;
      if (manual && !ports.app.enabled) { ports.app.recordCourseStep(item, run.outcome); const target = ports.app.nextPlannedModule(catalog); if (target) ports.app.courseNavigate(target); else ports.app.finishCourseStage(catalog); }
      else ports.app.nextModule(catalog, run);
    }
  }

  function resultFromNodes(nodes, allowColors = true) {
    let correct = false, answered = false;
    for (const node of nodes.filter(Boolean)) {
      if (!ports.platform.visible(node)) continue;
      const body = Course.text(node.textContent);
      const descendants = [node, ...node.querySelectorAll?.('[class], [data-result], [data-status], [aria-label], svg, use, [style]') || []].filter(el => ports.platform.visible(el.localName === 'use' ? el.closest?.('svg') || el.parentElement || el : el));
      const classes = descendants.map(el => ['class', 'data-result', 'data-status', 'aria-label', 'href', 'xlink:href', 'title'].map(key => el.getAttribute?.(key) || '').join(' ') + ' ' + (el.className?.baseVal || el.className || '')).join(' ').replace(/(?:correct|right)[-_]answer/gi, '');
      const colors = allowColors ? descendants.map(el => `${el.getAttribute?.('style') || ''} ${el.getAttribute?.('fill') || ''} ${el.ownerDocument?.defaultView?.getComputedStyle?.(el)?.color || ''}`).join(' ').replace(/\s/g, '').toLowerCase() : '';
      if (/cuowu|icon[-_](?:close|error|wrong)|incorrect|wrong|answer-error/i.test(classes) || /#(?:f56c6c|ff4949|ff4d4f|f44336)|rgb\((?:245,108,108|255,73,73|255,77,79|244,67,54)\)/.test(colors)) return 'wrong';
      if (/zhengque|icon[-_](?:check|success|right)|answer-right|check-circle/i.test(classes) || /#(?:67c23a|13ce66|52c41a|00b42a)|rgb\((?:103,194,58|19,206,102|82,196,26|0,180,42)\)/.test(colors)) correct = true;
      if (/回答错误|答案错误|回答有误|答错|未答对|部分正确|不完全正确/.test(body) || /(?:^|[\s_-])(?:wrong|incorrect|error|failed|partial)(?=$|[\s_-])/i.test(classes)) return 'wrong';
      if (/回答正确|答案正确|全部正确|答对/.test(body) || /(?:^|[\s_-])(?:correct|right|success)(?=$|[\s_-])/i.test(classes)) correct = true;
      if (/已作答|已提交|待批阅|等待批改|本题结果/.test(body) || /(?:^|[\s_-])(?:finish|finished|answered|submitted|done)(?=$|[\s_-])/i.test(classes)) answered = true;
    }
    return correct ? 'correct' : answered ? 'answered' : 'none';
  }

  function orderOutcome(order) {
    if (!order) return 'none';
    const marker = order.querySelector?.('.status-container');
    // 题号本身可能因当前选中而变绿，只有状态图标区域才能用颜色判分。
    return marker ? resultFromNodes([marker]) : resultFromNodes([order], false);
  }

  function resultPanelNodes(q) { return [...q.root.querySelectorAll('.answer-analysis, .problem-result, .answer-result, .result-container, .item-result, [data-result]')]; }

  function resultPanelSignature(q) {
    const nodes = resultPanelNodes(q).filter(node => ports.platform.visible(node));
    return nodes.length ? Course.fingerprint(nodes.map(node => [Course.text(node.textContent), String(node.className || ''), node.getAttribute?.('data-result') || ''])) : '';
  }

  function observedOutcome(q, doc) {
    const ownStatus = resultFromNodes([doc.querySelector('.J_order.active .status-container')]);
    if (ownStatus !== 'none') return ownStatus;
    const fence = ports.app.courseRun?.staleResult;
    if (fence?.number === q.number) {
      if (fence.signature && fence.signature === resultPanelSignature(q)) return 'none';
      ports.app.courseRun.staleResult = null;
    }
    return resultFromNodes(resultPanelNodes(q));
  }

  function pauseForWrong(item, q, key) {
    const existing = ports.app.chapterCache.read(item.chapter).submissions[key];
    if (!existing || existing.phase !== 'wrong') ports.app.chapterCache.update(item.chapter, data => { data.submissions[key] = { ...data.submissions[key], phase: 'wrong', outcome: 'wrong', hash: q.hash, at: Date.now() }; });
    const message = `网站判定第${q.number}题有误，自动提交已暂停。核验后可点面板“下一题”，再决定是否恢复自动提交。`;
    const fresh = GM_getValue(`course-wrong-pause:${ports.app.memoryCourse}`, null)?.key !== key;
    GM_setValue(`course-wrong-pause:${ports.app.memoryCourse}`, { key, chapter: item.chapter, number: q.number, message, reviewOnly: true, at: Date.now() });
    ports.app.courseSubmitEnabled = false; GM_setValue(`course-auto-submit:${ports.app.memoryCourse}`, false);
    ports.ai.cancelTask();
    if (ports.app.courseRun) { ports.app.courseRun.waitingWrong = key; ports.app.courseRun.waitingReview = true; ports.app.courseRun.error = null; ports.app.courseRun.pending = false; }
    ports.ui.courseStatus(message); if (fresh) ports.ui.feedback(message, 'error');
    if (fresh) ports.app.trace('course.answer.wrong', { number: q.number });
  }

  function acknowledgeWrongPause() {
    const saved = GM_getValue(`course-wrong-pause:${ports.app.memoryCourse}`, null);
    if (!saved) return;
    ports.app.chapterCache.update(saved.chapter, data => { if (data.submissions[saved.key]) data.submissions[saved.key] = { ...data.submissions[saved.key], phase: 'confirmed', acknowledged: true }; });
    GM_setValue(`course-wrong-pause:${ports.app.memoryCourse}`, null);
  }

  function processObservedResult(doc, item, q, run, catalog) {
    if (run.changingFrom === q.hash) { ports.ui.courseStatus('等待下一题加载；不会重复点击'); return true; }
    if (run.changingFrom) { run.changingFrom = null; run.filled = null; run.waitingWrong = null; }
    const outcome = observedOutcome(q, doc);
    if (outcome === 'none') return false;
    const key = `${item.id}:${q.number}:${q.hash}`, previous = ports.app.chapterCache.read(item.chapter).submissions[key];
    fuzzyResult(item, key, outcome);
    if (outcome === 'wrong' && !previous?.acknowledged) { pauseForWrong(item, q, key); return true; }
    if (outcome === 'answered') {
      if (run.resultKey !== key) { run.resultKey = key; run.resultSince = Date.now(); }
      if (Date.now() - run.resultSince < 2000) { ports.ui.courseStatus('网站已显示作答记录，等待评分状态稳定'); return true; }
    }
    collectQuestion(item, q);
    ports.app.chapterCache.update(item.chapter, data => { data.submissions[key] = { ...data.submissions[key], phase: 'confirmed', outcome, hash: q.hash, at: Date.now() }; });
    if (GM_getValue(`course-wrong-pause:${ports.app.memoryCourse}`, null)?.key === key) GM_setValue(`course-wrong-pause:${ports.app.memoryCourse}`, null);
    ports.ai.cancelTask(); run.pending = false; run.error = null; run.waitingReview = false;
    ports.ai.clearTaskStatus();
    nextQuestion(doc, item, q, run, catalog); return true;
  }

  function readFilledAnswer(q) {
    if (!q) throw new Error('尚未识别当前题目');
    if (['single', 'multiple', 'judge'].includes(q.type)) {
      const states = q.options.map(choiceState);
      if (states.some(state => state.selected === null || !state.consistent)) throw new Error('选项状态尚未确认，请等页面稳定后再核验');
      return { type: q.type, selections: states.filter(state => state.selected).map(state => state.id), sources: [], manual: true };
    }
    const values = q.inputs.map(input => input.isContentEditable ? input.textContent : input.value);
    return q.type === 'blank' ? { type: q.type, blanks: values, sources: [], manual: true } : { type: q.type, text: values[0], sources: [], manual: true };
  }

  function choiceState(option) {
    if (!option) return { id: null, native: null, aria: null, visual: null, selected: null, consistent: false, disabled: false };
    const element = option.element, input = element.querySelector('input');
    const indicator = element.querySelector('.el-checkbox__input, .el-radio__input');
    const native = typeof input?.checked === 'boolean' ? input.checked : null;
    const ariaValue = element.getAttribute?.('aria-checked') ?? input?.getAttribute?.('aria-checked') ?? indicator?.getAttribute?.('aria-checked');
    const aria = ['true', 'false'].includes(ariaValue) ? ariaValue === 'true' : null;
    const visualNode = indicator?.classList ? indicator : element.classList?.contains('el-checkbox') || element.classList?.contains('el-radio') ? element : null;
    const visual = visualNode ? visualNode.classList.contains('is-checked') : null;
    const states = [native, aria, visual].filter(state => state !== null);
    return { id: option.id, native, aria, visual, selected: states[0] ?? null,
      consistent: states.length > 0 && states.every(state => state === states[0]),
      disabled: !!input?.disabled || element.getAttribute?.('aria-disabled') === 'true' || !!element.classList?.contains('is-disabled') };
  }

  function choiceReport(q, answer) {
    const states = q.options.map(choiceState), expected = answer?.selections || [];
    return { number: q.number, expected, selected: states.filter(state => state.selected).map(state => state.id),
      missing: expected.filter(id => !states.some(state => state.id === id && state.selected === true && state.consistent)),
      unexpected: states.filter(state => state.selected && !expected.includes(state.id)).map(state => state.id), states };
  }

  async function fillQuestion(q, answer, replaceExisting = false, guard = () => true) {
    Course.validateAnswer(q, answer);
    if (['single', 'multiple', 'judge'].includes(q.type)) {
      const doc = q.root.ownerDocument || q.body?.ownerDocument || document;
      const current = () => {
        if (!guard()) throw new Error('作答已暂停，未继续选择选项');
        const live = Course.question(doc);
        if (!live || live.hash !== q.hash) throw new Error('题目已切换，未继续填写原题');
        return live;
      };
      const wait = () => new Promise(resolve => (doc.defaultView.setTimeout || setTimeout)(resolve, 120));
      const initial = choiceReport(current(), answer);
      if (!replaceExisting && initial.unexpected.length) throw new Error('选项已有不同选择，已保留原选择和模型草稿');
      // 每次点击后等待框架更新，再从新DOM取下一项，避免多选项共用旧状态互相覆盖。
      for (const id of q.options.map(option => option.id)) {
        let live = current(), option = live.options.find(option => option.id === id), state = option && choiceState(option);
        if (!state || state.selected === null) throw new Error('无法确认选项控件状态，已保留草稿，未提交');
        const desired = answer.selections.includes(id);
        if (!state.consistent) { await wait(); live = current(); option = live.options.find(option => option.id === id); state = option && choiceState(option); }
        if (!state || !state.consistent) throw new Error('选项显示与实际状态不一致，已保留草稿，未提交');
        if (state.selected === desired || q.type !== 'multiple' && !desired) continue;
        if (state.disabled) throw new Error('选项已锁定，未完成填写或提交');
        const input = option.element.querySelector('input');
        if (typeof input?.click === 'function') input.click(); else option.element.click();
        ports.app.trace('course.choice.clicked', { number: q.number, id, desired });
        await wait();
        live = current(); state = choiceState(live.options.find(option => option.id === id));
        if (state.selected !== desired || !state.consistent) throw new Error(`选项${id}未正确选中或取消，已保留草稿，未提交`);
      }
      await wait(); verifyFilled(current(), answer);
      ports.app.trace('course.choice.filled', choiceReport(current(), answer));
      return;
    }
    const values = q.type === 'blank' ? answer.blanks : [answer.text];
    if (q.inputs.length !== values.length) throw new Error('输入框数量不匹配，已保留草稿');
    for (let i = 0; i < values.length; i++) {
      const existing = q.inputs[i].isContentEditable ? q.inputs[i].textContent : q.inputs[i].value;
      if (!replaceExisting && existing?.trim() && existing !== values[i]) throw new Error('输入框已有不同内容，已保留原内容和模型草稿');
      ports.dom.setField(q.inputs[i], values[i]);
    }
    if (q.inputs.some((el, i) => (el.isContentEditable ? el.textContent : el.value) !== values[i])) throw new Error('答案未正确写入，已保留草稿');
  }

  function verifyFilled(q, answer) {
    if (['single', 'multiple', 'judge'].includes(q.type)) {
      const report = choiceReport(q, answer);
      if (report.missing.length || report.unexpected.length || report.states.some(state => state.selected === null || !state.consistent)) {
        ports.app.trace('course.choice.incomplete', report);
        throw new Error(`选项未完整写入（目标${report.expected.join('、')}，实际${report.selected.join('、') || '未选中'}），已保留草稿，未提交`);
      }
    } else {
      const values = q.type === 'blank' ? answer.blanks : [answer.text];
      if (q.inputs.length !== values.length || q.inputs.some((el, i) => (el.isContentEditable ? el.textContent : el.value) !== values[i])) throw new Error('答案被页面改写，已暂缓提交');
    }
  }

  async function renderQuestion(q, doc) {
    await doc.fonts?.ready;
    const canvas = doc.createElement('canvas'); canvas.width = 1000; canvas.height = 2600;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#111';
    let x = 24, y = 36, blank = 0;
    const write = (value, family = 'sans-serif') => {
      ctx.font = `20px ${family}`;
      for (const char of value) {
        const width = ctx.measureText(char).width;
        if (char === '\n' || x + width > 974) { x = 24; y += 32; if (char === '\n') continue; }
        if (y > 2550) throw new Error('题目过长，读图内容无法完整显示');
        ctx.fillText(char, x, y); x += width;
      }
    };
    const walk = node => {
      if (node.nodeType === 3) { write(node.textContent || '', doc.defaultView.getComputedStyle(node.parentElement).fontFamily); return; }
      if (node.nodeType !== 1) return;
      if (['script', 'style', 'button', 'svg'].includes(node.localName)) return;
      if (['input', 'textarea'].includes(node.localName)) { if (q.type === 'blank' && !['radio', 'checkbox', 'hidden', 'file'].includes(node.type)) write(` [空${++blank}] `); return; }
      if (node.localName === 'img') { write(' [图片] '); return; }
      if (node.localName === 'br') { write('\n'); return; }
      for (const child of node.childNodes) walk(child);
      if (['p', 'li'].includes(node.localName)) write('\n');
    };
    write(`第${q.number}题 ${q.type}\n`);
    walk(q.body);
    if (['single', 'multiple', 'judge'].includes(q.type)) for (const option of q.options) {
      write(`\n选项 ${option.id}: `); walk(option.element.querySelector('.radioText, .checkboxText') || option.element);
    }
    const crop = doc.createElement('canvas'); crop.width = canvas.width; crop.height = y + 35;
    crop.getContext('2d').drawImage(canvas, 0, 0);
    if (q.type === 'blank' && blank !== q.blankCount) throw new Error('题目图片中的空位数量不完整，未发送模型');
    const image = crop.toDataURL('image/png');
    lastQuestionRender = { image, meta: { number: q.number, questionHash: q.hash || null, width: crop.width, height: crop.height,
      blankCount: blank, omittedImages: q.imageCount || 0, fontState: doc.fonts?.status || 'unavailable', at: Date.now() } };
    return image;
  }

  async function inspectQuestionImage(download = false) {
    try {
      if (ports.platform.humanVerification(ports.platform.documents())) throw new Error('请先手动完成人机验证');
      const doc = questionDoc(ports.platform.documents()), q = doc && Course.question(doc);
      if (!q) throw new Error('请先打开一道作业题');
      const image = lastQuestionRender?.meta.questionHash === q.hash ? lastQuestionRender.image : await renderQuestion(q, doc);
      if (Course.question(doc)?.hash !== q.hash) throw new Error('题目已切换，请重新预览');
      if (download) {
        const link = document.createElement('a'); link.href = image; link.download = `yuketang-question-${q.number}.png`;
        document.documentElement.append(link); link.click(); link.remove();
      } else {
        ports.ui.showPanelView('diagnostics');
        const preview = ports.ui.shadow.getElementById('question-image'); preview.src = image; preview.hidden = false;
        ports.ui.shadow.getElementById('question-image-note').textContent = `第${q.number}题 · ${lastQuestionRender.meta.width}×${lastQuestionRender.meta.height} · ${q.blankCount}个空；这是识别时实际使用的图片。`;
      }
    } catch (error) { ports.ui.feedback(error.message, 'error'); }
  }

  async function materialsFor(item, run, question = null) {
    const records = selectedSources(item.chapter);
    if (!records.length) throw new Error('当前参考库没有可用正文，请勾选课程材料、导入文件或直接补充本题答案');
    const planned = Course.planMaterials(records, question, item.chapter.title);
    courseMaterialContext = { ...planned.report, at: Date.now(), questionHash: question?.hash || null,
      readingMethod: question?.readingMethod || (question ? 'page-text' : null), chapterKey: item.chapter.key };
    ports.app.trace('course.material.context', { mode: planned.report.mode, selectedCharacters: planned.report.selectedCharacters,
      sentCharacters: planned.report.sentCharacters, matchedPassages: planned.report.matchedPassages });
    if (!planned.materials.length) throw new Error('所选原文超过11万字，尚未定位到相关原文；请减少勾选、拆分资料或补充本题答案');
    ports.ui.noteCourseAction(`已准备所选原文${planned.report.selectedCharacters}字，本次发送${planned.report.sentCharacters}字，命中${planned.report.matchedPassages}段`);
    return planned.materials;
  }

  function collectMaterialTick(docs, item, catalog, run) {
      const pdf = pdfOnlyArticle(item, docs);
      if (pdf || ports.app.skippedPdfMaterial(item)) {
        if (pdf) recordPdfSkip(item, pdf);
        run.outcome = 'skipped'; ports.ui.courseStatus('图文仅含PDF附件，已跳过正文等待；附件内容未读取');
        if (ports.app.tour) ports.app.continueTour(catalog, run); else ports.app.nextModule(catalog, run);
        return true;
      }
      // 课程任务只读取视频页文字；只有独立的视频连播模式会走媒体播放流程。
      const collecting = ports.app.courseMode !== 'video' || !!ports.app.tour;
      if (item.type === 'video' && collecting) for (const video of docs.flatMap(doc => [...doc.querySelectorAll('video')])) if (!video.paused) video.pause();
      let record;
      const candidate = materialRecord(item, docs);
      if (item.type === 'video' && !settleVideoMaterial(candidate, docs, run)) return true;
      if (candidate && collecting) {
        const hash = Course.fingerprint(candidate);
        if (run.materialHash !== hash) { run.materialHash = hash; run.materialSince = Date.now(); }
        if (Date.now() - run.materialSince < 2000) { ports.ui.courseStatus('材料已出现，等待内容加载稳定'); return true; }
      }
      if (candidate) {
        const saved = ports.app.chapterCache.source(item.chapter, candidate); record = saved.record;
        if (saved.changed) ports.ui.noteCourseAction(item.type === 'video' ? `已记住知识导引与讲稿（${candidate.lecture?.segments || 0}段）` : '已记住当前图文');
      }
      if (!record && Date.now() - run.since > 20000) {
        record = ports.app.chapterCache.source(item.chapter, { id: item.id, title: item.title, kind: item.type === 'video' ? 'guidance' : 'article', text: '', quality: 'missing', assets: [] }).record;
      }
      if (!record) { ports.ui.courseStatus('等待图文、知识导引或视频讲稿加载'); return item.type !== 'video' || collecting; }
      ports.ui.courseStatus(`已记住本章材料：${item.title}${record.lecture?.status === 'timeout' ? '（讲稿未加载，已记录缺失）' : record.quality === 'partial' ? '（含未解析图片或附件）' : ''}`);
      run.outcome = record.quality === 'missing' ? 'missing' : 'processed';
      if (ports.app.tour) { ports.app.continueTour(catalog, run); return true; }
      if (item.type === 'article' || collecting) { ports.app.nextModule(catalog, run); return true; }
      return true;
    }

  function assignmentTick(docs, item, catalog, run, current = null) {
      const doc = current ? current.doc : questionDoc(docs), q = current ? current.q : doc && assignmentQuestion(doc, item);
      if (!q) { ports.ui.courseStatus('等待作业题目加载；如页面要求人机验证，请手动完成后等待继续'); return true; }
      if (ports.app.courseMode !== 'collect' && skipExcludedType(doc, item, q, run, catalog)) return true;
      const previous = ports.app.chapterCache.read(item.chapter);
      const scan = previous.scans?.[item.id];
      const cachedQuestion = previous.questions[`${item.id}:${q.number}`];
      if (ports.app.courseMode === 'collect' && scan?.count === q.count && cachedQuestion?.hash === q.hash) {
        ports.ui.courseStatus('已复用本地作业题型记录'); ports.app.nextModule(catalog, run); return true;
      }
      const key = `${collectQuestion(item, q)}:${q.hash}`;
      run.questionHash = q.hash;
      ports.ui.courseStatus(`作业第${q.number}/${q.count}题 · ${q.type}${q.type === 'blank' ? ` · ${q.blankCount}个空` : ''}`);
      if (ports.app.courseMode === 'collect') { nextQuestion(doc, item, q, run, catalog); return true; }
      const saved = ports.app.chapterCache.read(item.chapter), sent = saved.submissions[key];
      if (sent?.phase === 'wrong' && !sent.acknowledged) { pauseForWrong(item, q, key); return true; }
      if (sent?.phase === 'confirmed') { nextQuestion(doc, item, q, run, catalog); return true; }
      if (sent) { ports.ui.courseStatus('本题已有提交记录，等待网站结果；可点“下一题”，不重复提交'); return true; }
      if (skippedQuestion(saved, item, q.number, q.hash)) { nextQuestion(doc, item, q, run, catalog); return true; }
      if (q.inputs.some(input => input.disabled)) { ports.ui.courseStatus('题目输入框已锁定，等待网站结果；可在面板点“下一题”'); return true; }
      if (q.type === 'unsupported') { skipUnanswerable(run, '未适配题型'); return true; }
      ports.app.launchCourse(run, async () => {
        const version = selectedMaterialVersion(item.chapter);
        let draft = saved.drafts[key];
        const previousDraft = draft;
        const manual = referenceLibrary.read().answers[key];
        if (manual?.hash === q.hash) {
          Course.validateAnswer(q, manual);
          draft = { ...manual, manual: true, manualSavedAt: manual.at, hash: q.hash, materialVersion: version, formatVersion: 2 };
          if (previousDraft?.manualSavedAt !== manual.at) ports.app.chapterCache.update(item.chapter, data => { data.drafts[key] = draft; });
        } else if (!draft || draft.manual || draft.hash !== q.hash || draft.materialVersion !== version || draft.formatVersion !== 2 || draft.fuzzyPolicyEnabled !== fuzzyPolicy.enabled ||
          draft.strategy === 'fuzzy' && !draft.match?.textOnly || q.type === 'multiple' && draft.choiceVersion !== 2) {
          let question = Course.publicQuestion(q);
          if (q.hasImages && !fuzzyPolicy.enabled) throw skipQuestionError('图片题的题干匹配未开启，本题暂不作答');
          if (q.encrypted) {
            let transcript = ports.app.chapterCache.read(item.chapter).transcripts?.[key];
            if (!transcript || transcript.version !== 1) {
              const image = await renderQuestion(q, doc);
              if (!ports.app.runCurrent(run) || Course.question(doc)?.hash !== q.hash) return;
              for (let attempt = 0; attempt < 2; attempt++) {
                try {
                  const task = { kind: 'transcribe', chapterKey: item.chapter.key, question: { ...question,
                    transcriptionAttempt: attempt + 1,
                    transcriptionRule: `只转写文字，选项ID严格为${q.options.map(option => option.id).join('、') || '无'}；blankCount严格为${q.blankCount}，以网页输入框数量为准，选择题中的括号不计作填空。${attempt ? '上次返回结构不匹配，请逐项核对数量与ID，不得遗漏或增加选项。' : ''}` }, materials: [], image };
                  transcript = await ports.ai.localModel(task);
                  transcript = Course.parseModel(JSON.stringify(transcript), task);
                  if (transcript.structureCorrections?.length) ports.app.trace('course.transcription.corrected', { number: q.number, corrections: transcript.structureCorrections });
                  break;
                } catch (error) {
                  if (!ports.app.runCurrent(run) || Course.question(doc)?.hash !== q.hash) return;
                  ports.app.trace('course.transcription.invalid', { number: q.number, attempt: attempt + 1, code: error.code || error.message, details: error.details || null });
                  if (error.details) ports.ai.recordValidation({ kind: 'transcribe', number: q.number, details: error.details, at: Date.now() });
                  if (attempt || (error.code || error.message) !== 'MODEL_TRANSCRIPT_INVALID') throw error;
                  ports.ui.noteCourseAction(`第${q.number}题转写结构不匹配，正在按页面空数与选项重读一次`);
                }
              }
              if (!ports.app.runCurrent(run) || Course.question(doc)?.hash !== q.hash) return;
              // 同一套校验也保护旧版或自定义服务返回的转写。
              transcript = Course.parseModel(JSON.stringify(transcript), { kind: 'transcribe', question, materials: [] });
              ports.app.chapterCache.update(item.chapter, data => { data.transcripts ??= {}; data.transcripts[key] = { ...transcript, version: 1 }; });
              ports.ui.noteCourseAction(`已读取并缓存第${q.number}题明文`);
            }
            question = { ...question, prompt: transcript.questionText, matchPrompt: transcript.questionText, options: transcript.options, encrypted: false, readingMethod: 'cached-transcription' };
          }
          let result = fuzzyPolicy.enabled ? Course.matchMarkdownAnswer(selectedSources(item.chapter), question, item.chapter.title) : null;
          if (result) {
            fuzzyPolicy.lastMatch = { ...result.match, number: q.number, questionHash: q.hash, at: Date.now() }; saveFuzzyPolicy();
            ports.app.trace('course.fuzzy.matched', { number: q.number, score: result.match.score, sourceId: result.match.sourceId,
              textOnly: result.match.textOnly, queryCharacters: result.match.queryCharacters, sourceCharacters: result.match.sourceCharacters });
          } else {
            if (q.hasImages) throw skipQuestionError('图片题未找到90%以上且答案明确的文本匹配，暂不作答');
            const materials = await materialsFor(item, run, { ...question, hash: q.hash });
            if (!ports.app.runCurrent(run) || Course.question(doc)?.hash !== q.hash) return;
            for (let attempt = 0; attempt < 2; attempt++) {
              const task = { kind: 'answer', chapterKey: item.chapter.key, chapterTitle: item.chapter.title,
                question: { ...question, ...(attempt ? { reviewInstruction: '上次未完整核对多选题。请逐项检查所有选项，每项必须有optionChecks及材料依据；selections必须包含全部selected:true的id。' } : {}) }, materials };
              try {
                result = await ports.ai.localModel(task);
                if (q.type === 'multiple') result = Course.parseModel(JSON.stringify(result), task);
                break;
              } catch (error) {
                if (!ports.app.runCurrent(run) || Course.question(doc)?.hash !== q.hash) return;
                if (attempt || q.type !== 'multiple' || (error.code || error.message) !== 'MODEL_SELECTION_INCOMPLETE') {
                  if (error.message === 'MODEL_SELECTION_INCOMPLETE') { error.code = error.message; error.message = '多选题逐项核对仍不完整，已保留题目，未填写或提交'; }
                  throw error;
                }
                ports.ui.noteCourseAction(`第${q.number}题多选答案未完整核对，正在逐项复核全部选项`);
                ports.app.trace('course.multiple.review', { number: q.number, optionCount: q.options.length });
              }
            }
          }
          if (!ports.app.runCurrent(run)) return;
          Course.validateAnswer(q, result);
          draft = { ...result, strategy: result.strategy || 'model', fuzzyPolicyEnabled: fuzzyPolicy.enabled, hash: q.hash, materialVersion: version, formatVersion: 2, choiceVersion: 2 };
          ports.app.chapterCache.update(item.chapter, data => { data.drafts[key] = draft; });
          ports.ui.noteCourseAction(`已保存第${q.number}题答案草稿`);
        }
        if (!ports.app.runCurrent(run) || Course.question(doc)?.hash !== q.hash) return;
        Course.validateAnswer(q, draft);
        if (run.filled !== key) {
          let previousMatches = false; try { if (previousDraft) { verifyFilled(q, previousDraft); previousMatches = true; } } catch { /* 保留用户自行修改的内容 */ }
          run.filling = true; run.waitingReview = false;
          try { await fillQuestion(q, draft, !!draft.manual || previousMatches, () => ports.app.runCurrent(run)); }
          finally { run.filling = false; }
          if (!ports.app.runCurrent(run) || Course.question(doc)?.hash !== q.hash) return;
          verifyFilled(Course.question(doc), draft);
          run.filled = key; run.nextAt = Date.now() + 1200; ports.ui.noteCourseAction(`已填写第${q.number}题，页面校验通过`); return;
        }
        verifyFilled(q, draft);
        run.waitingReview = !ports.app.courseSubmitEnabled;
        if (!ports.app.courseSubmitEnabled) { ports.ui.courseStatus('答案已填写，自动提交暂停；请核验或在网站手动提交'); return; }
        const submit = [...q.root.querySelectorAll('.problem-fixedbar button')].find(el => /^(提交|提交答案|确认提交)$/.test(Course.text(el.textContent)) && ports.platform.available(el));
        if (!submit) {
          run.submitWaitAt ??= Date.now();
          if (Date.now() - run.submitWaitAt > 12000) throw new Error('填写已完成，但提交按钮仍不可用；请核验页面状态后重试');
          ports.ui.courseStatus('答案已填写，等待网站启用提交按钮'); run.nextAt = Date.now() + 500; return;
        }
        ports.app.chapterCache.update(item.chapter, data => { data.submissions[key] = { phase: 'sending', hash: q.hash, strategy: draft.strategy, match: draft.match, at: Date.now() }; });
        submit.click(); run.submitting = key;
        ports.ui.noteCourseAction(`第${q.number}题已提交，等待网站确认`);
        ports.app.trace('course.assignment.sent', { number: q.number, type: q.type });
      });
      return true;
    }

  const referenceLibrary = Course.createReferences(GM_getValue, GM_setValue, ports.app.memoryCourse);


  let courseInputHold = false;

  let courseImportBusy = false;



  function selectedSources(chapter) {
    const course = referenceLibrary.read().useCourse ? Object.values(ports.app.chapterCache.read(chapter).sources).filter(item => ['article', 'guidance'].includes(item.kind) && item.text?.trim() && item.quality !== 'missing') : [];
    return [...referenceLibrary.selected(chapter), ...course];
  }

  function selectedMaterialVersion(chapter) { return Course.fingerprint({ version: 4, priority: 'user-first', sources: selectedSources(chapter).map(item => [item.id, item.hash, !!item.userProvided]).sort((a, b) => a[0].localeCompare(b[0])) }); }

  function referenceContext() {
    const catalog = ports.platform.catalogSnapshot(ports.platform.documents()), item = catalog.items[catalog.index];
    const doc = item?.type === 'assignment' ? questionDoc(ports.platform.documents()) : null;
    const q = doc && assignmentQuestion(doc, item);
    return { item, doc, q, key: item && q ? `${item.id}:${q.number}:${q.hash}` : null };
  }

  function resetAfterReferenceChange() {
    ports.app.releaseCourse();
    ports.app.tour = null; GM_setValue(ports.app.tourKey, null);
    ports.ai.clearTaskStatus();
    courseMaterialContext = null;
    ports.ui.invalidateReferenceView(); ports.ui.invalidateProgress();
  }

  function saveManualAnswer() {
    try {
      const { q, key } = referenceContext(); if (!q || !key) throw Error('请先打开一道作业题');
      referenceLibrary.answer(key, q, ports.ui.shadow.getElementById('manual-answer').value);
      resetAfterReferenceChange(); ports.ui.feedback('本题答案已保存，将优先使用；是否提交由自动提交开关控制'); ports.ui.renderReferenceLibrary();
    } catch (error) { ports.ui.feedback(error.message, 'error'); }
  }

  function savePastedReference() {
    try {
      const { item } = referenceContext(), scope = ports.ui.shadow.getElementById('reference-scope').value || 'course';
      const result = referenceLibrary.add({ title: ports.ui.shadow.getElementById('reference-title').value || '粘贴的补充材料', text: ports.ui.shadow.getElementById('reference-text').value, scope, chapterKey: item?.chapter?.key, format: 'text' });
      resetAfterReferenceChange(); ports.ui.feedback(result.duplicate ? '相同材料已在库中，未重复添加' : '材料已保存并勾选，可在材料库中调整'); ports.ui.renderReferenceLibrary();
    } catch (error) { ports.ui.feedback(error.message, 'error'); }
  }

  async function importReferenceFiles(files) {
    if (courseImportBusy) return;
    const { item } = referenceContext(), scope = ports.ui.shadow.getElementById('reference-scope').value || 'course';
    if (scope === 'chapter' && !item?.chapter) { ports.ui.feedback('请先打开当前章节', 'error'); return; }
    if (files.length > 10) { ports.ui.feedback('一次最多导入10份文件', 'error'); return; }
    courseImportBusy = true; courseInputHold = true; resetAfterReferenceChange();
    const errors = []; let imported = 0;
    try {
      for (const file of files) {
        try {
          if (file.size > 15000000) throw Error('文件超过15MB');
          ports.ui.shadow.getElementById('reference-import-status').textContent = `正在本机解析：${file.name}`;
          const bytes = new Uint8Array(await file.arrayBuffer()); let result;
          if (/\.(md|markdown|txt)$/i.test(file.name)) {
            let text;
            if (bytes[0] === 255 && bytes[1] === 254) text = new TextDecoder('utf-16le').decode(bytes);
            else if (bytes[0] === 254 && bytes[1] === 255) text = new TextDecoder('utf-16be').decode(bytes);
            else { try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { text = new TextDecoder('gb18030').decode(bytes); } }
            result = { text, format: file.name.split('.').pop(), warnings: [] };
          } else {
            const pieces = [];
            for (let offset = 0; offset < bytes.length; offset += 12000) pieces.push(String.fromCharCode(...bytes.subarray(offset, offset + 12000)));
            result = await ports.ai.localModel({ filename: file.name, data: btoa(pieces.join('')) }, 'POST', 'extract');
          }
          const added = referenceLibrary.add({ title: file.name, text: result.text, format: result.format, scope, chapterKey: item?.chapter?.key });
          if (!added.duplicate) imported++;
          if (result.warnings?.length) errors.push(`${file.name}：${result.warnings.join('；')}`);
        } catch (error) { errors.push(`${file.name}：${error.message}`); }
      }
    } finally {
      courseImportBusy = false; courseInputHold = !!ports.ui.shadow.getElementById('reference-panel').open;
      resetAfterReferenceChange(); ports.ui.renderReferenceLibrary();
      ports.ui.shadow.getElementById('reference-files').value = '';
      ports.ui.shadow.getElementById('reference-import-status').textContent = `已导入${imported}份。${errors.join('；')}`;
    }
  }

  const materialJobKey = `course-material-job:${ports.app.memoryCourse}`;

  const materialBackupKey = `course-material-backup:${ports.app.memoryCourse}`;

  let courseMaterialJob = GM_getValue(materialJobKey, null);

  if (courseMaterialJob?.version !== 1 || !Array.isArray(courseMaterialJob.queue)) courseMaterialJob = null;

  function lectureSnapshot(doc) {
    const roots = [...doc.querySelectorAll('.draft-list')];
    const tab = [...doc.querySelectorAll('#js-tab-bar .ai-tabs-item')].find(el => Course.text(el.textContent) === '讲稿');
    const lines = roots.flatMap(root => [...root.querySelectorAll('.draft-content')].map(content => {
      const text = Course.text(content.textContent);
      const time = Course.text(content.closest?.('.draft-item')?.querySelector('.draft-time')?.textContent);
      return text ? { text, time: /^(?:\d+:)?\d{1,2}:\d{2}$/.test(time) ? time : '' } : null;
    }).filter(Boolean));
    const absent = roots.some(root => /暂无讲稿|暂无内容|尚无讲稿|没有讲稿|未生成讲稿/.test(Course.text(root.textContent)));
    return { roots, tab, text: lines.map(line => `${line.time ? `[${line.time}] ` : ''}${line.text}`).join('\n'),
      meta: { status: lines.length ? 'captured' : absent || !roots.length && !tab ? 'unavailable' : 'pending',
        segments: lines.length, characters: lines.reduce((n, line) => n + line.text.length, 0) } };
  }

  function settleVideoMaterial(record, docs, run) {
    if (!record || record.lecture?.status !== 'pending') return true;
    if (Date.now() - run.since < 20000) {
      const tab = docs.map(doc => lectureSnapshot(doc).tab).find(el => el && ports.platform.available(el));
      if (tab && !tab.classList.contains('active') && !run.lectureOpened) { tab.click(); run.lectureOpened = true; }
      ports.ui.courseStatus('等待视频讲稿加载；无需播放视频'); return false;
    }
    record.lecture.status = 'timeout';
    if (record.text.trim()) record.quality = 'partial';
    ports.app.trace('memory.lecture.timeout', { item: record.id });
    return true;
  }

  function pauseMaterialWork(message = '材料操作已结束，任务已暂停；核验后点“开始”继续') {
    ports.app.enabled = false; ports.app.releaseCourse(); ports.app.tour = null; GM_setValue(ports.app.tourKey, null);
    GM_setValue(`course-material-pause:${ports.app.memoryCourse}`, { message, at: Date.now() });
    for (const video of ports.platform.documents().flatMap(doc => [...doc.querySelectorAll('video')])) if (!video.paused) video.pause();
    ports.app.clearMediaVisibility();
    ports.ui.shadow.getElementById('toggle').textContent = '开始';
    ports.ai.clearTaskStatus();
    ports.ui.invalidateProgress(); ports.ui.invalidateReferenceView();
  }

  function beginMaterialImport(kind = 'lectures') {
    if (courseImportBusy) { ports.ui.feedback('文件正在解析，请完成后再采集课程材料', 'error'); return; }
    if (ports.platform.humanVerification(ports.platform.documents())) { ports.ui.feedback('请先手动完成人机验证', 'error'); return; }
    const catalog = ports.platform.catalogSnapshot(ports.platform.documents());
    const targets = catalog.items.filter(item => item.chapter && (kind === 'rebuild' ? ['video', 'article'].includes(item.type) : item.type === 'video' && !['captured', 'unavailable'].includes(ports.app.chapterCache.read(item.chapter).sources[item.id]?.lecture?.status)));
    if (!targets.length) { ports.ui.feedback(kind === 'rebuild' ? '当前目录没有可采集的图文或视频' : '视频讲稿已采集，无需重复读取'); return; }
    if (!ports.app.ownsCourse()) { ports.ui.feedback('另一标签页正在处理本课程，请先暂停该页再采集', 'error'); return; }
    ports.app.releaseCourse(); ports.app.tour = null; GM_setValue(ports.app.tourKey, null);
    courseMaterialJob = { version: 1, kind, queue: targets.map(item => item.id), total: targets.length, completed: 0, missing: 0, skipped: 0, returnTo: catalog.items[catalog.index]?.id || null, at: Date.now() };
    GM_setValue(materialJobKey, courseMaterialJob);
    ports.app.ownsCourse();
    ports.app.cancelWorkflow();
    ports.app.courseMode = 'auto'; GM_setValue('course-mode', ports.app.courseMode); ports.ui.shadow.getElementById('course-mode').value = ports.app.courseMode;
    ports.app.enabled = true; ports.ui.shadow.getElementById('toggle').textContent = '暂停';
    ports.ai.clearTaskStatus();
    ports.ui.showPanelView('task');
    ports.ui.courseStatus(`准备采集${targets.length}项${kind === 'lectures' ? '视频讲稿' : '课程材料'}，期间不作答或提交`);
  }

  function materialJobTick(docs) {
    if (courseInputHold) { ports.ui.courseStatus('材料编辑中，课程采集等待你返回任务页'); return true; }
    if (!ports.app.ownsCourse()) { ports.ui.courseStatus('另一标签页正在处理本课程，本页等待'); return true; }
    const job = courseMaterialJob, catalog = ports.platform.catalogSnapshot(docs);
    if (!job.queue.length) {
      const target = catalog.items.find(item => item.id === job.returnTo);
      const text = `已处理${job.completed}/${job.total}项${job.kind === 'lectures' ? '视频讲稿' : '课程材料'}${job.skipped ? `，其中${job.skipped}项仅PDF附件已跳过，未读取附件正文` : ''}${job.missing ? `，${job.missing}项缺失或未加载` : ''}，已暂停，核验后可点“开始”继续课程任务。`;
      pauseMaterialWork(text); GM_setValue(materialJobKey, null); courseMaterialJob = null;
      if (target && catalog.items[catalog.index]?.id !== target.id) ports.app.courseNavigate(target);
      ports.ui.courseStatus(text); ports.ui.feedback(text, job.missing ? 'error' : 'success'); return true;
    }
    const target = catalog.items.find(item => item.id === job.queue[0]);
    if (!target) { ports.ui.courseStatus('待采集项目暂未出现在目录，请展开章节后继续'); return true; }
    if (catalog.items[catalog.index]?.id !== target.id) {
      if (!ports.app.courseRun || ports.app.courseRun.destination !== target.id || ports.app.courseRun.route !== location.href) {
        ports.app.courseRun = { destination: target.id, route: location.href, since: Date.now(), type: target.type };
        if (!ports.app.courseNavigate(target)) { ports.app.courseRun = null; ports.ui.courseStatus('采集项目暂不可用，请展开目录或等待解锁'); }
      } else ports.ui.courseStatus('等待采集页面加载；未再次点击目录');
      return true;
    }
    if (!ports.app.courseRun || ports.app.courseRun.item !== target.id || ports.app.courseRun.route !== location.href) ports.app.courseRun = { item: target.id, type: target.type, route: location.href, since: Date.now() };
    const run = ports.app.courseRun;
    for (const video of docs.flatMap(doc => [...doc.querySelectorAll('video')])) if (!video.paused) video.pause();
    if (ports.platform.pauseBlocker(docs)) { ports.ui.courseStatus('页面有弹窗，材料采集等待处理'); return true; }
    const pdf = pdfOnlyArticle(target, docs);
    if (pdf) {
      recordPdfSkip(target, pdf);
      const next = { ...job, queue: job.queue.slice(1), completed: job.completed + 1, skipped: (job.skipped || 0) + 1 };
      GM_setValue(materialJobKey, next); courseMaterialJob = next; ports.app.courseRun = null;
      ports.ui.courseStatus(`材料采集 ${next.completed}/${next.total}，当前项仅PDF附件，已跳过`); return true;
    }
    if (Date.now() - run.since < 4000) { ports.ui.courseStatus(`采集${job.completed + 1}/${job.total}：等待正文与讲稿加载`); return true; }
    let record = materialRecord(target, docs);
    if (target.type === 'video' && !settleVideoMaterial(record, docs, run)) return true;
    if (!record && Date.now() - run.since < 20000) { ports.ui.courseStatus('等待课程材料加载'); return true; }
    if (!record) record = { id: target.id, title: target.title, kind: target.type === 'video' ? 'guidance' : 'article', text: '', quality: 'missing', assets: [], ...(target.type === 'video' ? { videoCaptureVersion: 1, lecture: { status: 'timeout', segments: 0, characters: 0 } } : {}) };
    const hash = Course.fingerprint(record);
    if (run.materialHash !== hash) { run.materialHash = hash; run.materialSince = Date.now(); }
    if (Date.now() - run.materialSince < 2000) { ports.ui.courseStatus('正文与讲稿已出现，等待内容稳定'); return true; }
    const old = ports.app.chapterCache.read(target.chapter).sources[target.id];
    // 页面临时失败时保留旧正文，避免重新采集反而丢失已读材料。
    if (record.quality !== 'missing' && !(record.lecture?.status === 'timeout' && old?.lecture?.status === 'captured')) ports.app.chapterCache.source(target.chapter, record);
    const incomplete = record.quality === 'missing' || record.lecture?.status === 'timeout';
    const next = { ...job, queue: job.queue.slice(1), completed: job.completed + 1, missing: job.missing + Number(incomplete) };
    GM_setValue(materialJobKey, next); courseMaterialJob = next; ports.app.courseRun = null;
    ports.ui.noteCourseAction(`已采集${next.completed}/${next.total}项，当前讲稿${record.lecture?.segments || 0}段`);
    ports.ui.courseStatus(`材料采集 ${next.completed}/${next.total}${incomplete ? '，当前项已记录缺失' : ''}`);
    return true;
  }

  function clearCourseMaterials() {
    if (courseImportBusy) { ports.ui.feedback('文件正在解析，请完成后再清理', 'error'); return; }
    if (!ports.app.ownsCourse()) { ports.ui.feedback('另一标签页正在处理本课程，请先暂停该页再清理', 'error'); return; }
    pauseMaterialWork('课程材料缓存已清除，任务已暂停；可重新采集、撤销清理或点“开始”继续'); courseMaterialJob = null; GM_setValue(materialJobKey, null);
    try {
      const chapters = ports.app.chapterCache.exportAll().chapters;
      if (!chapters.some(data => Object.keys(data.sources).length || Object.keys(data.summaries).length || Object.keys(data.drafts).length)) { ports.ui.feedback('课程材料缓存已经为空；主动导入的材料保持不变'); return; }
      GM_setValue(materialBackupKey, { version: 1, at: Date.now(), chapters: chapters.map(data => ({ chapter: data.chapter, sources: data.sources, summaries: data.summaries, drafts: data.drafts })) });
      for (const chapter of chapters) ports.app.chapterCache.update(chapter.chapter, data => { data.sources = {}; data.summaries = {}; data.drafts = {}; });
      if (ports.app.courseStage().phase === 'materials') ports.app.saveStage({ materialsDone: false, processed: { ...(ports.app.courseStage().processed || {}), materials: {} } });
      ports.ui.feedback('课程材料缓存已清除，任务已暂停。导入文件、勾选、人工答案和提交记录均保留；可重新采集或撤销清理');
    } catch { ports.ui.feedback('清理未全部完成，任务已暂停；可点击“撤销上次清理”恢复', 'error'); }
    ports.ui.invalidateProgress(); ports.ui.invalidateReferenceView(); ports.ui.renderMaterialControls();
  }

  function restoreCourseMaterials() {
    const backup = GM_getValue(materialBackupKey, null);
    if (!backup?.chapters) return;
    if (!ports.app.ownsCourse()) { ports.ui.feedback('另一标签页正在处理本课程，请先暂停该页再恢复', 'error'); return; }
    pauseMaterialWork('课程材料已恢复，任务保持暂停；核验后可点“开始”继续'); courseMaterialJob = null; GM_setValue(materialJobKey, null);
    try {
      for (const saved of backup.chapters) ports.app.chapterCache.update(saved.chapter, data => {
        for (const field of ['sources', 'summaries', 'drafts']) data[field] = { ...saved[field], ...data[field] };
      });
      GM_setValue(materialBackupKey, null); ports.ui.feedback('已恢复上次清理的课程材料；新采集内容和提交记录保留，核验后可继续任务');
    } catch { ports.ui.feedback('恢复未全部完成，任务保持暂停，请检查油猴存储后重试', 'error'); }
    ports.ui.invalidateProgress(); ports.ui.invalidateReferenceView(); ports.ui.renderMaterialControls();
  }

  const fuzzyPolicyKey = `course-fuzzy-policy:${ports.app.memoryCourse}`;

  let fuzzyPolicy = { enabled: false, wrongStreak: 0, epoch: 0, reason: '', lastMatch: null, ...GM_getValue(fuzzyPolicyKey, {}) };

  function assignmentQuestion(doc, item) {
    const live = Course.question(doc); if (live) return live;
    const active = doc.querySelector('.J_order.active'), number = Number(active?.getAttribute('data-order'));
    const record = number && ports.app.chapterCache.read(item.chapter).questions[`${item.id}:${number}`];
    const root = doc.querySelector('.container-problem');
    if (!record || !root || orderOutcome(active) === 'none') return null;
    return { ...record, root, inputs: [], options: [], body: root };
  }

  function saveFuzzyPolicy() { GM_setValue(fuzzyPolicyKey, fuzzyPolicy); }

  function toggleFuzzyPolicy() {
    const enabled = !!ports.ui.shadow.getElementById('fuzzy-match').checked;
    fuzzyPolicy = { ...fuzzyPolicy, enabled, wrongStreak: 0, epoch: fuzzyPolicy.epoch + 1, reason: enabled ? '' : '用户关闭' };
    saveFuzzyPolicy(); resetAfterReferenceChange(); ports.ui.renderAssignmentControls();
    ports.ui.feedback(enabled ? '已开启90%题干匹配：仅从已勾选资料的明确答案条目填充；连续两次判错会自动关闭' : '题干模糊匹配已关闭');
  }

  function fuzzyResult(item, key, outcome) {
    const data = ports.app.chapterCache.read(item.chapter);
    let submission = data.submissions[key];
    if (!submission && data.drafts[key]?.strategy === 'fuzzy') {
      try { const doc = questionDoc(ports.platform.documents()), q = doc && Course.question(doc); if (!q) return; verifyFilled(q, data.drafts[key]); submission = data.drafts[key]; } catch { return; }
    }
    if (submission?.strategy !== 'fuzzy' || submission.fuzzyGraded || !['wrong', 'correct'].includes(outcome)) return;
    fuzzyPolicy.wrongStreak = outcome === 'wrong' ? fuzzyPolicy.wrongStreak + 1 : 0;
    if (fuzzyPolicy.wrongStreak >= 2) { fuzzyPolicy.enabled = false; fuzzyPolicy.reason = '连续两次模糊匹配答案被判错，已自动关闭'; }
    saveFuzzyPolicy();
    ports.app.chapterCache.update(item.chapter, data => { data.submissions[key] = { ...submission, ...data.submissions[key], fuzzyGraded: outcome }; });
    ports.app.trace('course.fuzzy.graded', { outcome, wrongStreak: fuzzyPolicy.wrongStreak, enabled: fuzzyPolicy.enabled });
  }

  function reconcileAssignmentResults(doc, item) {
    if (!doc) return;
    const data = ports.app.chapterCache.read(item.chapter), updates = [];
    for (const order of doc.querySelectorAll('.J_order')) {
      const number = Number(order.getAttribute('data-order')), question = data.questions[`${item.id}:${number}`];
      if (!question) continue;
      if (question.type in questionTypeNames && !questionTypes.includes(question.type)) continue;
      const key = `${item.id}:${number}:${question.hash}`, sent = data.submissions[key];
      if (!sent) continue;
      const outcome = orderOutcome(order);
      if (sent.outcome === outcome && (sent.strategy !== 'fuzzy' || sent.fuzzyGraded)) continue;
      if (['correct', 'wrong'].includes(outcome)) updates.push({ key, sent, outcome, number });
    }
    updates.sort((a, b) => (a.sent.at || 0) - (b.sent.at || 0) || a.number - b.number);
    for (const update of updates) {
      fuzzyResult(item, update.key, update.outcome);
      ports.app.chapterCache.update(item.chapter, saved => { saved.submissions[update.key] = { ...saved.submissions[update.key], phase: update.outcome === 'wrong' ? 'wrong' : 'confirmed', outcome: update.outcome }; });
      if (update.outcome === 'wrong' && ports.app.courseSubmitEnabled) {
        ports.app.courseSubmitEnabled = false; GM_setValue(`course-auto-submit:${ports.app.memoryCourse}`, false);
        ports.ui.feedback(`网站返回第${update.number}题错误反馈，自动提交已暂停${!fuzzyPolicy.enabled && fuzzyPolicy.wrongStreak >= 2 ? '；模糊匹配也已自动关闭' : ''}`, 'error');
      }
    }
  }

  function currentSkipVersion(item) { return `text-only-2:${selectedMaterialVersion(item.chapter)}:${fuzzyPolicy.enabled}:${fuzzyPolicy.epoch}:${Course.fingerprint([...questionTypes].sort())}`; }

  function recordQuestionSkip(item, q, reason) {
    const id = `${item.id}:${q.number}`;
    collectQuestion(item, q);
    ports.app.chapterCache.update(item.chapter, data => { data.skips ??= {}; data.skips[id] = { hash: q.hash, version: currentSkipVersion(item), reason, at: Date.now() }; });
    ports.app.trace('course.question.skipped', { number: q.number, reason });
  }

  function skippedQuestion(saved, item, number, hash) {
    const skip = saved.skips?.[`${item.id}:${number}`];
    return skip && skip.hash === hash && skip.version === currentSkipVersion(item);
  }

  function skipUnanswerable(run, reason) {
    const catalog = ports.platform.catalogSnapshot(ports.platform.documents()), item = catalog.items[catalog.index], doc = questionDoc(ports.platform.documents()), q = doc && item?.chapter && assignmentQuestion(doc, item);
    if (!item || item.type !== 'assignment' || !q || ports.app.courseRun !== run || run.route !== location.href || run.questionHash && q.hash !== run.questionHash) return false;
    recordQuestionSkip(item, q, reason); run.error = null;
    ports.ai.clearTaskStatus();
    ports.ui.courseStatus(`第${q.number}题暂不作答，已记录并跳过：${reason}`);
    nextQuestion(doc, item, q, run, catalog); return true;
  }

  function assignmentErrorIsSkippable(error) {
    return ['QUESTION_SKIP', 'MODEL_IMAGE_UNREADABLE', 'MODEL_MATERIAL_INSUFFICIENT', 'MODEL_ANSWER_UNCERTAIN', 'MODEL_TRANSCRIPT_INVALID', 'MODEL_INSUFFICIENT'].includes(error.code) ||
      /无法可靠识别|题目图片|独立图片|题目过长|空位数量不完整|未适配题型|没有可用正文|尚未定位到相关原文|所选资料不足|不能确定答案|材料不足|无法读清题目|转写不完整/.test(error.message);
  }

  function skipQuestionError(message) { const error = new Error(message); error.code = 'QUESTION_SKIP'; return error; }

  function nextQuestionFromPanel() {
    if (ports.platform.humanVerification(ports.platform.documents())) { ports.ui.feedback('请先手动完成人机验证', 'error'); return; }
    const catalog = ports.platform.catalogSnapshot(ports.platform.documents()), item = catalog.items[catalog.index], doc = questionDoc(ports.platform.documents()), q = doc && item?.chapter && assignmentQuestion(doc, item);
    if (!q || item?.type !== 'assignment') { ports.ui.feedback('请先打开一道已加载的作业题', 'error'); return; }
    if (!ports.app.ownsCourse()) { ports.ui.feedback('另一标签页正在处理本课程，请先暂停该页', 'error'); return; }
    acknowledgeWrongPause();
    const outcome = observedOutcome(q, doc);
    if (outcome === 'none') recordQuestionSkip(item, q, '用户在面板主动切题');
    ports.ai.cancelTask();
    const run = { route: location.href, item: item.id, type: 'assignment', since: Date.now(), pending: false, nextAt: 0 };
    ports.app.courseRun = run; ports.ai.clearTaskStatus();
    nextQuestion(doc, item, q, run, catalog, true);
    ports.ui.feedback('已切换下一题；自动提交保持当前开关状态');
  }

  function retryCurrentAssignment() {
    const { item, q } = referenceContext(); if (item?.type !== 'assignment') return;
    if (q) ports.app.chapterCache.update(item.chapter, data => { if (data.skips) delete data.skips[`${item.id}:${q.number}`]; });
    const stage = ports.app.courseStage(), processed = { ...(stage.processed || {}), assignments: { ...(stage.processed?.assignments || {}) } };
    delete processed.assignments[item.id]; ports.app.saveStage({ assignmentsDone: false, processed });
  }

  function assignmentProgress(doc, item) {
    if (!doc || item?.type !== 'assignment') return null;
    const orders = [...doc.querySelectorAll('.J_order')], data = ports.app.chapterCache.read(item.chapter);
    const view = { total: orders.length, answered: 0, correct: 0, wrong: 0, awaitingGrade: 0, pending: 0, skipped: 0, untouched: 0 };
    for (const order of orders) {
      const number = Number(order.getAttribute('data-order')), record = data.questions[`${item.id}:${number}`];
      const sent = record && data.submissions[`${item.id}:${number}:${record.hash}`];
      const observed = orderOutcome(order);
      const outcome = observed !== 'none' ? observed : sent?.outcome || (sent?.phase === 'confirmed' ? 'answered' : 'none');
      if (['correct', 'wrong', 'answered'].includes(outcome)) { view.answered++; if (outcome === 'correct') view.correct++; else if (outcome === 'wrong') view.wrong++; else view.awaitingGrade++; }
      else if (sent?.phase === 'sending') view.pending++;
      else if (record && skippedQuestion(data, item, number, record.hash)) view.skipped++;
      else view.untouched++;
    }
    return view;
  }

  function recentAssignmentSkips(item) {
    if (item?.type !== 'assignment') return [];
    const data = ports.app.chapterCache.read(item.chapter);
    return Object.entries(data.skips || {}).filter(([id, skip]) => id.startsWith(`${item.id}:`) && skip.version === currentSkipVersion(item))
      .map(([id, skip]) => ({ number: Number(id.slice(item.id.length + 1)), reason: skip.reason, at: skip.at }))
      .sort((a, b) => b.at - a.at).slice(0, 3).reverse();
  }

  function setReferenceEditing(open, force = false) {
    const next = courseImportBusy || open;
    if (force || next !== courseInputHold) { courseInputHold = next; resetAfterReferenceChange(); }
  }

  function removeManualAnswer() {
    const { key } = referenceContext(); if (key) referenceLibrary.forgetAnswer(key);
    resetAfterReferenceChange(); ports.ui.renderReferenceLibrary(); ports.ui.feedback('已删除本题补充答案');
  }

  function removeReference(id) {
    referenceLibrary.remove(id); resetAfterReferenceChange(); ports.ui.renderReferenceLibrary(); ports.ui.feedback('材料已移除，可撤销');
  }

  function restoreReference() {
    referenceLibrary.restore(); resetAfterReferenceChange(); ports.ui.renderReferenceLibrary(); ports.ui.feedback('已恢复上次移除的材料');
  }

  function setReferenceEnabled(id, enabled) {
    referenceLibrary.setEnabled(id, enabled); resetAfterReferenceChange(); ports.ui.renderReferenceLibrary();
  }

  function cancelMaterialJob() { courseMaterialJob = null; GM_setValue(materialJobKey, null); }

  function adoptReviewedAnswer(q, key, item) {
    const answer = readFilledAnswer(q); Course.validateAnswer(q, answer);
    const draft = ports.app.chapterCache.read(item.chapter).drafts[key];
    let unchanged = false; try { if (draft) { verifyFilled(q, draft); unchanged = true; } } catch { /* 用户改动作为人工答案保存 */ }
    if (!unchanged) referenceLibrary.answer(key, q, q.type === 'blank' ? answer.blanks.join('\n') : q.type === 'essay' ? answer.text : answer.selections.join(' '));
  }

  const api = {
    get assignmentCompleted() { return assignmentCompleted; },
    get selectedQuestionTypes() { return selectedQuestionTypes; },
    get setQuestionTypes() { return setQuestionTypes; },
    get skipExcludedType() { return skipExcludedType; },
    get captureVideoMaterial() { return captureVideoMaterial; },
    get adoptReviewedAnswer() { return adoptReviewedAnswer; },
    get cancelMaterialJob() { return cancelMaterialJob; },
    get setReferenceEnabled() { return setReferenceEnabled; },
    get restoreReference() { return restoreReference; },
    get removeReference() { return removeReference; },
    get removeManualAnswer() { return removeManualAnswer; },
    get setReferenceEditing() { return setReferenceEditing; },
    get acknowledgeWrongPause() { return acknowledgeWrongPause; },
    get assignmentErrorIsSkippable() { return assignmentErrorIsSkippable; },
    get assignmentProgress() { return assignmentProgress; },
    get assignmentQuestion() { return assignmentQuestion; },
    get assignmentTick() { return assignmentTick; },
    get beginMaterialImport() { return beginMaterialImport; },
    get choiceReport() { return choiceReport; },
    get clearCourseMaterials() { return clearCourseMaterials; },
    get collectMaterialTick() { return collectMaterialTick; },
    get courseImportBusy() { return courseImportBusy; }, set courseImportBusy(value) { courseImportBusy = value; },
    get courseInputHold() { return courseInputHold; }, set courseInputHold(value) { courseInputHold = value; },
    get courseMaterialContext() { return courseMaterialContext; }, set courseMaterialContext(value) { courseMaterialContext = value; },
    get courseMaterialJob() { return courseMaterialJob; }, set courseMaterialJob(value) { courseMaterialJob = value; },
    get fuzzyPolicy() { return fuzzyPolicy; }, set fuzzyPolicy(value) { fuzzyPolicy = value; },
    get importReferenceFiles() { return importReferenceFiles; },
    get inspectQuestionImage() { return inspectQuestionImage; },
    get lastQuestionRender() { return lastQuestionRender; }, set lastQuestionRender(value) { lastQuestionRender = value; },
    get materialBackupKey() { return materialBackupKey; },
    get materialJobTick() { return materialJobTick; },
    get nextQuestionFromPanel() { return nextQuestionFromPanel; },
    get observedOutcome() { return observedOutcome; },
    get processObservedResult() { return processObservedResult; },
    get questionDoc() { return questionDoc; },
    get recentAssignmentSkips() { return recentAssignmentSkips; },
    get reconcileAssignmentResults() { return reconcileAssignmentResults; },
    get referenceContext() { return referenceContext; },
    get referenceLibrary() { return referenceLibrary; },
    get rememberMaterial() { return rememberMaterial; },
    get resetAfterReferenceChange() { return resetAfterReferenceChange; },
    get restoreCourseMaterials() { return restoreCourseMaterials; },
    get retryCurrentAssignment() { return retryCurrentAssignment; },
    get saveManualAnswer() { return saveManualAnswer; },
    get savePastedReference() { return savePastedReference; },
    get skipUnanswerable() { return skipUnanswerable; },
    get toggleFuzzyPolicy() { return toggleFuzzyPolicy; }
  };
  if (options.testing) api.testing = {
    get assignmentCompleted() { return assignmentCompleted; },
    get selectedQuestionTypes() { return selectedQuestionTypes; },
    get setQuestionTypes() { return setQuestionTypes; },
    get captureVideoMaterial() { return captureVideoMaterial; },
    get lastQuestionRender() { return lastQuestionRender; }, set lastQuestionRender(value) { lastQuestionRender = value; },
    get courseMaterialContext() { return courseMaterialContext; }, set courseMaterialContext(value) { courseMaterialContext = value; },
    get referenceLibrary() { return referenceLibrary; },
    get courseInputHold() { return courseInputHold; }, set courseInputHold(value) { courseInputHold = value; },
    get courseImportBusy() { return courseImportBusy; }, set courseImportBusy(value) { courseImportBusy = value; },
    get materialJobKey() { return materialJobKey; },
    get materialBackupKey() { return materialBackupKey; },
    get courseMaterialJob() { return courseMaterialJob; }, set courseMaterialJob(value) { courseMaterialJob = value; },
    get fuzzyPolicyKey() { return fuzzyPolicyKey; },
    get fuzzyPolicy() { return fuzzyPolicy; }, set fuzzyPolicy(value) { fuzzyPolicy = value; },
    get pdfOnlyArticle() { return pdfOnlyArticle; }, set pdfOnlyArticle(value) { pdfOnlyArticle = value; },
    get recordPdfSkip() { return recordPdfSkip; }, set recordPdfSkip(value) { recordPdfSkip = value; },
    get materialRecord() { return materialRecord; }, set materialRecord(value) { materialRecord = value; },
    get rememberMaterial() { return rememberMaterial; }, set rememberMaterial(value) { rememberMaterial = value; },
    get questionDoc() { return questionDoc; }, set questionDoc(value) { questionDoc = value; },
    get collectQuestion() { return collectQuestion; }, set collectQuestion(value) { collectQuestion = value; },
    get nextQuestion() { return nextQuestion; }, set nextQuestion(value) { nextQuestion = value; },
    get resultFromNodes() { return resultFromNodes; }, set resultFromNodes(value) { resultFromNodes = value; },
    get orderOutcome() { return orderOutcome; }, set orderOutcome(value) { orderOutcome = value; },
    get resultPanelNodes() { return resultPanelNodes; }, set resultPanelNodes(value) { resultPanelNodes = value; },
    get resultPanelSignature() { return resultPanelSignature; }, set resultPanelSignature(value) { resultPanelSignature = value; },
    get observedOutcome() { return observedOutcome; }, set observedOutcome(value) { observedOutcome = value; },
    get pauseForWrong() { return pauseForWrong; }, set pauseForWrong(value) { pauseForWrong = value; },
    get acknowledgeWrongPause() { return acknowledgeWrongPause; }, set acknowledgeWrongPause(value) { acknowledgeWrongPause = value; },
    get processObservedResult() { return processObservedResult; }, set processObservedResult(value) { processObservedResult = value; },
    get readFilledAnswer() { return readFilledAnswer; }, set readFilledAnswer(value) { readFilledAnswer = value; },
    get choiceState() { return choiceState; }, set choiceState(value) { choiceState = value; },
    get choiceReport() { return choiceReport; }, set choiceReport(value) { choiceReport = value; },
    get fillQuestion() { return fillQuestion; }, set fillQuestion(value) { fillQuestion = value; },
    get verifyFilled() { return verifyFilled; }, set verifyFilled(value) { verifyFilled = value; },
    get renderQuestion() { return renderQuestion; }, set renderQuestion(value) { renderQuestion = value; },
    get inspectQuestionImage() { return inspectQuestionImage; }, set inspectQuestionImage(value) { inspectQuestionImage = value; },
    get materialsFor() { return materialsFor; }, set materialsFor(value) { materialsFor = value; },
    get selectedSources() { return selectedSources; }, set selectedSources(value) { selectedSources = value; },
    get selectedMaterialVersion() { return selectedMaterialVersion; }, set selectedMaterialVersion(value) { selectedMaterialVersion = value; },
    get referenceContext() { return referenceContext; }, set referenceContext(value) { referenceContext = value; },
    get resetAfterReferenceChange() { return resetAfterReferenceChange; }, set resetAfterReferenceChange(value) { resetAfterReferenceChange = value; },
    get saveManualAnswer() { return saveManualAnswer; }, set saveManualAnswer(value) { saveManualAnswer = value; },
    get savePastedReference() { return savePastedReference; }, set savePastedReference(value) { savePastedReference = value; },
    get importReferenceFiles() { return importReferenceFiles; }, set importReferenceFiles(value) { importReferenceFiles = value; },
    get lectureSnapshot() { return lectureSnapshot; }, set lectureSnapshot(value) { lectureSnapshot = value; },
    get settleVideoMaterial() { return settleVideoMaterial; }, set settleVideoMaterial(value) { settleVideoMaterial = value; },
    get pauseMaterialWork() { return pauseMaterialWork; }, set pauseMaterialWork(value) { pauseMaterialWork = value; },
    get beginMaterialImport() { return beginMaterialImport; }, set beginMaterialImport(value) { beginMaterialImport = value; },
    get materialJobTick() { return materialJobTick; }, set materialJobTick(value) { materialJobTick = value; },
    get clearCourseMaterials() { return clearCourseMaterials; }, set clearCourseMaterials(value) { clearCourseMaterials = value; },
    get restoreCourseMaterials() { return restoreCourseMaterials; }, set restoreCourseMaterials(value) { restoreCourseMaterials = value; },
    get assignmentQuestion() { return assignmentQuestion; }, set assignmentQuestion(value) { assignmentQuestion = value; },
    get saveFuzzyPolicy() { return saveFuzzyPolicy; }, set saveFuzzyPolicy(value) { saveFuzzyPolicy = value; },
    get toggleFuzzyPolicy() { return toggleFuzzyPolicy; }, set toggleFuzzyPolicy(value) { toggleFuzzyPolicy = value; },
    get fuzzyResult() { return fuzzyResult; }, set fuzzyResult(value) { fuzzyResult = value; },
    get reconcileAssignmentResults() { return reconcileAssignmentResults; }, set reconcileAssignmentResults(value) { reconcileAssignmentResults = value; },
    get currentSkipVersion() { return currentSkipVersion; }, set currentSkipVersion(value) { currentSkipVersion = value; },
    get recordQuestionSkip() { return recordQuestionSkip; }, set recordQuestionSkip(value) { recordQuestionSkip = value; },
    get skippedQuestion() { return skippedQuestion; }, set skippedQuestion(value) { skippedQuestion = value; },
    get skipUnanswerable() { return skipUnanswerable; }, set skipUnanswerable(value) { skipUnanswerable = value; },
    get assignmentErrorIsSkippable() { return assignmentErrorIsSkippable; }, set assignmentErrorIsSkippable(value) { assignmentErrorIsSkippable = value; },
    get skipQuestionError() { return skipQuestionError; }, set skipQuestionError(value) { skipQuestionError = value; },
    get nextQuestionFromPanel() { return nextQuestionFromPanel; }, set nextQuestionFromPanel(value) { nextQuestionFromPanel = value; },
    get retryCurrentAssignment() { return retryCurrentAssignment; }, set retryCurrentAssignment(value) { retryCurrentAssignment = value; },
    get assignmentProgress() { return assignmentProgress; }, set assignmentProgress(value) { assignmentProgress = value; },
    get recentAssignmentSkips() { return recentAssignmentSkips; }, set recentAssignmentSkips(value) { recentAssignmentSkips = value; },
    get assignmentTick() { return assignmentTick; }, set assignmentTick(value) { assignmentTick = value; },
    get collectMaterialTick() { return collectMaterialTick; }, set collectMaterialTick(value) { collectMaterialTick = value; }
  };
  return api;
}
module.exports = createAssignmentAutomation;
