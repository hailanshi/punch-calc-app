/* 打卡工资计算器 · 自检（静态检查 + 逻辑自检）
 *
 * 用法（在仓库根目录）:
 *     node tools/selfcheck.js 打卡工资计算器.html
 * 退出码 0 = 全通过，1 = 有失败。可直接接进 CI。
 *
 * 它做四件事：
 *   1. 语法：把 <script id="appJS"> 的内容丢进 vm 编译，抓语法错误
 *   2. 一致性：HTML 里每个内联 onclick="window.X(...)" 都必须在脚本里 window.X = ...
 *              每个字面量 $('id') 都能在 HTML 里找到对应的 id="..."
 *   3. 不变量：加班费两套参数互斥且只有 otRatesFor 一个计算入口
 *   4. 逻辑：用 stub 的 window/document/localStorage 把真实脚本跑起来，
 *            验证归类、工时拆分、加班费、缺勤、节假日档位与重算、标准工时两套方案、
 *            手风琴互斥、版本号等（不需要浏览器）
 *
 * 改完业务代码先跑这个，再考虑打包 —— 它比开浏览器点一遍快得多。
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const htmlPath = process.argv[2];
if (!htmlPath) {
  console.error('用法: node tools/selfcheck.js 打卡工资计算器.html');
  process.exit(2);
}
const html = fs.readFileSync(htmlPath, 'utf8');

let fails = 0, passes = 0;
function ok(name, cond, extra) {
  if (cond) { passes++; console.log('  PASS  ' + name); }
  else { fails++; console.log('  FAIL  ' + name + (extra !== undefined ? '  →  ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ---------- 1. 语法 ---------- */
section('1. JS 语法');
const m = html.match(/<script id="appJS">([\s\S]*?)<\/script>/);
ok('找到 <script id="appJS">', !!m);
const script = m[1];
try { new vm.Script(script, { filename: 'appJS.js' }); ok('脚本可解析（无语法错误）', true); }
catch (e) { ok('脚本可解析（无语法错误）', false, e.message); process.exit(1); }

/* ---------- 2. 内联 onclick → window 导出 ---------- */
section('2. 内联 onclick → window 导出');
const markup = html.slice(0, html.indexOf('<script id="appJS">'));
const used = new Set();
for (const mm of markup.matchAll(/on(?:click|change|input)="window\.([A-Za-z_$][\w$]*)\s*\(/g)) used.add(mm[1]);
const assigned = new Set();
for (const mm of script.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) assigned.add(mm[1]);
const missing = [...used].filter(n => !assigned.has(n));
ok('所有内联 handler 都已挂到 window (' + used.size + ' 个)', missing.length === 0, missing.join(', '));
ok('markup 里确实取到了 handler（防正则失配）', used.size > 25, used.size);

/* ---------- 3. $('id') ↔ HTML id ---------- */
section("3. $('id') ↔ HTML id");
const ids = new Set();
for (const mm of html.matchAll(/\sid="([^"]+)"/g)) ids.add(mm[1]);
const wanted = new Set();
for (const mm of script.matchAll(/\$\('([^']+)'\)/g)) wanted.add(mm[1]);
const missingIds = [...wanted].filter(n => !ids.has(n));
ok("所有字面量 $('id') 都能在 HTML 找到 (" + wanted.size + " 个)", missingIds.length === 0, missingIds.join(', '));
for (const must of ['typeRow', 'holiKindRow', 'otModeRow', 'blkRate', 'blkMult', 'tagRate', 'tagMult',
                    'uOtMode', 'uOtRate', 'sRate1', 'sRate2', 'sRate3', 'sOT1', 'sOT2', 'sOT3',
                    'sStdMonth', 'uStdMonth', 'uStdMonthLbl', 'tagStdManual', 'tagStdNet', 'uStdMapList',
                    'setSummary', 'sumStd', 'sumBase', 'sumOt', 'sumPay', 'sumMore', 'themeNow', 'uVersion',
                    'acc-g1', 'acc-g2', 'acc-g3', 'acc-g4', 'acc-g5']) {
  ok('id 存在: ' + must, ids.has(must));
}
ok('旧的 sStd 输入框已移除（并入每月标准工时）', !ids.has('sStd'));
ok('旧的 uAuto / uStd 已移除', !ids.has('uAuto') && !ids.has('uStd'));

/* ---------- 4. 两套参数并存 + 单一计算入口 ---------- */
section('4. 两套加班参数并存、且只有一个计算入口');
ok('DEFAULTS 有 otMode', /otMode:'rate'/.test(script));
ok('DEFAULTS 有倍数 ot1/ot2/ot3', /ot1:1\.5, ot2:2, ot3:3/.test(script));
ok('DEFAULTS 有固定时薪 otRate1/2/3', /otRate1:23\.28/.test(script) && /otRate3:46\.55/.test(script));
// calcMonth 里必须只用 R.r1/R.r2/R.r3，不能再直接乘倍数或直接取 otRate
const cmBody = script.slice(script.indexOf('function calcMonth('), script.indexOf('function rowHtml('));
ok('calcMonth 用 otRatesFor 取生效时薪', /var R = otRatesFor\(ym, S\)/.test(cmBody));
ok('calcMonth 加班费只乘 R.r1/r2/r3',
  /sum\.wd\s*\*\s*R\.r1/.test(cmBody) && /sum\.we\s*\*\s*R\.r2/.test(cmBody) && /sum\.hol\s*\*\s*R\.r3/.test(cmBody));
ok('calcMonth 里没有 S.ot1/S.ot2/S.ot3 直接相乘', !/sum\.\w+\s*\*\s*hourly\s*\*\s*S\.ot/.test(cmBody));
ok('calcMonth 里没有 S.otRate* 直接相乘', !/S\.otRate\d/.test(cmBody));
ok('otRatesFor 是唯一分支点', (script.match(/function otRatesFor\(/g) || []).length === 1);
// 全站不应再有别处自己判断模式
const modeChecks = (script.match(/otMode\s*===\s*'mult'/g) || []).length;
ok("otMode==='mult' 判断只出现在 otRatesFor 与展示逻辑里 (共 " + modeChecks + " 处)", modeChecks <= 6, modeChecks);

/* ---------- 5. 逻辑自检 ---------- */
section('5. 逻辑自检');
const store = new Map();
const localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
const elCache = new Map();
function makeQsa(pairs) {
  // 返回持久化的对象数组：renderXxx 改的 className 必须能被后续查询看到
  const list = pairs.map(p => ({ className: '', getAttribute: k => p[k], setAttribute: () => {} }));
  return () => list;
}
function makeEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', className: '', style: {}, options: [],
    querySelectorAll: () => [], getAttribute: () => null, setAttribute: () => {},
    appendChild: () => {}, parentNode: null, disabled: false, select: () => {}, focus: () => {},
  };
  // 注意：键必须是真实的属性名，否则 getAttribute('data-x') 取不到值
  if (id === 'otModeRow') el.querySelectorAll = makeQsa([{ 'data-m': 'rate' }, { 'data-m': 'mult' }]);
  if (id === 'typeRow') el.querySelectorAll = makeQsa([{ 'data-t': 'work' }, { 'data-t': 'absent' }]);
  if (id === 'holiKindRow') el.querySelectorAll = makeQsa([{ 'data-k': 'weekend' }, { 'data-k': 'holiday' }]);
  return el;
}
const document = {
  getElementById: id => { if (!elCache.has(id)) elCache.set(id, makeEl(id)); return elCache.get(id); },
  addEventListener: () => {}, createElement: () => makeEl('tmp'), querySelectorAll: () => [],
};
const sandbox = {
  console, localStorage, document,
  setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
  Date, Math, JSON, parseInt, parseFloat, isFinite, isNaN, String, Number, Object, Array, RegExp, Error,
  fetch: () => Promise.reject(new Error('no network in test')),
};
sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.addEventListener = () => {};
const runnable = script.replace(/\nboot\(\);\s*/, '\n/* boot() skipped */\n');
let ctx;
try {
  ctx = vm.createContext(sandbox);
  new vm.Script(runnable, { filename: 'appJS-test.js' }).runInContext(ctx);
  ok('脚本在 stub 环境下加载成功', true);
} catch (e) {
  ok('脚本在 stub 环境下加载成功', false, e.stack.split('\n').slice(0, 3).join(' | '));
  console.log('\n结果: ' + passes + ' 通过, ' + fails + ' 失败'); process.exit(1);
}
const S = sandbox;

/* 5.1 默认值 */
const st = S.getSet();
ok('默认 otMode = rate', S.otModeOf(st) === 'rate', st.otMode);
ok('默认倍数 1.5/2/3', st.ot1 === 1.5 && st.ot2 === 2 && st.ot3 === 3, [st.ot1, st.ot2, st.ot3].join('/'));
ok('默认时薪 23.28/31.03/46.55', st.otRate1 === 23.28 && st.otRate2 === 31.03 && st.otRate3 === 46.55,
  [st.otRate1, st.otRate2, st.otRate3].join('/'));

/* 5.2 固定时薪模式：单价写死，不随底薪变 */
S.setRecs([
  S.buildRec('2026-10-10', 'work', 10, ''),  // 调休补班工作日 → 2h 平日加班
  S.buildRec('2026-10-11', 'work', 6, ''),   // 周日 → 6h 周末加班
  S.buildRec('2026-10-01', 'work', 4, ''),   // 国庆当天 → 4h 节假日加班
]);
let cm = S.calcMonth('2026-10');
ok('[rate] 平日 2h×23.28 = 46.56', cm.otWd === 46.56, cm.otWd);
ok('[rate] 周末 6h×31.03 = 186.18', cm.otWe === 186.18, cm.otWe);
ok('[rate] 法定 4h×46.55 = 186.20', cm.otHol === 186.2, cm.otHol);
ok('[rate] 合计 418.94', cm.otMoney === 418.94, cm.otMoney);
const ratePay = cm.otMoney;
S.setSet(Object.assign(S.getSet(), { base: 5000 }));
ok('[rate] 底薪 2700→5000 加班费不变', S.calcMonth('2026-10').otMoney === ratePay);
S.setSet(Object.assign(S.getSet(), { base: 2700 }));
// rate 模式下改倍数不应有任何影响
S.setSet(Object.assign(S.getSet(), { ot1: 9, ot2: 9, ot3: 9 }));
ok('[rate] 改倍数完全不影响结果（互斥）', S.calcMonth('2026-10').otMoney === ratePay, S.calcMonth('2026-10').otMoney);
S.setSet(Object.assign(S.getSet(), { ot1: 1.5, ot2: 2, ot3: 3 }));

/* 5.3 底薪倍数模式：单价跟底薪浮动，且忽略固定时薪 */
S.setSet(Object.assign(S.getSet(), { otMode: 'mult' }));
cm = S.calcMonth('2026-10');
// 2700÷174×1.5 = 23.275862… ×2h = 46.5517 → 46.55（与 rate 的 46.56 只差 1 分，正是"舍入口径"差异）
ok('[mult] 平日 2h = 46.55', cm.otWd === 46.55, cm.otWd);
ok('[mult] 周末 6h = 186.21', cm.otWe === 186.21, cm.otWe);
ok('[mult] 法定 4h = 186.21', cm.otHol === 186.21, cm.otHol);
ok('[mult] 与 rate 模式结果确实不同', cm.otMoney !== ratePay, cm.otMoney + ' vs ' + ratePay);
ok('[mult] 生效时薪带着倍数说明', /倍 = /.test(S.otNote(cm, 1)), S.otNote(cm, 1));
const multPay2700 = cm.otMoney;
S.setSet(Object.assign(S.getSet(), { base: 5000 }));
const cmB = S.calcMonth('2026-10');
ok('[mult] 底薪 2700→5000 加班费跟着涨', cmB.otMoney > multPay2700, multPay2700 + ' → ' + cmB.otMoney);
// mult 模式下改固定时薪不应有任何影响
S.setSet(Object.assign(S.getSet(), { otRate1: 999, otRate2: 999, otRate3: 999 }));
ok('[mult] 改固定时薪完全不影响结果（互斥）', S.calcMonth('2026-10').otMoney === cmB.otMoney, S.calcMonth('2026-10').otMoney);
S.setSet(Object.assign(S.getSet(), { base: 2700, otRate1: 23.28, otRate2: 31.03, otRate3: 46.55 }));

/* 5.4 切回 rate 应立刻恢复原值 */
S.setSet(Object.assign(S.getSet(), { otMode: 'rate' }));
ok('切回 rate 后结果复原', S.calcMonth('2026-10').otMoney === ratePay, S.calcMonth('2026-10').otMoney);

/* 5.5 节假日改动 → 已有记录重算（这是本次修的核心 bug） */
S.setCustom([]);
S.setRecs([S.buildRec('2026-10-12', 'work', 8, '')]);   // 周一，平日 8h 正常出勤
let r0 = S.getRecs()[0];
ok('初始：周一 8h → n=8 d=0', r0.n === 8 && r0.d === 0 && r0.h === 0, JSON.stringify([r0.n, r0.d, r0.h]));
const beforePay = S.calcMonth('2026-10').otMoney;
ok('初始加班费为 0', beforePay === 0, beforePay);

// 把这一天设成「节假日加班档」→ 8h 应全部变成节假日加班
S.setCustom([{ date: '2026-10-12', name: '公司假', kind: 'holiday' }]);
const nChanged = S.resplitRecords();
S.refreshHome();
let r1 = S.getRecs()[0];
ok('新增自定义节假日 → resplitRecords 报告改动 1 条', nChanged === 1, nChanged);
ok('记录已重算：n=0 h=8', r1.n === 0 && r1.h === 8, JSON.stringify([r1.n, r1.d, r1.w, r1.h]));
ok('工资已按新归类重算 (8×46.55=372.40)', S.calcMonth('2026-10').otMoney === 372.4, S.calcMonth('2026-10').otMoney);

// 切成周末加班档 → 应变成 w=8
S.setCustom([{ date: '2026-10-12', name: '公司假', kind: 'weekend' }]);
S.resplitRecords();
let r2 = S.getRecs()[0];
ok('切档后：w=8 h=0', r2.w === 8 && r2.h === 0, JSON.stringify([r2.n, r2.d, r2.w, r2.h]));
ok('工资按周末档重算 (8×31.03=248.24)', S.calcMonth('2026-10').otMoney === 248.24, S.calcMonth('2026-10').otMoney);

// 删除自定义节假日 → 回到工作日
S.setCustom([]);
const nBack = S.resplitRecords();
let r3 = S.getRecs()[0];
ok('删除后 resplitRecords 报告改动', nBack === 1, nBack);
ok('记录回到 n=8', r3.n === 8 && r3.w === 0 && r3.h === 0, JSON.stringify([r3.n, r3.d, r3.w, r3.h]));
ok('工资回到 0', S.calcMonth('2026-10').otMoney === 0);
ok('isHoliday/isWeekend 标记同步更新', r3.isHoliday === 0 && r3.isWeekend === 0, JSON.stringify([r3.isHoliday, r3.isWeekend]));

// 工时缺失的旧记录不能被杀掉
S.setRecs([{ date: '2026-10-13', type: 'work', hours: 0, n: 8, d: 0, w: 0, h: 0 }]);
S.resplitRecords();
ok('工时缺失但有拆分的旧记录被保留', S.getRecs()[0].n === 8, JSON.stringify(S.getRecs()[0]));

/* 5.6 保存打卡不跳首页 */
S.setCustom([]);
S.setRecs([]);
S._editDate = '';
S.$('pDate').value = '2026-10-14';
S.$('pHours').value = '8';
S.$('pNote').value = '测试';
S.pickType('work');
S.doCommitPunch(S.buildRec('2026-10-14', 'work', 8, '测试'));
ok('保存后停留在打卡页', document.getElementById('page-punch').className.indexOf('on') >= 0,
  document.getElementById('page-punch').className);
ok('保存后没有跳到首页', document.getElementById('page-home').className.indexOf('on') < 0,
  document.getElementById('page-home').className);
ok('保存后日期保持在刚存的那天', document.getElementById('pDate').value === '2026-10-14',
  document.getElementById('pDate').value);
ok('保存后表单复位为上班打卡', S._curType === 'work' && document.getElementById('savePunchBtn').textContent === '保存打卡',
  S._curType + '/' + document.getElementById('savePunchBtn').textContent);
ok('记录确实写进去了', S.getRecs().length === 1 && S.getRecs()[0].date === '2026-10-14', JSON.stringify(S.getRecs()));

/* 5.7 编辑保存仍然回记录页 */
S._editDate = '2026-10-14';
S.doCommitPunch(S.buildRec('2026-10-14', 'work', 9, '改过'));
ok('编辑保存后回记录页', document.getElementById('page-records').className.indexOf('on') >= 0,
  document.getElementById('page-records').className);

/* 5.8 设置页：两套值都收、模式开关高亮、互斥标注 */
S.$('sBase').value = '2700';
S.$('sRate1').value = '23.28'; S.$('sRate2').value = '31.03'; S.$('sRate3').value = '46.55';
S.$('sOT1').value = '1.5'; S.$('sOT2').value = '2'; S.$('sOT3').value = '3';
S.$('sSocial').value = '420'; S.$('sTaxThr').value = '5000'; S.$('sTaxRate').value = '0.03';
S.$('sFull').value = '100'; S.$('sPerf').value = '50'; S.$('sPost').value = '400';
S.$('sMeal').value = '15'; S.$('sMealCap').value = '360'; S.$('sStd').value = '174';
S.$('sStdOt').value = '174'; S.$('sAuto').value = '11'; S.$('sTaxOn').value = 'off';
const cs = S.collectSettings();
ok('collectSettings 同时收下两套参数', cs.ot1 === 1.5 && cs.otRate1 === 23.28 && cs.otMode === 'rate',
  JSON.stringify([cs.otMode, cs.ot1, cs.otRate1]));
ok('collectSettings 收下其余字段', cs.base === 2700 && cs.stdOt === 174 && cs.auto === 11);

S.setOtMode('mult');
ok('setOtMode 落库为 mult', S.otModeOf(S.getSet()) === 'mult', S.getSet().otMode);
ok('切换后固定时薪那组灰显', document.getElementById('blkRate').className === 'modeBlock off',
  document.getElementById('blkRate').className);
ok('切换后倍数那组高亮', document.getElementById('blkMult').className === 'modeBlock on',
  document.getElementById('blkMult').className);
ok('倍数组标注生效中', document.getElementById('tagMult').textContent.indexOf('生效') >= 0,
  document.getElementById('tagMult').textContent);
ok('固定时薪组标注未参与计算', document.getElementById('tagRate').textContent === '未参与计算',
  document.getElementById('tagRate').textContent);
S.renderOtModeUI();
const modeBtns = document.getElementById('otModeRow').querySelectorAll('.typeItem');
ok('模式按钮高亮跟着走', modeBtns[1].className === 'typeItem on' && modeBtns[0].className === 'typeItem',
  modeBtns.map(b => b.className).join(' | '));

S.setOtMode('rate');
ok('切回 rate 落库正确', S.otModeOf(S.getSet()) === 'rate', S.getSet().otMode);
ok('切回后倍数组变未参与计算', document.getElementById('tagMult').textContent === '未参与计算',
  document.getElementById('tagMult').textContent);
ok('切换模式不丢另一套的值', S.getSet().ot1 === 1.5 && S.getSet().otRate1 === 23.28,
  JSON.stringify([S.getSet().ot1, S.getSet().otRate1]));

/* 5.9 缺勤按钮（回归） */
S.pickType('absent');
ok('选缺勤 → hoursField 隐藏', document.getElementById('hoursField').style.display === 'none');
ok('选缺勤 → 按钮文案「记录缺勤」', document.getElementById('savePunchBtn').textContent === '记录缺勤',
  document.getElementById('savePunchBtn').textContent);
S.pickType('work');
ok('选上班 → 按钮文案「保存打卡」', document.getElementById('savePunchBtn').textContent === '保存打卡');

/* ---------- 6. 每月标准工时：两套方案 ---------- */
section('6. 每月标准工时（两套方案）');
S.setCustom([]);
S.setRecs([]);
S.setStdMap({});
const stub = id => document.getElementById(id);

// 6.1 未设置时自动推算
let si = S.stdInfo('2026-10');
ok('未设置 → 来源 auto', si.stdSrc === 'auto', si.stdSrc);
ok('未设置 → 工作日×8 自动推算', si.baseDiv === S.offlineWorkdays('2026-10') * 8,
  si.baseDiv + ' vs ' + S.offlineWorkdays('2026-10') * 8);

// 6.2 方案 A：手动套用
stub('sStdMonth').value = '168';
S.applyStdMonth();
si = S.stdInfo('2026-10');
ok('方案A 手动套用 168h 生效', si.baseDiv === 168, si.baseDiv);
ok('方案A 来源标记 manual', si.stdSrc === 'manual', si.stdSrc);
ok('方案A 标签订为「本月生效」', stub('tagStdManual').textContent.indexOf('生效') >= 0,
  stub('tagStdManual').textContent);
ok('方案B 标签为「未生效」', stub('tagStdNet').textContent === '未生效', stub('tagStdNet').textContent);
ok('出勤比例分母真的用上了 168', S.calcMonth('2026-10').stdBase === 168, S.calcMonth('2026-10').stdBase);
ok('写入带时间戳', /^\d\d-\d\d \d\d:\d\d$/.test(S.stdInfo('2026-10').stdAt), S.stdInfo('2026-10').stdAt);

// 6.3 方案 A 非法输入不能写入
stub('sStdMonth').value = '0';
S.applyStdMonth();
ok('方案A 输入 0 被拒绝，仍是 168', S.stdInfo('2026-10').baseDiv === 168, S.stdInfo('2026-10').baseDiv);
stub('sStdMonth').value = 'abc';
S.applyStdMonth();
ok('方案A 输入非数字被拒绝', S.stdInfo('2026-10').baseDiv === 168, S.stdInfo('2026-10').baseDiv);

// 6.4 方案 B：联网更新（直接写存储 + 重渲染，等价于 netUpdateStd 成功后的动作）
S.setStdForMonth('2026-10', 176, 'net');
S.renderStdSection();
si = S.stdInfo('2026-10');
ok('方案B 联网写入 176h 生效', si.baseDiv === 176 && si.stdSrc === 'net', si.baseDiv + '/' + si.stdSrc);
ok('方案B 切换后标签互换', stub('tagStdNet').textContent.indexOf('生效') >= 0
  && stub('tagStdManual').textContent === '未生效', stub('tagStdNet').textContent + '/' + stub('tagStdManual').textContent);

// 6.5 清除 → 回到自动
S.clearStdMonth();
si = S.stdInfo('2026-10');
ok('清除后回到 auto', si.stdSrc === 'auto' && si.baseDiv === S.offlineWorkdays('2026-10') * 8, si.baseDiv + '/' + si.stdSrc);

// 6.6 只影响当月，其他月份仍自动
S.setStdForMonth('2026-10', 160, 'manual');
ok('手动只作用于当月', S.stdInfo('2026-10').baseDiv === 160 && S.stdInfo('2026-11').stdSrc === 'auto',
  S.stdInfo('2026-10').baseDiv + '/' + S.stdInfo('2026-11').stdSrc);
S.clearStdMonth();
ok('清除只清当月', S.stdInfo('2026-10').stdSrc === 'auto');

// 6.7 旧数据兼容：纯数字也要能读
S.setStdMap({ '2026-09': 174 });
si = S.stdInfo('2026-09');
ok('旧格式纯数字兼容读取', si.baseDiv === 174 && si.stdSrc === 'manual', si.baseDiv + '/' + si.stdSrc);
S.setStdMap({});
ok('stdRecOf 对空/非法值返回 null', S.stdRecOf({}, '2026-01') === null && S.stdRecOf({ x: 'abc' }, 'x') === null);

// 6.8 影响工资：手动改标准工时 → 出勤比例变 → 底薪变
// 2026-10-01/02/03 三天法定假，没打卡会自动按 3×8 = 24h 有效出勤计入
S.setRecs([]);
const eff = S.calcMonth('2026-10').sum.effHours;
ok('2026-10 法定假自动计 3 天 × 8 = 24h 有效出勤', eff === 24, eff);
S.setStdMap({ '2026-10': 100 });
const payTight = S.calcMonth('2026-10');
S.setStdMap({ '2026-10': 200 });
const payLoose = S.calcMonth('2026-10');
S.setStdMap({ '2026-10': 20 });
const payCap = S.calcMonth('2026-10');
S.setStdMap({});
ok('标准工时 100h → 出勤比例 24/100 = 24%', Math.round(payTight.ratio * 100) === 24, Math.round(payTight.ratio * 100));
ok('标准工时 200h → 出勤比例 24/200 = 12%', Math.round(payLoose.ratio * 100) === 12, Math.round(payLoose.ratio * 100));
ok('标准工时 20h → 比例封顶 100%', payCap.ratio === 1, payCap.ratio);
ok('底薪随标准工时变化', payTight.base !== payLoose.base && payCap.base > payTight.base,
  [payCap.base, payTight.base, payLoose.base].join('/'));
ok('calcMonth 带出标准工时来源', S.calcMonth('2026-10').stdSrc === 'auto', S.calcMonth('2026-10').stdSrc);

/* ---------- 7. 设置页瘦身：手风琴互斥 ---------- */
section('7. 设置页手风琴');
S.renderSettings();
const heads = { g1: stub('acc-g1'), g2: stub('acc-g2'), g3: stub('acc-g3'), g4: stub('acc-g4'), g5: stub('acc-g5') };
// 模拟 page-settings 下的 accHead 列表
const headEls = ['g1','g2','g3','g4','g5'].map(g => ({ className: g === 'g1' ? 'accHead on' : 'accHead', getAttribute: () => g }));
document.querySelectorAll = sel => (sel === '#page-settings .accHead' ? headEls : []);
heads.g1.className = 'accBody on';
['g2','g3','g4','g5'].forEach(g => { heads[g].className = 'accBody'; });

S.toggleAcc({ getAttribute: () => 'g3', className: 'accHead' });
ok('打开 g3 后 g3 展开', heads.g3.className.indexOf('on') >= 0, heads.g3.className);
ok('打开 g3 时 g1 自动收起（互斥，这是瘦身关键）', heads.g1.className.indexOf('on') < 0, heads.g1.className);
ok('只有一组处于展开状态', ['g1','g2','g3','g4','g5'].filter(g => heads[g].className.indexOf('on') >= 0).length === 1);
S.toggleAcc({ getAttribute: () => 'g3', className: 'accHead on' });
ok('再点一次收起 g3', heads.g3.className.indexOf('on') < 0, heads.g3.className);
ok('全部收起时一个都不开', ['g1','g2','g3','g4','g5'].filter(g => heads[g].className.indexOf('on') >= 0).length === 0);

/* ---------- 8. 版本号与摘要 ---------- */
section('8. 版本号与摘要');
ok('APP_VER = 2.0', S.APP_VER === '2.0', S.APP_VER);
ok('title 带 v2.0', /<title>[^<]*v2\.0[^<]*<\/title>/.test(html));
ok('Info.plist 版本为 2.0', fs.readFileSync(path.join(path.dirname(htmlPath), 'ios-shell/PunchCalcApp/Info.plist'), 'utf8')
  .indexOf('<string>2.0</string>') >= 0);
S.renderSettings();
ok('摘要卡片有内容', stub('setSummary').innerHTML.indexOf('当前生效') >= 0);
ok('摘要显示本月标准工时来源', stub('setSummary').innerHTML.indexOf('自动推算') >= 0);
ok('折叠标题摘要：标准工时', stub('sumStd').textContent.length > 0, stub('sumStd').textContent);
ok('折叠标题摘要：底薪', stub('sumBase').textContent.indexOf('底薪') >= 0, stub('sumBase').textContent);
ok('折叠标题摘要：加班方式', stub('sumOt').textContent.length > 0, stub('sumOt').textContent);
ok('版本号写进「更多」', stub('uVersion').innerHTML.indexOf('v2.0') >= 0, stub('uVersion').innerHTML);
ok('主题名显示中文', stub('themeNow').textContent === '粉色', stub('themeNow').textContent);
/* 回归：点折叠会调 renderAccSums，曾经把主题名覆盖回「pink 主题」 */
S.toggleAcc({ getAttribute: () => 'g2', className: 'accHead' });
ok('点折叠后主题名仍是中文（不被覆盖）', stub('themeNow').textContent === '粉色', stub('themeNow').textContent);

/* ---------- 9. 保存设置后两套加班参数都不丢 ---------- */
section('9. 保存设置回归');
S.setStdMap({});
stub('sBase').value = '2800';
stub('sRate1').value = '24.00'; stub('sRate2').value = '32.00'; stub('sRate3').value = '48.00';
stub('sOT1').value = '1.6'; stub('sOT2').value = '2.1'; stub('sOT3').value = '3.1';
stub('sStdOt').value = '174'; stub('sSocial').value = '430'; stub('sTaxThr').value = '5000';
stub('sTaxRate').value = '0.03'; stub('sFull').value = '110'; stub('sPerf').value = '60';
stub('sPost').value = '420'; stub('sMeal').value = '16'; stub('sMealCap').value = '370';
stub('sAuto').value = '10'; stub('sTaxOn').value = 'off';
S.saveSettings();
const saved = S.getSet();
ok('保存后底薪 2800', saved.base === 2800, saved.base);
ok('保存后两套加班参数都在', saved.otRate1 === 24 && saved.ot1 === 1.6, saved.otRate1 + '/' + saved.ot1);
ok('保存后 otMode 保持', S.otModeOf(saved) === 'rate', saved.otMode);
ok('std 兜底值仍在（非 NaN）', isFinite(saved.std) && saved.std > 0, saved.std);
ok('底薪按月落库', parseFloat(S.getBaseMap()['2026-10']) === 2800, JSON.stringify(S.getBaseMap()));

console.log('\n结果: ' + passes + ' 通过, ' + fails + ' 失败');
process.exit(fails ? 1 : 0);
