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
for (const must of [
                    'uOtRate', 'sStdOt',
                    'sStdMonth', 'uStdMonth', 'uStdMapList',
                    'setSummary', 'sumStd', 'sumOt', 'sumPay', 'sumMore', 'themeNow', 'uVersion',
                    'acc-g1', 'acc-g2', 'acc-g3', 'acc-g4']) {
  ok('id 存在: ' + must, ids.has(must));
}
ok('旧的 sStd 输入框已移除', !ids.has('sStd'));
ok('节假日前端已移除（管理页/自定义节假日/两套加班参数）',
   !ids.has('page-holidays') && !ids.has('holiKindRow') && !ids.has('otModeRow')
   && !ids.has('sRate1') && !ids.has('sOT1') && !ids.has('sAuto'));
ok('餐补上限输入框保留（公司规则 360）', ids.has('sMealCap'));

/* ---------- 4. 加班单价：公司工资条唯一口径 ---------- */
section('4. 加班单价 = 基本工资 ÷ 174 × 1.5/2/3（唯一口径）');
ok('DEFAULTS 已无 otMode / 固定时薪 / 倍数配置',
   !/otMode\s*:/.test(script) && !/otRate1\s*:/.test(script) && !/ot1\s*:/.test(script));
ok('DEFAULTS 保留 stdOt:174', /stdOt\s*:\s*174/.test(script));
const cmBody = script.slice(script.indexOf('function calcMonth('), script.indexOf('function rowHtml('));
ok('calcMonth 用 otRatesFor 取单价', /var R = otRatesFor\(ym, S\)/.test(cmBody));
ok('calcMonth 加班费只乘 R.r1/r2/r3',
  /sum\.wd\s*\*\s*R\.r1/.test(cmBody) && /sum\.we\s*\*\s*R\.r2/.test(cmBody) && /sum\.hol\s*\*\s*R\.r3/.test(cmBody));
ok('otRatesFor 只有一处定义', (script.match(/function otRatesFor\(/g) || []).length === 1);
ok('全站不再有 otMode 分支', !/otMode/.test(script));

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
/* 自检固定按「整月应出勤」口径，避免断言随系统日期漂移
 * （真实运行时当月会只算到今天为止，见 stdHoursElapsed） */
S._freezeMonthEnd = true;

/* 5.1 默认值（公司工资条口径） */
const st = S.getSet();
ok('默认 stdOt = 174（加班时薪分母）', st.stdOt === 174, st.stdOt);
ok('默认基本工资 2700', st.base === 2700, st.base);
ok('已无固定时薪 / 倍数 / otMode 配置',
  st.otMode === undefined && st.otRate1 === undefined && st.ot1 === undefined);

/* 5.2 三档单价 = 基本工资 ÷ 174 × 1.5 / 2 / 3 */
S.setBaseMap({ '2026-10': 2700 });
S.setSet(Object.assign(S.getSet(), { base: 2700, stdOt: 174 }));
const Rr = S.otRatesFor('2026-10', S.getSet());
ok('平日单价 = 2700÷174×1.5', Math.abs(Rr.r1 - 2700 / 174 * 1.5) < 1e-9, Rr.r1);
ok('周末单价 = 2700÷174×2', Math.abs(Rr.r2 - 2700 / 174 * 2) < 1e-9, Rr.r2);
ok('法定单价 = 2700÷174×3', Math.abs(Rr.r3 - 2700 / 174 * 3) < 1e-9, Rr.r3);
ok('单价文案带倍数', /倍 = /.test(S.otNote(Rr, 1)), S.otNote(Rr, 1));

/* 5.3 底薪变化 → 单价跟着浮动 */
S.setBaseMap({ '2026-10': 2520 });
S.setSet(Object.assign(S.getSet(), { base: 2520 }));
const Rr2 = S.otRatesFor('2026-10', S.getSet());
ok('2520 时平日单价 = 2520÷174×1.5', Math.abs(Rr2.r1 - 2520 / 174 * 1.5) < 1e-9, Rr2.r1);
ok('底薪降 → 单价跟着降', Rr2.r1 < Rr.r1, Rr.r1 + ' → ' + Rr2.r1);
S.setBaseMap({});
S.setSet(Object.assign(S.getSet(), { base: 2700 }));

/* 5.4 加班单价只跟基本工资走（公司工资条口径） */
S.setBaseMap({ '2026-10': 2700 });
S.setSet(Object.assign(S.getSet(), { base: 2700, stdOt: 174 }));
const R27 = S.otRatesFor('2026-10', S.getSet());
ok('2700 ÷ 174 × 1.5 = 23.2759', Math.abs(R27.r1 - 2700 / 174 * 1.5) < 1e-9, R27.r1);
ok('2700 ÷ 174 × 2 = 31.0345', Math.abs(R27.r2 - 2700 / 174 * 2) < 1e-9, R27.r2);
S.setBaseMap({ '2026-10': 2520 });
S.setSet(Object.assign(S.getSet(), { base: 2520 }));
const R25 = S.otRatesFor('2026-10', S.getSet());
ok('2520 ÷ 174 × 1.5 = 21.7241', Math.abs(R25.r1 - 2520 / 174 * 1.5) < 1e-9, R25.r1);
ok('2520 ÷ 174 × 2 = 28.9655', Math.abs(R25.r2 - 2520 / 174 * 2) < 1e-9, R25.r2);
S.setBaseMap({});
S.setSet(Object.assign(S.getSet(), { base: 2700 }));

/* 5.5 内置法定节假日表仅用于「没有工资条的月份推算应出勤工时」 */
ok('法定当天识别为 holiday', S.classify('2026-10-01').type === 'holiday', S.classify('2026-10-01').type);
ok('调休补班日识别为 workday', S.classify('2026-10-10').type === 'workday', S.classify('2026-10-10').type);
ok('普通周末识别为 weekend', S.classify('2026-10-11').type === 'weekend', S.classify('2026-10-11').type);
ok('classify 不再读自定义节假日', !/var cs = getCustom/.test(script));
ok('节假日管理页已移除', html.indexOf('id="page-holidays"') < 0);
ok('自定义节假日存储已无入口', !/window\.addHoliday/.test(script));

// 工时缺失的旧记录不能被杀掉
S.setRecs([{ date: '2026-10-13', type: 'work', hours: 0, n: 8, d: 0, w: 0, h: 0 }]);
S.resplitRecords();
ok('工时缺失但有拆分的旧记录被保留', S.getRecs()[0].n === 8, JSON.stringify(S.getRecs()[0]));

/* 5.8 设置页：collectSettings 按工资条口径收参 */
S.$('sBase').value = '2700';
S.$('sSocial').value = '421.04';
S.$('sFull').value = '100'; S.$('sPerf').value = '50'; S.$('sPost').value = '400';
S.$('sSenior').value = '50'; S.$('sOther').value = '0';
S.$('sMeal').value = '15';
S.$('sStdOt').value = '174';
S.$('sTaxThr').value = '5000'; S.$('sTaxRate').value = '0.03'; S.$('sTaxOn').value = 'off';
const cs = S.collectSettings();
ok('collectSettings 收下工资条参数',
  cs.base === 2700 && cs.social === 421.04 && cs.stdOt === 174 && cs.meal === 15,
  JSON.stringify([cs.base, cs.social, cs.stdOt, cs.meal]));
ok('collectSettings 收下奖金三项（绩效/岗位/工龄）',
  cs.perf === 50 && cs.post === 400 && cs.senior === 50, JSON.stringify([cs.perf, cs.post, cs.senior]));
ok('collectSettings 已无旧字段（otMode/固定时薪/倍数/自动补卡）',
  cs.otMode === undefined && cs.otRate1 === undefined && cs.ot1 === undefined
  && cs.auto === undefined && cs.std === undefined);
ok('collectSettings 收下餐补上限 360', cs.mealCap === 360, cs.mealCap);

/* ---------- 6. 每月标准工时：两套方案 ---------- */
section('6. 应出勤工时（工资条 / 手动 / 自动推算）');
S._curYM = '2026-10';   /* boot 被跳过，这里显式指定查看月份 */
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
ok('出勤比例分母真的用上了 168', S.calcMonth('2026-10').stdBase === 168, S.calcMonth('2026-10').stdBase);
ok('写入带时间戳', /^\d\d-\d\d \d\d:\d\d$/.test(S.stdInfo('2026-10').stdAt), S.stdInfo('2026-10').stdAt);

// 6.3 方案 A 非法输入不能写入
stub('sStdMonth').value = '0';
S.applyStdMonth();
ok('方案A 输入 0 被拒绝，仍是 168', S.stdInfo('2026-10').baseDiv === 168, S.stdInfo('2026-10').baseDiv);
stub('sStdMonth').value = 'abc';
S.applyStdMonth();
ok('方案A 输入非数字被拒绝', S.stdInfo('2026-10').baseDiv === 168, S.stdInfo('2026-10').baseDiv);

// 6.4 读工资条写入应出勤工时（来源标记 sheet）
S.setStdForMonth('2026-10', 176, 'net');
S.renderStdSection();
si = S.stdInfo('2026-10');
ok('方案B 联网写入 176h 生效', si.baseDiv === 176 && si.stdSrc === 'net', si.baseDiv + '/' + si.stdSrc);

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

// 6.8 公司工资条口径：正班合计 = 应出勤工时 − 请假工时
// 2026-10-01/02/03 三天法定假，没打卡会自动按 3×8 = 24h 计入「有效出勤」参考值
S.setRecs([]);
const eff = S.calcMonth('2026-10').sum.effHours;
ok('2026-10 法定假自动计 3 天 × 8 = 24h 有效出勤', eff === 24, eff);
S.setStdMap({ '2026-10': 100 });
const payTight = S.calcMonth('2026-10');
S.setStdMap({ '2026-10': 200 });
const payLoose = S.calcMonth('2026-10');
S.setStdMap({});
ok('无请假 → 正班合计 = 应出勤 100h', payTight.attendHours === 100, payTight.attendHours);
ok('无请假 → 出勤比例 100%', payTight.ratio === 1, payTight.ratio);
ok('无请假 → 正班工资 = 基本工资全额', payTight.base === 2700, payTight.base);
ok('换应出勤工时不改变全额结论', payLoose.base === 2700, payLoose.base);
// 请假 1 天（显式 absent 记录）→ 扣 8h
S.setStdMap({ '2026-10': 100 });
S.setRecs([S.buildRec('2026-10-12', 'absent', 0, '事假')]);
const payLeave = S.calcMonth('2026-10');
ok('请假 1 天 → 正班合计 100 − 8 = 92h', payLeave.attendHours === 92, payLeave.attendHours);
ok('请假 1 天 → 出勤比例 92%', Math.round(payLeave.ratio * 100) === 92, Math.round(payLeave.ratio * 100));
ok('请假 1 天 → 正班工资 2700÷100×92 = 2484', payLeave.base === 2484, payLeave.base);
S.setStdMap({});
S.setRecs([]);
ok('calcMonth 带出标准工时来源', S.calcMonth('2026-10').stdSrc === 'auto', S.calcMonth('2026-10').stdSrc);

/* ---------- 7. 设置页瘦身：手风琴互斥 ---------- */
section('7. 设置页手风琴');
S.renderSettings();
const heads = { g1: stub('acc-g1'), g2: stub('acc-g2'), g3: stub('acc-g3'), g4: stub('acc-g4') };
// 模拟 page-settings 下的 accHead 列表
const headEls = ['g1','g2','g3','g4'].map(g => ({ className: g === 'g1' ? 'accHead on' : 'accHead', getAttribute: () => g }));
document.querySelectorAll = sel => (sel === '#page-settings .accHead' ? headEls : []);
heads.g1.className = 'accBody on';
['g2','g3','g4'].forEach(g => { heads[g].className = 'accBody'; });

S.toggleAcc({ getAttribute: () => 'g3', className: 'accHead' });
ok('打开 g3 后 g3 展开', heads.g3.className.indexOf('on') >= 0, heads.g3.className);
ok('打开 g3 时 g1 自动收起（互斥，这是瘦身关键）', heads.g1.className.indexOf('on') < 0, heads.g1.className);
ok('只有一组处于展开状态', ['g1','g2','g3','g4'].filter(g => heads[g].className.indexOf('on') >= 0).length === 1);
S.toggleAcc({ getAttribute: () => 'g3', className: 'accHead on' });
ok('再点一次收起 g3', heads.g3.className.indexOf('on') < 0, heads.g3.className);
ok('全部收起时一个都不开', ['g1','g2','g3','g4'].filter(g => heads[g].className.indexOf('on') >= 0).length === 0);

/* ---------- 8. 版本号与摘要 ---------- */
section('8. 版本号与摘要');
ok('APP_VER = 2.6', S.APP_VER === '2.6', S.APP_VER);
ok('title 带 v2.6', /<title>[^<]*v2\.6[^<]*<\/title>/.test(html));
ok('Info.plist 版本为 2.6', fs.readFileSync(path.join(path.dirname(htmlPath), 'ios-shell/PunchCalcApp/Info.plist'), 'utf8')
  .indexOf('<string>2.6</string>') >= 0);
S.renderSettings();
ok('摘要卡片有内容', stub('setSummary').innerHTML.indexOf('当前生效') >= 0);
ok('摘要显示本月标准工时来源', stub('setSummary').innerHTML.indexOf('自动推算') >= 0);
ok('折叠标题摘要：标准工时', stub('sumStd').textContent.length > 0, stub('sumStd').textContent);
ok('折叠标题摘要：奖金基数', stub('sumPay').textContent.indexOf('奖金') >= 0, stub('sumPay').textContent);
ok('折叠标题摘要：加班折算', stub('sumOt').textContent.indexOf('174') >= 0 || stub('sumOt').textContent.length > 0, stub('sumOt').textContent);
ok('版本号写进「更多」', stub('uVersion').innerHTML.indexOf('v2.6') >= 0, stub('uVersion').innerHTML);
ok('主题名显示中文', stub('themeNow').textContent === '粉色', stub('themeNow').textContent);
/* 回归：点折叠会调 renderAccSums，曾经把主题名覆盖回「pink 主题」 */
S.toggleAcc({ getAttribute: () => 'g2', className: 'accHead' });
ok('点折叠后主题名仍是中文（不被覆盖）', stub('themeNow').textContent === '粉色', stub('themeNow').textContent);

/* ---------- 9. 保存设置：工资条参数回归 ---------- */
section('9. 保存设置回归');
S.setStdMap({});
stub('sBase').value = '2800';
stub('sStdOt').value = '174';
stub('sSocial').value = '430';
stub('sTaxThr').value = '5000';
stub('sTaxRate').value = '0.03';
stub('sFull').value = '110'; stub('sPerf').value = '60';
stub('sPost').value = '420'; stub('sSenior').value = '55'; stub('sOther').value = '20';
stub('sMeal').value = '16'; stub('sTaxOn').value = 'off';
S.saveSettings();
const saved = S.getSet();
ok('保存后基本工资 2800', saved.base === 2800, saved.base);
ok('保存后奖金三项（绩效/岗位/工龄）', saved.perf === 60 && saved.post === 420 && saved.senior === 55,
  JSON.stringify([saved.perf, saved.post, saved.senior]));
ok('保存后社保/全勤/餐补', saved.social === 430 && saved.full === 110 && saved.meal === 16,
  JSON.stringify([saved.social, saved.full, saved.meal]));
ok('保存后不再写回旧字段', saved.otMode === undefined && saved.otRate1 === undefined && saved.auto === undefined);
ok('加班分母仍是 174（非 NaN）', saved.stdOt === 174, saved.stdOt);
ok('基本工资按月落库', parseFloat(S.getBaseMap()['2026-10']) === 2800, JSON.stringify(S.getBaseMap()));

/* ---------- 10. HR 工资条对照 ---------- */
section('10. HR 工资条对照');
/* 密码算法：必须与真实抓包值逐字节一致（这是最容易写错的一处） */
ok('hrSecret 是函数', typeof S.hrSecret === 'function');
if (typeof S.hrSecret === 'function') {
  ok("hrSecret('testpw') 与抓包算法一致",
    S.hrSecret('testpw') === '200203218205221224222231204205', S.hrSecret('testpw'));
  ok('hrSecret 长度随密码增长', S.hrSecret('12345678').length > S.hrSecret('123456').length);
}
/* 只做工资条对照，不应再有任何考勤汇总 UI */
ok('已移除考勤汇总字段表 HR_KQ_FIELDS', typeof S.HR_KQ_FIELDS === 'undefined');
ok('HR 页不再有考勤卡片', html.indexOf('id="hrAttCard"') < 0 && html.indexOf('id="hrAttRows"') < 0);
ok('HR 页不再有考勤渲染函数', script.indexOf('function hrRenderAtt') < 0);
ok('HR 工资条映射有应出勤/H1/H2/实发',
  S.HR_GZ_FIELDS.some(f => f[0] === 'item_61') &&
  S.HR_GZ_FIELDS.some(f => f[0] === 'item_66') &&
  S.HR_GZ_FIELDS.some(f => f[0] === 'item_67') &&
  S.HR_GZ_FIELDS.some(f => f[0] === 'item_145'));
/* 缓存读写 + 渲染不抛异常 */
S.storeSet('punchSalaryHrCache_v1', {});
ok('HR 缓存初始为空', Object.keys(S.hrCacheGet()).length === 0);
S.storeSet('punchSalaryHrCache_v1', {
  '2026-08': {
    at: '2026-10-01 20:00', ym: '2026-08',
    kq: { rows: [{ id_date: '2026-08-01', calc_field1: 8, calc_field3: 3 }] },
    card: { rows: [{ kq_date: '2026-08-01', card1: '2026-08-01 08:00', card2: '2026-08-01 17:00' }] },
    gz: { gz_result: { item_61: '168.0', item_66: '60.0', item_67: '22.0', item_145: '4935.01' } },
    gzMsg: ''
  }
});
ok('HR 缓存可写可读', !!S.hrCacheGet()['2026-08']);
/* 数据卡只在登录后显示：先验证未登录时不渲染数据，再模拟登录 */
S._hrLoggedIn = false;
S._hrYM = '2026-08';
stub('hrPayRows').innerHTML = 'SENTINEL';
S.hrRender();
ok('未登录时不渲染数据卡', stub('hrPayRows').innerHTML === 'SENTINEL', stub('hrPayRows').innerHTML);
ok('未登录时显示登录卡', stub('hrLoginCard').style.display !== 'none', stub('hrLoginCard').style.display);
/* 模拟已登录（等价于用户完成登录） */
S._hrAcct = 'T00001'; S._hrPwd = 'testpw'; S._hrLoggedIn = true;
let hrErr = '';
try {
  S._hrYM = '2026-08';
  S.hrRender();
} catch (e) { hrErr = e.message; }
ok('hrRender 不抛异常', hrErr === '', hrErr);
ok('登录后显示数据卡', stub('hrDataWrap').style.display !== 'none', stub('hrDataWrap').style.display);
ok('登录后隐藏登录卡', stub('hrLoginCard').style.display === 'none', stub('hrLoginCard').style.display);
ok('工资条卡片渲染出实发工资', stub('hrPayRows').innerHTML.indexOf('实发工资') >= 0);
ok('工资条金额带 ¥ 符号', stub('hrPayRows').innerHTML.indexOf('¥4935.01') >= 0);
/* 对照：只比工资条，不再比考勤 */
ok('对照卡片渲染出「本机计算」列', stub('hrCmpRows').innerHTML.indexOf('本机计算') >= 0);
ok('对照卡片含实发工资一项', stub('hrCmpRows').innerHTML.indexOf('实发工资') >= 0);
ok('对照不再输出考勤工时增减', stub('hrCmpRows').innerHTML.indexOf('正班工时（') < 0);
ok('逐日明细渲染出日期', stub('hrDayRows').innerHTML.indexOf('2026-08-01') >= 0);
ok('逐日明细带导入勾选框', stub('hrDayRows').innerHTML.indexOf('hrDayChk') >= 0);
ok('逐日明细预演归类（→ 提示）', stub('hrDayRows').innerHTML.indexOf('→') >= 0);

/* 公司班次口径：正班 = 落在 8:20-11:50 / 12:50-17:20 内的时长；加班 = 18:00 后；统计取整数 */
const REAL_PUNCH = {
  card1: '2026-09-01 08:12', card2: '2026-09-01 11:51',
  card3: '2026-09-01 12:45', card4: '2026-09-01 17:21',
  card5: '2026-09-01 17:55', card6: '2026-09-01 21:00'
};
const rp = S.hrDayPunch(REAL_PUNCH, null);
ok('真实打卡：正班 8h（早到/晚走不计）', rp.normal === 8, rp.normal);
ok('真实打卡：加班 3h（18 点后，不计那几分钟）', rp.ot === 3, rp.ot);
ok('真实打卡：合计 11h（整数）', S.hrDayHours(REAL_PUNCH) === 11, S.hrDayHours(REAL_PUNCH));
ok('满勤 8:20-11:50 / 12:50-17:20 = 正班 8h、无加班',
  S.hrDayHours({ card1: '2026-08-03 08:20', card2: '2026-08-03 11:50', card3: '2026-08-03 12:50', card4: '2026-08-03 17:20' }) === 8);
/* 迟到 / 早退要如实扣减（用户明确说这两种要计较） */
const late = S.hrDayPunch({ card1: '2026-08-03 08:45', card2: '2026-08-03 11:50', card3: '2026-08-03 12:50', card4: '2026-08-03 17:20' }, null);
ok('迟到 25 分钟 → 正班 7.58h（不被抹平）', Math.abs(late.normal - 7.58) < 0.005, late.normal);
const early = S.hrDayPunch({ card1: '2026-08-03 08:20', card2: '2026-08-03 11:50', card3: '2026-08-03 12:50', card4: '2026-08-03 16:00' }, null);
ok('早退 80 分钟 → 正班 6.67h（不被抹平）', Math.abs(early.normal - 6.67) < 0.005, early.normal);
ok('加班到 20:00 → 加班 2h', S.hrDayPunch({ card1: '2026-08-03 08:20', card2: '2026-08-03 11:50', card3: '2026-08-03 12:50', card4: '2026-08-03 17:20', card5: '2026-08-03 17:55', card6: '2026-08-03 20:00' }, null).ot === 2);
ok('hrDayHours 无卡返回 0', S.hrDayHours({}) === 0);
ok('hrDayHours 脏数据（单段超 16h）不计入',
  S.hrDayHours({ card1: '2026-08-01 00:00', card2: '2026-08-02 20:00' }) === 0);
/* 只有一条卡（漏打下班卡）不能丢整天：补正常下班 21:00，标记 partial */
const oneCard = S.hrDayPunch({ card1: '2026-08-03 08:20' }, '2026-08-03');
ok('只有一条卡时识别为缺卡 partial', oneCard.partial === true && oneCard.punched === 1, JSON.stringify(oneCard));
ok('只有一条卡仍算出整天 11h（正班 8 + 加班 3）',
  S.hrDayHours({ card1: '2026-08-03 08:20' }) === 11, S.hrDayHours({ card1: '2026-08-03 08:20' }));
/* 三条卡（漏了最后一次）同样补齐 */
const threeCard = S.hrDayPunch({
  card1: '2026-08-03 08:20', card2: '2026-08-03 11:50', card3: '2026-08-03 12:50'
}, '2026-08-03');
ok('三条卡也按 partial 处理并按 21:00 补齐', threeCard.partial === true && threeCard.normal + threeCard.ot === 11,
  threeCard.normal + '/' + threeCard.ot);
ok('正常四条卡不算 partial',
  S.hrDayPunch({ card1: '2026-08-03 08:20', card2: '2026-08-03 11:50', card3: '2026-08-03 12:50', card4: '2026-08-03 17:20' }, '2026-08-03').partial === false);
/* 缺卡的日期照样能导入，不会被跳过 */
const impOne = {
  card: { rows: [{ kq_date: '2026-08-03', card1: '2026-08-03 08:20' }] },
  kq: { rows: [{ id_date: '2026-08-03' }] }
};
ok('只有一条卡的日期可以导入（不被 skipped）',
  S.hrBuildImport(impOne, ['2026-08-03']).recs.length === 1 &&
  S.hrBuildImport(impOne, ['2026-08-03']).skipped === 0,
  JSON.stringify(S.hrBuildImport(impOne, ['2026-08-03'])));
/* 只有 1 天的数据也要能导入 1 条 */
const impSingle = {
  card: { rows: [{ kq_date: '2026-10-06', card1: '2026-10-06 08:20', card2: '2026-10-06 11:50', card3: '2026-10-06 12:50', card4: '2026-10-06 17:20' }] },
  kq: { rows: [{ id_date: '2026-10-06' }] }
};
ok('只有 1 天数据也能导入 1 条', S.hrBuildImport(impSingle, ['2026-10-06']).recs.length === 1);
/* 完全没打卡（card 全空）才跳过 */
const impEmpty = {
  card: { rows: [{ kq_date: '2026-10-01', card1: '' }] },
  kq: { rows: [{ id_date: '2026-10-01' }] }
};
ok('无打卡的日期才计入 skipped', S.hrBuildImport(impEmpty, ['2026-10-01']).skipped === 1);

/* 缺勤预览：导入前要能看出哪些工作日没记录、会清零全勤奖 */
S.storeSet('punchSalaryHrCache_v1', {
  '2026-08': {
    at: '2026-10-01 22:00', ym: '2026-08',
    kq: { rows: [{ id_date: '2026-08-03' }, { id_date: '2026-08-04' }] },
    card: { rows: [
      { kq_date: '2026-08-03', card1: '2026-08-03 08:20', card2: '2026-08-03 11:50', card3: '2026-08-03 12:50', card4: '2026-08-03 17:20' },
      { kq_date: '2026-08-04', card1: '' }
    ] },
    gz: { gz_result: {} }, gzMsg: ''
  }
});
S.setRecs([]);
S._hrYM = '2026-08'; S._curYM = '2026-08';
S.hrRender();
const impHintTxt = stub('hrImpHint').innerHTML;
ok('导入提示带缺勤预警', impHintTxt.indexOf('算<b>缺勤</b>') >= 0 || impHintTxt.indexOf('缺勤') >= 0);
ok('导入提示给出可导入天数（只算有空卡的）',
  impHintTxt.indexOf('本次可导入 <b>1</b> 天') >= 0, impHintTxt.slice(0, 300));
ok('导入提示说明全勤奖会清零', impHintTxt.indexOf('全勤奖') >= 0);

/* ---------- 12. 跨月对照必须被拦掉 ---------- */
section('12. 跨月对照拦截（8月工资条 ≠ 9月考勤）');
/* 工资条月初与查看月份不同 → 不给任何金额差额 */
S.storeSet('punchSalaryHrCache_v1', {
  '2026-09': {
    at: '2026-10-01 22:30', ym: '2026-09',
    kq: { rows: [{ id_date: '2026-09-01', calc_field1: 8, calc_field3: 3 }] },
    card: { rows: [] },
    gz: { gz_result: { item_2: '2026-08', item_61: '168.0', item_65: '168.0',
                       item_66: '60.0', item_67: '22.0', item_71: '2520.0',
                       item_118: '5355.69', item_145: '4935.01' } },
    gzMsg: ''
  }
});
S._hrYM = '2026-09'; S._curYM = '2026-09';
S.hrRender();
const cmpHtml = stub('hrCmpRows').innerHTML;
ok('跨月时给出拦截提示', cmpHtml.indexOf('月份对不上') >= 0, cmpHtml.slice(0, 200));
ok('跨月时列出工资条所属月份', cmpHtml.indexOf('工资条所属月份') >= 0);
ok('跨月时列出打卡实际月份', cmpHtml.indexOf('网页打卡实际月份') >= 0);
ok('跨月时不显示「本机计算」差额列', cmpHtml.indexOf('本机计算') < 0);
ok('跨月时不显示差额数字', cmpHtml.indexOf('实发工资（') < 0, cmpHtml.slice(0, 300));
ok('跨月时仍可看到工资条原始项', cmpHtml.indexOf('工资条 · 实发工资') >= 0);
ok('跨月提示指引切到工资条月份', stub('hrCmpHint').innerHTML.indexOf('2026-08') >= 0);
/* 同月时恢复正常对照 */
S.storeSet('punchSalaryHrCache_v1', {
  '2026-08': {
    at: '2026-10-01 22:31', ym: '2026-08',
    kq: { rows: [{ id_date: '2026-08-03', calc_field1: 8, calc_field3: 3 }] },
    card: { rows: [] },
    gz: { gz_result: { item_2: '2026-08', item_71: '2520.0', item_145: '4935.01' } },
    gzMsg: ''
  }
});
S._hrYM = '2026-08'; S._curYM = '2026-08';
S.hrRender();
const cmpHtml2 = stub('hrCmpRows').innerHTML;
ok('同月时恢复「本机计算」对照', cmpHtml2.indexOf('本机计算') >= 0);
ok('同月时不再报月份不一致', cmpHtml2.indexOf('月份对不上') < 0);
ok('hrDayPunch 识别休息日', S.hrDayPunch(REAL_PUNCH, '2026-09-27').rest === true);
ok('hrDayPunch 识别工作日（含调休补班 09-20）',
  S.hrDayPunch(REAL_PUNCH, '2026-09-20').rest === false && S.classify('2026-09-20').type === 'workday');
ok('hrDayPunchText 拼出打卡时间', S.hrDayPunchText({ card1: '2026-08-01 08:12', card2: '2026-08-01 17:21' }) === '08:12 17:21');
ok('hrDayPunchText 标注补卡', S.hrDayPunchText({ card1: '2026-08-01 08:12', is_buka1: 'Y' }) === '08:12(补)');
/* 统计取整：整数不显示小数点，迟到才露出小数 */
ok('hrStat 整数不带小数', S.hrStat(8) === '8');
ok('hrStat 非整数保留两位（迟到场景）', S.hrStat(7.42) === '7.42');
ok('hrStat 8.0 归整', S.hrStat(8.001) === '8');

/* 导入：把网页打卡写进本机记录，并按日期自动拆分（用纯函数测，不依赖 DOM 勾选）
 * 用 2026-08-03（周一）而非 08-01（周六），才能验证「工作日 8h 正班 + 加班」 */
const impD = {
  card: { rows: [{
    kq_date: '2026-08-03',
    card1: '2026-08-03 08:20', card2: '2026-08-03 11:50',
    card3: '2026-08-03 12:50', card4: '2026-08-03 17:20',
    card5: '2026-08-03 17:55', card6: '2026-08-03 21:00'
  }] },
  kq: { rows: [{ id_date: '2026-08-03', calc_field1: 8 }] }
};
const built = S.hrBuildImport(impD, ['2026-08-03']);
ok('hrBuildImport 产出 1 条记录', built.recs.length === 1, JSON.stringify(built));
const ir = built.recs[0] || {};
ok('导入记录类型为上班打卡', ir.type === 'work', ir.type);
ok('导入记录日期正确', ir.date === '2026-08-03', ir.date);
ok('导入记录工时 = 正班 8 + 加班 3 = 11h（整数）', ir.hours === 11, ir.hours);
ok('导入记录备注标明来源', String(ir.note).indexOf('HR导入') === 0, ir.note);
ok('导入工时按日期自动拆分（工作日 8h 正班 + 3h 平日加班）', ir.n === 8 && ir.d === 3, ir.n + '/' + ir.d);
/* 周六导入应全部进周末加班桶，验证日期判定真的生效 */
const impSat = {
  card: { rows: [{
    kq_date: '2026-08-01',
    card1: '2026-08-01 08:20', card2: '2026-08-01 11:50',
    card3: '2026-08-01 12:50', card4: '2026-08-01 17:20',
    card5: '2026-08-01 17:55', card6: '2026-08-01 21:00'
  }] },
  kq: { rows: [] }
};
const satRec = S.hrBuildImport(impSat, ['2026-08-01']).recs[0] || {};
ok('周六导入全计周末加班 11h', satRec.w === 11 && satRec.n === 0, satRec.n + '/' + satRec.w);
ok('hrBuildImport 对无打卡日期计入 skipped',
  S.hrBuildImport(impD, ['2026-08-02']).skipped === 1 &&
  S.hrBuildImport(impD, ['2026-08-02']).recs.length === 0);
ok('hrBuildImport 对空入参安全', S.hrBuildImport(null, null).recs.length === 0);
/* 事假标注：站点把事假记在 calc_field19，导入时要提示 */
const impD2 = {
  card: { rows: [{
    kq_date: '2026-08-03',
    card1: '2026-08-03 08:20', card2: '2026-08-03 11:50',
    card3: '2026-08-03 12:50', card4: '2026-08-03 17:20'
  }] },
  kq: { rows: [{ id_date: '2026-08-03', calc_field19: 8 }] }
};
ok('事假日期在备注里被标注',
  String(S.hrBuildImport(impD2, ['2026-08-03']).recs[0].note).indexOf('事假') >= 0,
  S.hrBuildImport(impD2, ['2026-08-03']).recs[0].note);

/* ---------- 11. 月份对应：网页几月 ↔ 本机几月 ---------- */
section('11. 网页月份与本机月份对应');
ok('hrMonthRange 单月', S.hrMonthRange(['2026-08-01', '2026-08-31']).from === '2026-08' &&
  S.hrMonthRange(['2026-08-01', '2026-08-31']).to === '2026-08');
ok('hrMonthRange 跨月取最早/最晚', S.hrMonthRange(['2026-08-31', '2026-09-01']).from === '2026-08' &&
  S.hrMonthRange(['2026-08-31', '2026-09-01']).to === '2026-09');
ok('hrMonthRange 忽略非法值', S.hrMonthRange(['', null, 'garbage']).from === '');
ok('hrMonthRange 对空入参安全', S.hrMonthRange(null).to === '');
/* HR 页与首页/记录页必须同一个月 */
S._hrYM = ''; S._curYM = '2026-09';
S.hrInitYM();
ok('hrInitYM 采用 _curYM（不再自说自话取上月）', S._hrYM === '2026-09', S._hrYM);
S._hrYM = '2026-09'; S._curYM = '2026-09';
S.hrShiftMonth(-1);
ok('HR 页切月带动 _curYM', S._curYM === '2026-08', S._curYM);
ok('HR 页切月后两处一致', S._hrYM === S._curYM, S._hrYM + ' / ' + S._curYM);
S._curYM = '2026-09';
S.shiftMonth(-1);
ok('首页/记录页切月带动 HR 页', S._hrYM === '2026-08', S._hrYM);
S.hrGotoYM('2026-07');
ok('hrGotoYM 同步两边', S._hrYM === '2026-07' && S._curYM === '2026-07');

/* 导入后应自动切到「数据实际所在月份」，而不是停在你碰巧停留的月份 */
const impMonthD = {
  card: { rows: [
    { kq_date: '2026-08-03', card1: '2026-08-03 08:20', card2: '2026-08-03 11:50', card3: '2026-08-03 12:50', card4: '2026-08-03 17:20' },
    { kq_date: '2026-08-04', card1: '2026-08-04 08:20', card2: '2026-08-04 11:50', card3: '2026-08-04 12:50', card4: '2026-08-04 17:20' }
  ] },
  kq: { rows: [{ id_date: '2026-08-03' }, { id_date: '2026-08-04' }] },
  gz: { gz_result: { item_61: '168.0', item_145: '4935.01' } }, gzMsg: ''
};
S.storeSet('punchSalaryHrCache_v1', { '2026-08': impMonthD });
S.setRecs([]);
S._hrYM = '2026-10'; S._curYM = '2026-10';     /* 故意停在 10 月，数据其实是 8 月 */
const hrDayEl = stub('hrDayRows');
hrDayEl.querySelectorAll = () => [
  { checked: true, getAttribute: () => '2026-08-03' },
  { checked: true, getAttribute: () => '2026-08-04' }
];
S.hrImport();
const impRecs = S.getRecs();
ok('导入写入 2 条记录', impRecs.length === 2, impRecs.length);
ok('记录日期来自数据本身（8 月）',
  impRecs.length === 2 && impRecs[0].date.indexOf('2026-08') === 0, impRecs[0] && impRecs[0].date);
ok('导入后自动切到数据月份 2026-08', S._curYM === '2026-08', S._curYM);
ok('HR 页也跟着切到 2026-08', S._hrYM === '2026-08', S._hrYM);
ok('导入的是正班 8h（满勤整点）',
  impRecs.length === 2 && impRecs[0].hours === 8 && impRecs[0].n === 8, impRecs[0] && impRecs[0].hours + 'h');
/* 导入的打卡记录必须参与工资计算（用户要求用它来算） */
const impCalc = S.calcMonth('2026-08');
ok('导入的打卡记录参与工资计算（正班工时 > 0）', impCalc.sum.normal === 16, impCalc.sum.normal);
ok('导入后该月记录数正确', impCalc.recCount === 2, impCalc.recCount);
/* 导入的记录要真的出现在「打卡记录」页，且工时显示为整数 */
S.setRecs([
  { date: '2026-08-03', type: 'work', hours: 11, n: 8, d: 3, w: 0, h: 0, isHoliday: 0, isWeekend: 0, note: 'HR导入 08:20~21:00' }
]);
S._curYM = '2026-08';
S.navTo('records');
const recHtml = stub('recList').innerHTML;
ok('导入的记录出现在记录页', recHtml.indexOf('08月03日') >= 0, recHtml.slice(0, 160));
ok('记录页工时显示为整数 11 而非 11.00', recHtml.indexOf('共 11h') >= 0, recHtml.slice(0, 200));
ok('记录页拆分也显示整数', recHtml.indexOf('正常 8') >= 0 && recHtml.indexOf('平日加 3') >= 0);
ok('记录页保留 HR导入 备注', recHtml.indexOf('HR导入') >= 0);
ok('记录页保留删除入口（已无本地编辑）',
  recHtml.indexOf('askDeleteRecord') >= 0 && recHtml.indexOf('editRecord') < 0);
ok('fmtHs 整数不带小数', S.fmtHs(11) === '11' && S.fmtHs(8) === '8');
ok('fmtHs 迟到场景保留两位', S.fmtHs(7.58) === '7.58');
ok('hrPunchBrief 只取首末两次卡',
  S.hrPunchBrief({ card1: '2026-08-03 08:20', card2: '2026-08-03 11:50', card3: '2026-08-03 12:50', card4: '2026-08-03 17:20' }) === '08:20~17:20');
ok('hrPunchBrief 单条卡只显示一个', S.hrPunchBrief({ card1: '2026-08-03 08:20' }) === '08:20');

/* ---------- 13. 记录页「从HR导入打卡」入口 ---------- */
section('13. 记录页从 HR 导入入口');
ok('记录页有「从HR导入打卡」按钮', /recHrImport\(\)/.test(html) && html.indexOf('从HR导入打卡') >= 0);
ok('recHrImport 已挂 window', script.indexOf('window.recHrImport = recHrImport') >= 0);
ok('openOnlyCard 已定义', typeof S.openOnlyCard === 'function');
ok('_hrWantImport 标记已定义', typeof S._hrWantImport !== 'undefined');
/* 记录页当月已有缓存时：跳到 HR 页并展开导入卡，不重复取数 */
S.storeSet('punchSalaryHrCache_v1', {
  '2026-08': {
    at: '2026-10-01 23:00', ym: '2026-08',
    kq: { rows: [] },
    card: { rows: [{ kq_date: '2026-08-03', card1: '2026-08-03 08:20', card2: '2026-08-03 17:20' }] },
    gz: { gz_result: {} }, gzMsg: ''
  }
});
S._curYM = '2026-08'; S._hrYM = '2026-08';
S.navTo('records');
S.recHrImport();
ok('点入口后切到 HR 页', S._curPage === 'hr', S._curPage);
ok('导入卡片被展开', stub('hrDayCard').className.indexOf('open') >= 0, stub('hrDayCard').className);
ok('已有缓存时不置取数标记', S._hrWantImport === false, S._hrWantImport);
/* 当月没有缓存、但别的月份有：回退到最近读过的月份，不白跑一次网络 */
S.storeSet('punchSalaryHrCache_v1', {
  '2026-07': {
    at: '2026-10-01 23:01', ym: '2026-07',
    kq: { rows: [] }, card: { rows: [] }, gz: { gz_result: {} }, gzMsg: ''
  }
});
S._curYM = '2026-10'; S._hrYM = '2026-10';
S.navTo('records');
S.recHrImport();
ok('当前月无缓存时回退到最近有数据的月份', S._hrYM === '2026-07', S._hrYM);
ok('回退后不再触发网络取数', S._hrWantImport === false, S._hrWantImport);

/* ---------- 14. 导入前先清空该月原有记录 ---------- */
section('14. 导入先清空旧记录（整片覆盖）');
const impCard = (d) => ({ kq_date: d, card1: d + ' 08:20', card2: d + ' 11:50', card3: d + ' 12:50', card4: d + ' 17:20', card5: d + ' 17:55', card6: d + ' 21:00' });
S.storeSet('punchSalaryHrCache_v1', {
  '2026-08': {
    at: '2026-10-02 00:00', ym: '2026-08',
    kq: { rows: [{ id_date: '2026-08-03' }, { id_date: '2026-08-04' }] },
    card: { rows: [impCard('2026-08-03'), impCard('2026-08-04')] },
    gz: { gz_result: {} }, gzMsg: ''
  }
});
/* 预置：月初有手动打卡、还有一条不在导入范围内的日期 */
S.setRecs([
  { date: '2026-08-03', type: 'work', hours: 7, n: 7, d: 0, w: 0, h: 0, note: '手动录的旧数据' },
  { date: '2026-08-04', type: 'absent', hours: 0, n: 0, d: 0, w: 0, h: 0, note: '' },
  { date: '2026-08-10', type: 'work', hours: 8, n: 8, d: 0, w: 0, h: 0, note: '不在导入范围' }
]);
S._hrYM = '2026-08'; S._curYM = '2026-08';
const dayEl = stub('hrDayRows');
dayEl.querySelectorAll = () => [
  { checked: true, getAttribute: () => '2026-08-03' },
  { checked: true, getAttribute: () => '2026-08-04' }
];
S.hrImport();
const afterClear = S.getRecs();
const byDate = {};
for (const r of afterClear) byDate[r.date] = r;
ok('导入后旧的手动记录被清掉（不再 7h）',
  byDate['2026-08-03'] && byDate['2026-08-03'].hours === 11, byDate['2026-08-03'] && byDate['2026-08-03'].hours);
ok('导入后旧的缺勤记录被清掉（变成上班 11h）',
  byDate['2026-08-04'] && byDate['2026-08-04'].type === 'work' && byDate['2026-08-04'].hours === 11,
  byDate['2026-08-04'] && byDate['2026-08-04'].type);
ok('不在导入范围的记录保留',
  byDate['2026-08-10'] && byDate['2026-08-10'].note === '不在导入范围', byDate['2026-08-10'] && byDate['2026-08-10'].note);
ok('导入的日期不重复（没有新旧两条）',
  afterClear.filter((r) => r.date === '2026-08-03').length === 1,
  afterClear.filter((r) => r.date === '2026-08-03').length);
ok('总记录数 = 保留 1 条 + 新增 2 条', afterClear.length === 3, afterClear.length);
ok('重复导入结果稳定（不再有疑问弹窗）', (() => {
  const before = JSON.stringify(S.getRecs().map((r) => r.date + ':' + r.hours).sort());
  S.hrImport();
  const after = JSON.stringify(S.getRecs().map((r) => r.date + ':' + r.hours).sort());
  return before === after;
})());
/* 导入的数据要进工资计算 */
const impCalc2 = S.calcMonth('2026-08');
ok('导入的数据参与工资计算（正班 = 8+8+8）', impCalc2.sum.normal === 24, impCalc2.sum.normal);
ok('导入的数据带来加班工时（3+3）', impCalc2.sum.wd === 6, impCalc2.sum.wd);
ok('导入后该月记录数正确', impCalc2.recCount === 3, impCalc2.recCount);

/* ---------- 15. 公司登录（不预置账号 / 服务器验证 / 保存登录 / 退出） ---------- */
section('15. 公司登录');
ok('源码里不再预置账号密码', typeof S.HR_ACCT === 'undefined' && typeof S.HR_PWD === 'undefined');
ok('源码里没有硬编码账号赋值', !/HR_ACCT\s*=\s*['"]/.test(script) && !/HR_PWD\s*=\s*['"]/.test(script));
ok('登录用的是可编辑输入框而非固定值',
  /user_id:\s*user/.test(script) && /hrSecret\(pass\)/.test(script));
ok('账号存储键已定义', S.LS_HRACCT === 'punchSalaryHrAcct_v1');
ok('认证走 hrAuth / hrEnsureAuth 两个入口',
  typeof S.hrAuth === 'function' && typeof S.hrEnsureAuth === 'function');

/* 造一个假的公司服务器：loginReply 控制登录成败，便于测「登录失败必须留在登录页」 */
let loginReply = '1';
let failCount = 0;
const realHrPost = S.hrPost;
S.hrPost = function (url, body, tms, cb) {
  if (url.indexOf('action=getLangList') >= 0) { cb(true, 200, '{}'); return; }
  if (url.indexOf('LoginController.ashx') >= 0) {
    if (loginReply === '1') { cb(true, 200, '1'); return; }
    failCount++;
    cb(true, 200, loginReply);
    return;
  }
  cb(false, 0, '');
};
const flush = () => { for (let i = 0; i < 12; i++) { /* hrPost 桩是同步回调，无需等待 */ } };

/* 未登录时 hrFetch 应被拦住，不发请求 */
S._hrAcct = ''; S._hrPwd = ''; S._hrLoggedIn = false; S._hrSessionOk = false;
let fetchBlocked = false;
const probePost = S.hrPost;
S.hrPost = (u, b, t, cb) => { fetchBlocked = true; };
S.hrFetch();
S.hrPost = probePost;
ok('未登录时 hrFetch 不发请求', fetchBlocked === false);
ok('未登录时提示去登录', stub('hrLoginHint').textContent.indexOf('请先输入账号') >= 0, stub('hrLoginHint').textContent);
ok('未登录时不显示数据页', stub('hrDataWrap').style.display === 'none', stub('hrDataWrap').style.display);

/* 输入为空要拦住 */
S.hrClearAcct();
stub('hrUser').value = ''; stub('hrPass').value = '';
S.hrLogin();
ok('账号为空时拒绝登录', S._hrLoggedIn === false, S._hrLoggedIn);
ok('账号为空时给出提示', stub('hrLoginHint').textContent.indexOf('请输入账号') >= 0, stub('hrLoginHint').textContent);
stub('hrUser').value = 'u1'; stub('hrPass').value = '';
S.hrLogin();
ok('密码为空时拒绝登录', S._hrLoggedIn === false && stub('hrLoginHint').textContent.indexOf('请输入密码') >= 0);

/* ★ 关键回归：服务器说密码错 -> 必须留在登录页，不能进数据页 */
loginReply = '对不起,您输入的密码不正确';
S._hrSessionOk = false; S._hrLoggedIn = false;
stub('hrUser').value = 'testuser'; stub('hrPass').value = 'wrongpass';
stub('hrRemember').checked = false;
S.hrLogin();
ok('登录失败时留在登录页（不显示数据页）',
  S._hrLoggedIn === false && stub('hrDataWrap').style.display === 'none', S._hrLoggedIn + '/' + stub('hrDataWrap').style.display);
ok('登录失败时登录卡可见', stub('hrLoginCard').style.display !== 'none', stub('hrLoginCard').style.display);
ok('登录失败时给出服务器原因', stub('hrLoginHint').innerHTML.indexOf('密码不正确') >= 0, stub('hrLoginHint').innerHTML);
ok('登录失败时不置会话有效', S._hrSessionOk === false);
ok('登录失败时清掉运行期凭据', S._hrAcct === '' && S._hrPwd === '', S._hrAcct + '/' + S._hrPwd);
ok('登录失败不落盘错误密码', !S.storeGet(S.LS_HRACCT, null));
ok('登录失败可重新登录（输入框仍可编辑）', stub('hrUser').value === 'testuser');

/* 登录成功才进数据页 */
loginReply = '1';
stub('hrUser').value = 'testuser'; stub('hrPass').value = 'testpass'; stub('hrRemember').checked = false;
S.hrLogin();
ok('登录成功后进入数据页', S._hrLoggedIn === true && stub('hrDataWrap').style.display !== 'none', S._hrLoggedIn);
ok('登录成功后隐藏登录卡', stub('hrLoginCard').style.display === 'none', stub('hrLoginCard').style.display);
ok('登录成功后置会话有效', S._hrSessionOk === true);
ok('未勾选保存时不落盘账号', !S.storeGet(S.LS_HRACCT, null), JSON.stringify(S.storeGet(S.LS_HRACCT, null)));
/* 勾选保存 -> 落盘 */
stub('hrUser').value = 'testuser'; stub('hrPass').value = 'testpass'; stub('hrRemember').checked = true;
S.hrLogin();
const loginSaved = S.storeGet(S.LS_HRACCT, null);
ok('勾选保存后账号落盘', loginSaved && loginSaved.u === 'testuser' && loginSaved.p === 'testpass', JSON.stringify(loginSaved));
S._hrLoggedIn = false; S._hrAcct = ''; S._hrPwd = ''; S._hrSessionOk = false;
stub('hrUser').value = ''; stub('hrPass').value = ''; stub('hrRemember').checked = false;
S.hrLoadAcct();
ok('重新打开时预填账号', stub('hrUser').value === 'testuser', stub('hrUser').value);
ok('重新打开时预填密码', stub('hrPass').value === 'testpass', stub('hrPass').value);
ok('重新打开时勾选保存', stub('hrRemember').checked === true);
ok('预填不等于自动登录', S._hrLoggedIn === false, S._hrLoggedIn);
ok('预填不等于会话有效', S._hrSessionOk === false, S._hrSessionOk);
ok('预填后提示可点登录', stub('hrLoginHint').innerHTML.indexOf('已保存登录') >= 0);
/* 退出：回到登录页 */
S._hrLoggedIn = true; S._hrSessionOk = true; S._hrAcct = 'testuser'; S._hrPwd = 'testpass';
S.hrLogout();
ok('退出后回到登录页', S._hrLoggedIn === false && stub('hrLoginCard').style.display !== 'none');
ok('退出后清空运行期凭据', S._hrAcct === '' && S._hrPwd === '', S._hrAcct + '/' + S._hrPwd);
ok('退出不影响已保存的账号', !!S.storeGet(S.LS_HRACCT, null));
/* hrLogin / hrLogout 已挂 window */
ok('hrLogin / hrLogout 已挂 window',
  script.indexOf('window.hrLogin = hrLogin') >= 0 && script.indexOf('window.hrLogout = hrLogout') >= 0);
/* 底部导航：公司入口 + 首屏入口已下线 */
ok('底部导航有「公司」入口', /navItem" data-p="hr"/.test(html) && html.indexOf('>公司</button>') >= 0);
ok('hr 已加入 navPages（切过去底部栏不消失）',
  /var navPages = \[[^\]]*'hr'[^\]]*\]/.test(script));
ok('首页的 HR 按钮已移除', html.indexOf('HR工资条对照 / 导入打卡') < 0);
ok('HR 页标题改为「公司」', /<div class="title">公司<\/div>/.test(html));

/* ---------- 16. 考勤月报签收（WPS） ---------- */
section('16. 考勤月报签收');
ok('WPS 月报地址已定义', S.HR_WPS_URL === 'https://web.wps.cn/etapps/query/q/5Jeta36W');
ok('wpsSign 已挂 window', script.indexOf('window.wpsSign = wpsSign') >= 0);
ok('签收卡 DOM 齐备',
  ['hrWpsCard', 'wpsYear', 'wpsMonth', 'wpsWho', 'wpsSignBtn', 'wpsHint'].every((id) => html.indexOf('id="' + id + '"') >= 0));
ok('wpsBridgeOn 已定义', typeof S.wpsBridgeOn === 'function');
/* 工号姓名从公司数据里提取（用户要求不用手填） */
S.storeSet('punchSalaryHrWho_v1', {});
const who1 = S.hrWhoFromRows([{ reference_code: 'T00001', name: '测试员' }], '测试');
ok('从考勤行里取到工号', who1 && who1.empId === 'T00001', who1 && who1.empId);
ok('从考勤行里取到姓名', who1 && who1.name === '测试员', who1 && who1.name);
ok('工号姓名已落盘', (() => { const w = S.hrWhoGet(); return w && w.empId === 'T00001' && w.name === '测试员'; })());
ok('空数据不覆盖已存身份', (() => { S.hrWhoFromRows([], 'x'); const w = S.hrWhoGet(); return w && w.empId === 'T00001'; })());
ok('缺 reference_code 时用 employee_id 兜底', (() => {
  const before = S.hrWhoGet();
  const got = S.hrWhoFromRows([{ employee_id: 'E9', name: 'N9' }], 'x');
  const okFallback = got && got.empId === 'E9' && got.name === 'N9';
  S.storeSet('punchSalaryHrWho_v1', before);   /* 还原，别影响后面的断言 */
  return okFallback;
})());
/* 未登录不渲染签收卡内容 */
S._hrLoggedIn = false;
S.wpsRender();
ok('未登录时不写入签收提示', stub('wpsHint').innerHTML === '' || stub('wpsHint').innerHTML.indexOf('手写签名') < 0);
/* 登录后渲染：拿到工号姓名 -> 提示可签收；没有桥时禁用按钮 */
S._hrLoggedIn = true; S._hrAcct = 'u'; S._hrPwd = 'p';
S._hrYM = '2026-08'; S._curYM = '2026-08';
S.wpsRender();
ok('签收提示说明会弹出内嵌窗口', stub('wpsHint').innerHTML.indexOf('手写签名') >= 0 || stub('wpsHint').innerHTML.indexOf('App 内使用') >= 0);
ok('签收卡显示工号', stub('wpsWho').innerHTML.indexOf('T00001') >= 0, stub('wpsWho').innerHTML.slice(0, 120));
ok('签收卡显示姓名', stub('wpsWho').innerHTML.indexOf('测试员') >= 0);
ok('年份按当前查看月份预填', stub('wpsYear').value === '2026', stub('wpsYear').value);
ok('月份按当前查看月份预填', stub('wpsMonth').value === '8', stub('wpsMonth').value);
/* 浏览器环境（无原生桥）应禁用按钮并提示 */
ok('无原生桥时禁用签收按钮', stub('wpsSignBtn').disabled === true);
S.wpsSign();   /* 无桥时应被拦住，不抛异常 */
ok('无原生桥时点击签收被拦（不抛异常）', true);
/* 有桥：应把参数投给原生 */
S.window.webkit = { messageHandlers: { wpsSign: { postMessage: (m) => { S.__wpsMsg = m; } } } };
ok('wpsBridgeOn 检测到桥', S.wpsBridgeOn() === true);
S.wpsRender();
ok('有原生桥时按钮可用', stub('wpsSignBtn').disabled === false);
stub('wpsYear').value = '2026'; stub('wpsMonth').value = '6';
S.wpsSign();
const wm = S.__wpsMsg || {};
ok('签收消息带年份', wm.year === '2026', wm.year);
ok('签收消息带月份', wm.month === '6', wm.month);
ok('签收消息带工号（来自公司数据）', wm.empId === 'T00001', wm.empId);
ok('签收消息带姓名（来自公司数据）', wm.name === '测试员', wm.name);
/* 参数校验 */
S.__wpsMsg = null; stub('wpsYear').value = '26';
S.wpsSign();
ok('年份不是 4 位时拒绝', S.__wpsMsg === null);
S.__wpsMsg = null; stub('wpsYear').value = '2026'; stub('wpsMonth').value = '13';
S.wpsSign();
ok('月份越界时拒绝', S.__wpsMsg === null);
/* 原生回调存在 */
ok('wpsAfterSign 回调已挂 window', script.indexOf('window.wpsAfterSign') >= 0);

/* 月份不一致必须告警（考勤接口只有本月/上月两档，服务端会回落） */
ok('跨月时给出告警文案', script.indexOf('月份对不上，已隐藏金额差额') >= 0 && script.indexOf('无法对照') >= 0);
ok('HR 页已注册进 showPage', /var pages = \[[^\]]*'hr'[^\]]*\]/.test(script));
ok('HR 内联 handler 都已挂 window',
  ['hrBack', 'hrFetch', 'hrShiftMonth', 'hrClearCache', 'hrSelAll', 'hrImport']
    .every(f => script.indexOf('window.' + f + ' = ' + f) >= 0));
ok('HR 页 DOM id 齐备',
  ['page-hr', 'hrLoginCard', 'hrUser', 'hrPass', 'hrRemember', 'hrLoginBtn', 'hrLoginHint',
   'hrDataWrap', 'hrMonthLabel', 'hrStatus', 'hrFetchBtn', 'hrPayRows', 'hrPayHint',
   'hrCmpRows', 'hrCmpHint', 'hrDayRows', 'hrImpHint', 'hrAccount']
    .every(id => html.indexOf('id="' + id + '"') >= 0));

/* ---------- 17. 公司日考勤 → 本地记录（婚假 / 加班 / 漏卡） ---------- */
section('17. 日考勤同步（含婚假等假别）');
{
  // 用公司真实的 calc_field 结构造数据（不含任何个人身份信息）
  const kqRows = [
    { id_date: '2026-11-02', calc_field1: 0, calc_field3: 0, calc_field5: 0, calc_field24: 8 }, // 周一 婚假
    { id_date: '2026-11-03', calc_field1: 8, calc_field3: 3, calc_field5: 0 },                 // 周二 出勤+加班
    { id_date: '2026-11-04', calc_field1: 0, calc_field3: 0, calc_field5: 11 },                // 周三 周末档
    { id_date: '2026-11-05', calc_field1: 0, calc_field3: 0, calc_field5: 0 },                 // 全 0 → 跳过
  ];
  const built = S.hrBuildFromKqDetail('2026-11', kqRows);
  ok('婚假 calc_field24 识别为请假', built.leaves === 1, built.leaves);
  ok('出勤记录 2 条', built.works === 2, built.works);
  ok('全 0 的天被跳过', built.skipped === 1, built.skipped);
  const lvRec = built.recs.find(r => r.type === 'absent');
  ok('请假记录带 leave 工时 8h', lvRec && lvRec.leave === 8, lvRec && lvRec.leave);
  ok('请假 note 写明假别（婚假）', lvRec && /婚假/.test(lvRec.note), lvRec && lvRec.note);

  const wRec = built.recs.find(r => r.date === '2026-11-03');
  ok('正班/加班直接搬公司值 n=8 d=3', wRec && wRec.n === 8 && wRec.d === 3, wRec && (wRec.n + '/' + wRec.d));
  const w2 = built.recs.find(r => r.date === '2026-11-04');
  ok('周末档直接搬公司值 w=11', w2 && w2.w === 11, w2 && w2.w);

  S.setRecs(built.recs);
  S.setStdForMonth('2026-11', 176, 'manual');
  S.setBaseMap({ '2026-11': 2700 });
  const m11 = S.calcMonth('2026-11');
  ok('婚假是带薪假 → 不扣正班工时', m11.leaveHours === 0, m11.leaveHours);
  ok('正班合计 = 应出勤 176h', m11.attendHours === 176, m11.attendHours);
  ok('正班工资 = 基本工资全额 2700', m11.base === 2700, m11.base);
  ok('婚假不影响全勤奖（全额发放）', m11.full === S.getSet().full, m11.full + ' / ' + S.getSet().full);
  ok('当月应发出勤工资 = 正班 + 加班', m11.attend === Math.round((m11.base + m11.otMoney) * 100) / 100, m11.attend);

  // 只有事假才扣钱、清全勤
  S.setRecs([
    { date: '2026-11-02', type: 'absent', hours: 0, leave: 8, deduct: true, src: 'kqdetail', note: '事假 8h' },
    { date: '2026-11-03', type: 'work', hours: 8, n: 8, d: 0, w: 0, h: 0, src: 'kqdetail', note: '出勤' },
  ]);
  const m11b = S.calcMonth('2026-11');
  ok('事假扣 8h 正班', m11b.leaveHours === 8, m11b.leaveHours);
  ok('事假 → 正班合计 168h', m11b.attendHours === 168, m11b.attendHours);
  ok('事假 → 全勤清零', m11b.full === 0, m11b.full);

  // 「截至今日」：当月不该把未来工作日算成出勤
  S._freezeMonthEnd = false;
  const nowYM = S.ymNow();
  const me = S.calcMonth(nowYM);
  ok('当月 stdElapsed ≤ stdBase', me.stdElapsed <= me.stdBase, me.stdElapsed + '/' + me.stdBase);
  ok('当月 attendHours 不超过 stdElapsed', me.attendHours <= me.stdElapsed, me.attendHours);
  ok('历史月份仍按整月口径', S.calcMonth('2026-11').stdElapsed === 176, S.calcMonth('2026-11').stdElapsed);
  S._freezeMonthEnd = true;
  S.setRecs([]);
  S.setStdMap({});
}

/* ---------- 18. 餐补上限（公司实测封顶 360） ---------- */
section('18. 餐补 = min(出勤天数 × 每日餐补, 上限)');
{
  // 造 25 个出勤日（对应 7 月：正班 23 天 + 周末 2 天，25×15=375 应封顶到 360）
  const recs = [];
  for (let d = 1; d <= 25; d++) {
    const ds = '2026-07-' + String(d).padStart(2, '0');
    recs.push({ date: ds, type: 'work', hours: 8, n: 8, d: 0, w: 0, h: 0, src: 'kqdetail', note: 'test' });
  }
  S.setRecs(recs);
  S.setStdForMonth('2026-07', 184, 'manual');
  S.setBaseMap({ '2026-07': 2520 });
  S.setSet(Object.assign(S.getSet(), { meal: 15, mealCap: 360 }));
  const m7 = S.calcMonth('2026-07');
  ok('25 天 × 15 = 375', m7.mealRaw === 375, m7.mealRaw);
  ok('封顶后餐补 = 360', m7.meal === 360, m7.meal);

  // 去掉 6 天 → 19 天 × 15 = 285，不触发封顶
  S.setRecs(recs.slice(0, 19));
  const m9 = S.calcMonth('2026-07');
  ok('19 天 × 15 = 285（未封顶）', m9.meal === 285, m9.meal);

  // 上限可改
  S.setSet(Object.assign(S.getSet(), { mealCap: 300 }));
  const m300 = S.calcMonth('2026-07');
  ok('上限改成 300 → 285 仍不受影响', m300.meal === 285, m300.meal);

  S.setRecs([]);
  S.setStdMap({});
  S.setBaseMap({});
  S.setSet(Object.assign(S.getSet(), { meal: 15, mealCap: 360 }));
}

/* ---------- 19. 原始打卡补充日考勤（公司折算滞后） ---------- */
section('19. 打卡补充日考勤');
{
  // 10/16 型：日考勤只给正班 8h，打卡有到 21:00 → 补上 3h 加班
  const kq1 = [{ id_date: '2026-12-01', calc_field1: 8, calc_field3: 0, calc_field5: 0 }];
  const cd1 = [{ kq_date: '2026-12-01',
    card1: '2026-12-01 08:15', card2: '2026-12-01 11:50',
    card3: '2026-12-01 12:50', card4: '2026-12-01 17:20',
    card5: '2026-12-01 17:55', card6: '2026-12-01 21:00' }];
  let b = S.hrBuildFromKqDetail('2026-12', kq1, cd1);
  ok('日考勤缺加班 → 打卡补成 8+3',
    b.recs.length === 1 && b.recs[0].n === 8 && b.recs[0].d === 3,
    JSON.stringify(b.recs.map(r => [r.n, r.d, r.w])));

  // 10/17 型：日考勤还没更新（全 0），打卡有 → 照样写入
  const kq2 = [{ id_date: '2026-12-01', calc_field1: 0, calc_field3: 0, calc_field5: 0 }];
  b = S.hrBuildFromKqDetail('2026-12', kq2, cd1);
  ok('日考勤未更新 → 按打卡写入 8+3',
    b.recs.length === 1 && b.recs[0].n === 8 && b.recs[0].d === 3,
    JSON.stringify(b.recs.map(r => [r.n, r.d, r.w])));

  // 9/20 型：公司标休息日（f5=11），App 内置表当补班日 → 档位必须听公司的
  const kq3 = [{ id_date: '2026-09-20', calc_field1: 0, calc_field3: 0, calc_field5: 11 }];
  const cd3 = [{ kq_date: '2026-09-20',
    card1: '2026-09-20 08:15', card2: '2026-09-20 11:50',
    card3: '2026-09-20 12:50', card4: '2026-09-20 17:20',
    card5: '2026-09-20 17:55', card6: '2026-09-20 21:00' }];
  b = S.hrBuildFromKqDetail('2026-09', kq3, cd3);
  ok('公司标休息日 → 整天进周末档，不拆成 8+3',
    b.recs.length === 1 && b.recs[0].w === 11 && b.recs[0].n === 0 && b.recs[0].d === 0,
    JSON.stringify(b.recs.map(r => [r.n, r.d, r.w])));

  // 打卡比考勤多一天（公司还没折算）→ 也补进来
  const kq4 = [{ id_date: '2026-12-01', calc_field1: 8, calc_field3: 3, calc_field5: 0 }];
  const cd4 = cd1.concat([{ kq_date: '2026-12-02',
    card1: '2026-12-02 08:15', card2: '2026-12-02 11:50',
    card3: '2026-12-02 12:50', card4: '2026-12-02 17:20',
    card5: '2026-12-02 17:55', card6: '2026-12-02 21:00' }]);
  b = S.hrBuildFromKqDetail('2026-12', kq4, cd4);
  ok('打卡多出的日期被补进记录', b.recs.length === 2, b.recs.length);
  ok('补充记录带说明', b.recs.some(r => /打卡补充/.test(r.note)), b.recs.map(r => r.note).join(' | '));
}

console.log('\n结果: ' + passes + ' 通过, ' + fails + ' 失败');
process.exit(fails ? 1 : 0);
