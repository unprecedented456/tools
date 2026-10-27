'use strict';
// 仅测试用户指定的本地资料，不填写课程、不提交；凭据只在进程内读取。
const fs = require('node:fs');
const path = require('node:path');
const Course = require('../src/course-core.cjs')();
const { complete, modelErrorCode } = require('./model-service.cjs');
const { extractReference } = require('./reference-extractor.cjs');
async function main() {
  const started = Date.now();
  const value = flag => { const index = process.argv.indexOf(flag); return index >= 0 ? process.argv[index + 1] : null; };
  try {
    const file = value('--file'), prompt = value('--prompt'), count = Number(value('--blanks'));
    if (!file || !prompt || !Number.isInteger(count) || count < 1 || count > 50) throw Error('MODEL_REQUEST_INVALID');
    const chapterKey = 'local-reference-check', chapterTitle = value('--chapter') || '';
    const question = { number: 5, type: 'blank', blankCount: count, options: [], encrypted: false, readingMethod: 'verified-user-screenshot', prompt };
    const result = await extractReference({ filename: path.basename(file), data: fs.readFileSync(file).toString('base64') });
    const source = { id: 'user-selected-reference', chapterKey, title: path.basename(file), text: result.text, userProvided: true, quality: 'text' };
    if (process.argv.includes('--fuzzy')) {
      const answer = Course.matchMarkdownAnswer([source], question, chapterTitle);
      process.stdout.write(JSON.stringify({ ok: !!answer, similarity: answer?.match.score || 0, blanks: answer?.blanks || [], usedModel: false, submitted: false }) + '\n');
      return;
    }
    const plan = Course.planMaterials([source], question, chapterTitle);
    const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.local', 'model-service.json'), 'utf8'));
    const task = { kind: 'answer', chapterKey, chapterTitle, question, materials: plan.materials };
    let answer;
    if (process.argv.includes('--service')) {
      const response = await fetch('http://127.0.0.1:8954/complete', { method: 'POST', signal: AbortSignal.timeout(100000),
        headers: { 'Content-Type': 'application/json', 'X-Ykt-Token': config.token }, body: JSON.stringify(task) });
      const data = await response.json();
      if (!response.ok) throw Error(/^MODEL_[A-Z0-9_]+$/.test(data.error || '') ? data.error : 'MODEL_REQUEST_INVALID');
      answer = Course.parseModel(JSON.stringify(data.result), task);
    } else answer = await complete(task, config);
    Course.validateAnswer(question, answer);
    const output = { ok: true, viaLocalService: process.argv.includes('--service'), model: config.model, report: plan.report, answer, submitted: false, elapsedSeconds: (Date.now() - started) / 1000 };
    fs.writeFileSync(path.join(__dirname, '..', '.local', 'inspections', 'reference-answer-check.json'), JSON.stringify(output, null, 2));
    process.stdout.write(JSON.stringify({ ok: true, viaLocalService: output.viaLocalService, model: config.model, originalCharacters: result.text.length, sentCharacters: plan.report.sentCharacters,
      fullOriginal: plan.report.mode === 'full-original', matchedPassages: plan.report.matchedPassages, blanks: answer.blanks, submitted: false, elapsedSeconds: output.elapsedSeconds }) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify({ ok: false, code: modelErrorCode(error), submitted: false, elapsedSeconds: (Date.now() - started) / 1000 }) + '\n'); process.exitCode = 1; }
}
if (require.main === module) void main();
