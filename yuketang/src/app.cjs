'use strict';

// 统一调度：模式、任务生命周期、提交策略与诊断；通过显式端口调用功能对象。
function createApplication(ports, options = {}) {
  const Course = ports.core;
  const CONFIG = {
    speed: 2,
    endWaitMs: 15000, // 自然结束后等待页面更新完成度，再决定是否重播。
    maxStagnantReplays: 2,
    maxReplays: 10,
    pollMs: 1000,
    startupWaitMs: 4000,
    resumeDelayMs: 2000,
    resumeRetryMs: 3000,
    menuWaitMs: 6000,
    // 已知页面结构时可填写 CSS 选择器，例如 ['button[aria-label="下一视频"]']。
    nextSelectors: [],
  };



  let enabled = GM_getValue(`course-material-job:${Course.courseId(location.href)}`, null)?.version === 1 || !GM_getValue(`course-material-pause:${Course.courseId(location.href)}`, null);

  let selecting = false;

  let lastTickAt = null;

  let lastError = null;

  const debugEvents = [];





  let lastSampleAt = 0;

  let lastFaultKey = '';

  let nonVideoRoute = '';

  let nonVideoSince = 0;

  let nonVideoAdvanced = false;



  let lastCatalogCheckAt = -Infinity;



  let courseMode = GM_getValue('course-mode', 'video');

  if (courseMode === 'collect') { courseMode = 'auto'; GM_setValue('course-mode', courseMode); }

  if (!['video', 'auto', 'discussion'].includes(courseMode)) courseMode = 'video';

  let courseRun = null;

  const courseOwner = options.owner || `${Date.now()}-${Math.random().toString(36).slice(2)}`;

  function trace(event, data = {}) {
    debugEvents.push({ at: Date.now(), event, stateId: ports.video.state?.id || null, ...data });
    if (debugEvents.length > 400) debugEvents.shift();
  }

  const memoryCourse = Course.courseId(location.href);

  const workflowKey = `course-workflow:${memoryCourse}`;
  let workflow = GM_getValue(workflowKey, null);
  if (workflow?.version !== 1 || workflow.course !== memoryCourse || !['video', 'discussion', 'materials', 'assignments', 'done'].includes(workflow.phase)) workflow = null;
  if (workflow?.active && workflow.paused || workflow?.phase === 'done' && !workflow.stoppedAt) enabled = false;
  const assignmentActionKey = `course-assignment-action:${memoryCourse}`;
  let assignmentAction = GM_getValue(assignmentActionKey, null);
  if (!['materials', 'complete'].includes(assignmentAction)) assignmentAction = courseStage().phase === 'assignments' ? 'complete' : 'materials';

  const chapterCache = Course.createCache(GM_getValue, GM_setValue, memoryCourse);

  const tourKey = `course-tour:${memoryCourse}`;

  let courseSubmitEnabled = loadSubmitPreference();

  const leaseKey = `course-lease:${memoryCourse}`;

  let tour = GM_getValue(tourKey, null);

  let courseVerificationWaiting = false;

  let catalogEntryRecovery = null;

  function stageKey() { return `course-stage:${memoryCourse}:${courseMode}`; }

  function courseStage() {
    const saved = GM_getValue(stageKey(), null);
    return saved?.version === 1 && ['materials', 'assignments'].includes(saved.phase)
      ? saved : { version: 1, phase: 'materials', materialsDone: false, assignmentsDone: false };
  }

  function saveStage(change) {
    const next = { ...courseStage(), ...change };
    GM_setValue(stageKey(), next);
    return next;
  }

  function inStage(item, stage = courseStage()) {
    if (courseMode === 'discussion') return item.type === 'discussion';
    return stage.phase === 'assignments' ? item.type === 'assignment' : item.type === 'article' || ports.assignment.referenceLibrary.read().useCourse && item.type === 'video';
  }

  function cachedMaterial(item, chapterData = null) {
    if (!item?.chapter || !['article', 'video'].includes(item.type)) return null;
    const record = (chapterData || chapterCache.read(item.chapter)).sources[item.id];
    return record?.text?.trim() && record.quality !== 'missing' && record.kind === (item.type === 'video' ? 'guidance' : 'article') &&
      (item.type !== 'video' || record.videoCaptureVersion === 1 && record.lecture?.status !== 'pending') ? record : null;
  }

  function skippedPdfMaterial(item, chapterData = null) {
    return item?.type === 'article' && item.chapter && (chapterData || chapterCache.read(item.chapter)).sources[item.id]?.articleSkip === 'pdf-only';
  }

  function needsModule(item, stage = courseStage()) {
    if (!item?.chapter || !inStage(item, stage)) return false;
    if (stage.phase === 'assignments') {
      const handled = stage.processed?.assignments?.[item.id];
      return workflow?.active ? !assignmentCovered(item, stage) && !(handled?.at >= workflow.startedAt) : !handled;
    }
    if (['article', 'video'].includes(item.type)) return !cachedMaterial(item) && !skippedPdfMaterial(item) && stage.processed?.materials?.[item.id]?.outcome !== 'missing';
    const submission = chapterCache.read(item.chapter).submissions[`${item.id}:discussion`];
    return submission?.phase !== 'confirmed' && !(workflow?.active && ports.platform.moduleCompleted(item)) && stage.processed?.[stage.phase]?.[item.id]?.outcome !== 'skipped';
  }

  function reuseMaterialCoverage(catalog) {
    const stage = courseStage();
    if (stage.phase !== 'materials') return;
    const processed = { ...(stage.processed || {}) }, steps = { ...(processed.materials || {}) };
    const chapters = new Map();
    let added = 0;
    for (const item of catalog.items) {
      if (!inStage(item, stage)) continue;
      if (item.chapter && !chapters.has(item.chapter.key)) chapters.set(item.chapter.key, chapterCache.read(item.chapter));
      const data = item.chapter && chapters.get(item.chapter.key);
      const completedDiscussion = item.type === 'discussion' && data && data.submissions[`${item.id}:discussion`]?.phase === 'confirmed';
      const pdfSkipped = skippedPdfMaterial(item, data);
      if ((cachedMaterial(item, data) || completedDiscussion || pdfSkipped) && (!steps[item.id] || steps[item.id].outcome === 'missing')) {
        steps[item.id] = { outcome: pdfSkipped ? 'skipped' : 'cached', at: Date.now() }; added++;
      }
    }
    if (added) { processed.materials = steps; saveStage({ processed }); ports.ui.noteCourseAction(`复用${added}项本地记录`); trace('course.materials.reused', { count: added }); }
  }

  function nextPlannedModule(catalog, fromStart = false) {
    const stage = courseStage();
    const next = catalog.items.slice(fromStart || workflow?.active ? 0 : catalog.index + 1).find(item => needsModule(item, stage));
    return next || (stage.phase === 'materials' ? catalog.items.find(item => needsModule(item, stage)) : undefined);
  }

  function resumeCoursePlan() {
    if (ports.platform.humanVerification(ports.platform.documents())) { ports.ui.courseStatus('请先手动完成当前页面的人机验证'); return; }
    if (workflow?.active) { startWorkflow(); return; }
    ports.ui.showPanelView('task');
    if (courseMode === 'video') { courseMode = 'auto'; GM_setValue('course-mode', courseMode); ports.ui.shadow.getElementById('course-mode').value = courseMode; }
    releaseCourse(); tour = null; GM_setValue(tourKey, null);
    const stage = courseStage();
    if (stage.phase === 'materials') saveStage({ materialsDone: false, discussionsDone: false, processed: { ...(stage.processed || {}), materials: {} } });
    const catalog = ports.platform.catalogSnapshot(ports.platform.documents()); reuseMaterialCoverage(catalog);
    const first = nextPlannedModule(catalog, true);
    if (first) { ports.ui.courseStatus('复用本地材料，继续未处理的任务'); if (!courseNavigate(first)) ports.ui.courseStatus('任务暂不可用，等待解锁或展开目录'); }
    else finishCourseStage(catalog);
    ports.ui.updateCourseStageUI();
  }

  function finishCourseStage(catalog) {
    if (workflow?.active && ['discussion', 'materials', 'assignments'].includes(workflow.phase) && catalog.items.some(item => inStage(item) && !item.chapter)) {
      ports.ui.courseStatus('一键流程等待任务所属章节识别，暂不结束当前阶段'); return;
    }
    const stage = courseStage();
    if (courseMode === 'discussion') {
      if (!stage.discussionsDone) saveStage({ discussionsDone: true });
      ports.ui.courseStatus('本轮讨论已遍历，已发布、等待确认和跳过情况请以网站反馈为准');
    } else if (stage.phase === 'materials') {
      if (!stage.materialsDone) { saveStage({ materialsDone: true }); trace('course.stage.finished', { phase: 'materials' }); }
      ports.ui.courseStatus(catalog.items.some(item => item.type === 'assignment')
        ? '材料收集结束；点击“完成作业”继续，遇到人机验证请手动完成'
        : '材料收集结束，当前目录没有作业习题');
    } else {
      if (!stage.assignmentsDone) { saveStage({ assignmentsDone: true }); trace('course.stage.finished', { phase: 'assignments' }); }
      ports.ui.courseStatus(courseMode === 'collect' ? '作业习题已导入，本轮采集完成' : '本轮作业已遍历；跳过或待确认的题目仍需处理，请以网站作答结果为准');
    }
    ports.ui.updateCourseStageUI();
    if (workflow?.active && ['discussion', 'materials', 'assignments'].includes(workflow.phase)) advanceWorkflow(catalog);
  }

  function beginAssignmentImport() {
    if (!['auto', 'collect'].includes(courseMode) || !courseStage().materialsDone) { ports.ui.courseStatus('请先完成材料收集，或在作业子任务中直接选择“完成作业”'); return; }
    if (ports.platform.humanVerification(ports.platform.documents())) { courseVerificationWaiting = true; ports.ui.courseStatus('请手动完成页面人机验证后继续'); ports.ui.updateCourseStageUI(); return; }
    releaseCourse(); tour = null; GM_setValue(tourKey, null);
    saveStage({ phase: 'assignments', assignmentsDone: false });
    assignmentAction = 'complete'; GM_setValue(assignmentActionKey, assignmentAction);
    const catalog = ports.platform.catalogSnapshot(ports.platform.documents()), first = nextPlannedModule(catalog, true);
    if (first) {
      ports.ui.courseStatus('开始完成作业；遇到人机验证将等待手动完成');
      if (catalog.items[catalog.index]?.id !== first.id && !courseNavigate(first)) ports.ui.courseStatus('作业暂不可用，等待解锁或展开目录');
    } else finishCourseStage(catalog);
    ports.ui.updateCourseStageUI();
  }

  function ownsCourse() {
    const saved = GM_getValue(leaseKey, null);
    if (saved?.owner !== courseOwner && saved?.until > Date.now()) return false;
    GM_setValue(leaseKey, { owner: courseOwner, until: Date.now() + 20000 });
    return true;
  }

  function releaseCourse() {
    if (GM_getValue(leaseKey, null)?.owner === courseOwner) GM_setValue(leaseKey, null);
    ports.ai.cancelTask(); courseRun = null;
  }

  function runCurrent(run) {
    return enabled && !selecting && !ports.assignment.courseInputHold && !courseVerificationWaiting && !ports.platform.humanVerification(ports.platform.documents()) &&
      !(typeof ports.platform.catalogNavigationWaiting === 'function' && ports.platform.catalogNavigationWaiting()) &&
      courseRun === run && run.route === location.href && courseMode !== 'video' && ownsCourse();
  }

  function launchCourse(run, action) {
    if (run.pending || run.error) return;
    run.pending = true;
    Promise.resolve().then(action).catch(error => {
      if (!enabled || courseRun !== run || run.route !== location.href) return;
      if (run.type === 'assignment' && ports.assignment.assignmentErrorIsSkippable(error) && ports.assignment.skipUnanswerable(run, error.message)) return;
      run.error = error.message;
      ports.ui.courseStatus(error.message);
      trace('course.error', { name: error.name, type: run.type });
    }).finally(() => { run.pending = false; });
  }

  function moduleStateText() {
    return Course.text(document.querySelector('.learning-space-control-unit .control-right')?.textContent);
  }

  function courseNavigate(item) {
    if (!item || !ports.platform.available(item.element) || ports.platform.resourceLocked(item.element)) return false;
    ports.platform.clickNavigation(item.element, item);
    return true;
  }

  function enterDiscussionFromUnresolvedCatalog(catalog, docs) {
    if (courseMode !== 'discussion' || !enabled || selecting) return false;
    if (ports.assignment.courseInputHold || ports.platform.pauseBlocker(docs)) { ports.ui.courseStatus('页面正在编辑或有弹窗，暂缓定位讨论'); return true; }
    const candidates = catalog.items.filter(item => item.chapter && needsModule(item));
    if (!candidates.length) {
      if (catalog.items.some(item => item.type === 'discussion' && item.chapter)) { reuseMaterialCoverage(catalog); finishCourseStage(catalog); }
      else ports.ui.courseStatus('等待讨论目录及章节加载');
      return true;
    }
    // 当前页可能是无选中标记的视频/讨论，不能凭重复标题猜测；明确点击一项建立入口。
    if (!catalogEntryRecovery) catalogEntryRecovery = { tried: [], at: -Infinity };
    if (Date.now() - catalogEntryRecovery.at < 15000) { ports.ui.courseStatus('已点击讨论目录，等待页面切换并确认当前项'); return true; }
    const target = candidates.find(item => !catalogEntryRecovery.tried.includes(item.id) && ports.platform.available(item.element) && !ports.platform.resourceLocked(item.element));
    if (!target) { ports.ui.courseStatus('目录已识别，但尚未确认当前项；请在设置中点“识别当前目录项”后标记当前条目'); return true; }
    if (courseNavigate(target)) {
      catalogEntryRecovery.tried.push(target.id); catalogEntryRecovery.at = Date.now();
      ports.ui.courseStatus('正在打开未处理的讨论，等待页面确认目录位置');
      ports.ui.noteCourseAction('当前项未定位，已从目录进入讨论'); trace('course.discussion.entry', { id: target.id });
    }
    return true;
  }

  function nextModule(catalog, run) {
    if (!runCurrent(run) || run.advanced) return;
    recordCourseStep(catalog.items[catalog.index], run.outcome || 'processed');
    const target = nextPlannedModule(catalog);
    if (!target) { run.advanced = true; finishCourseStage(catalog); return; }
    if (courseNavigate(target)) {
      run.advanced = true;
      if (courseMode === 'discussion') ports.ui.courseStatus(`${run.discussionConfirmation ? '讨论发布已确认，' : ''}正在进入下一个讨论：${target.title || '讨论'}`);
      ports.ui.noteCourseAction(courseMode === 'discussion' ? '已点击下一个讨论目录' : '已进入下一学习模块');
      trace('course.navigation', { destination: target.type });
    }
    else ports.ui.courseStatus('下一模块暂不可用，等待解锁');
  }

  function ensureChapter(item, catalog, run) {
    if (!tour) {
      const saved = chapterCache.read(item.chapter);
      const missing = catalog.items.filter(candidate => candidate.chapter?.key === item.chapter.key && ['video', 'article'].includes(candidate.type) && !cachedMaterial(candidate) && !skippedPdfMaterial(candidate));
      if (!missing.length) return false;
      tour = { chapter: item.chapter.key, returnTo: item.id, queue: missing.map(candidate => candidate.id) };
      GM_setValue(tourKey, tour);
    }
    return continueTour(catalog, run);
  }

  function continueTour(catalog, run) {
    if (!tour) return false;
    while (tour.queue.length && (cachedMaterial(catalog.items.find(item => item.id === tour.queue[0])) || skippedPdfMaterial(catalog.items.find(item => item.id === tour.queue[0])) || run.item === tour.queue[0] && run.outcome === 'missing')) tour.queue.shift();
    GM_setValue(tourKey, tour);
    const targetId = tour.queue[0] || tour.returnTo;
    const target = catalog.items.find(candidate => candidate.id === targetId && candidate.chapter?.key === tour.chapter);
    if (!target) throw new Error('章节材料目录发生变化，请点“重试当前任务”');
    if (catalog.items[catalog.index].id !== target.id) {
      if (!courseNavigate(target)) ports.ui.courseStatus('同章参考材料暂不可用，等待解锁或展开目录');
      return true;
    }
    if (!tour.queue.length) { tour = null; GM_setValue(tourKey, null); return false; }
    return false; // 当前项就是待采集材料，交给正常材料分支处理。
  }

  function courseTick(docs) {
    const materialPause = GM_getValue(`course-material-pause:${memoryCourse}`, null);
    if (materialPause && !ports.assignment.courseMaterialJob && courseMode !== 'discussion') { enabled = false; ports.ui.shadow.getElementById('toggle').textContent = '开始'; ports.ui.courseStatus(materialPause.message); return true; }
    const wrongPause = courseMode === 'auto' && GM_getValue(`course-wrong-pause:${memoryCourse}`, null);
    if (wrongPause && !ports.assignment.courseMaterialJob && courseSubmitEnabled) { courseSubmitEnabled = false; GM_setValue(`course-auto-submit:${memoryCourse}`, false); }
    if (ports.platform.humanVerification(docs)) {
      if (!courseVerificationWaiting) {
        courseVerificationWaiting = true;
        ports.ai.cancelTask(); courseRun = null;
        trace('course.verification.wait');
      }
      if (courseMode !== 'video') ownsCourse();
      ports.ui.courseStatus('检测到人机验证，请手动完成；脚本不会点击、识别或绕过验证码');
      ports.ui.updateCourseStageUI();
      return true;
    }
    if (courseVerificationWaiting) {
      courseVerificationWaiting = false; courseRun = null;
      trace('course.verification.cleared');
      ports.ui.courseStatus('验证提示已消失，等待题目加载后继续');
    }
    if (courseMode === 'discussion' && tour) { tour = null; GM_setValue(tourKey, null); }
    if (ports.assignment.courseMaterialJob) return ports.assignment.materialJobTick(docs);
    if (workflow?.active && workflowTick(docs)) return true;
    ports.ui.updateCourseStageUI();
    if (courseMode === 'video') {
      const catalog = ports.platform.catalogSnapshot(docs), item = catalog.items[catalog.index];
      if (item?.chapter && item.type === 'video') ports.assignment.captureVideoMaterial(item, docs);
      return false;
    }
    if (!ownsCourse()) { ports.ui.courseStatus('另一标签页正在处理本课程，本页等待'); return true; }
    const catalog = ports.platform.catalogSnapshot(docs), item = catalog.items[catalog.index];
    if (!item?.chapter) {
      if (courseRun && courseRun.route !== location.href) { ports.ai.cancelTask(); courseRun = null; }
      if (enterDiscussionFromUnresolvedCatalog(catalog, docs)) return true;
      ports.ui.courseStatus('等待识别当前模块及所属章节'); return true;
    }
    catalogEntryRecovery = null;
    reuseMaterialCoverage(catalog);
    if (!courseRun || courseRun.route !== location.href || courseRun.item !== item.id) {
      ports.ai.cancelTask();
      courseRun = { route: location.href, item: item.id, type: item.type, since: Date.now(), pending: false, error: null, nextAt: 0, advanced: false };
      trace('course.module', { type: item.type, chapter: item.chapter.key });
    }
    const run = courseRun;
    let stage = courseStage();
    if (courseMode === 'discussion' && stage.discussionsDone && catalog.items.some(entry => needsModule(entry, stage))) {
      stage = saveStage({ discussionsDone: false });
    }
    if (stage.phase === 'materials' && stage.materialsDone && ports.assignment.referenceLibrary.read().useCourse && catalog.items.some(entry => {
      const old = entry.chapter && chapterCache.read(entry.chapter).sources[entry.id];
      return entry.type === 'video' && old?.text?.trim() && old.videoCaptureVersion !== 1;
    })) {
      const processed = { ...(stage.processed || {}), materials: { ...(stage.processed?.materials || {}) } };
      for (const entry of catalog.items) if (entry.type === 'video' && !cachedMaterial(entry)) delete processed.materials[entry.id];
      stage = saveStage({ materialsDone: false, processed });
    }
    if (ports.discussion.confirmDiscussion(item, catalog, run)) return true;
    let assignmentView = null;
    if (courseMode === 'auto' && item.type === 'assignment') {
      const doc = ports.assignment.questionDoc(docs);
      const q = doc && ports.assignment.assignmentQuestion(doc, item);
      assignmentView = { doc, q };
      if (q && ports.assignment.skipExcludedType(doc, item, q, run, catalog)) return true;
      ports.assignment.reconcileAssignmentResults(doc, item);
      if (q && (!ports.assignment.courseInputHold || ports.assignment.observedOutcome(q, doc) === 'wrong') && ports.assignment.processObservedResult(doc, item, q, run, catalog)) return true;
    }
    if (ports.assignment.courseInputHold) { ports.ui.courseStatus(ports.assignment.courseImportBusy ? '正在本机解析材料，任务暂缓' : '正在编辑材料库，返回任务页后继续'); return true; }
    if (!tour && stage.phase === 'materials' && !catalog.items.some(entry => needsModule(entry, stage))) { finishCourseStage(catalog); return true; }
    if (!tour && (stage.phase === 'materials' && stage.materialsDone || stage.phase === 'assignments' && stage.assignmentsDone)) {
      finishCourseStage(catalog); return true;
    }
    if (run.advanced || run.pending || run.error || Date.now() < run.nextAt) return true;
    if (Date.now() - run.since < 4000) { ports.ui.courseStatus('等待当前模块加载'); return true; }
    if (!tour && stage.phase === 'materials' && cachedMaterial(item)) { nextModule(catalog, run); return true; }
    if (!tour && !inStage(item, stage)) { nextModule(catalog, run); return true; }
    if (tour && item.chapter.key !== tour.chapter) { ports.ui.courseStatus('材料采集尚未返回原章节，请点“重试当前任务”'); return true; }
    if (tour && continueTour(catalog, run)) return true;
    if (item.type === 'exam') { nextModule(catalog, run); return true; }
    if (item.type === 'article' || item.type === 'video') return ports.assignment.collectMaterialTick(docs, item, catalog, run);
    if (ports.platform.pauseBlocker(docs)) {
      // 只处理由本脚本提交引起的“仅提交本题”确认；其他弹窗不猜测。
      const own = docs.flatMap(doc => [...doc.querySelectorAll('.homework-problem-batch-submit-dialog')]).find(ports.platform.visible);
      const button = own && [...own.querySelectorAll('.rain-btn')].find(el => Course.text(el.textContent) === '仅提交本题');
      if (run.submitting && button) button.click();
      else ports.ui.courseStatus('页面有弹窗，当前模块等待处理');
      return true;
    }
    if (item.type === 'discussion') return ports.discussion.discussionTick(item, catalog, run);
    const activeQ = item.type === 'assignment' ? assignmentView ? assignmentView.q : Course.question(ports.assignment.questionDoc(docs) || document) : null;
    const hasManualAnswer = activeQ && ports.assignment.referenceLibrary.read().answers[`${item.id}:${activeQ.number}:${activeQ.hash}`];
    if (courseMode === 'auto' && ports.assignment.referenceLibrary.read().useCourse && !hasManualAnswer && ensureChapter(item, catalog, run)) return true;
    if (item.type === 'assignment') return ports.assignment.assignmentTick(docs, item, catalog, run, assignmentView);
    ports.ui.courseStatus('当前模块尚未适配'); return true;
  }

  function exportMemory() {
    const blob = new Blob([JSON.stringify({ ...chapterCache.exportAll(), references: ports.assignment.referenceLibrary.read() }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = `yuketang-memory-${Date.now()}.json`;
    document.documentElement.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function courseDiagnostics() {
    const memory = chapterCache.exportAll();
    const doc = courseStage().phase === 'assignments' && !courseVerificationWaiting ? ports.assignment.questionDoc(ports.platform.documents()) : null;
    const question = doc && Course.question(doc);
    const catalog = ports.platform.catalogSnapshot(ports.platform.documents()), item = catalog.items[catalog.index];
    return { mode: courseMode, stage: courseStage(), workflow: workflowSnapshot(), assignmentAction, questionTypes: ports.assignment.selectedQuestionTypes(), verificationWaiting: courseVerificationWaiting, questionRender: ports.assignment.lastQuestionRender?.meta || null,
      serviceConfigured: !!ports.ai.serviceToken, serviceMessage: ports.ai.courseServiceMessage,
      autoSubmit: courseSubmitEnabled, referenceEditing: ports.assignment.courseInputHold, importing: ports.assignment.courseImportBusy,
      materialJob: ports.assignment.courseMaterialJob ? { kind: ports.assignment.courseMaterialJob.kind, total: ports.assignment.courseMaterialJob.total, completed: ports.assignment.courseMaterialJob.completed, remaining: ports.assignment.courseMaterialJob.queue.length, missing: ports.assignment.courseMaterialJob.missing, skipped: ports.assignment.courseMaterialJob.skipped || 0 } : null,
      materialContext: ports.assignment.courseMaterialContext,
      fuzzyPolicy: { ...ports.assignment.fuzzyPolicy },
      assignmentProgress: ports.assignment.assignmentProgress(doc, item),
      recentSkippedQuestions: ports.assignment.recentAssignmentSkips(item),
      references: { useCourse: ports.assignment.referenceLibrary.read().useCourse, files: ports.assignment.referenceLibrary.read().items.length, selected: ports.assignment.referenceLibrary.read().items.filter(item => item.enabled).length, manualAnswers: Object.keys(ports.assignment.referenceLibrary.read().answers).length },
      live: ports.ui.courseProgressSnapshot(),
      run: courseRun ? { type: courseRun.type, pending: courseRun.pending, filling: !!courseRun.filling, error: !!courseRun.error, submitting: !!courseRun.submitting, discussionConfirmation: courseRun.discussionConfirmation || null } : null,
      question: question ? { number: question.number, count: question.count, type: question.type,
        encrypted: question.encrypted, imageCount: question.imageCount || 0, blankCount: question.blankCount, optionIds: question.options.map(option => option.id),
        choices: ['single', 'multiple', 'judge'].includes(question.type) ? ports.assignment.choiceReport(question, item?.chapter ? chapterCache.read(item.chapter).drafts[`${item.id}:${question.number}:${question.hash}`] : null) : null,
        controls: question.inputs.slice(0, 30).map(el => ({ tag: el.localName, type: el.getAttribute('type'), className: String(el.className || '').slice(0, 120) })) } : null,
      chapters: memory.chapters.map(ch => ({ key: ch.chapter.key, sourceCount: Object.keys(ch.sources).length,
        lectures: Object.values(ch.sources).filter(source => source.videoCaptureVersion).map(source => ({ id: source.id, ...source.lecture })),
        questionTypes: [...new Set(Object.values(ch.questions).map(q => q.type))], draftCount: Object.keys(ch.drafts).length,
        sendingCount: Object.values(ch.submissions).filter(s => s.phase === 'sending').length,
        confirmedCount: Object.values(ch.submissions).filter(s => s.phase === 'confirmed').length })) };
  }

  function nextCatalogVideo(docs) {
    const catalog = ports.platform.catalogSnapshot(docs);
    if (catalog.index < 0) return { handled: false };
    const following = catalog.items.slice(catalog.index + 1);
    const target = courseMode === 'video' ? following.find(item => item.type === 'video') : nextPlannedModule(catalog);
    if (!target) {
      if (courseMode === 'video') ports.ui.status('当前目录已没有后续视频');
      else finishCourseStage(catalog);
      trace('navigation.finished', { count: catalog.items.length });
      return { handled: true };
    }
    if (ports.platform.resourceLocked(target.element)) {
      ports.ui.status('下一个视频暂不可用，等待课程解锁');
      return { handled: true, blocked: true };
    }
    const skipped = following.slice(0, following.indexOf(target)).length;
    ports.ui.status(courseMode !== 'video' ? '正在进入下一学习模块' : skipped ? `已跳过${skipped}项非视频内容，进入下一个视频` : '正在进入下一个视频');
    trace('navigation.catalog', { from: catalog.index, skipped, destination: target.type });
    return { handled: true, target: target.element };
  }

  function skipAssessment(docs) {
    let type = ports.platform.routeResourceType(location.href);
    if (type === 'video') return false;
    if (!type) {
      const catalog = ports.platform.catalogSnapshot(docs);
      type = catalog.items[catalog.index]?.type;
    }
    if (type !== 'assignment' && type !== 'exam') return false;
    if (nonVideoRoute !== location.href) {
      nonVideoRoute = location.href;
      nonVideoSince = Date.now();
      nonVideoAdvanced = false;
      trace('navigation.assessment.detected', { type });
    }
    if (nonVideoAdvanced) return true;
    if (Date.now() - nonVideoSince < CONFIG.startupWaitMs) {
      ports.ui.status('已识别作业／考试，等待目录加载后跳过');
      return true;
    }
    const catalogNext = nextCatalogVideo(docs);
    const target = catalogNext.handled ? catalogNext.target : ports.platform.nextTarget(docs);
    if (target && !ports.platform.pauseBlocker(docs)) {
      nonVideoAdvanced = true;
      trace('navigation.assessment.skip', { method: catalogNext.handled ? 'catalog' : 'next-button' });
      ports.platform.clickNavigation(target);
    } else if (catalogNext.handled && !catalogNext.blocked && !target) {
      nonVideoAdvanced = true;
    } else if (!catalogNext.handled) ports.ui.status('已识别作业／考试，等待可用的目录或下一节按钮');
    return true;
  }

  function safeTick() {
    ports.platform.beginCatalogCycle();
    try { performSafeTick(); } finally { ports.platform.endCatalogCycle(); }
  }

  function performSafeTick() {
    lastTickAt = Date.now();
    try {
      if (!ports.ui.host.isConnected) document.documentElement.append(ports.ui.host);
      ports.ui.keepPanelVisible(); tick();
      lastError = null;
    } catch (error) {
      lastError = { name: error.name, message: String(error.message) };
      trace('script.error', lastError);
      ports.ui.status(`脚本执行出错：${error.name}，请点“诊断信息”`);
    }
    const actual = ports.ui.shadow.getElementById('actual');
    const moduleLabels = { article: '图文', assignment: '作业', discussion: '讨论', exam: '考试', video: '视频' };
    const text = courseMode !== 'video' && courseRun ? `${moduleLabels[courseRun.type] || '课程模块'} · ${courseRun.pending ? '处理中' : '章节学习模式'}`
      : courseMode !== 'video' ? courseMode === 'collect' ? '课程材料采集' : '课程自动处理'
      : ports.video.state?.video.isConnected ? ports.video.playbackStatus(ports.video.state.video) : '尚未找到视频';
    if (actual.textContent !== text) actual.textContent = text;
    const moduleView = courseMode !== 'video';
    ports.ui.shadow.getElementById('playback-state').hidden = moduleView;
    ports.ui.shadow.getElementById('completion').hidden = moduleView;
    ports.ui.shadow.getElementById('setup-result').hidden = moduleView;
    ports.ui.shadow.getElementById('resume').hidden = moduleView || !enabled || !!ports.video.state && !ports.video.state.video.paused;
    ports.ui.shadow.getElementById('course-retry').hidden = !moduleView || !enabled || ports.ai.courseModelState.state === 'pending' || !!courseRun?.pending;
    ports.ui.toggleNode.setAttribute('data-secondary', String(!ports.ui.shadow.getElementById('course-assignments').hidden));
    ports.ui.shadow.getElementById('task-guide').textContent = courseMode === 'video' ? '播放进度以网站反馈为准。倍速与控件可在“设置”调整。'
      : courseMode === 'discussion' ? '抽取最多3条不同评论，综合为200字以内的回复；发布以网站已发言状态为准。'
      : courseMode === 'collect' ? '只采集，不填写或提交。作业习题最后单独导入。'
      : '只读文字归纳与图文。本轮进度不代表网站完成度。';
    try {
      const context = ports.assignment.referenceContext();
      ports.ui.renderTaskOptions(); ports.ui.renderCourseProgress({ statusText: ports.ui.message, error: lastError });
      ports.ui.renderSubmissionControl(context);
      if (ports.ui.shadow.getElementById('reference-panel').open) ports.ui.renderReferenceLibrary(context);
      ports.ui.renderMaterialControls(); ports.ui.renderAssignmentControls(context);
    }
    catch (error) { ports.ui.shadow.getElementById('course-live-reason').textContent = `状态面板更新失败：${error.name}；可导出调试文件`; }
    ports.ui.verifySettings();
    if (!selecting && Date.now() - lastCatalogCheckAt >= 3000) {
      lastCatalogCheckAt = Date.now();
      try {
        const catalog = ports.platform.catalogSnapshot(ports.platform.documents());
        const button = ports.ui.shadow.getElementById('pick-catalog');
        button.textContent = catalog.index >= 0 ? '目录已识别' : '识别当前目录项';
        button.title = catalog.index >= 0 ? `已找到当前项，共${catalog.items.length}个资源，无需手动设置` : '仅在目录自动识别失败时使用';
      } catch (error) { trace('catalog.summary.error', { name: error.name }); }
    }
    if (Date.now() - lastSampleAt >= 10000) {
      lastSampleAt = Date.now();
      trace('sample', { enabled, selecting, autoResume: ports.video.autoResume, media: ports.video.mediaState(ports.video.state?.video) });
    }
    const faults = detectFaults();
    const key = JSON.stringify(faults);
    if (key !== lastFaultKey) {
      lastFaultKey = key;
      trace('faults.changed', { faults });
    }
  }

  function detectFaults() {
    const faults = [];
    if (!enabled) faults.push('AUTOMATION_DISABLED');
    if (lastError) faults.push('SCRIPT_EXCEPTION');
    if (courseVerificationWaiting) { faults.push('HUMAN_VERIFICATION_REQUIRED'); return faults; }
    if (courseMode !== 'video') {
      if (courseRun?.error) faults.push('COURSE_MODULE_ERROR');
      if (ports.ai.courseModelState.state === 'error') faults.push('MODEL_REQUEST_FAILED');
      return faults;
    }
    if (!ports.video.state) faults.push('NO_ACCESSIBLE_VIDEO');
    else {
      const v = ports.video.state.video;
      if (!ports.video.state.initialized) faults.push('PLAYER_INITIALIZING');
      if (ports.video.state.blocked) faults.push('PLAY_REJECTED');
      if (v.error) faults.push('MEDIA_ERROR');
      if (ports.video.state.initialized && !v.ended) {
        if (v.paused) faults.push('PLAYBACK_PAUSED');
        if (v.playbackRate !== ports.video.speed) faults.push('RATE_NOT_APPLIED');
        if (!v.muted && v.volume !== 0) faults.push('MUTE_NOT_APPLIED');
        if (v.readyState < 2) faults.push('MEDIA_NOT_READY');
      }
      if (ports.video.state.rateUiAttempts >= 3 && v.playbackRate !== ports.video.speed) faults.push('RATE_UI_RETRY_LIMIT');
      if (ports.video.state.muteUiAttempts >= 3 && !v.muted && v.volume !== 0) faults.push('MUTE_UI_RETRY_LIMIT');
      if (ports.video.state.completion.percent === null) faults.push('COMPLETION_NOT_RECOGNIZED');
      if (ports.video.state.replayStopped) faults.push('REPLAY_STOPPED');
      if (ports.video.foregroundMask && [...ports.video.foregroundRecords.values()].some(record => !record.active)) faults.push('FOREGROUND_MASK_FAILED');
    }
    return faults;
  }

  function diagnosticReport() {
    const docs = ports.platform.documents();
    const catalog = ports.platform.catalogSnapshot(docs);
    const videos = [];
    docs.forEach((doc, documentIndex) => {
      for (const video of doc.querySelectorAll('video')) {
        const rect = video.getBoundingClientRect();
        videos.push({
          documentIndex, selected: video === ports.video.state?.video,
          visible: ports.platform.visible(video), width: rect.width, height: rect.height,
          paused: video.paused, ended: video.ended, readyState: video.readyState,
          playbackRate: video.playbackRate, muted: video.muted, volume: video.volume,
          currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : null,
        });
      }
    });
    // 只导出运行状态；不包含完整网址、视频地址、Cookie、账号或网页正文。
    const report = {
      scriptVersion: ports.version,
      scriptManager: typeof GM_info === 'object' ? GM_info.scriptHandler : 'unknown',
      status: ports.ui.message, enabled, selecting, autoResume: ports.video.autoResume, targetSpeed: ports.video.speed,
      config: { startupWaitMs: CONFIG.startupWaitMs, resumeDelayMs: CONFIG.resumeDelayMs, menuWaitMs: CONFIG.menuWaitMs,
        endWaitMs: CONFIG.endWaitMs, maxReplays: CONFIG.maxReplays, maxStagnantReplays: CONFIG.maxStagnantReplays },
      visibility: ports.video.nativeForeground(typeof unsafeWindow === 'object' ? unsafeWindow.document : document),
      foregroundMask: { requested: ports.video.foregroundMask, documents: [...ports.video.foregroundRecords.values()].map(record => ({
        active: record.active, verified: record.active && record.doc.hidden === false && record.doc.visibilityState === 'visible' && record.doc.hasFocus(),
        native: ports.video.nativeForeground(record.doc), blockedEvents: record.blockedEvents, error: record.error,
      })) },
      panelConnected: ports.ui.host.isConnected,
      lastTickAgeMs: lastTickAt === null ? null : Date.now() - lastTickAt,
      lastError,
      documentCount: docs.length,
      iframeCount: docs.reduce((count, doc) => count + doc.querySelectorAll('iframe').length, 0),
      markedControls: { rateMenu: !!ports.video.controls.rateMenu, rate2: !!ports.video.controls.rate2, mute: !!ports.video.controls.mute },
      course: courseDiagnostics(),
      speedMenu: ports.video.state ? (() => {
        const menu = ports.video.speedMenu(ports.video.state);
        return { kind: menu.xt ? 'xt' : 'marked', opener: ports.platform.controlInfo(menu.opener),
          option: ports.platform.controlInfo(menu.option || ports.video.markedControl(ports.video.state, ports.video.controls.rate2, true)),
          chain: ports.video.controlChain(menu.option || menu.opener, menu.root) };
      })() : null,
      catalog: { count: catalog.items.length, currentIndex: catalog.index, resolution: catalog.resolution || null, types: catalog.items.slice(0, 100).map(item => item.type) },
      state: ports.video.state ? {
        current: ports.video.current(ports.video.state), started: ports.video.state.started, manualPause: ports.video.state.manualPause,
        blocked: ports.video.state.blocked, pending: ports.video.state.pending, attempted: ports.video.state.attempted,
        rateLimited: ports.video.state.rateLimited, rateResets: ports.video.state.rateResets,
        endedAt: ports.video.state.endedAt, advanced: ports.video.state.advanced,
        completion: ports.video.state.completion, replayCount: ports.video.state.replayCount, replayBaseline: ports.video.state.replayBaseline,
        stagnantReplays: ports.video.state.stagnantReplays, replayStopped: ports.video.state.replayStopped,
        skipReason: ports.video.state.skipReason,
        rateUiAttempts: ports.video.state.rateUiAttempts, muteUiAttempts: ports.video.state.muteUiAttempts,
        rateDirectAttempts: ports.video.state.rateDirectAttempts, rateUiPending: ports.video.state.rateUiPending,
        settingsConfirmed: !!ports.video.state.settingsConfirmed,
        initialized: ports.video.state.initialized, readySince: ports.video.state.readySince, pauseAt: ports.video.state.pauseAt,
        nextResumeAt: ports.video.state.nextResumeAt, recentResumeCount: ports.video.state.resumeHistory.length,
      } : null,
      faults: detectFaults(), videos, recentMessages: ports.ui.recentMessages, debugEvents, controlInputEvents: ports.platform.controlInputEvents,
    };
    return report;
  }

  function exportDebug() {
    const blob = new Blob([JSON.stringify(diagnosticReport(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `yuketang-debug-${Date.now()}.json`;
    document.documentElement.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function toggle() {
    if (!enabled && workflow?.phase === 'done') cancelWorkflow();
    if (!enabled && courseMode === 'auto') ports.assignment.acknowledgeWrongPause();
    if (!enabled) GM_setValue(`course-material-pause:${memoryCourse}`, null);
    enabled = !enabled;
    if (workflow?.active) writeWorkflow({ ...workflow, paused: !enabled });
    ports.ui.toggleNode.textContent = enabled ? '暂停' : '开始';
    ports.ui.shadow.getElementById('badge').textContent = enabled ? '运行中' : '已暂停';
    if (!enabled) {
      releaseCourse();
      ports.video.syncForegroundMask(ports.platform.documents(), false);
      ports.video.releaseRateMenu(ports.video.state);
      ports.video.state?.video.pause();
      ports.ui.status('自动化已暂停');
    } else {
      if (ports.video.state) ports.video.state.manualPause = false;
      ports.video.resume();
    }
  }

  let started = false;
  function start() {
    if (started) return;
    started = true;
    ports.ui.status(ports.ui.message);
    ports.ui.memorySummary();
    if (ports.video.controls.rateMenu || ports.video.controls.rate2 || ports.video.controls.mute || ports.video.controls.completion || ports.platform.savedSelector) ports.ui.feedback('已加载记住的控件，播放器就绪后自动应用');
    document.defaultView.addEventListener?.('pagehide', () => {
      releaseCourse();
      ports.video.release();
    });
    trace('script.start', { version: ports.version });
    safeTick();
    setInterval(safeTick, CONFIG.pollMs);
  }


  function tick() {
    if (!enabled || selecting) return;
    const docs = ports.platform.documents();
    if (courseTick(docs) || skipAssessment(docs)) { ports.video.suspend(docs); return; }
    ports.video.tick(docs);
  }

  function recordCourseStep(item, outcome = 'processed') {
    if (!item || !inStage(item)) return;
    const stage = courseStage(), phase = stage.phase;
    const processed = { ...(stage.processed || {}) }, steps = { ...(processed[phase] || {}) };
    if (steps[item.id]?.outcome === outcome) return;
    steps[item.id] = { outcome, at: Date.now() }; processed[phase] = steps;
    saveStage({ processed });
  }

  function changeMode(value, preserveWorkflow = false) {
    if (!preserveWorkflow) cancelWorkflow();
    releaseCourse();
    ports.assignment.cancelMaterialJob();
    courseMode = value;
    if (!['video', 'auto', 'discussion'].includes(courseMode)) courseMode = 'video';
    GM_setValue('course-mode', courseMode); tour = null; GM_setValue(tourKey, null);
    courseSubmitEnabled = loadSubmitPreference(); ports.ui.invalidateProgress(); ports.assignment.courseMaterialContext = null;
    ports.ai.clearTaskStatus();
    ports.ui.showPanelView('task'); ports.ui.updateCourseStageUI();
    ports.ui.courseStatus(courseMode === 'discussion' ? '讨论自动化：随机抽取评论，综合后填写与发布' : courseMode === 'auto' ? '作业自动化：优先复用同章图文、知识导引和讲稿；排除讨论' : '视频自动化：倍速、静音与连播');
  }

  function retryCurrentTask() {
    ports.assignment.retryCurrentAssignment();
    const catalog = ports.platform.catalogSnapshot(ports.platform.documents()), item = catalog.items[catalog.index];
    if (item?.chapter) chapterCache.update(item.chapter, data => {
      for (const key of Object.keys(data.sources)) if (data.sources[key].quality === 'missing') delete data.sources[key];
    });
    releaseCourse(); tour = null; GM_setValue(tourKey, null);
    ports.ui.courseStatus('已重置当前处理流程；已保存的材料、草稿和提交记录仍保留');
  }

  function updateCurrentMaterial() {
    const docs = ports.platform.documents(), catalog = ports.platform.catalogSnapshot(docs), item = catalog.items[catalog.index];
    if (item?.chapter && ports.assignment.rememberMaterial(item, docs)) ports.ui.feedback('当前章节材料已记住，刷新后可复用');
    else ports.ui.feedback('暂未识别当前章节材料，请等待正文或知识导引加载', 'error');
  }

  function submissionPreferenceKey() { return `course-auto-submit:${memoryCourse}${courseMode === 'discussion' ? ':discussion' : ''}`; }

  function loadSubmitPreference() { return courseMode !== 'discussion' && GM_getValue(`course-wrong-pause:${memoryCourse}`, null) ? false : GM_getValue(submissionPreferenceKey(), true); }

  function toggleCourseSubmit() {
    const next = !courseSubmitEnabled;
    const review = GM_getValue(`course-wrong-pause:${memoryCourse}`, null);
    if (next && review && courseMode !== 'discussion') {
      const { key } = ports.assignment.referenceContext();
      if (key === review.key) { ports.ui.feedback('本题仍为错误状态；请先核验并点“下一题”，再恢复自动提交', 'error'); return; }
      ports.assignment.acknowledgeWrongPause();
    }
    if (next && courseRun?.filled && !courseRun?.submitting) {
      const { item, q, key } = ports.assignment.referenceContext();
      try {
        if (item?.type === 'discussion') {
          ports.discussion.adoptReviewedReply(item);
        } else {
          ports.assignment.adoptReviewedAnswer(q, key, item);
        }
      } catch (error) { ports.ui.feedback(`请先完成本题核验：${error.message}`, 'error'); return; }
      if (item) ports.assignment.resetAfterReferenceChange();
    }
    try { GM_setValue(submissionPreferenceKey(), next); courseSubmitEnabled = next; }
    catch { courseSubmitEnabled = false; ports.ui.feedback('提交开关保存失败，自动提交保持暂停，请检查油猴存储', 'error'); ports.ui.renderSubmissionControl(); return; }
    ports.ui.courseStatus(next ? '自动提交已恢复，将使用当前填写内容' : '自动提交已暂停；答案仍可生成和填写，等待你核验');
    ports.ui.renderSubmissionControl();
  }

  function clearMediaVisibility() { ports.video.syncForegroundMask(ports.platform.documents(), false); }

  function writeWorkflow(value) { GM_setValue(workflowKey, value); workflow = value; }

  function cancelWorkflow() {
    if (workflow?.active || workflow?.phase === 'done' && !workflow.stoppedAt) writeWorkflow({ ...workflow, active: false, paused: false, stoppedAt: Date.now() });
  }

  function workflowSnapshot() {
    if (!workflow) return null;
    const labels = { video: '视频', discussion: '讨论', materials: '作业 · 收集材料', assignments: '作业 · 完成作业', done: '流程遍历结束' };
    return { active: !!workflow.active, paused: !!workflow.paused, phase: workflow.phase, label: labels[workflow.phase],
      videoProcessed: Object.keys(workflow.videos || {}).length, videoSkipped: Object.values(workflow.videos || {}).filter(item => item.outcome === 'skipped').length,
      coverage: workflow.coverage || null, startedAt: workflow.startedAt, finishedAt: workflow.finishedAt || null };
  }

  function assignmentCovered(item, stage, chapterData = null, indexedQuestions = null) {
    if (ports.platform.moduleCompleted(item) || ports.assignment.assignmentCompleted(item, chapterData, indexedQuestions)) return true;
    const hasQuestions = item.chapter && (indexedQuestions ? indexedQuestions.length > 0 : Object.keys((chapterData || chapterCache.read(item.chapter)).questions).some(key => key.startsWith(`${item.id}:`) && /^\d+$/.test(key.slice(item.id.length + 1))));
    return !hasQuestions && stage?.processed?.assignments?.[item.id]?.outcome === 'processed';
  }

  function workflowCoverage(catalog) {
    const savedAuto = GM_getValue(`course-stage:${memoryCourse}:auto`, {});
    const chapters = new Map();
    const questionIndex = new Map();
    const dataFor = item => {
      if (!item.chapter) return null;
      if (!chapters.has(item.chapter.key)) chapters.set(item.chapter.key, chapterCache.read(item.chapter));
      return chapters.get(item.chapter.key);
    };
    const questionsFor = item => {
      const data = dataFor(item);
      if (!questionIndex.has(item.chapter.key)) {
        const index = new Map();
        for (const [key, question] of Object.entries(data.questions)) {
          const separator = key.lastIndexOf(':');
          if (separator < 0 || !/^\d+$/.test(key.slice(separator + 1))) continue;
          const task = key.slice(0, separator);
          if (!index.has(task)) index.set(task, []);
          index.get(task).push(question);
        }
        questionIndex.set(item.chapter.key, index);
      }
      return questionIndex.get(item.chapter.key).get(item.id) || [];
    };
    const summarize = (items, completed) => ({ total: items.length, completed: items.filter(completed).length });
    const useCourse = ports.assignment.referenceLibrary.read().useCourse;
    const materials = catalog.items.filter(item => item.type === 'article' || item.type === 'video' && useCourse);
    return {
      video: summarize(catalog.items.filter(item => item.type === 'video'), item => ports.video.catalogCompletion(item) === 100 || workflow?.videos?.[item.id]?.outcome === 'confirmed'),
      discussion: summarize(catalog.items.filter(item => item.type === 'discussion'), item => ports.platform.moduleCompleted(item) || item.chapter && dataFor(item).submissions[`${item.id}:discussion`]?.phase === 'confirmed'),
      materials: summarize(materials, item => !!cachedMaterial(item, dataFor(item)) || skippedPdfMaterial(item, dataFor(item))),
      assignments: summarize(catalog.items.filter(item => item.type === 'assignment'), item => !!item.chapter && assignmentCovered(item, savedAuto, dataFor(item), questionsFor(item))),
    };
  }

  function prepareWorkflowStages() {
    for (const mode of ['auto', 'discussion']) {
      const key = `course-stage:${memoryCourse}:${mode}`, saved = GM_getValue(key, null);
      if (!saved?.processed) continue;
      const processed = Object.fromEntries(Object.entries(saved.processed).map(([phase, records]) => [phase, Object.fromEntries(Object.entries(records || {}).filter(([, record]) => ['processed', 'cached'].includes(record?.outcome)))]));
      GM_setValue(key, { ...saved, processed });
    }
  }

  function startWorkflow() {
    if (Course.courseId(location.href) !== memoryCourse) { ports.ui.courseStatus('课程已切换，请刷新当前课程页后再启动一键流程'); ports.ui.feedback('课程已切换，请刷新后再启动一键流程', 'error'); return; }
    if (ports.platform.humanVerification(ports.platform.documents())) { ports.ui.courseStatus('请先手动完成当前验证，再启动一键流程'); ports.ui.feedback('请先手动完成当前验证，再启动一键流程', 'error'); return; }
    if (!ownsCourse()) { ports.ui.courseStatus('另一标签页正在处理本课程，请先暂停该页'); ports.ui.feedback('另一标签页正在处理本课程，请先暂停该页', 'error'); return; }
    if (!workflow?.active) {
      prepareWorkflowStages();
      const videos = Object.fromEntries(Object.entries(workflow?.videos || {}).filter(([, record]) => record.outcome === 'confirmed'));
      writeWorkflow({ version: 1, course: memoryCourse, active: true, paused: false, phase: 'video', videos, positioned: false, startedAt: Date.now() });
    }
    else writeWorkflow({ ...workflow, paused: false });
    GM_setValue(`course-material-pause:${memoryCourse}`, null);
    enabled = true; ports.ui.toggleNode.textContent = '暂停';
    releaseCourse(); ports.assignment.cancelMaterialJob();
    restoreWorkflowMode(); ports.ui.showPanelView('task');
    ports.ui.courseStatus(`一键流程已启动：${workflowSnapshot().label}；可随时暂停`);
  }

  function setAssignmentAction(value, preserveWorkflow = false) {
    if (!['materials', 'complete'].includes(value)) return;
    if (!preserveWorkflow) cancelWorkflow();
    if (courseMode !== 'auto') changeMode('auto', true);
    releaseCourse(); ports.assignment.cancelMaterialJob(); tour = null; GM_setValue(tourKey, null);
    assignmentAction = value; GM_setValue(assignmentActionKey, value);
    const stage = courseStage(), phase = value === 'complete' ? 'assignments' : 'materials';
    saveStage({ phase, materialsDone: value === 'complete' || stage.materialsDone, assignmentsDone: false,
      ...(value === 'materials' ? { materialsDone: false } : {}), processed: { ...(stage.processed || {}), [phase]: {} } });
    ports.ui.invalidateProgress(); ports.ui.updateCourseStageUI();
    ports.ui.courseStatus(value === 'complete' ? '完成作业：优先使用所选材料与缓存，未选题型直接跳过' : '收集材料：复用已有正文，仅补采缺失的图文、知识导引和讲稿');
  }

  function restoreWorkflowMode() {
    const mode = workflow.phase === 'video' ? 'video' : workflow.phase === 'discussion' ? 'discussion' : 'auto';
    if (courseMode !== mode) changeMode(mode, true);
    if (mode === 'auto') {
      assignmentAction = workflow.phase === 'assignments' ? 'complete' : 'materials'; GM_setValue(assignmentActionKey, assignmentAction);
      const phase = assignmentAction === 'complete' ? 'assignments' : 'materials';
      if (courseStage().phase !== phase) saveStage({ phase, materialsDone: phase === 'assignments', assignmentsDone: false });
    }
  }

  function advanceWorkflow(catalog) {
    if (!workflow?.active) return;
    const next = { video: 'discussion', discussion: 'materials', materials: 'assignments', assignments: 'done' }[workflow.phase];
    writeWorkflow({ ...workflow, phase: next, coverage: workflowCoverage(catalog), positioned: false, navigation: null, ...(next === 'done' ? { active: false, finishedAt: Date.now() } : {}) });
    releaseCourse();
    if (next === 'done') {
      enabled = false; ports.ui.toggleNode.textContent = '开始';
      ports.ui.courseStatus('一键流程已遍历结束；跳过、待确认及错误结果请以网站反馈为准'); return;
    }
    restoreWorkflowMode();
    const stage = courseStage(), phase = next === 'assignments' ? 'assignments' : 'materials';
    if (next !== 'video') saveStage({ phase, discussionsDone: false, materialsDone: next === 'assignments', assignmentsDone: false });
    ports.ui.invalidateProgress(); ports.ui.courseStatus(`一键流程进入：${workflowSnapshot().label}`);
    trace('workflow.phase', { phase: next });
  }

  function nextWorkflowVideo(catalog) {
    return catalog.items.find(item => item.type === 'video' && !workflow.videos?.[item.id] && ports.video.catalogCompletion(item) !== 100);
  }

  function workflowNavigate(target) {
    if (!target) return false;
    if (workflow.navigation?.target === target.id && Date.now() - workflow.navigation.at < 15000) { ports.ui.courseStatus('一键流程等待已点击的目录项加载'); return true; }
    if (workflow.navigation?.target === target.id) {
      enabled = false; ports.ui.toggleNode.textContent = '开始'; writeWorkflow({ ...workflow, paused: true, navigation: null });
      ports.video.state?.video.pause();
      ports.ui.courseStatus('目录点击后尚未确认跳转，一键流程已暂停；核验后可继续'); return true;
    }
    if (!ports.platform.available(target.element) || ports.platform.resourceLocked(target.element)) { ports.ui.courseStatus('下一任务暂未解锁或不可用，等待页面就绪'); return true; }
    const previous = workflow;
    writeWorkflow({ ...workflow, navigation: { target: target.id, at: Date.now() } });
    if (!courseNavigate(target)) writeWorkflow(previous);
    return true;
  }

  function workflowTick(docs) {
    if (!workflow?.active) return false;
    if (Course.courseId(location.href) !== memoryCourse) { cancelWorkflow(); enabled = false; ports.ui.courseStatus('课程已切换，一键流程已停止'); return true; }
    if (workflow.paused || !enabled) return true;
    if (ports.assignment.courseInputHold || ports.platform.pauseBlocker(docs)) { ports.ui.courseStatus('一键流程等待编辑或弹窗处理'); return true; }
    if (!ownsCourse()) { ports.ui.courseStatus('另一标签页正在处理本课程，本页等待'); return true; }
    restoreWorkflowMode();
    const catalog = ports.platform.catalogSnapshot(docs), item = catalog.items[catalog.index];
    if (!catalog.items.length) { ports.ui.courseStatus('一键流程等待课程目录加载'); return true; }
    const coverage = workflowCoverage(catalog);
    if (Course.fingerprint(coverage) !== Course.fingerprint(workflow.coverage || null)) writeWorkflow({ ...workflow, coverage });
    if (workflow.navigation?.target === item?.id) writeWorkflow({ ...workflow, navigation: null, positioned: true });
    if (workflow.phase === 'video') {
      if (item?.type === 'video' && item.chapter && ports.video.catalogCompletion(item) !== 100 && workflow.videos?.[item.id]?.outcome !== 'confirmed') ports.assignment.captureVideoMaterial(item, docs);
      if (workflow.positioned && item?.type === 'video' && !workflow.videos?.[item.id] && ports.video.catalogCompletion(item) !== 100) return false;
      const target = nextWorkflowVideo(catalog);
      if (target) {
        if (item?.id === target.id) { writeWorkflow({ ...workflow, positioned: true }); return false; }
        return workflowNavigate(target);
      }
      advanceWorkflow(catalog); return true;
    }
    if (workflow.phase === 'assignments' && tour) return false;
    const type = workflow.phase === 'discussion' ? 'discussion' : workflow.phase === 'assignments' ? 'assignment' : null;
    reuseMaterialCoverage(catalog);
    const target = nextPlannedModule(catalog, true);
    const unknownChapter = catalog.items.some(entry => (type ? entry.type === type : inStage(entry)) && !entry.chapter);
    if (!target) {
      if (unknownChapter) { ports.ui.courseStatus('一键流程等待当前任务所属章节识别'); return true; }
      finishCourseStage(catalog); return true;
    }
    if (!item?.chapter || !inStage(item) || !needsModule(item)) return workflowNavigate(target);
    return false;
  }

  function videoFinished(s, docs) {
    const catalog = ports.platform.catalogSnapshot(docs), item = catalog.items[catalog.index];
    if (item?.type === 'video' && item.chapter && !ports.assignment.captureVideoMaterial(item, docs).ready) {
      ports.ui.status('视频已结束，等待当前知识导引与讲稿加载稳定'); return true;
    }
    if (!workflow?.active || workflow.phase !== 'video') return false;
    if (!item || item.type !== 'video' || !ownsCourse() || ports.platform.humanVerification(docs)) return true;
    writeWorkflow({ ...workflow, videos: { ...(workflow.videos || {}), [item.id]: { outcome: s.completion.percent === 100 ? 'confirmed' : 'skipped', at: Date.now() } }, navigation: null });
    s.advanced = true;
    const target = nextWorkflowVideo(catalog);
    if (target) workflowNavigate(target); else advanceWorkflow(catalog);
    return true;
  }

  const api = {
    get startWorkflow() { return startWorkflow; },
    get cancelWorkflow() { return cancelWorkflow; },
    get workflowSnapshot() { return workflowSnapshot; },
    get setAssignmentAction() { return setAssignmentAction; },
    get assignmentAction() { return assignmentAction; },
    get videoFinished() { return videoFinished; },
    get clearMediaVisibility() { return clearMediaVisibility; },
    get courseSubmitEnabled() { return courseSubmitEnabled; }, set courseSubmitEnabled(value) { courseSubmitEnabled = value; },
    get toggleCourseSubmit() { return toggleCourseSubmit; },
    get updateCurrentMaterial() { return updateCurrentMaterial; },
    get retryCurrentTask() { return retryCurrentTask; },
    get changeMode() { return changeMode; },
    get recordCourseStep() { return recordCourseStep; },
    get CONFIG() { return CONFIG; },
    get beginAssignmentImport() { return beginAssignmentImport; },
    get chapterCache() { return chapterCache; },
    get continueTour() { return continueTour; },
    get courseMode() { return courseMode; }, set courseMode(value) { courseMode = value; },
    get courseNavigate() { return courseNavigate; },
    get courseRun() { return courseRun; }, set courseRun(value) { courseRun = value; },
    get courseStage() { return courseStage; },
    get courseVerificationWaiting() { return courseVerificationWaiting; }, set courseVerificationWaiting(value) { courseVerificationWaiting = value; },
    get diagnosticReport() { return diagnosticReport; },
    get enabled() { return enabled; }, set enabled(value) { enabled = value; },
    get exportDebug() { return exportDebug; },
    get exportMemory() { return exportMemory; },
    get finishCourseStage() { return finishCourseStage; },
    get inStage() { return inStage; },
    get launchCourse() { return launchCourse; },
    get memoryCourse() { return memoryCourse; },
    get moduleStateText() { return moduleStateText; },
    get nextCatalogVideo() { return nextCatalogVideo; },
    get nextModule() { return nextModule; },
    get nextPlannedModule() { return nextPlannedModule; },
    get ownsCourse() { return ownsCourse; },
    get releaseCourse() { return releaseCourse; },
    get resumeCoursePlan() { return resumeCoursePlan; },
    get runCurrent() { return runCurrent; },
    get safeTick() { return safeTick; },
    get saveStage() { return saveStage; },
    get selecting() { return selecting; }, set selecting(value) { selecting = value; },
    get skippedPdfMaterial() { return skippedPdfMaterial; },
    get start() { return start; },
    get toggle() { return toggle; },
    get tour() { return tour; }, set tour(value) { tour = value; },
    get tourKey() { return tourKey; },
    get trace() { return trace; },
  };
  if (options.testing) api.testing = {
    get workflowCoverage() { return workflowCoverage; },
    get startWorkflow() { return startWorkflow; },
    get workflowSnapshot() { return workflowSnapshot; },
    get workflowTick() { return workflowTick; },
    get setAssignmentAction() { return setAssignmentAction; },
    get videoFinished() { return videoFinished; },
    get courseSubmitEnabled() { return courseSubmitEnabled; }, set courseSubmitEnabled(value) { courseSubmitEnabled = value; },
    get submissionPreferenceKey() { return submissionPreferenceKey; }, set submissionPreferenceKey(value) { submissionPreferenceKey = value; },
    get loadSubmitPreference() { return loadSubmitPreference; }, set loadSubmitPreference(value) { loadSubmitPreference = value; },
    get toggleCourseSubmit() { return toggleCourseSubmit; }, set toggleCourseSubmit(value) { toggleCourseSubmit = value; },
    get recordCourseStep() { return recordCourseStep; }, set recordCourseStep(value) { recordCourseStep = value; },
    get CONFIG() { return CONFIG; },
    get enabled() { return enabled; }, set enabled(value) { enabled = value; },
    get selecting() { return selecting; }, set selecting(value) { selecting = value; },
    get lastTickAt() { return lastTickAt; }, set lastTickAt(value) { lastTickAt = value; },
    get lastError() { return lastError; }, set lastError(value) { lastError = value; },
    get debugEvents() { return debugEvents; },
    get lastSampleAt() { return lastSampleAt; }, set lastSampleAt(value) { lastSampleAt = value; },
    get lastFaultKey() { return lastFaultKey; }, set lastFaultKey(value) { lastFaultKey = value; },
    get nonVideoRoute() { return nonVideoRoute; }, set nonVideoRoute(value) { nonVideoRoute = value; },
    get nonVideoSince() { return nonVideoSince; }, set nonVideoSince(value) { nonVideoSince = value; },
    get nonVideoAdvanced() { return nonVideoAdvanced; }, set nonVideoAdvanced(value) { nonVideoAdvanced = value; },
    get lastCatalogCheckAt() { return lastCatalogCheckAt; }, set lastCatalogCheckAt(value) { lastCatalogCheckAt = value; },
    get courseMode() { return courseMode; }, set courseMode(value) { courseMode = value; },
    get courseRun() { return courseRun; }, set courseRun(value) { courseRun = value; },
    get courseOwner() { return courseOwner; },
    get trace() { return trace; }, set trace(value) { trace = value; },
    get memoryCourse() { return memoryCourse; },
    get chapterCache() { return chapterCache; },
    get tourKey() { return tourKey; },
    get leaseKey() { return leaseKey; },
    get tour() { return tour; }, set tour(value) { tour = value; },
    get courseVerificationWaiting() { return courseVerificationWaiting; }, set courseVerificationWaiting(value) { courseVerificationWaiting = value; },
    get catalogEntryRecovery() { return catalogEntryRecovery; }, set catalogEntryRecovery(value) { catalogEntryRecovery = value; },
    get stageKey() { return stageKey; }, set stageKey(value) { stageKey = value; },
    get courseStage() { return courseStage; }, set courseStage(value) { courseStage = value; },
    get saveStage() { return saveStage; }, set saveStage(value) { saveStage = value; },
    get inStage() { return inStage; }, set inStage(value) { inStage = value; },
    get cachedMaterial() { return cachedMaterial; }, set cachedMaterial(value) { cachedMaterial = value; },
    get skippedPdfMaterial() { return skippedPdfMaterial; }, set skippedPdfMaterial(value) { skippedPdfMaterial = value; },
    get needsModule() { return needsModule; }, set needsModule(value) { needsModule = value; },
    get reuseMaterialCoverage() { return reuseMaterialCoverage; }, set reuseMaterialCoverage(value) { reuseMaterialCoverage = value; },
    get nextPlannedModule() { return nextPlannedModule; }, set nextPlannedModule(value) { nextPlannedModule = value; },
    get resumeCoursePlan() { return resumeCoursePlan; }, set resumeCoursePlan(value) { resumeCoursePlan = value; },
    get finishCourseStage() { return finishCourseStage; }, set finishCourseStage(value) { finishCourseStage = value; },
    get beginAssignmentImport() { return beginAssignmentImport; }, set beginAssignmentImport(value) { beginAssignmentImport = value; },
    get ownsCourse() { return ownsCourse; }, set ownsCourse(value) { ownsCourse = value; },
    get releaseCourse() { return releaseCourse; }, set releaseCourse(value) { releaseCourse = value; },
    get runCurrent() { return runCurrent; }, set runCurrent(value) { runCurrent = value; },
    get launchCourse() { return launchCourse; }, set launchCourse(value) { launchCourse = value; },
    get moduleStateText() { return moduleStateText; }, set moduleStateText(value) { moduleStateText = value; },
    get courseNavigate() { return courseNavigate; }, set courseNavigate(value) { courseNavigate = value; },
    get enterDiscussionFromUnresolvedCatalog() { return enterDiscussionFromUnresolvedCatalog; }, set enterDiscussionFromUnresolvedCatalog(value) { enterDiscussionFromUnresolvedCatalog = value; },
    get nextModule() { return nextModule; }, set nextModule(value) { nextModule = value; },
    get ensureChapter() { return ensureChapter; }, set ensureChapter(value) { ensureChapter = value; },
    get continueTour() { return continueTour; }, set continueTour(value) { continueTour = value; },
    get courseTick() { return courseTick; }, set courseTick(value) { courseTick = value; },
    get exportMemory() { return exportMemory; }, set exportMemory(value) { exportMemory = value; },
    get courseDiagnostics() { return courseDiagnostics; }, set courseDiagnostics(value) { courseDiagnostics = value; },
    get nextCatalogVideo() { return nextCatalogVideo; }, set nextCatalogVideo(value) { nextCatalogVideo = value; },
    get skipAssessment() { return skipAssessment; }, set skipAssessment(value) { skipAssessment = value; },
    get tick() { return tick; }, set tick(value) { tick = value; },
    get safeTick() { return safeTick; }, set safeTick(value) { safeTick = value; },
    get detectFaults() { return detectFaults; }, set detectFaults(value) { detectFaults = value; },
    get diagnosticReport() { return diagnosticReport; }, set diagnosticReport(value) { diagnosticReport = value; },
    get exportDebug() { return exportDebug; }, set exportDebug(value) { exportDebug = value; },
    get toggle() { return toggle; }, set toggle(value) { toggle = value; }
  };
  return api;
}
module.exports = createApplication;
