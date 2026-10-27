'use strict';

// 讨论对象：评论采样、草稿、发布确认与讨论遍历。
function createDiscussionAutomation(ports, options = {}) {
  const Course = ports.core;
  function discussionPage(doc = document) {
    const prompt = Course.text(doc.querySelector('.main-text-attachment .custom-ueditor')?.textContent);
    const comments = [...doc.querySelectorAll('.forum-content .forum-item > .publish-forum-topic > .comment-text')]
      .filter(node => ports.platform.visible(node) && !node.closest?.('.replyBox'))
      .map(node => (node.innerText || node.textContent || '').trim()).filter(Boolean);
    return { prompt, comments, editor: doc.querySelector('.forum-publish textarea[placeholder="发表你的观点..."]'),
      send: doc.querySelector('.forum-publish .prompt-send-btn') };
  }

  function discussionCurrent(run, hash) {
    if (!ports.app.runCurrent(run) || ports.app.courseMode !== 'discussion' || ports.platform.pauseBlocker(ports.platform.documents()) || /已发言|已完成/.test(ports.app.moduleStateText())) return false;
    const catalog = ports.platform.catalogSnapshot(ports.platform.documents()), item = catalog.items[catalog.index];
    return item?.id === run.item && item.type === 'discussion' && Course.fingerprint(discussionPage().prompt) === hash;
  }

  function confirmDiscussion(item, catalog, run) {
    if (ports.app.courseMode !== 'discussion' || item.type !== 'discussion') return false;
    const saved = ports.app.chapterCache.read(item.chapter), key = `${item.id}:discussion`, submission = saved.submissions[key];
    let evidence = submission?.phase === 'confirmed' ? 'saved-confirmation' : null;
    // 路由先变、正文后加载时，不能把上一讨论残留的“已发言”算到新讨论。
    if (!evidence && Date.now() - run.since < 4000) return false;
    if (!evidence && /已发言|已完成/.test(ports.app.moduleStateText())) evidence = 'module-status';
    if (!evidence && submission?.phase === 'sending' && Number.isInteger(submission.matchingBefore)) {
      const page = discussionPage(), draft = saved.drafts[key], text = draft?.text?.trim();
      // 页面有时已新增本人评论，却未及时更新右上角状态。必须同时看到本次
      // 发布正文的数量增加、输入框清空及同一题干；单独出现相同评论不足以确认。
      if (text && page.editor && !page.editor.value?.trim() && submission.hash === Course.fingerprint(page.prompt) &&
        submission.textHash === Course.fingerprint(text) &&
        page.comments.filter(comment => Course.text(comment) === Course.text(text)).length > submission.matchingBefore) evidence = 'new-comment-and-cleared-editor';
    }
    if (!evidence) return false;
    if (run.advanced) return true;
    // 仅接受模块状态或本次发布的组合证据；不凭“删除”或原有相同评论确认。
    if (ports.app.chapterCache.read(item.chapter).submissions[`${item.id}:discussion`]?.phase !== 'confirmed') {
      ports.app.chapterCache.update(item.chapter, data => {
        const key = `${item.id}:discussion`;
        data.submissions[key] = { ...data.submissions[key], phase: 'confirmed', confirmedAt: Date.now(), confirmation: evidence };
      });
    }
    if (run.pending) { ports.ai.cancelTask(); }
    run.pending = false; run.error = null; run.waitingReview = false;
    run.discussionConfirmation = evidence;
    ports.ai.clearTaskStatus();
    ports.ui.noteCourseAction('讨论发布已确认，准备进入下一个讨论');
    ports.app.trace('course.discussion.confirmed', { evidence }); ports.app.nextModule(catalog, run); return true;
  }

  function discussionTick(item, catalog, run) {
    const page = discussionPage(), prompt = page.prompt;
    if (!prompt) { ports.ui.courseStatus('等待讨论题正文加载'); return true; }
    const key = `${item.id}:discussion`, hash = Course.fingerprint(prompt), saved = ports.app.chapterCache.read(item.chapter);
    const previousSample = saved.discussionSamples?.[key], previousDraft = saved.drafts[key];
    if (previousSample?.hash === hash) run.discussion = { total: previousSample.total, unique: previousSample.unique,
      selected: previousSample.samples.length, allSame: previousSample.allSame,
      ...(previousDraft?.text ? { characters: [...previousDraft.text.trim()].length } : {}) };
    if (saved.submissions[key]) { ports.ui.courseStatus('讨论发送记录已保存，等待网站显示“已发言”；不会重复发送'); return true; }
    let sample = saved.discussionSamples?.[key];
    if (!sample || sample.hash !== hash || sample.version !== 1) {
      const selected = Course.sampleDiscussionComments(page.comments);
      if (!selected.samples.length) {
        run.commentWaitAt ??= Date.now();
        if (Date.now() - run.commentWaitAt < 15000) { ports.ui.courseStatus('等待已有评论加载（最多15秒）'); return true; }
        run.outcome = 'skipped'; ports.ui.courseStatus('没有可用评论，本讨论未作答并跳过'); ports.app.nextModule(catalog, run); return true;
      }
      sample = { ...selected, hash, version: 1, at: Date.now() };
      ports.app.chapterCache.update(item.chapter, data => {
        data.discussionSamples ??= {}; data.discussionSamples[key] = sample;
        data.questions[key] = { task: item.id, type: 'discussion', prompt, hash };
      });
      ports.ui.noteCourseAction(`已抽取${sample.samples.length}条不同评论（共${sample.unique}种）`);
    }
    run.discussion = { total: sample.total, unique: sample.unique, selected: sample.samples.length, allSame: sample.allSame };
    ports.app.launchCourse(run, async () => {
      if (!discussionCurrent(run, hash)) return;
      let draft = ports.app.chapterCache.read(item.chapter).drafts[key];
      const sampleHash = Course.fingerprint(sample.samples);
      if (!draft || draft.hash !== hash || draft.sampleHash !== sampleHash || draft.discussionVersion !== 1) {
        const materials = sample.samples.map((text, i) => ({ id: `${key}:comment:${i + 1}`, chapterKey: item.chapter.key,
          title: `参考评论${i + 1}`, kind: 'discussion-comment', text }));
        const task = { kind: 'discussion', chapterKey: item.chapter.key, chapterTitle: item.chapter.title, prompt, materials,
          discussionSpec: { version: 1, maxCharacters: 200, allSame: sample.allSame, selected: materials.length } };
        let result;
        if (sample.allSame && [...sample.samples[0]].length <= 200) {
          result = { text: sample.samples[0], sources: [materials[0].id], insufficient: false };
        } else {
          ports.ui.courseStatus(`已抽取${sample.samples.length}条不同评论，正在整理200字以内的讨论正文`);
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const response = await ports.ai.localModel(attempt ? { ...task, revision: '上次正文超过200字，请压缩为200字以内（按Unicode字符计数），保留主要观点。' } : task);
              if (!discussionCurrent(run, hash)) return;
              result = Course.parseModel(JSON.stringify(response), task); break;
            } catch (error) {
              if (!discussionCurrent(run, hash)) return;
              if ((error.code || error.message) !== 'MODEL_DISCUSSION_TOO_LONG') throw error;
              if (attempt) throw Error('讨论正文仍超过200字，自动发布已停止；请核验模型或重试');
              ports.ui.noteCourseAction('讨论超过200字，正在请求压缩一次');
            }
          }
        }
        if (!discussionCurrent(run, hash)) return;
        draft = { ...result, text: result.text.trim(), hash, sampleHash, discussionVersion: 1 };
        ports.app.chapterCache.update(item.chapter, data => { data.drafts[key] = draft; });
        ports.ui.noteCourseAction(`已保存讨论草稿（${[...draft.text].length}/200字）`);
      }
      if (!discussionCurrent(run, hash)) return;
      const current = discussionPage(), text = draft.text?.trim();
      if (!text || [...text].length > 200) throw Error('讨论草稿为空或超过200字，未发送');
      run.discussion.characters = [...text].length;
      const editor = current.editor;
      if (!editor) { ports.ui.courseStatus('等待讨论输入框加载'); run.nextAt = Date.now() + 500; return; }
      if (run.filled !== key) {
        if (editor.value?.trim() && editor.value.trim() !== text) throw Error('讨论框已有不同内容，已保留原内容；请先核验');
        ports.dom.setField(editor, text); run.filled = key; run.nextAt = Date.now() + 1200;
        ports.ui.courseStatus(`讨论正文已填写（${[...text].length}/200字），等待页面校验`);
        ports.ui.noteCourseAction('已填写讨论，等待页面校验后发布'); return;
      }
      if (editor.value?.trim() !== text) throw Error('讨论内容已改变；请暂停并恢复自动提交以采用你修改的正文');
      run.waitingReview = !ports.app.courseSubmitEnabled;
      if (!ports.app.courseSubmitEnabled) { ports.ui.courseStatus('讨论已填写，自动提交暂停；核验后可手动发布或恢复自动提交'); return; }
      if (!discussionCurrent(run, hash) || !ports.app.courseSubmitEnabled) return;
      if (/已发言|已完成/.test(ports.app.moduleStateText())) return;
      const send = current.send;
      if (!send || !ports.platform.visible(send) || !ports.platform.available(send) || send.classList.contains('disabled') || send.getAttribute?.('aria-disabled') === 'true') {
        run.sendWaitAt ??= Date.now();
        if (Date.now() - run.sendWaitAt > 12000) throw Error('讨论已填写，但发布控件仍禁用；请核验后重试');
        ports.ui.courseStatus('讨论已填写，等待网站启用发布控件'); run.nextAt = Date.now() + 500; return;
      }
      // 先持久保存待确认状态，刷新或点击失败均不盲目重发。
      ports.app.chapterCache.update(item.chapter, data => { data.submissions[key] = { phase: 'sending', hash, sampleHash, at: Date.now(),
        textHash: Course.fingerprint(text), matchingBefore: current.comments.filter(comment => Course.text(comment) === Course.text(text)).length }; });
      send.click(); run.submitting = key;
      ports.ui.noteCourseAction('讨论已点击发布，等待网站确认'); ports.app.trace('course.discussion.sent', { selected: sample.samples.length, characters: [...text].length });
    });
    return true;
  }

  function adoptReviewedReply(item) {
    const text = discussionPage().editor?.value?.trim();
    if (!text || [...text].length > 200) throw Error('讨论内容为空或超过200字');
    const id = `${item.id}:discussion`;
    ports.app.chapterCache.update(item.chapter, data => { if (data.drafts[id]) data.drafts[id] = { ...data.drafts[id], text }; });
  }

  const api = {
    get adoptReviewedReply() { return adoptReviewedReply; },
    get confirmDiscussion() { return confirmDiscussion; },
    get discussionTick() { return discussionTick; }
  };
  if (options.testing) api.testing = {
    get discussionPage() { return discussionPage; }, set discussionPage(value) { discussionPage = value; },
    get discussionCurrent() { return discussionCurrent; }, set discussionCurrent(value) { discussionCurrent = value; },
    get confirmDiscussion() { return confirmDiscussion; }, set confirmDiscussion(value) { confirmDiscussion = value; },
    get discussionTick() { return discussionTick; }, set discussionTick(value) { discussionTick = value; }
  };
  return api;
}
module.exports = createDiscussionAutomation;
