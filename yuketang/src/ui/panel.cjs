'use strict';

// 只创建面板和样式，不执行课程任务。
function mountPanel(version) {
  const host = document.createElement('div');

  host.id = 'ykt-autoplay-assistant';

  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { position:fixed; right:16px; bottom:16px; z-index:2147483647; color-scheme:light; }
      * { box-sizing:border-box; } [hidden] { display:none!important; }
      section { width:320px; max-width:calc(100vw - 24px); max-height:calc(100vh - 32px); overflow:auto;
        border:1px solid #dce3df; border-radius:16px; background:#fff; color:#22332c;
        font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;
        box-shadow:0 12px 40px #183b2522; }
      header { display:flex; align-items:center; gap:9px; min-height:52px; padding:14px 16px 12px; position:sticky; top:0; background:white; z-index:2; cursor:grab; touch-action:none; user-select:none; }
      header[data-dragging="true"] { cursor:grabbing; }
      strong { font-size:15px; font-weight:650; } #badge { margin-left:auto; color:#24734a; font-size:11px; }
      button { cursor:pointer; font:inherit; border:1px solid #dce3df; border-radius:8px;
        padding:8px 10px; background:#fff; color:#30473a; transition:background .15s; }
      button:hover { background:#f0f5f2; } button:focus-visible,input:focus-visible,select:focus-visible,summary:focus-visible { outline:2px solid #39805a; outline-offset:2px; }
      #collapse { border:0; padding:0 3px; font-size:19px; color:#79867e; line-height:24px; }
      .content { padding:0 16px 14px; } .state { padding:12px; border-radius:10px; background:#f2f7f4; }
      .tabs { display:flex; gap:4px; padding:4px; margin:0 0 14px; background:#f2f5f3; border-radius:10px; position:sticky; top:52px; z-index:2; }
      .tabs button { flex:1; border:0; padding:6px; color:#718077; background:transparent; font-size:12px; }
      .tabs button[aria-selected="true"] { background:white; color:#215f3e; font-weight:650; box-shadow:0 1px 4px #173b2512; }
      .mode-label { display:block; font-size:11px; color:#718077; margin-bottom:8px; }
      .mode-label select { color:#30473a; background:white; }
      h3 { margin:0 0 5px; font-size:13px; font-weight:650; }
      .hint { margin:7px 0 0; color:#718077; font-size:11px; line-height:1.6; overflow-wrap:anywhere; }
      .settings-group + .settings-group { margin-top:16px; padding-top:14px; border-top:1px solid #e9eeeb; }
      #model-settings-state { padding:9px 10px; border-radius:8px; background:#f2f7f4; font-size:12px; }
      #model-settings-state[data-kind="error"] { background:#fff0eb; color:#9b4227; }
      a { color:#27764e; text-underline-offset:3px; font-size:12px; }
      #course-assignments { width:100%; margin-top:10px; }
      #actual { margin:0; font-weight:650; color:#1f6341; font-size:14px; }
      #status { margin:5px 0 0; font-size:12px; color:#697a70; overflow-wrap:anywhere; }
      #feedback { margin:0 16px 12px; padding:9px 12px; border-radius:8px; background:#eaf5ee; color:#21613f; font-size:12px; }
      #feedback[data-kind="error"] { background:#fff0eb; color:#9b4227; }
      #setup-result { margin:7px 0 0; font-size:12px; color:#627368; }
      #completion { margin:6px 0 0; font-size:12px; color:#21613f; }
      #course-live p { margin:7px 0 0; font-size:12px; overflow-wrap:anywhere; }
      #course-live .live-head { display:flex; justify-content:space-between; gap:8px; font-weight:650; }
      #course-live[data-state="error"] { background:#fff0eb; }
      #course-live[data-state="waiting"] { background:#fff8e8; }
      #course-live-current { font-weight:600; }
      #course-live-stage,#course-live-cache { color:#718077; font-size:11px!important; }
      #course-live-model-brief { padding-top:8px; border-top:1px solid #244b3510; color:#627368; font-size:11px!important; }
      #course-live-progress { width:100%; height:7px; accent-color:#27764e; }
      #course-live-heartbeat,#course-live-action,#course-live-requests { color:#6b7a71; font-size:11px!important; }
      .actions { display:flex; gap:8px; margin:12px 0 0; } .actions button { flex:1; }
      #toggle,.primary { background:#27764e; color:white; border-color:#27764e; }
      #toggle:hover,.primary:hover { background:#1e6340; }
      #toggle[data-secondary="true"] { background:white; color:#30473a; border-color:#dce3df; }
      #toggle[data-secondary="true"]:hover { background:#f0f5f2; }
      .row { display:flex; align-items:center; justify-content:space-between; min-height:38px; }
      #speed { padding:3px 12px; font-weight:650; } input[type=checkbox] { accent-color:#27764e; width:17px; height:17px; cursor:pointer; }
      .note { color:#7c8981; font-size:11px; margin:8px 0 0; }
      details { border-top:1px solid #e9eeeb; padding-top:10px; margin-top:10px; }
      summary { cursor:pointer; color:#627368; font-size:12px; }
      .setup { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-top:10px; }
      .setup button { font-size:12px; padding:7px 6px; }
      select,#service-token { width:100%; border:1px solid #dce3df; border-radius:7px; padding:7px; font:inherit; margin-top:5px; }
      .debug-actions { display:flex; gap:8px; margin-top:10px; }
      .debug-actions button { flex:1; font-size:12px; }
      .diagnostic-info { color:#627368; font-size:12px; overflow-wrap:anywhere; }
      .diagnostic-info p { margin:7px 0; }
      textarea { width:100%; height:180px; margin-top:10px; border:1px solid #dce3df; border-radius:8px;
        padding:8px; background:#f8faf9; color:#22332c; font:10px/1.5 monospace; resize:vertical; }
      #question-image { width:100%; margin-top:8px; border:1px solid #e9eeeb; border-radius:6px; }
      .reference-choice { display:flex; align-items:flex-start; gap:8px; margin-top:10px; font-size:12px; overflow-wrap:anywhere; }
      .reference-choice input { flex-shrink:0; margin-top:2px; }
      #reference-list { max-height:180px; overflow:auto; }
      #reference-panel textarea { height:95px; font:12px/1.6 system-ui; }
      #reference-title { width:100%; margin-top:8px; border:1px solid #dce3df; border-radius:7px; padding:7px; }
      #reference-files { width:100%; margin-top:10px; font-size:12px; }
      #assignment-controls .setup { margin-top:8px; }
      .question-types { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:10px; }
      .question-types label { display:flex; align-items:center; gap:5px; font-size:12px; }
      .task-card { padding:12px; border:1px solid #e2e9e4; border-radius:10px; margin-bottom:12px; }
      .task-card .mode-label { margin-bottom:0; }
      .workflow-steps { list-style:none; padding:0; margin:10px 0 0; display:grid; gap:6px; }
      .workflow-steps li { display:flex; justify-content:space-between; gap:8px; font-size:12px; color:#697a70; }
      .workflow-steps li[data-current="true"] { color:#21613f; font-weight:650; }
      .workflow-steps span:last-child { text-align:right; font-size:11px; }
      #materials-open { width:100%; text-align:left; font-weight:600; }
      #task-reference-summary { margin-bottom:12px; }
      #reference-panel { border-top:0; padding-top:0; margin-top:0; }
      #reference-panel > summary { display:none; }
      #reference-done { position:sticky; bottom:0; background:#27764e; color:white; }
      #course-live details p { font-size:11px; }
      #course-options { margin-top:16px; padding-top:14px; border-top:1px solid #e9eeeb; }
      .actions { position:sticky; bottom:0; background:white; padding:10px 0 2px; z-index:1; }
    </style>
    <section aria-label="雨课堂连播助手">
      <header id="panel-drag" tabindex="0" title="拖动标题栏移动面板；双击回到右下角，也可用方向键移动"><strong>雨课堂学习助手</strong><span id="badge">运行中</span>
        <button id="collapse" aria-label="收起面板" aria-expanded="true">−</button></header>
      <p id="feedback" role="status" aria-live="polite" hidden></p>
      <div class="content" id="panel-body">
        <nav class="tabs" role="tablist" aria-label="助手页面">
          <button id="tab-task" role="tab" aria-controls="view-task" aria-selected="true">任务</button>
          <button id="tab-materials" role="tab" aria-controls="view-materials" aria-selected="false" tabindex="-1">材料</button>
          <button id="tab-settings" role="tab" aria-controls="view-settings" aria-selected="false" tabindex="-1">设置</button>
          <button id="tab-diagnostics" role="tab" aria-controls="view-diagnostics" aria-selected="false" tabindex="-1">诊断</button>
        </nav>
        <div id="view-task" role="tabpanel" aria-labelledby="tab-task">
        <div class="task-card"><h3>全课程流程</h3>
        <button id="workflow-start" class="primary" style="width:100%;margin-top:5px">一键自动化</button>
        <p id="workflow-status" class="hint" role="status">按视频 → 讨论 → 作业执行，可随时暂停。</p>
        <ol class="workflow-steps" aria-label="一键流程进度"><li id="workflow-row-video"><span>1 · 视频</span><span id="workflow-step-video">待检查</span></li><li id="workflow-row-discussion"><span>2 · 讨论</span><span id="workflow-step-discussion">待检查</span></li><li id="workflow-row-assignments"><span>3 · 作业</span><span id="workflow-step-assignments">待检查</span></li></ol>
        </div>
        <button id="materials-open">＋ 导入参考材料 / 管理材料库</button><p id="task-reference-summary" class="hint">用户材料优先，支持文件导入和粘贴。</p>
        <div class="task-card"><label class="mode-label" for="course-mode">独立任务 · 运行方式
          <select id="course-mode"><option value="video">视频自动化</option><option value="auto">作业自动化</option><option value="discussion">讨论自动化</option></select>
        </label>
        <div id="assignment-task-options" hidden>
          <label class="mode-label" for="assignment-action">作业子任务<select id="assignment-action"><option value="materials">收集材料</option><option value="complete">完成作业</option></select></label>
          <details id="question-type-panel"><summary id="question-type-summary">作答题型（全部）</summary>
            <div class="question-types"><label><input id="question-type-single" type="checkbox" checked>单选</label><label><input id="question-type-multiple" type="checkbox" checked>多选</label><label><input id="question-type-judge" type="checkbox" checked>判断</label><label><input id="question-type-blank" type="checkbox" checked>填空</label><label><input id="question-type-essay" type="checkbox" checked>问答</label></div>
            <p class="hint">只作答勾选题型；其他题型直接跳过，不调用模型。设置按课程保存。</p>
          </details>
        </div>
        </div>
        <div class="state" id="playback-state"><p id="actual">等待视频</p><p id="completion">当前视频完成度：等待识别</p><p id="status" aria-live="polite"></p><p id="setup-result">等待验证播放设置</p></div>
        <div class="state" id="course-live" hidden>
          <div class="live-head"><span>当前任务</span><span id="course-live-state">等待检查</span></div>
          <p id="course-live-current">当前内容：等待识别</p>
          <progress id="course-live-progress" max="1" value="0" aria-label="本轮已处理步骤"></progress>
          <p id="course-live-reason" role="status" aria-live="polite"></p>
          <details><summary>处理详情</summary><p id="course-live-stage"></p><p id="course-live-model-brief"></p><p id="course-live-cache"></p></details>
        </div>
        <button id="course-assignments" class="primary" hidden disabled>完成作业</button>
        <div id="assignment-controls" hidden><div class="setup"><button id="submit-toggle" aria-pressed="false">暂停自动提交</button><button id="question-next">下一题</button><button id="reference-open">补充本题答案</button></div><p id="submit-status" class="hint" role="status"></p><p id="assignment-progress" class="hint" role="status" hidden></p></div>
        <div class="actions"><button id="toggle">暂停</button><button id="resume">继续播放</button><button id="course-retry" hidden>重试当前任务</button></div>
        <p id="task-guide" class="hint">视频连播会应用倍速和静音，播放进度以网站反馈为准。</p>
        </div>
        <div id="view-materials" role="tabpanel" aria-labelledby="tab-materials" hidden>
        <h3>材料库</h3><p class="hint" style="margin-bottom:12px">本课程独立保存。编辑期间暂缓任务，返回任务页后继续。</p>
        <details id="reference-panel"><summary>导入与参考材料库</summary>
          <details id="reference-import-panel" open><summary>主动添加材料 · 文件或粘贴</summary>
            <label class="note" for="reference-scope">适用范围</label><select id="reference-scope"><option value="course">本课程通用</option><option value="chapter">仅当前章节</option></select>
            <input id="reference-files" type="file" accept=".md,.markdown,.txt,.pdf,.docx,.doc" multiple aria-label="导入参考文件">
            <p class="hint">支持MD、TXT、PDF、Word DOCX，每份不超过15MB。旧版DOC请先另存为DOCX；扫描件需先转文字。</p>
            <details id="reference-paste-panel"><summary>粘贴文字材料</summary><input id="reference-title" placeholder="材料名称（粘贴时选填）" aria-label="材料名称">
            <textarea id="reference-text" placeholder="也可以直接粘贴参考正文或答案材料" aria-label="参考材料正文"></textarea>
            <button id="reference-paste-save">保存粘贴材料</button></details><p id="reference-import-status" class="hint" role="status"></p>
          </details>
          <p id="reference-summary" class="hint"></p><div id="reference-list"></div>
          <p class="hint">只使用勾选的材料，可单选或组合。文件在本机提取文字，选中的正文会发送给已配置的模型。</p>
          <details id="manual-answer-panel"><summary>直接补充本题答案</summary><p id="manual-answer-context" class="hint"></p>
            <textarea id="manual-answer" placeholder="填空题每行一个答案；选择题填写选项字母；问答题填写正文" aria-label="本题答案"></textarea>
            <div class="setup"><button id="manual-answer-save">保存本题答案</button><button id="manual-answer-remove">删除本题答案</button></div>
            <p class="hint">仅用于当前题，优先于模型生成；自动提交暂停时会先填写供你核验。</p>
          </details>
          <details id="reference-remove-group" hidden><summary>管理已导入材料</summary><select id="reference-remove-list" aria-label="要移除的材料"></select><button id="reference-remove">移除所选材料</button></details>
          <button id="reference-undo" hidden>撤销上次移除</button>
          <button id="reference-done" style="width:100%;margin-top:12px">完成编辑，返回任务</button>
        </details>
        <div class="settings-group" id="course-options">
          <h3>课程材料与缓存</h3><p class="hint" id="course-stage">完整流程先补齐材料；也可独立收集或作答。</p>
          <button id="lecture-import" style="width:100%;margin-top:8px">补采视频讲稿</button>
          <p class="hint">依次读取各视频下方的讲稿，已缓存的完整讲稿自动复用；不播放视频，不调用模型或提交。</p>
          <div class="setup"><button id="course-start">检查并继续任务</button><button id="cache-export">导出本地记忆</button><button id="cache-current">更新当前材料</button></div>
          <p class="hint">自动跳过有效缓存，只补采缺失材料。当前内容更新后可手动刷新材料。</p>
          <details><summary>清除与重新采集课程缓存</summary>
            <p class="hint">清理课程原文、摘要与草稿；保留你导入的文件、材料勾选、人工答案、题目识别及提交记录。</p>
            <div class="setup"><button id="cache-clear">清除课程缓存</button><button id="cache-rebuild">重新采集课程材料</button></div>
            <button id="cache-undo" style="width:100%;margin-top:8px" hidden>撤销上次清理</button>
            <p class="hint">重新采集会读取图文、知识导引与讲稿，不自动作答；完成后暂停供你核验。</p>
          </details>
        </div>
        </div>
        <div id="view-settings" role="tabpanel" aria-labelledby="tab-settings" hidden>
        <div class="settings-group">
          <h3>模型连接</h3><p class="hint">已接通后无需重复配置。视频连播与材料采集无需API。</p>
          <p id="model-settings-state" role="status" aria-live="polite">尚未检测模型连接</p>
          <div class="setup"><button id="service-test">检测服务</button><button id="course-model-probe" title="固定短文本测试，不发送课程内容，会使用少量模型额度">测试模型回复</button></div>
          <p class="hint"><a href="http://127.0.0.1:8954/" target="_blank" rel="noopener">打开本地模型设置 ↗</a></p>
          <details><summary>修改本地连接口令</summary>
            <label class="note" for="service-token">从本地设置页复制口令</label><input id="service-token" type="password" autocomplete="off" placeholder="本地连接口令，不是API密钥">
            <button id="service-save" style="width:100%;margin-top:8px">保存口令</button>
          </details>
        </div>
        <details><summary>作答策略</summary><label class="row" for="fuzzy-match"><span>题干模糊匹配（≥90%）</span><input id="fuzzy-match" type="checkbox"></label><p id="fuzzy-status" class="hint" role="status">默认关闭；连续两次模糊匹配答错会自动关闭。</p></details>
        <details><summary>视频播放与控件</summary>
        <div id="playback-options"><div class="row"><span>播放速度</span><button id="speed" title="点击切换1倍速或2倍速">2×</button></div>
        <label class="row" for="auto-resume"><span>暂停后自动恢复</span><input id="auto-resume" type="checkbox" checked></label>
        <label class="row" for="foreground-mask"><span>前台伪装（实验）</span><input id="foreground-mask" type="checkbox"></label>
        <p class="note" id="foreground-status">前台伪装：等待视频</p>
        </div>
          <p class="note" id="memory">控件设置自动保存，刷新或换视频后复用。</p>
          <div class="setup"><button id="mark-rate">设置倍速控件</button><button id="mark-mute">设置静音控件</button>
          <button id="pick-catalog">识别当前目录项</button><button id="pick">设置下一节按钮</button>
          <button id="mark-completion">识别视频完成度</button></div>
          <p class="hint">播放设置用于视频连播；课程任务只读文字材料。</p>
        </details>
        </div>
        <div id="view-diagnostics" role="tabpanel" aria-labelledby="tab-diagnostics" hidden>
          <h3>运行记录</h3><p class="hint">发生问题时先导出，再刷新。文件不包含密钥或连接口令。</p>
          <div class="debug-actions"><button class="primary" id="export-debug">导出调试文件</button><button id="diagnose">查看记录</button></div>
          <div class="diagnostic-info"><p id="course-live-service"></p><p id="course-live-model"></p><p id="course-live-requests"></p><p id="course-live-materials"></p><p id="course-live-results"></p><p id="course-live-action"></p><p id="course-live-heartbeat"></p><p id="course-status"></p></div>
          <button id="course-health-check" style="width:100%;margin-top:8px">刷新服务状态</button>
          <details><summary>题目读取检查</summary><div class="setup"><button id="question-preview">预览题目图片</button><button id="question-export">导出题目图片</button></div>
            <p id="question-image-note" class="hint">普通文字直接读取，特殊字体先识别成明文并缓存。</p><img id="question-image" alt="发送给模型识别的题目图片" hidden></details>
          <textarea id="diagnostics" aria-label="脚本诊断信息" readonly hidden></textarea>
          <p class="hint">v${version} · 视频 / 作业 / 讨论独立模式</p>
        </div>
      </div>
    </section>`;

  document.documentElement.append(host);

  return { host, shadow };
}
module.exports = mountPanel;
