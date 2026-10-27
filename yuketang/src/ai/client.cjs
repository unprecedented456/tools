'use strict';

// AI接入对象：连接设置、请求句柄、状态统计、取消与服务检测。
function createAIClient(ports, options = {}) {
  const Course = ports.core;
  let serviceToken = GM_getValue('model-service-token', '');

  let courseRequest = null;

  let courseServiceMessage = '';

  let courseHealthRequest = null;

  let courseHealthPromise = null;

  let courseHealthGeneration = 0;

  const requestHistoryKey = `course-model-history:${ports.app.memoryCourse}`;

  const savedModelHistory = GM_getValue(requestHistoryKey, {});

  const courseModelState = { state: 'idle', since: null, kind: null, error: null,
    lastValidation: null,
    attempts: Number(savedModelHistory.attempts) || 0, successes: Number(savedModelHistory.successes) || 0,
    failures: Number(savedModelHistory.failures) || 0, lastSuccessAt: savedModelHistory.lastSuccessAt || null,
    lastFailureAt: savedModelHistory.lastFailureAt || null };

  const courseServiceHealth = { state: 'unchecked', checkedAt: null, model: null, vision: null, error: null, serviceVersion: null };

  function rememberModelHistory() {
    try { GM_setValue(requestHistoryKey, { attempts: courseModelState.attempts, successes: courseModelState.successes,
      failures: courseModelState.failures, lastSuccessAt: courseModelState.lastSuccessAt, lastFailureAt: courseModelState.lastFailureAt }); }
    catch { ports.app.trace('course.model.history.save.error'); }
  }

  function checkCourseService(force = false) {
    if (courseHealthPromise) return courseHealthPromise;
    if (!serviceToken) {
      Object.assign(courseServiceHealth, { state: 'missing-token', error: '尚未保存本地连接口令', checkedAt: Date.now() });
      return Promise.resolve(courseServiceHealth);
    }
    if (!force && courseServiceHealth.checkedAt !== null && Date.now() - courseServiceHealth.checkedAt < 30000) return Promise.resolve(courseServiceHealth);
    const generation = courseHealthGeneration, token = serviceToken;
    Object.assign(courseServiceHealth, { state: 'checking', checkedAt: Date.now(), error: null });
    courseHealthPromise = localModel(null, 'GET').then(result => {
      if (generation !== courseHealthGeneration || token !== serviceToken) return courseServiceHealth;
      if (typeof result.ready !== 'boolean') throw new Error('本地服务状态格式不正确');
      Object.assign(courseServiceHealth, { state: result.ready ? 'ready' : 'unconfigured', checkedAt: Date.now(), model: result.model || null,
        vision: result.vision !== false, error: result.ready ? null : '本地服务尚未配置模型API', serviceVersion: result.serviceVersion || null });
      courseServiceMessage = result.ready ? '本机服务正常，模型已配置；实际回复请看模型请求状态' : '本地服务正常，尚未配置模型API';
      return courseServiceHealth;
    }).catch(error => {
      if (generation === courseHealthGeneration && token === serviceToken) {
        Object.assign(courseServiceHealth, { state: 'error', checkedAt: Date.now(), error: error.message });
        courseServiceMessage = error.message;
      }
      return courseServiceHealth;
    }).finally(() => { if (generation === courseHealthGeneration) courseHealthPromise = null; });
    return courseHealthPromise;
  }

  function resetCourseServiceCheck() {
    courseHealthGeneration++;
    courseHealthRequest?.abort?.(); courseHealthRequest = null; courseHealthPromise = null;
    Object.assign(courseServiceHealth, { state: 'unchecked', checkedAt: null, model: null, vision: null, error: null });
  }

  function localModel(task, method = 'POST', route = 'complete') {
    if (route === 'complete' && method === 'POST') task = Course.prioritizeTask(task);
    const importing = method === 'POST' && route === 'extract';
    if (!importing && method === 'POST' && (ports.app.courseVerificationWaiting || ports.platform.humanVerification(ports.platform.documents()))) return Promise.reject(new Error('请先手动完成人机验证，再继续模型处理'));
    if (!serviceToken) return Promise.reject(new Error('请先在本地设置模型，并保存连接口令；也可切换为材料采集'));
    if (typeof GM_xmlhttpRequest !== 'function') return Promise.reject(new Error('油猴尚未提供本地连接权限，请保存新版脚本后刷新'));
    const endpoint = ['probe', 'extract'].includes(route) ? route : 'complete';
    const modelRequest = method !== 'GET' && !importing;
    if (modelRequest) {
      Object.assign(courseModelState, { state: 'pending', since: Date.now(), kind: endpoint === 'probe' ? 'probe' : task?.kind || 'request', error: null });
      courseModelState.attempts++; rememberModelHistory();
      ports.ui.noteCourseAction(endpoint === 'probe' ? '发起模型短文本测试' : '已向本地服务发送模型请求');
      ports.app.trace('course.model.request', { kind: courseModelState.kind });
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      let request = null;
      const finish = (error, result) => {
        if (settled) return; settled = true; clearTimeout(timer);
        if (modelRequest && courseRequest === request) courseRequest = null;
        if (importing && courseImportRequest === request) courseImportRequest = null;
        if (!modelRequest && !importing && courseHealthRequest === request) courseHealthRequest = null;
        if (modelRequest) {
          Object.assign(courseModelState, { state: error ? 'error' : 'success', error: error?.message || null });
          if (error) { courseModelState.failures++; courseModelState.lastFailureAt = Date.now(); }
          else { courseModelState.successes++; courseModelState.lastSuccessAt = Date.now(); ports.ui.noteCourseAction('已收到模型有效回复'); }
          rememberModelHistory(); ports.app.trace(error ? 'course.model.failed' : 'course.model.succeeded', { elapsedMs: Date.now() - courseModelState.since });
        }
        error ? reject(error) : resolve(result);
      };
      const timer = setTimeout(() => { finish(new Error(importing ? '文件解析60秒未完成，请拆分材料后重试' : modelRequest ? '模型请求100秒未完成，请检测模型回复后重试' : '本机服务8秒未响应，请检查服务窗口和连接口令')); request?.abort?.(); }, importing ? 60000 : modelRequest ? 100000 : 8000);
      try { request = GM_xmlhttpRequest({
        method, url: `http://127.0.0.1:8954/${method === 'GET' ? 'status' : endpoint}`,
        headers: { 'Content-Type': 'application/json', 'X-Ykt-Token': serviceToken },
        anonymous: true, redirect: 'error', data: method === 'GET' ? undefined : JSON.stringify(task),
        onload(response) {
          try {
            const data = JSON.parse(response.responseText);
            if (response.status !== 200) {
              const labels = { MODEL_NOT_CONFIGURED: '本地服务尚未配置模型API，请打开本地设置',
                VISION_REQUIRED: '此题需要支持读图的模型，请检查本地读图设置',
                MODEL_HTTP_401: '模型接口鉴权失败，请检查本地API密钥',
                MODEL_HTTP_429: '模型接口达到调用限额，请稍后重试或检查额度',
                MODEL_HTTP_502: '模型接口网关暂时异常（502），请稍后重试',
                MODEL_HTTP_503: '模型服务暂时不可用（503），可能繁忙或维护；请稍后重试',
                MODEL_HTTP_504: '模型接口网关响应超时（504），请稍后重试',
                MODEL_HTTP_400: '模型接口拒绝请求，请检查接口地址、模型名和读图能力',
                MODEL_OUTPUT_TRUNCATED: '模型回答不完整，已暂缓提交',
                MODEL_JSON_INVALID: '模型回复不是有效JSON，未进入填写或提交',
                MODEL_SOURCE_INVALID: '模型引用了不存在的材料，已暂缓提交',
                MODEL_INSUFFICIENT: '模型提示材料不足或无法读清题目，已暂缓提交',
                MODEL_IMAGE_UNREADABLE: '题目图片无法可靠识别，请在诊断中检查题目图片；未进入作答',
                MODEL_MATERIAL_INSUFFICIENT: '题目已读取，但模型认为所选资料不足以作答；已暂缓提交',
                MODEL_ANSWER_UNCERTAIN: '题目已读取，但模型不能确定答案；已暂缓提交',
                MODEL_TRANSCRIPT_INVALID: '题目转写不完整或空位、选项不匹配，未进入作答',
                MODEL_SELECTION_INCOMPLETE: '多选题逐项核对不完整或与答案列表不一致，未填写或提交',
                MODEL_DISCUSSION_TOO_LONG: 'MODEL_DISCUSSION_TOO_LONG',
                MODEL_RESULT_INVALID: '模型回复字段不完整，已暂缓提交',
                MODEL_PROTOCOL_INVALID: '接口未返回兼容格式，请检查服务商接口地址和模型名',
                MODEL_NETWORK_ERROR: '本机服务无法连接模型接口，请检查接口地址和系统代理，并重启模型服务',
                MODEL_TIMEOUT: '模型接口响应超时，已暂缓提交',
                MODEL_HTTP_404: '模型名或接口路径不存在，请在本地设置中检查真实模型名称',
                NOT_FOUND: '本机服务版本较旧，请重新运行启动模型服务.cmd' };
              const error = new Error(labels[data.error] || data.error || '本地模型请求未成功'); error.code = data.error;
              if (data.error === 'MODEL_TRANSCRIPT_INVALID') {
                error.details = data.details || null;
                courseModelState.lastValidation = { kind: 'transcribe', number: task.question?.number, details: error.details, at: Date.now() };
                if (error.details?.field) error.message += `（字段：${error.details.field}${error.details.expected !== undefined ? `，期望${JSON.stringify(error.details.expected)}` : ''}${error.details.actual !== undefined ? `，实际${JSON.stringify(error.details.actual)}` : ''}）`;
              }
              throw error;
            }
            if ((modelRequest || importing) && (!data.result || typeof data.result !== 'object')) throw new Error('本地服务没有返回有效模型结果');
            finish(null, method === 'GET' ? data : data.result);
          } catch (error) { const wrapped = new Error(error instanceof SyntaxError ? '本地模型返回格式错误' : error.message); wrapped.code = error.code; wrapped.details = error.details; finish(wrapped); }
        },
        onerror: () => finish(new Error('无法连接本地模型服务，请先运行“启动模型服务.cmd”')),
        onabort: () => finish(new Error('模型请求已取消')),
      });
      } catch { finish(new Error('本机请求未能发出，请检查油猴的本地连接权限')); }
      if (!settled) { if (importing) courseImportRequest = request; else if (modelRequest) courseRequest = request; else courseHealthRequest = request; }
    });
  }

  let courseImportRequest = null;

  function cancelTask() { courseRequest?.abort?.(); courseRequest = null; }

  function clearTaskStatus() { Object.assign(courseModelState, { state: 'idle', error: null }); }

  function recordValidation(value) { courseModelState.lastValidation = value; }

  function saveConnectionToken(value) {
    resetCourseServiceCheck(); serviceToken = value.trim();
    GM_setValue('model-service-token', serviceToken); courseServiceMessage = ''; ports.app.courseRun = null;
    ports.ui.feedback('本地连接口令已保存');
  }

  function inspectService() {
    void checkCourseService(true).then(() => { ports.ui.courseStatus(courseServiceMessage || courseServiceHealth.error || '尚未配置本地连接口令'); ports.ui.renderCourseProgress({ statusText: ports.ui.message }); });
  }

  function probeModel() {
    if (courseModelState.state === 'pending' || ports.app.courseRun?.pending) { ports.ui.courseStatus('当前请求尚未结束，模型测试暂缓'); return; }
    ports.ui.courseStatus('正在用不含课程内容的短文本测试模型回复');
    localModel({}, 'POST', 'probe').then(() => { ports.ui.courseStatus('模型已返回有效回复；课程处理状态请看当前步骤'); ports.ui.renderCourseProgress({ statusText: ports.ui.message }); })
      .catch(error => { ports.ui.courseStatus(error.message); ports.ui.renderCourseProgress({ statusText: ports.ui.message }); });
  }

  const api = {
    get probeModel() { return probeModel; },
    get inspectService() { return inspectService; },
    get saveConnectionToken() { return saveConnectionToken; },
    get recordValidation() { return recordValidation; },
    get clearTaskStatus() { return clearTaskStatus; },
    get cancelTask() { return cancelTask; },
    get checkCourseService() { return checkCourseService; },
    get courseModelState() { return courseModelState; },
    get courseServiceHealth() { return courseServiceHealth; },
    get courseServiceMessage() { return courseServiceMessage; }, set courseServiceMessage(value) { courseServiceMessage = value; },
    get localModel() { return localModel; },
    get serviceToken() { return serviceToken; }, set serviceToken(value) { serviceToken = value; }
  };
  if (options.testing) api.testing = {
    get serviceToken() { return serviceToken; }, set serviceToken(value) { serviceToken = value; },
    get courseRequest() { return courseRequest; }, set courseRequest(value) { courseRequest = value; },
    get courseImportRequest() { return courseImportRequest; }, set courseImportRequest(value) { courseImportRequest = value; },
    get courseServiceMessage() { return courseServiceMessage; }, set courseServiceMessage(value) { courseServiceMessage = value; },
    get courseHealthRequest() { return courseHealthRequest; }, set courseHealthRequest(value) { courseHealthRequest = value; },
    get courseHealthPromise() { return courseHealthPromise; }, set courseHealthPromise(value) { courseHealthPromise = value; },
    get courseHealthGeneration() { return courseHealthGeneration; }, set courseHealthGeneration(value) { courseHealthGeneration = value; },
    get requestHistoryKey() { return requestHistoryKey; },
    get savedModelHistory() { return savedModelHistory; },
    get courseModelState() { return courseModelState; },
    get courseServiceHealth() { return courseServiceHealth; },
    get rememberModelHistory() { return rememberModelHistory; }, set rememberModelHistory(value) { rememberModelHistory = value; },
    get checkCourseService() { return checkCourseService; }, set checkCourseService(value) { checkCourseService = value; },
    get resetCourseServiceCheck() { return resetCourseServiceCheck; }, set resetCourseServiceCheck(value) { resetCourseServiceCheck = value; },
    get localModel() { return localModel; }, set localModel(value) { localModel = value; }
  };
  return api;
}
module.exports = createAIClient;
