'use strict';

// 面板对象：视图、展示缓存与事件转发；业务操作由对应功能对象处理。
function createUI(ports, options = {}) {
  const Course = ports.core;
  let message = '等待页面出现视频';

  let feedbackUntil = 0;

  const recentMessages = [];

  const { host, shadow } = options.panel || ports.mountPanel();

  const statusNode = shadow.getElementById('status');

  const toggleNode = shadow.getElementById('toggle');

  toggleNode.textContent = ports.app.enabled ? '暂停' : '开始';

  const speedNode = shadow.getElementById('speed');

  function showPanelView(view) {
    if (!['task', 'materials', 'settings', 'diagnostics'].includes(view)) return;
    if (view !== 'materials' && shadow.getElementById('reference-panel').open) {
      shadow.getElementById('reference-panel').open = false;
      ports.assignment.setReferenceEditing(false, true);
    }
    if (view === 'materials') {
      shadow.getElementById('reference-panel').open = true;
      ports.assignment.setReferenceEditing(true);
      renderReferenceLibrary();
    }
    for (const key of ['task', 'materials', 'settings', 'diagnostics']) {
      const selected = key === view, button = shadow.getElementById(`tab-${key}`);
      button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1;
      shadow.getElementById(`view-${key}`).hidden = !selected;
    }
    shadow.querySelector?.('section')?.scrollTo?.({ top: 0 });
  }

  const panelPositionKey = `panel-position:${location.origin}`;

  let panelPosition = GM_getValue(panelPositionKey, null);

  let panelDrag = null;

  function positionPanel(x, y, save = false) {
    if (!host.style || typeof host.getBoundingClientRect !== 'function') return;
    const rect = host.getBoundingClientRect(), win = document.defaultView;
    const width = win.innerWidth || document.documentElement.clientWidth || 1280, height = win.innerHeight || document.documentElement.clientHeight || 800;
    panelPosition = { x: Math.max(8, Math.min(Number.isFinite(x) ? x : 16, Math.max(8, width - rect.width - 8))),
      y: Math.max(8, Math.min(Number.isFinite(y) ? y : 16, Math.max(8, height - rect.height - 8))) };
    for (const [key, value] of Object.entries({ left: `${panelPosition.x}px`, top: `${panelPosition.y}px`, right: 'auto', bottom: 'auto' })) host.style.setProperty(key, value);
    if (save) try { GM_setValue(panelPositionKey, panelPosition); } catch { feedback('面板已移动，但位置未能保存', 'error'); }
  }

  function resetPanelPosition() {
    panelPosition = null;
    for (const key of ['left', 'top', 'right', 'bottom']) host.style?.removeProperty(key);
    GM_setValue(panelPositionKey, null); feedback('面板已回到右下角；可拖动标题栏重新放置');
  }

  function keepPanelVisible() { if (panelPosition) positionPanel(panelPosition.x, panelPosition.y); }

  const panelDragHandle = shadow.getElementById('panel-drag');

  const finishPanelDrag = event => {
    if (!panelDrag || event.pointerId !== panelDrag.id) return;
    if (panelDrag.moved && panelPosition) positionPanel(panelPosition.x, panelPosition.y, true);
    try { panelDragHandle.releasePointerCapture?.(event.pointerId); } catch { /* 捕获可能已由浏览器释放 */ }
    panelDrag = null; panelDragHandle.setAttribute('data-dragging', 'false');
  };

  function connectDrag() {
  panelDragHandle.addEventListener('pointerdown', event => {
    if (event.button !== 0 || event.target.closest?.('button') || typeof host.getBoundingClientRect !== 'function') return;
    const rect = host.getBoundingClientRect(); panelDrag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top, moved: false };
    try { panelDragHandle.setPointerCapture?.(event.pointerId); } catch { /* 普通鼠标事件仍可继续 */ }
    panelDragHandle.setAttribute('data-dragging', 'true'); event.preventDefault();
  });

  panelDragHandle.addEventListener('pointermove', event => {
    if (!panelDrag || event.pointerId !== panelDrag.id) return;
    if (Math.hypot(event.clientX - panelDrag.x, event.clientY - panelDrag.y) > 3) panelDrag.moved = true;
    if (panelDrag.moved) positionPanel(panelDrag.left + event.clientX - panelDrag.x, panelDrag.top + event.clientY - panelDrag.y);
  });



  panelDragHandle.addEventListener('pointerup', finishPanelDrag);

  panelDragHandle.addEventListener('pointercancel', finishPanelDrag);

  panelDragHandle.addEventListener('dblclick', event => { if (!event.target.closest?.('button')) resetPanelPosition(); });

  panelDragHandle.addEventListener('keydown', event => {
    if (event.target !== panelDragHandle) return;
    if (event.key === 'Home') { event.preventDefault(); resetPanelPosition(); return; }
    const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key];
    if (!delta || typeof host.getBoundingClientRect !== 'function') return;
    const rect = host.getBoundingClientRect(); event.preventDefault(); positionPanel(rect.left + delta[0], rect.top + delta[1], true);
  });

  document.defaultView.addEventListener?.('resize', keepPanelVisible);

  keepPanelVisible();

  }

  function feedback(text, kind = 'success') {
    const node = shadow.getElementById('feedback');
    node.textContent = text;
    node.setAttribute('data-kind', kind);
    node.hidden = false;
    feedbackUntil = Date.now() + 8000;
    ports.app.trace('feedback', { text, kind });
  }

  function memorySummary() {
    const labels = [];
    if (ports.video.controls.rateMenu || ports.video.controls.rate2) labels.push('倍速');
    if (ports.video.controls.mute) labels.push('静音');
    if (ports.video.controls.completion) labels.push('完成度');
    if (ports.platform.savedSelector) labels.push('下一节');
    shadow.getElementById('memory').textContent = labels.length
      ? `已记住：${labels.join('、')}。刷新或换视频后自动复用。`
      : '控件设置自动保存，刷新或换视频后复用。';
    shadow.getElementById('mark-rate').textContent = ports.video.controls.rateMenu || ports.video.controls.rate2 ? '重新设置倍速' : '设置倍速控件';
    shadow.getElementById('mark-mute').textContent = ports.video.controls.mute ? '重新设置静音' : '设置静音控件';
    shadow.getElementById('pick').textContent = ports.platform.savedSelector ? '重新设置下一节' : '设置下一节按钮';
  }

  function verifySettings() {
    if (feedbackUntil && Date.now() >= feedbackUntil) {
      shadow.getElementById('feedback').hidden = true;
      feedbackUntil = 0;
    }
    const result = shadow.getElementById('setup-result');
    if (!ports.video.state?.initialized) { result.textContent = '等待验证播放设置'; return; }
    const s = ports.video.state, v = s.video;
    if (!ports.app.enabled || ports.app.selecting) return;
    const applied = v.playbackRate === ports.video.speed && (v.muted || v.volume === 0);
    if (!applied) {
      if (s.settingsConfirmed) feedback('播放设置发生变化，正在重新应用', 'error');
      s.settingsConfirmed = false;
      s.settingsReadyAt = null;
      result.textContent = '设置尚未生效 · 正在尝试应用';
      return;
    }
    if (s.settingsReadyAt == null) s.settingsReadyAt = Date.now();
    if (Date.now() - s.settingsReadyAt < 1000) { result.textContent = '正在确认倍速和静音'; return; }
    result.textContent = `设置成功 · ${ports.video.speed}倍速 · 静音`;
    if (!s.settingsConfirmed) {
      s.settingsConfirmed = true;
      ports.app.trace('settings.confirmed', { media: ports.video.mediaState(v) });
      feedback(`设置成功：${ports.video.speed}倍速、静音已生效`);
    }
  }

  function status(text) {
    if (message !== text) {
      recentMessages.push({ at: Date.now(), text });
      if (recentMessages.length > 20) recentMessages.shift();
      ports.app.trace('status', { text });
    }
    message = text;
    const displayText = /^播放中 · 实际/.test(text) ? '将按目录顺序连播下一个视频' : text;
    if (statusNode.textContent !== displayText) statusNode.textContent = displayText;
  }

  let courseLastMessage = '';

  let courseLastAction = null;

  let courseStatsAt = -Infinity;

  let courseCachedStats = null;
  let referenceViewKey = '', referenceEditorKey = null;

  function noteCourseAction(text) {
    courseLastAction = { text, at: Date.now() };
    courseStatsAt = -Infinity;
  }

  function courseProgressSnapshot(options = {}) {
    const catalog = ports.platform.catalogSnapshot(ports.platform.documents()), item = catalog.items[catalog.index], stage = ports.app.courseStage();
    const eligible = catalog.items.filter(entry => ports.app.inStage(entry, stage));
    const processed = stage.processed?.[stage.phase] || {};
    const done = eligible.filter(entry => processed[entry.id]);
    if (!courseCachedStats || Date.now() - courseStatsAt >= 3000) {
      const memory = ports.app.chapterCache.exportAll();
      courseCachedStats = { materials: 0, lectures: 0, lectureSegments: 0, questions: 0, drafts: 0, confirmed: 0, sending: 0 };
      for (const chapter of memory.chapters) {
        courseCachedStats.materials += Object.keys(chapter.sources).length;
        for (const source of Object.values(chapter.sources)) if (source.lecture?.status === 'captured') { courseCachedStats.lectures++; courseCachedStats.lectureSegments += source.lecture.segments || 0; }
        courseCachedStats.questions += Object.keys(chapter.questions).filter(key => ports.app.courseMode === 'discussion' ? key.endsWith(':discussion') : !key.endsWith(':discussion')).length;
        courseCachedStats.drafts += Object.keys(chapter.drafts).filter(key => ports.app.courseMode === 'discussion' ? key.endsWith(':discussion') : !key.endsWith(':discussion')).length;
        courseCachedStats.confirmed += Object.entries(chapter.submissions).filter(([key, s]) => s.phase === 'confirmed' && (ports.app.courseMode === 'discussion' ? key.endsWith(':discussion') : !key.endsWith(':discussion'))).length;
        courseCachedStats.sending += Object.entries(chapter.submissions).filter(([key, s]) => s.phase === 'sending' && (ports.app.courseMode === 'discussion' ? key.endsWith(':discussion') : !key.endsWith(':discussion'))).length;
      }
      courseStatsAt = Date.now();
    }
    let state = 'working', label = '执行中', reason = options.statusText || courseLastMessage || '等待识别当前页面';
    if (!ports.app.enabled) { state = 'paused'; label = '已暂停'; reason = [GM_getValue(`course-material-pause:${ports.app.memoryCourse}`, null)?.message, GM_getValue(`course-wrong-pause:${ports.app.memoryCourse}`, null)?.message].filter(Boolean).join('；') || '点击“开始”继续'; }
    else if (options.error || ports.app.courseRun?.error) { state = 'error'; label = '需处理'; reason = options.error?.message || String(options.error || ports.app.courseRun?.error); }
    else if (ports.app.courseVerificationWaiting) { state = 'waiting'; label = '等待验证'; reason = '请在页面手动完成人机验证'; }
    else if (ports.assignment.courseInputHold) { state = 'waiting'; label = '编辑材料'; reason = ports.assignment.courseImportBusy ? '正在本机解析文件，暂缓自动作答与提交' : '正在编辑参考库；完成后关闭此入口或返回任务页继续'; }
    else if (ports.assignment.courseMaterialJob) { state = 'working'; label = ports.assignment.courseMaterialJob.kind === 'lectures' ? '采集讲稿' : '采集材料'; }
    else if (ports.ai.courseModelState.state === 'pending') { state = 'model'; label = '等待模型'; reason = `模型${({ answer: '作答', discussion: '讨论', summary: '摘要', probe: '连接测试', transcribe: '题目文字识别' })[ports.ai.courseModelState.kind] || '请求'}已发出，等待回复`; }
    else if (ports.ai.courseModelState.state === 'error') { state = 'error'; label = '模型失败'; reason = ports.ai.courseModelState.error; }
    else if (ports.app.courseRun?.waitingWrong) { state = 'waiting'; label = '答错待核验'; reason = GM_getValue(`course-wrong-pause:${ports.app.memoryCourse}`, null)?.message || '自动提交已暂停；查看后可点“下一题”'; }
    else if (ports.app.courseRun?.filling) { state = 'working'; label = '填写中'; reason = '正在逐项选择并核对页面实际状态'; }
    else if (ports.app.courseRun?.waitingReview) { state = 'waiting'; label = '待你核验'; reason = ports.app.courseMode === 'discussion' ? '讨论已填写，自动提交暂停；核验后可手动发布或恢复自动提交' : '答案已填写，自动提交已暂停；核验后可手动提交或恢复自动提交'; }
    else if (ports.app.courseMode === 'discussion' && stage.discussionsDone) { state = 'finished'; label = '讨论遍历结束'; reason = '请以网站已发言状态确认；跳过的讨论未作答'; }
    else if (stage.phase === 'materials' && stage.materialsDone) { state = 'waiting'; label = '材料收集结束'; reason = '点击“完成作业”继续，或在作业子任务中切换'; }
    else if (stage.phase === 'assignments' && stage.assignmentsDone) { state = 'finished'; label = '遍历结束'; reason = done.some(entry => processed[entry.id].outcome === 'skipped') ? '仍有未作答或待确认的题目，跳过不代表回答完成' : '请以网站反馈确认作答结果'; }
    else if (ports.app.courseRun?.pending) { state = 'working'; label = '处理材料'; reason = '正在准备参考材料、读取缓存或绘制题目'; }
    else if (/等待|暂缓|未识别|未找到|不可用/.test(reason)) { state = 'waiting'; label = '等待中'; }
    return { state, label, reason, phase: stage.phase, discussion: ports.app.courseRun?.discussion ? { ...ports.app.courseRun.discussion } : null, materialJob: ports.assignment.courseMaterialJob ? { kind: ports.assignment.courseMaterialJob.kind, total: ports.assignment.courseMaterialJob.total, completed: ports.assignment.courseMaterialJob.completed, missing: ports.assignment.courseMaterialJob.missing } : null, current: item ? { title: item.title, type: item.type, chapter: item.chapter?.title || null } : null,
      total: ports.assignment.courseMaterialJob?.total ?? eligible.length, processed: ports.assignment.courseMaterialJob?.completed ?? done.length, skipped: done.filter(entry => processed[entry.id].outcome === 'skipped').length,
      reused: done.filter(entry => processed[entry.id].outcome === 'cached').length,
      missing: done.filter(entry => processed[entry.id].outcome === 'missing').length,
      position: item ? eligible.indexOf(item) + 1 : 0, cache: { ...courseCachedStats },
      model: { ...ports.ai.courseModelState, elapsedMs: ports.ai.courseModelState.state === 'pending' ? Math.max(0, Date.now() - ports.ai.courseModelState.since) : null },
      service: { ...ports.ai.courseServiceHealth }, lastAction: courseLastAction ? { ...courseLastAction, ageMs: Math.max(0, Date.now() - courseLastAction.at) } : null };
  }

  function renderCourseProgress(options = {}) {
    const panel = shadow.getElementById('course-live'); panel.hidden = ports.app.courseMode === 'video';
    if (['auto', 'discussion'].includes(ports.app.courseMode) && ports.app.enabled) void ports.ai.checkCourseService();
    const view = courseProgressSnapshot(options);
    const labels = { video: '视频文字归纳', article: '图文', discussion: '讨论', assignment: '作业', exam: '考试' };
    shadow.getElementById('course-live-state').textContent = view.label;
    panel.setAttribute?.('data-state', view.state);
    shadow.getElementById('course-live-current').textContent = view.current ? `${view.current.chapter || '章节待识别'} · ${labels[view.current.type] || '模块'}：${view.current.title || '当前内容'}` : '当前内容：等待识别目录与章节';
    shadow.getElementById('course-live-stage').textContent = `${view.materialJob ? view.materialJob.kind === 'lectures' ? '补采视频讲稿' : '重新采集材料' : ports.app.courseMode === 'discussion' ? '讨论' : view.phase === 'materials' ? '收集材料' : '完成作业'} · 本轮已处理 ${view.processed}/${view.total || '—'}${view.reused && !view.materialJob ? `，复用${view.reused}项` : ''}${view.skipped && !view.materialJob ? `，其中跳过${view.skipped}项` : ''}${view.missing ? `，缺材料${view.missing}项` : ''}`;
    const bar = shadow.getElementById('course-live-progress'); bar.max = Math.max(1, view.total); bar.value = view.processed;
    shadow.getElementById('course-live-cache').textContent = ports.app.courseMode === 'discussion' ? (view.discussion ? `当前讨论：读取${view.discussion.total}条 · 去重${view.discussion.unique}种 · 抽取${view.discussion.selected}条${view.discussion.characters !== undefined ? ` · 正文${view.discussion.characters}/200字` : ''}` : '讨论参考：仅使用本次抽取的评论正文') : `本地：材料 ${view.cache.materials}（含讲稿${view.cache.lectures}份） · 题目 ${view.cache.questions} · 草稿 ${view.cache.drafts}`;
    shadow.getElementById('course-live-results').textContent = `网站反馈：已确认 ${view.cache.confirmed} · 等待确认 ${view.cache.sending}`;
    shadow.getElementById('course-live-reason').textContent = view.reason;
    const health = view.service;
    shadow.getElementById('course-live-service').textContent = `本机服务：${health.state === 'ready' ? `正常 · 已配置 ${health.model || '模型'}` : health.state === 'checking' ? '检测中' : health.error || '尚未检测'}`;
    const model = view.model;
    const probeButton = shadow.getElementById('course-model-probe');
    probeButton.disabled = model.state === 'pending' || !!ports.app.courseRun?.pending || ports.app.courseVerificationWaiting;
    shadow.getElementById('service-save').disabled = model.state === 'pending';
    const brief = model.state === 'pending' ? `模型回复中 · 已等待 ${Math.floor(model.elapsedMs / 1000)}秒`
      : model.state === 'error' ? /资料不足|原文|确定答案|题目图片|转写/.test(model.error || '') ? '暂未得到可靠答案 · 请查看诊断中的参考传递' : '模型调用失败 · 请到“设置”测试连接'
      : model.state === 'success' ? '模型最近一次调用成功'
      : health.state === 'ready' ? '本机服务在线 · 模型已配置'
      : health.state === 'checking' ? '正在检测本机服务'
      : health.error || '模型尚未检测，可到“设置”检查';
    const briefNode = shadow.getElementById('course-live-model-brief');
    briefNode.textContent = brief; briefNode.hidden = ports.app.courseMode === 'collect';
    const settingsState = shadow.getElementById('model-settings-state');
    settingsState.textContent = model.state === 'error' ? model.error : model.state === 'pending' ? brief
      : health.state === 'ready' ? `${health.model || '模型'} · 服务在线${model.state === 'success' ? ' · 回复成功' : ''}`
      : model.state === 'success' ? '模型回复成功；可检测本机服务状态'
      : health.error || (!ports.ai.serviceToken ? '尚未保存本地连接口令' : health.state === 'checking' ? '正在检测本机服务' : '尚未检测，可点击“检测服务”或“测试模型回复”');
    settingsState.setAttribute?.('data-kind', model.state === 'error' || ['error', 'missing-token'].includes(health.state) ? 'error' : 'info');
    shadow.getElementById('course-live-model').textContent = model.state === 'pending' ? `模型请求：等待回复 ${Math.floor(model.elapsedMs / 1000)}秒（最长100秒）`
      : model.state === 'error' ? `模型请求失败：${model.error}` : model.state === 'success' ? '模型最近一次请求成功'
      : model.successes ? '模型当前空闲，历史请求曾成功' : '模型尚未返回过成功结果；配置保存不代表调用成功';
    shadow.getElementById('course-live-requests').textContent = `模型请求 ${model.attempts}次 · 成功 ${model.successes} · 失败 ${model.failures}（含连接测试）`;
    shadow.getElementById('course-live-materials').textContent = ports.app.courseMode === 'discussion' ? '参考传递：抽样评论；与作业参考库独立' : ports.assignment.courseMaterialContext
      ? `参考传递：用户资料优先 · 所选${ports.assignment.courseMaterialContext.selectedCharacters}字 · 本次${ports.assignment.courseMaterialContext.sentCharacters}字 · ${ports.assignment.courseMaterialContext.mode === 'full-original' ? '完整原文' : '相关原文片段'} · 命中${ports.assignment.courseMaterialContext.matchedPassages}段`
      : '参考传递：尚未准备本页作答材料';
    shadow.getElementById('course-live-action').textContent = view.lastAction ? `最近动作：${view.lastAction.text} · ${Math.floor(view.lastAction.ageMs / 1000)}秒前` : '最近动作：本页尚未执行采集、作答或提交';
    shadow.getElementById('course-live-heartbeat').textContent = '脚本在线 · 刚刚检查页面';
    if (!panel.hidden) shadow.getElementById('badge').textContent = view.label;
  }

  function updateCourseStageUI() {
    const stage = ports.app.courseStage();
    shadow.getElementById('course-stage').textContent = ports.app.courseVerificationWaiting ? '等待手动完成人机验证，自动操作已暂缓'
      : ports.app.courseMode === 'discussion' ? '讨论自动化：评论去重抽样 → 200字以内综合 → 填写与发布'
      : stage.phase === 'assignments' ? '完成作业：使用所选材料，按勾选题型作答（验证请手动完成）'
      : stage.materialsDone ? '材料收集结束：可切换“完成作业”' : '收集材料：图文、知识导引、视频讲稿；复用已有缓存';
    const button = shadow.getElementById('course-assignments');
    button.disabled = !ports.app.enabled || !stage.materialsDone || ports.app.courseVerificationWaiting || !!ports.assignment.courseMaterialJob || ports.app.courseMode === 'video' || ports.ai.courseModelState.state === 'pending';
    button.hidden = !['auto', 'collect'].includes(ports.app.courseMode) || !stage.materialsDone || stage.phase !== 'materials';
  }

  function courseStatus(text) {
    courseLastMessage = text;
    shadow.getElementById('course-status').textContent = text;
    if (ports.app.courseMode !== 'video' || ports.app.workflowSnapshot()?.active) status(text);
  }

  function renderReferenceLibrary(current = null) {
    const list = shadow.getElementById('reference-list');
    if (typeof list.replaceChildren !== 'function') return;
    const { item, q, key } = current || ports.assignment.referenceContext(), data = ports.assignment.referenceLibrary.read();
    if (key !== referenceEditorKey) {
      const saved = data.answers[key];
      shadow.getElementById('manual-answer').value = !saved ? '' : q.type === 'blank' ? saved.blanks.join('\n') : q.type === 'essay' ? saved.text : saved.selections.map(id => String.fromCharCode(65 + q.options.findIndex(option => option.id === id))).join(' ');
      referenceEditorKey = key;
    }
    const signature = Course.fingerprint({ chapter: item?.chapter?.key, sources: item?.chapter && ports.app.chapterCache.sourceVersion(item.chapter), question: key, items: data.items.map(record => [record.id, record.enabled]), useCourse: data.useCourse, manual: !!data.answers[key], removed: !!data.removed });
    if (signature !== referenceViewKey) {
      referenceViewKey = signature; list.replaceChildren();
      const addChoice = (id, label, checked, disabled = false) => {
        const row = document.createElement('label'); row.className = 'reference-choice';
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = disabled;
        const text = document.createElement('span'); text.textContent = label;
        input.addEventListener('change', () => { ports.assignment.setReferenceEnabled(id, input.checked); });
        row.append(input, text); list.append(row);
      };
      const courseCount = item?.chapter ? Object.values(ports.app.chapterCache.read(item.chapter).sources).filter(record => record.text?.trim() && record.quality !== 'missing').length : 0;
      const lectureCount = item?.chapter ? Object.values(ports.app.chapterCache.read(item.chapter).sources).filter(record => record.lecture?.status === 'captured').length : 0;
      addChoice('course', `课程材料汇总（本章${courseCount}份，含${lectureCount}份视频讲稿）`, data.useCourse);
      for (const record of data.items) {
        const otherChapter = record.scope === 'chapter' && record.chapterKey !== item?.chapter?.key;
        addChoice(record.id, `${record.title}${otherChapter ? '（其他章节）' : ''}`, record.enabled, otherChapter);
      }
      const options = shadow.getElementById('reference-remove-list'); options.replaceChildren();
      for (const record of data.items) { const option = document.createElement('option'); option.value = record.id; option.textContent = record.title; options.append(option); }
      shadow.getElementById('reference-remove-group').hidden = !data.items.length;
      shadow.getElementById('reference-undo').hidden = !data.removed;
      shadow.getElementById('manual-answer-context').textContent = q ? `第${q.number}题 · ${q.type === 'blank' ? `共${q.blankCount}个空，每行填一个答案` : ['single','multiple','judge'].includes(q.type) ? '填写选项字母，如A或A C，对应页面顺序' : '填写完整答案'}` : '打开一道作业题后，可补充本题答案';
      shadow.getElementById('manual-answer-save').disabled = !q;
      shadow.getElementById('manual-answer-remove').disabled = !data.answers[key];
    }
    const selected = item?.chapter ? ports.assignment.referenceLibrary.selected(item.chapter).length : data.items.filter(record => record.enabled && record.scope === 'course').length;
    shadow.getElementById('reference-summary').textContent = `参考顺序：本题人工答案优先${selected ? ` → 用户材料${selected}份` : '（未选用户材料）'}${data.useCourse ? ' → 本章课程材料补充' : '；不使用课程材料'}`;
  }

  function renderSubmissionControl(current = null) {
    const { item } = current || ports.assignment.referenceContext();
    shadow.getElementById('assignment-controls').hidden = !(ports.app.courseMode === 'discussion' && item?.type === 'discussion' || ports.app.courseMode === 'auto' && item?.type === 'assignment');
    shadow.getElementById('reference-open').hidden = ports.app.courseMode === 'discussion';
    const button = shadow.getElementById('submit-toggle');
    button.textContent = ports.app.courseSubmitEnabled ? '暂停自动提交' : '恢复自动提交';
    button.setAttribute('aria-pressed', String(!ports.app.courseSubmitEnabled));
    shadow.getElementById('submit-status').textContent = ports.app.courseMode === 'discussion' ? (ports.app.courseSubmitEnabled ? '正文校验通过后自动发布；可随时暂停核验。' : '自动发布已暂停，正文保留。可手动发布或恢复自动提交。') : ports.app.courseSubmitEnabled ? '填写并校验后自动提交；网站判错会暂停自动提交。' : '自动提交已暂停。核验后可手动提交、点“下一题”，或恢复自动提交。';
  }

  function renderMaterialControls() {
    shadow.getElementById('cache-undo').hidden = !GM_getValue(ports.assignment.materialBackupKey, null);
    shadow.getElementById('lecture-import').disabled = ports.assignment.courseImportBusy || !!ports.assignment.courseMaterialJob;
    shadow.getElementById('cache-rebuild').disabled = ports.assignment.courseImportBusy || !!ports.assignment.courseMaterialJob;
    shadow.getElementById('cache-clear').disabled = ports.assignment.courseImportBusy;
  }

  function renderAssignmentControls(current = null) {
    const { item, doc, q } = current || ports.assignment.referenceContext();
    shadow.getElementById('question-next').hidden = item?.type !== 'assignment';
    shadow.getElementById('question-next').disabled = !q || ports.assignment.courseImportBusy || !!ports.assignment.courseMaterialJob || ports.app.courseVerificationWaiting;
    shadow.getElementById('fuzzy-match').checked = ports.assignment.fuzzyPolicy.enabled;
    const match = ports.assignment.fuzzyPolicy.lastMatch;
    shadow.getElementById('fuzzy-status').textContent = ports.assignment.fuzzyPolicy.reason && !ports.assignment.fuzzyPolicy.enabled ? ports.assignment.fuzzyPolicy.reason + '；检查材料后可重新开启'
      : `${ports.assignment.fuzzyPolicy.enabled ? '已开启' : '默认关闭'} · 连续两次模糊匹配答错自动关闭${match ? ` · 上次命中${(match.score * 100).toFixed(1)}%` : ''}。仅使用勾选资料的明确答案条目。`;
    const progress = ports.assignment.assignmentProgress(doc, item), panel = shadow.getElementById('assignment-progress');
    panel.hidden = !progress || ports.app.courseMode === 'video';
    if (progress) {
      panel.textContent = `当前作业：已答 ${progress.answered}/${progress.total}（正确${progress.correct} · 错误${progress.wrong} · 待批阅${progress.awaitingGrade}） · 等待确认${progress.pending} · 已跳过${progress.skipped} · 未处理${progress.untouched}`;
      const skips = ports.assignment.recentAssignmentSkips(item);
      const shortReason = reason => /optionCount/.test(reason) ? '选项数量未完整识别' : /optionIds/.test(reason) ? '选项编号不匹配'
        : /optionText/.test(reason) ? '选项文字缺失' : /blankCount/.test(reason) ? '填空数不匹配' : /blankMarkers/.test(reason) ? '填空标记缺失'
        : /questionText/.test(reason) ? '题干未完整识别' : /转写不完整/.test(reason) ? '题目转写校验失败' : reason.length > 32 ? reason.slice(0, 32) + '…' : reason;
      if (skips.length) panel.textContent += `。最近未作答：${skips.map(skip => `第${skip.number}题（${shortReason(skip.reason)}）`).join('；')}`;
      panel.title = skips.map(skip => `第${skip.number}题：${skip.reason}`).join('\n');
      if (q) {
        const draft = ports.app.chapterCache.read(item.chapter).drafts[`${item.id}:${q.number}:${q.hash}`];
        if (draft?.strategy === 'fuzzy') shadow.getElementById('submit-status').textContent += ` 本题由原文模糊匹配填充，命中${(draft.match.score * 100).toFixed(1)}%。`;
      }
    }
  }

  function showDiagnostics() {
    showPanelView('diagnostics');
    shadow.getElementById('panel-body').hidden = false;
    shadow.getElementById('collapse').textContent = '−';
    shadow.getElementById('collapse').setAttribute('aria-expanded', 'true');
    shadow.getElementById('collapse').setAttribute('aria-label', '收起面板');
    const output = shadow.getElementById('diagnostics');
    output.hidden = false;
    output.value = JSON.stringify(ports.app.diagnosticReport(), null, 2);
  }

  let connected = false;
  function connect() {
    if (connected) return;
    connected = true;
    connectDrag();
    shadow.getElementById('workflow-start').addEventListener('click', ports.app.startWorkflow);
    shadow.getElementById('assignment-action').addEventListener('change', () => ports.app.setAssignmentAction(shadow.getElementById('assignment-action').value));
    for (const type of ['single', 'multiple', 'judge', 'blank', 'essay']) shadow.getElementById(`question-type-${type}`).addEventListener('change', () => {
      ports.assignment.setQuestionTypes(['single', 'multiple', 'judge', 'blank', 'essay'].filter(value => shadow.getElementById(`question-type-${value}`).checked));
    });
    shadow.getElementById('toggle').addEventListener('click', ports.app.toggle);
    shadow.getElementById('resume').addEventListener('click', ports.video.resume);
    shadow.getElementById('submit-toggle').addEventListener('click', ports.app.toggleCourseSubmit);
    shadow.getElementById('question-next').addEventListener('click', ports.assignment.nextQuestionFromPanel);
    shadow.getElementById('fuzzy-match').addEventListener('change', ports.assignment.toggleFuzzyPolicy);
    shadow.getElementById('lecture-import').addEventListener('click', () => ports.assignment.beginMaterialImport('lectures'));
    shadow.getElementById('cache-rebuild').addEventListener('click', () => ports.assignment.beginMaterialImport('rebuild'));
    shadow.getElementById('cache-clear').addEventListener('click', ports.assignment.clearCourseMaterials);
    shadow.getElementById('cache-undo').addEventListener('click', ports.assignment.restoreCourseMaterials);
    shadow.getElementById('reference-open').addEventListener('click', () => {
      showPanelView('materials'); shadow.getElementById('manual-answer-panel').open = true;
    });
    shadow.getElementById('materials-open').addEventListener('click', () => {
      showPanelView('materials'); shadow.getElementById('reference-import-panel').open = true;
    });
    shadow.getElementById('reference-panel').addEventListener('toggle', () => {
      ports.assignment.setReferenceEditing(shadow.getElementById('reference-panel').open);
    });
    shadow.getElementById('reference-done').addEventListener('click', () => showPanelView('task'));
    shadow.getElementById('reference-files').addEventListener('change', event => { void ports.assignment.importReferenceFiles([...event.target.files]); });
    shadow.getElementById('reference-paste-save').addEventListener('click', ports.assignment.savePastedReference);
    shadow.getElementById('manual-answer-save').addEventListener('click', ports.assignment.saveManualAnswer);
    shadow.getElementById('manual-answer-remove').addEventListener('click', () => ports.assignment.removeManualAnswer());
    shadow.getElementById('reference-remove').addEventListener('click', () => ports.assignment.removeReference(shadow.getElementById('reference-remove-list').value));
    shadow.getElementById('reference-undo').addEventListener('click', () => ports.assignment.restoreReference());
    const panelViews = ['task', 'materials', 'settings', 'diagnostics'];
    panelViews.forEach((view, index) => {
      const button = shadow.getElementById(`tab-${view}`);
      button.addEventListener('click', () => showPanelView(view));
      button.addEventListener('keydown', event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % panelViews.length
          : event.key === 'ArrowLeft' ? (index + panelViews.length - 1) % panelViews.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? panelViews.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); showPanelView(panelViews[next]);
        shadow.getElementById(`tab-${panelViews[next]}`).focus?.();
      });
    });
    showPanelView('task');
    shadow.getElementById('pick').addEventListener('click', ports.video.markNext);
    shadow.getElementById('mark-completion').addEventListener('click', ports.video.markCompletion);
    shadow.getElementById('course-mode').value = ports.app.courseMode;
    shadow.getElementById('course-mode').addEventListener('change', () => ports.app.changeMode(shadow.getElementById('course-mode').value));
    shadow.getElementById('course-start').addEventListener('click', ports.app.resumeCoursePlan);
    shadow.getElementById('course-assignments').addEventListener('click', ports.app.beginAssignmentImport);
    shadow.getElementById('course-retry').addEventListener('click', () => ports.app.retryCurrentTask());
    shadow.getElementById('cache-export').addEventListener('click', ports.app.exportMemory);
    shadow.getElementById('cache-current').addEventListener('click', () => ports.app.updateCurrentMaterial());
    shadow.getElementById('service-token').value = ports.ai.serviceToken;
    shadow.getElementById('service-save').addEventListener('click', () => ports.ai.saveConnectionToken(shadow.getElementById('service-token').value));
    shadow.getElementById('service-test').addEventListener('click', ports.ai.inspectService);
    shadow.getElementById('course-health-check').addEventListener('click', ports.ai.inspectService);
    shadow.getElementById('course-model-probe').addEventListener('click', ports.ai.probeModel);
    shadow.getElementById('pick-catalog').addEventListener('click', ports.platform.markCatalogItem);
    shadow.getElementById('collapse').addEventListener('click', () => {
      const body = shadow.getElementById('panel-body');
      body.hidden = !body.hidden;
      const button = shadow.getElementById('collapse');
      button.textContent = body.hidden ? '+' : '−';
      button.setAttribute('aria-expanded', String(!body.hidden));
      button.setAttribute('aria-label', body.hidden ? '展开面板' : '收起面板');
    });
    shadow.getElementById('diagnose').addEventListener('click', showDiagnostics);
    shadow.getElementById('question-preview').addEventListener('click', () => { void ports.assignment.inspectQuestionImage(); });
    shadow.getElementById('question-export').addEventListener('click', () => { void ports.assignment.inspectQuestionImage(true); });
    shadow.getElementById('export-debug').addEventListener('click', ports.app.exportDebug);
    shadow.getElementById('auto-resume').addEventListener('click', ports.video.toggleAutoResume);
    shadow.getElementById('foreground-mask').checked = ports.video.foregroundMask;
    shadow.getElementById('foreground-mask').addEventListener('click', ports.video.toggleForegroundMask);
    shadow.getElementById('mark-rate').addEventListener('click', () => ports.video.markPlayerControl('rate'));
    shadow.getElementById('mark-mute').addEventListener('click', () => ports.video.markPlayerControl('mute'));
    speedNode.addEventListener('click', ports.video.changeSpeed);
    GM_registerMenuCommand('暂停 / 启用自动化', ports.app.toggle);
    GM_registerMenuCommand('标记下一节按钮', ports.video.markNext);
    GM_registerMenuCommand('显示播放诊断信息', showDiagnostics);
    GM_registerMenuCommand('导出调试文件', ports.app.exportDebug);
    GM_registerMenuCommand('清除播放器控件标记', ports.video.clearControlMarkers);
    GM_registerMenuCommand('清除下一节按钮标记', ports.platform.clearNextMarker);
  }


  function invalidateProgress() { courseStatsAt = -Infinity; }

  function invalidateReferenceView() { referenceViewKey = ''; }

  function renderTaskOptions() {
    const plan = ports.app.workflowSnapshot(), active = plan?.active;
    const button = shadow.getElementById('workflow-start');
    button.disabled = !!active && ports.app.enabled;
    button.textContent = active ? ports.app.enabled ? '一键流程运行中' : '继续一键流程' : plan?.phase === 'done' ? '检查并补做未完成项' : '一键自动化';
    const order = { video: '1/3', discussion: '2/3', materials: '3/3', assignments: '3/3', done: '3/3' };
    shadow.getElementById('workflow-status').textContent = active ? `一键流程 ${order[plan.phase]} · ${plan.label}${ports.app.enabled ? '' : ' · 已暂停'}${plan.videoSkipped ? ` · 视频跳过${plan.videoSkipped}项` : ''}。切换运行方式可退出流程。`
      : plan?.phase === 'done' ? '本轮遍历结束；再次检查会保留完成记录，只补做未完成项。' : '自动跳过已完成项；视频 → 讨论 → 作业。暂停按钮控制整个流程。';
    for (const key of ['video', 'discussion', 'assignments']) {
      const view = plan?.coverage?.[key], current = active && (plan.phase === key || key === 'assignments' && plan.phase === 'materials');
      shadow.getElementById(`workflow-row-${key}`).setAttribute('data-current', String(!!current));
      const materials = plan?.coverage?.materials;
      shadow.getElementById(`workflow-step-${key}`).textContent = current && plan.phase === 'materials' && materials ? `材料 ${materials.completed}/${materials.total}已处理`
        : view ? `${view.completed}/${view.total}已完成${key === 'assignments' ? ' · 已选题型' : ''}${current ? ' · 处理中' : ''}` : '待检查';
    }
    const refs = ports.assignment.referenceLibrary.read(), selected = refs.items.filter(item => item.enabled).length;
    shadow.getElementById('task-reference-summary').textContent = `本课程用户材料 ${refs.items.length}份 · 已勾选${selected}份${refs.useCourse ? ' · 同时参考课程材料' : ' · 仅用用户材料'}。用户材料优先。`;
    shadow.getElementById('assignment-task-options').hidden = ports.app.courseMode !== 'auto';
    shadow.getElementById('assignment-action').value = ports.app.courseStage().phase === 'assignments' ? 'complete' : 'materials';
    const types = ports.assignment.selectedQuestionTypes();
    for (const type of ['single', 'multiple', 'judge', 'blank', 'essay']) shadow.getElementById(`question-type-${type}`).checked = types.includes(type);
    shadow.getElementById('question-type-summary').textContent = `作答题型（已选${types.length}/5${types.length ? '' : '，全部跳过'}）`;
  }

  const api = {
    get renderTaskOptions() { return renderTaskOptions; },
    get invalidateReferenceView() { return invalidateReferenceView; },
    get invalidateProgress() { return invalidateProgress; },
    get connect() { return connect; },
    get courseProgressSnapshot() { return courseProgressSnapshot; },
    get courseStatus() { return courseStatus; },
    get feedback() { return feedback; },
    get host() { return host; },
    get keepPanelVisible() { return keepPanelVisible; },
    get memorySummary() { return memorySummary; },
    get message() { return message; }, set message(value) { message = value; },
    get noteCourseAction() { return noteCourseAction; },
    get recentMessages() { return recentMessages; },
    get renderAssignmentControls() { return renderAssignmentControls; },
    get renderCourseProgress() { return renderCourseProgress; },
    get renderMaterialControls() { return renderMaterialControls; },
    get renderReferenceLibrary() { return renderReferenceLibrary; },
    get renderSubmissionControl() { return renderSubmissionControl; },
    get shadow() { return shadow; },
    get showPanelView() { return showPanelView; },
    get speedNode() { return speedNode; },
    get status() { return status; },
    get toggleNode() { return toggleNode; },
    get updateCourseStageUI() { return updateCourseStageUI; },
    get verifySettings() { return verifySettings; }
  };
  if (options.testing) api.testing = {
    get host() { return host; },
    get shadow() { return shadow; },
    get statusNode() { return statusNode; },
    get toggleNode() { return toggleNode; },
    get speedNode() { return speedNode; },
    get panelPositionKey() { return panelPositionKey; },
    get panelPosition() { return panelPosition; }, set panelPosition(value) { panelPosition = value; },
    get panelDrag() { return panelDrag; }, set panelDrag(value) { panelDrag = value; },
    get panelDragHandle() { return panelDragHandle; },
    get finishPanelDrag() { return finishPanelDrag; },
    get message() { return message; }, set message(value) { message = value; },
    get feedbackUntil() { return feedbackUntil; }, set feedbackUntil(value) { feedbackUntil = value; },
    get recentMessages() { return recentMessages; },
    get courseLastMessage() { return courseLastMessage; }, set courseLastMessage(value) { courseLastMessage = value; },
    get courseLastAction() { return courseLastAction; }, set courseLastAction(value) { courseLastAction = value; },
    get courseStatsAt() { return courseStatsAt; }, set courseStatsAt(value) { courseStatsAt = value; },
    get courseCachedStats() { return courseCachedStats; }, set courseCachedStats(value) { courseCachedStats = value; },
    get showPanelView() { return showPanelView; }, set showPanelView(value) { showPanelView = value; },
    get positionPanel() { return positionPanel; }, set positionPanel(value) { positionPanel = value; },
    get resetPanelPosition() { return resetPanelPosition; }, set resetPanelPosition(value) { resetPanelPosition = value; },
    get keepPanelVisible() { return keepPanelVisible; }, set keepPanelVisible(value) { keepPanelVisible = value; },
    get feedback() { return feedback; }, set feedback(value) { feedback = value; },
    get memorySummary() { return memorySummary; }, set memorySummary(value) { memorySummary = value; },
    get verifySettings() { return verifySettings; }, set verifySettings(value) { verifySettings = value; },
    get status() { return status; }, set status(value) { status = value; },
    get noteCourseAction() { return noteCourseAction; }, set noteCourseAction(value) { noteCourseAction = value; },
    get courseProgressSnapshot() { return courseProgressSnapshot; }, set courseProgressSnapshot(value) { courseProgressSnapshot = value; },
    get renderCourseProgress() { return renderCourseProgress; }, set renderCourseProgress(value) { renderCourseProgress = value; },
    get courseStatus() { return courseStatus; }, set courseStatus(value) { courseStatus = value; },
    get updateCourseStageUI() { return updateCourseStageUI; }, set updateCourseStageUI(value) { updateCourseStageUI = value; },
    get renderReferenceLibrary() { return renderReferenceLibrary; }, set renderReferenceLibrary(value) { renderReferenceLibrary = value; },
    get renderSubmissionControl() { return renderSubmissionControl; }, set renderSubmissionControl(value) { renderSubmissionControl = value; },
    get renderMaterialControls() { return renderMaterialControls; }, set renderMaterialControls(value) { renderMaterialControls = value; },
    get renderAssignmentControls() { return renderAssignmentControls; }, set renderAssignmentControls(value) { renderAssignmentControls = value; },
    get showDiagnostics() { return showDiagnostics; }, set showDiagnostics(value) { showDiagnostics = value; }
  };
  return api;
}
module.exports = createUI;
