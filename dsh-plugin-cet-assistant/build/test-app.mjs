/* 前端冒烟测试：用最小 DOM 桩执行 app/app.js，
 * 验证 boot → 练习记录一览 → 回看单条记录 → 返回练习 的渲染流程没有运行时错误。
 * 只校验「渲染出预期结构」，不替代浏览器目视。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..', 'app');
const code = fs.readFileSync(path.join(appDir, 'app.js'), 'utf8');

/* ---------------- DOM 桩 ---------------- */
function mkClassList() {
  const set = new Set();
  return {
    add: (c) => set.add(c),
    remove: (c) => set.delete(c),
    contains: (c) => set.has(c),
    toggle: (c, force) => {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    _set: set,
  };
}

function mkEl(id, tag) {
  const el = {
    id,
    tagName: (tag || 'div').toUpperCase(),
    innerHTML: '',
    textContent: '',
    value: '',
    style: {},
    scrollTop: 0,
    children: [],
    classList: mkClassList(),
    _handlers: {},
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    removeEventListener() {},
    insertAdjacentHTML(_pos, html) { this.innerHTML += html; },
    appendChild(child) { this.children.push(child); return child; },
    remove() {},
    focus() {},
    setSelectionRange() {},
    getAttribute() { return null; },
    setAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { top: 0, left: 0, width: 400, height: 800 }; },
    parentNode: null,
    parentElement: null,
  };
  return el;
}

const nodes = {};
const ids = ['scroll', 'actionbar', 'toast', 'sel-level', 'sel-exam', 'seg-mode', 'btn-min', 'btn-float', 'zoom-ctl', 'zoom-val', 'answer', 'wordcount', 'ocr-text', 'ocr-note', 'file', 'dropzone', 'thumb'];
for (const id of ids) nodes[id] = mkEl(id);

const tabs = ['practice', 'records', 'vocab'].map((v) => {
  const t = mkEl('tab-' + v, 'button');
  t.getAttribute = (n) => (n === 'data-view' ? v : null);
  t.setAttribute = () => {};
  return t;
});
// 顶层 tab 的父节点用于 classList 高亮
tabs.forEach((t) => { t.parentNode = mkEl('tabs'); });

const docHandlers = {};
const documentStub = {
  body: mkEl('body'),
  getElementById(id) { return nodes[id] || (nodes[id] = mkEl(id)); },
  querySelectorAll(sel) {
    if (sel === '#tabs [data-view]') return tabs;
    if (/#tabs/.test(sel)) return tabs;
    return [];
  },
  querySelector(sel) {
    const m = /^#([\w-]+)$/.exec(sel || '');
    return m ? documentStub.getElementById(m[1]) : null;
  },
  createElement(tag) { return mkEl('', tag); },
  addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn); },
};

const winHandlers = {};
const opened = [];
const windowStub = {
  innerHeight: 900,
  innerWidth: 1280,
  addEventListener(type, fn) { (winHandlers[type] = winHandlers[type] || []).push(fn); },
  open(url) { opened.push(url); return {}; },
  parent: { postMessage() {} },
};

const store = new Map();
const localStorageStub = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/* ---------------- 假数据 + 假 fetch ---------------- */
const exams = [
  {
    id: 'cet6-201512-1', level: 'CET6', exam_date: '2015-12', set: 1, topic: '科技',
    writing_prompt: 'Write an essay on the impact of social networking websites on reading.',
    word_limit: '150-200', zh_source: '中国的父母往往决定孩子的一切，甚至替孩子做重要的决定。'.repeat(3),
    ref_trans: 'In China, parents always try every means to help their children, even making important decisions for them.',
    ref_idea: 'The impact of social networking websites on reading has been a heated topic.',
    has_writing: true, has_translation: true, has_ref_trans: true, has_ref_idea: true,
  },
  {
    id: 'cet4-201512-1', level: 'CET4', exam_date: '2015-12', set: 1, topic: '社会',
    writing_prompt: 'Write an essay on "Listening is more important than talking".',
    word_limit: '120-180', zh_source: '云南的丽江古镇是中国著名的旅游胜地。'.repeat(3),
    ref_trans: 'Lijiang ancient town in Yunnan is a famous tourist attraction in China.',
    ref_idea: 'Listening is more important than talking in daily communication.',
    has_writing: true, has_translation: true, has_ref_trans: true, has_ref_idea: true,
  },
];

const uiSchema = {
  side: 'left', fixed: true,
  panel_order: ['task_header', 'user_input_panel', 'score_overview', 'error_panel', 'info_panel', 'sample_panel', 'knowledge_panel', 'suggest_panel', 'stats_panel', 'action_bar'],
  panel_config: {
    task_header: { title: '任务信息', fold: false },
    user_input_panel: { title: '你的作答', fold: false },
    score_overview: { title: '评分概览', fold: false },
    error_panel: { title: '错误明细', fold: false },
    info_panel: { title: '要点/结构评价', fold: false },
    sample_panel: { title: '参考范文', fold: true },
    knowledge_panel: { title: '考点记忆卡', fold: true },
    suggest_panel: { title: '个性化提升建议', fold: false },
    stats_panel: { title: '个人训练统计', fold: true },
    action_bar: { buttons: ['save_card', 'review_test', 'ocr_edit', 'clear'] },
  },
};

const result = {
  task_type: 'translation', total_score: 11, grade_desc: '10-12：全部要点覆盖，仅有少量不影响理解的细微错误',
  dim_score: { faithful: 4.5, vocab: 3, grammar: 2.5, fluency: 1 },
  error_list: [{ error_type: '表达不准确', source_fragment: '决定孩子的一切', user_fragment: 'decide everything for their children', correct_version: 'make important decisions for their children', explanation: 'decide everything 不是地道搭配' }],
  lost_info: ['替孩子做重要的决定'],
  sample_official: true,
  learn_version: 'In China, parents always try every means to help their children, even making important decisions for them.',
  revised_full: 'In recent years, an increasing number of Chinese parents tend to make decisions on their children\'s behalf. In my view, this practice deserves careful reflection.',
  sentence_review: [
    { sentence: 'In recent years, Chinese parents always decide everything for their children.', issue: '表达不准确', revision: 'In recent years, an increasing number of Chinese parents tend to make decisions on their children\'s behalf.', upgrade: '用 tend to / on one\'s behalf 提升书面度' },
    { sentence: 'I think this is not good.', issue: '词汇低级、过于口语', revision: 'From my perspective, such an approach may do more harm than good.', upgrade: 'From my perspective 替换 I think，do more harm than good 提升论证力' },
  ],
  vocab_upgrade: [
    { basic: 'decide everything', advanced: 'make decisions on their children\'s behalf', category: '教育 & 校园', usage: '动词短语，正式语域', note: '后者更书面、含代劳意味', example: 'Many parents make decisions on their children\'s behalf.' },
    { basic: 'not good', advanced: 'do more harm than good', category: '利弊词', usage: '用于利弊论证的固定搭配', note: '更适合议论文结论句', example: 'Overprotection may do more harm than good.' },
    { basic: 'think', advanced: 'from my perspective', category: '观点功能短语', usage: '句首插入语，引出观点', note: '比 I think 更正式', example: 'From my perspective, independence matters most.' },
  ],
  review_points: ['try every means｜用尽一切办法', 'on behalf of｜代表'],
  personal_suggestion: '注意搭配与信息完整性。',
};

const trend = [
  { id: 'r0', t: 1762900000000, total: 8, task_type: 'translation', mode: 'translation', level: 'CET6', exam_id: 'cet6-201512-1', exam_date: '2015-12', set: 1, topic: '科技', dim_score: { faithful: 3, vocab: 2, grammar: 2, fluency: 1 } },
  { id: 'r1', t: 1763000000000, total: 11, task_type: 'translation', mode: 'translation', level: 'CET6', exam_id: 'cet6-201512-1', exam_date: '2015-12', set: 1, topic: '科技', dim_score: result.dim_score },
  { id: 'r2', t: 1763100000000, total: 9, task_type: 'writing', mode: 'writing', level: 'CET4', exam_id: 'cet4-201512-1', exam_date: '2015-12', set: 1, topic: '社会', dim_score: { content: 3, coherence: 2, vocab: 2, grammar: 2 } },
];
const recordList = [{ id: 'r1', created_at: 1763000000000, total_score: 11, task_type: 'translation', input_mode: 'text', level: 'CET6', exam_id: 'cet6-201512-1', exam_date: '2015-12', set: 1, topic: '科技' }];
const stats = { count: 3, avg_total: 9.3, max_total: 11, streak: 2, error_types: { 表达不准确: 1 }, weak_tags: ['搭配'], avg_theme: '科技', avg_translation: 9.5, avg_writing: 9, avg_writing_image: 0, retested: 0, retest_avg_delta: 0, retest_last_delta: 0 };

const vocabItems = [
  { key: "A|教育 & 校园", term: "make decisions on their children's behalf", category: "教育 & 校园", group: "教育与成长", basic: "decide everything", cn: "替孩子做决定", usage: "动词短语，正式语域", example: "Many parents make decisions on their children's behalf.", hits: 2, mastered: false, source: { exam_date: "2015-12", set: 1 } },
  { key: "B|利弊词", term: "do more harm than good", category: "利弊词", group: "经济与表达", basic: "not good", cn: "弊大于利", usage: "利弊论证固定搭配", example: "Overprotection may do more harm than good.", hits: 1, mastered: false, source: { exam_date: "2015-12", set: 1 } },
  { key: "C|观点功能短语", term: "from my perspective", category: "观点功能短语", group: "经济与表达", basic: "I think", cn: "在我看来", usage: "句首插入语", example: "From my perspective, independence matters most.", hits: 3, mastered: true, source: { exam_date: "2015-12", set: 1 } },
];
const vocabSummary = {
  total: 3, mastered: 1, updated_at: 1763200000000,
  groups: [
    { name: "文化与传承", total: 0, categories: [] },
    { name: "教育与成长", total: 1, categories: [{ name: "教育 & 校园", count: 1 }] },
    { name: "科技与网络", total: 0, categories: [] },
    { name: "环境与生态", total: 0, categories: [] },
    { name: "社会与民生", total: 0, categories: [] },
    { name: "经济与表达", total: 2, categories: [{ name: "利弊词", count: 1 }, { name: "观点功能短语", count: 1 }] },
  ],
};

const calls = [];
function fakeFetch(url) {
  calls.push(url);
  let body;
  if (url.includes('vocab_export')) body = { ok: true, path: 'C:\\x\\高级词汇库.csv', rows: 3 };
  else if (url.includes('vocab_anki')) body = { ok: true, path: 'C:\\x\\anki-vocab.tsv', rows: 2 };
  else if (url.endsWith('vocab') || url.includes('/vocab?')) body = { ok: true, categories: ['教育 & 校园', '利弊词'], summary: vocabSummary, items: vocabItems };
  else if (url.includes('bootstrap')) body = { exams, records: recordList, stats, trend, dataset: { total: 2, cet4: 1, cet6: 1 }, vocab: vocabSummary };
  else if (url.includes('history')) body = { ok: true, trend, records: recordList, stats, dataset: { total: 2 } };
  else if (url.includes('record?')) body = { ok: true, payload: { ui_schema: uiSchema, ocr_meta: null, result }, record: recordList[0] };
  else if (url.includes('export')) body = { ok: true, path: 'C:\\x\\成绩单.csv', rows: 1 };
  else body = { ok: true };
  return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
}

/* ---------------- 执行 app.js ---------------- */
const fileReaderStub = function FileReader() { this.readAsDataURL = () => {}; };
const run = new Function('document', 'window', 'localStorage', 'fetch', 'setTimeout', 'clearTimeout', 'FileReader', code);
run(documentStub, windowStub, localStorageStub, fakeFetch, setTimeout, clearTimeout, fileReaderStub);

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const fail = [];
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra ? ' → ' + extra : '')); fail.push(name); }
}
function fireDocClick(target) {
  for (const fn of docHandlers.click || []) fn({ target, preventDefault() {} });
}

await tick(60);

console.log('\n[1] 首屏（练习视图）');
const first = nodes.scroll.innerHTML;
check('渲染出作答区', /你的作答|开始作答|提交批改/.test(first), first.slice(0, 120));
check('真题来源已填', first.includes('科技') || first.includes('社会'));
check('调用了 bootstrap', calls.some((u) => u.includes('bootstrap')));

console.log('\n[2] 切到「练习记录」');
fireDocClick({ closest: (sel) => (sel === '#tabs [data-view]' ? tabs[1] : null) });
await tick(60);
const rec = nodes.scroll.innerHTML;
check('渲染统计卡 rec-hero', rec.includes('rec-hero'));
check('渲染折线图 svg', rec.includes('<svg viewBox="0 0 620 168"') && rec.includes('<path d="M') && rec.includes('<circle'));
check('渲染记录行', rec.includes('data-record'));
check('调用了 history 接口', calls.some((u) => u.includes('history')));

console.log('\n[3] 回看一条记录');
const rowStub = { getAttribute: (n) => (n === 'data-record' ? 'r1' : null) };
fireDocClick({ closest: (sel) => (sel === '#tabs [data-view]' ? null : sel === '[data-record]' ? rowStub : null) });
await tick(60);
const replay = nodes.scroll.innerHTML;
check('回放渲染评分概览', replay.includes('评分概览'));
check('回放渲染错误明细', replay.includes('错误明细'));
check('回放渲染逐句改写', replay.includes('sent-card'));
check('回放渲染同义替换', replay.includes('vcard') && replay.includes('vterm'));
check('回放按钮为「返回记录」', nodes.actionbar.innerHTML.includes('返回记录'));
check('翻译模式不显示 OCR 面板', !replay.includes('OCR识别'));

console.log('\n[4] 返回练习');
fireDocClick({ closest: (sel) => (sel === '#tabs [data-view]' ? tabs[0] : null) });
await tick(60);
const back = nodes.scroll.innerHTML;
check('回到作答区', /你的作答|开始作答|提交批改/.test(back));

console.log('\n[5] 高级词汇板块');
fireDocClick({ closest: (sel) => (sel === '#tabs [data-view]' ? tabs[2] : null) });
await tick(60);
const vb = nodes.scroll.innerHTML;
check('渲染词汇统计卡', vb.includes('rec-hero') && vb.includes('高级词汇'));
check('渲染分类筛选 chip', vb.includes('data-vfilter') && vb.includes('教育与成长'));
check('按分类折叠展示词条', vb.includes('vcat') && vb.includes('vterm'));
check('词条带用法与来源', vb.includes('vusage') && vb.includes('vsrc'));
check('待复习词条可标记掌握', vb.includes('data-act="vocab_master"') && vb.includes('data-key'));
check('已掌握词条显示相反操作', vb.includes('data-act="vocab_unmaster"'));
check('底部按钮齐全', /vocab_export/.test(nodes.actionbar.innerHTML) && /vocab_anki/.test(nodes.actionbar.innerHTML) && /vocab_clear/.test(nodes.actionbar.innerHTML));
check('调用了 vocab 接口', calls.some((u) => /\/vocab$/.test(u) || u.endsWith('vocab')));

console.log('\n[6] 高级词汇筛选与掌握');
fireDocClick({ closest: (sel) => (sel === '[data-vfilter]' ? { getAttribute: () => '经济与表达' } : null) });
await tick(40);
const filtered = nodes.scroll.innerHTML;
check('筛选后只显示该分组', filtered.includes('do more harm than good') && !filtered.includes('make decisions on their children'));
const masterBtn = { getAttribute: (n) => (n === 'data-act' ? 'vocab_master' : n === 'data-key' ? 'B|利弊词' : null) };
fireDocClick({ closest: (sel) => (sel === '[data-act]' ? masterBtn : null) });
await tick(60);
check('标记掌握后重新拉取词汇库', calls.filter((u) => /vocab/.test(u)).length >= 2);

console.log('\n[7] 批改结果里的全文改写与逐句改写');
fireDocClick({ closest: (sel) => (sel === '#tabs [data-view]' ? tabs[3] : null) });
await tick(40);fireDocClick({ closest: (sel) => (sel === '[data-record]' ? rowStub : null) });
await tick(60);
const replay2 = nodes.scroll.innerHTML;
check('回放含全文改写稿', replay2.includes('全文改写稿') && replay2.includes('revised'));
check('回放含全篇逐句（编号）', (replay2.match(/class="sent-card"/g) || []).length >= 2 && replay2.includes('class="sn"'));
check('逐句改写旁并排官方范文/译文', replay2.includes('class="cmp"') && replay2.includes('cmp-text') && replay2.includes('官方参考'));
check('回放含分类高级词汇', replay2.includes('高级词汇同义替换') && replay2.includes('vcat'));
check('考点记忆卡含本篇高级词汇', replay2.includes('本篇高级词汇'));
console.log('\n[8] 导出报告（PDF / 图片）');
check('结果页有导出 PDF 与图片按钮', nodes.actionbar.innerHTML.includes('export_pdf') && nodes.actionbar.innerHTML.includes('export_png'));
check('回看态底部按钮含导出', nodes.actionbar.innerHTML.includes('导出 PDF') && nodes.actionbar.innerHTML.includes('导出图片'));
const pdfBtn = { getAttribute: (n) => (n === 'data-act' ? 'export_pdf' : null), closest: (sel) => (sel === '[data-act]' ? pdfBtn : null), parentNode: null };
fireDocClick(pdfBtn);
await tick(30);
check('点导出 PDF 会打开报告页', opened.some((u) => u.includes('/cetwt/report?id=')), opened.join(','));

console.log('\n' + (fail.length ? 'FAILED: ' + fail.join(' | ') : 'ALL PASS'));
process.exit(fail.length ? 1 : 0);
