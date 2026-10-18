/* 真实数据回归：9 月（有工资条，逐项比对）+ 10 月（未结算，只看工时口径） */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');
/* hr-data 不入库：本机开发时在工作区根（仓库外一层），clone 后放仓库根即可 */
const DATA = [
  path.join(__dirname, '..', '..', '..', 'hr-data'),
  path.join(__dirname, '..', '..', 'hr-data'),
  path.join(__dirname, '..', 'hr-data'),
  path.join(process.cwd(), 'hr-data'),
].find(p => fs.existsSync(p));
if (!DATA) { console.error('找不到 hr-data/（含真实工资条与考勤，不入库）'); console.error('放到仓库根或工作区根即可，见 tools/tools-README.md'); process.exit(2); }
const html = fs.readFileSync(path.join(ROOT, '打卡工资计算器.html'), 'utf8');
const script = html.match(/<script id="appJS">([\s\S]*?)<\/script>/)[1];

function makeSandbox() {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k),
  };
  const elCache = new Map();
  const makeEl = id => ({
    id, value: '', textContent: '', innerHTML: '', className: '', style: {}, options: [],
    querySelectorAll: () => [], getAttribute: () => null, setAttribute: () => {},
    appendChild: () => {}, parentNode: null, disabled: false, select: () => {}, focus: () => {},
  });
  const document = {
    getElementById: id => { if (!elCache.has(id)) elCache.set(id, makeEl(id)); return elCache.get(id); },
    addEventListener: () => {}, createElement: () => makeEl('tmp'), querySelectorAll: () => [],
  };
  const sandbox = {
    console, localStorage, document,
    setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
    Date, Math, JSON, parseInt, parseFloat, isFinite, isNaN, String, Number, Object, Array, RegExp, Error,
    fetch: () => Promise.reject(new Error('no network')),
  };
  sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.addEventListener = () => {};
  vm.createContext(sandbox);
  new vm.Script(script.replace(/\nboot\(\);\s*/, '\n/* boot skipped */\n'), { filename: 'app.js' }).runInContext(sandbox);
  return sandbox;
}
const load = p => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8').replace(/^\uFEFF/, ''));

/* ---------- 9 月：完整比对 ---------- */
{
  const S = makeSandbox();
  const ym = '2026-09';
  const kq = load('kqdetail-full.decoded.json');
  const gz = load('gzs-2026-09.decoded.json').gz_result;

  console.log('='.repeat(74));
  console.log('  2026-09  完整比对（有工资条）');
  console.log('='.repeat(74));
  console.log('参数对齐: ' + S.hrAlignFromGz(ym, { gz_result: gz }));
  const card = load('kq-2026-09-full.json');
  const sync = S.hrSyncMonth(ym, kq.rows, card.rows);
  console.log('日考勤同步: 写入 ' + sync.added + ' 条（出勤 ' + sync.built.works
    + ' 天 / 请假 ' + sync.built.leaves + ' 天）');
  if (sync.built.unknown && sync.built.unknown.length)
    console.log('  ⚠ 未识别字段: ' + sync.built.unknown.join(', '));

  const m = S.calcMonth(ym);
  const rows = [
    ['正班工资', 'item_71', m.base], ['平时加班工资', 'item_72', m.otWd],
    ['周末加班工资', 'item_73', m.otWe], ['应发出勤工资', 'item_80', m.attend],
    ['奖金汇总', 'item_89', m.bonusSum], ['全勤奖', 'item_90', m.full],
    ['餐补', 'item_191', m.meal], ['应发工资', 'item_118', m.taxBase],
    ['个人社保', 'item_134', m.social], ['实发工资', 'item_145', m.total],
  ];
  console.log('\n  ' + '项目'.padEnd(16) + '工资条'.padStart(12) + '本机'.padStart(12) + '差额'.padStart(10) + '   ');
  console.log('  ' + '-'.repeat(60));
  let bad = 0;
  for (const [name, key, mine] of rows) {
    const raw = gz[key];
    const sheet = (raw === '' || raw == null) ? 0 : parseFloat(raw);
    const gap = Math.round((mine - sheet) * 100) / 100;
    const pass = Math.abs(gap) < 0.005;
    if (!pass) bad++;
    console.log('  ' + name.padEnd(16) + (raw === '' ? '(空)' : sheet.toFixed(2)).padStart(12)
      + mine.toFixed(2).padStart(12) + (gap === 0 ? '0.00' : gap.toFixed(2)).padStart(10)
      + '   ' + (pass ? 'OK' : 'DIFF'));
  }
  console.log('\n  应出勤 ' + m.stdBase + 'h  正班合计 ' + m.attendHours + 'h  请假 ' + m.leaveHours + 'h  比例 '
    + (Math.round(m.ratio * 10000) / 100) + '%');
  console.log('  >>> ' + (bad === 0 ? '全部吻合 ✔' : bad + ' 项不一致 ✘'));
}

/* ---------- 10 月：未结算，只看工时与假别 ---------- */
{
  const S = makeSandbox();
  const ym = '2026-10';
  const kq = load('kqdetail-m0.decoded.json');
  const card10 = load('kq-m0.decoded.json');

  console.log('\n' + '='.repeat(74));
  console.log('  2026-10  工时口径（工资条未结算，无金额可比）');
  console.log('='.repeat(74));
  const sync = S.hrSyncMonth(ym, kq.rows, card10.rows);
  console.log('日考勤同步: 写入 ' + sync.added + ' 条（出勤 ' + sync.built.works
    + ' 天 / 假期 ' + sync.built.leaves + ' 天）');
  if (sync.built.unknown && sync.built.unknown.length)
    console.log('  ⚠ 未识别字段: ' + sync.built.unknown.join(', '));

  const recs = S.getRecs();
  console.log('\n  同步后的记录:');
  recs.sort((a, b) => a.date < b.date ? -1 : 1).forEach(r => {
    const tail = r.type === 'absent' ? ('请假 ' + r.leave + 'h  ' + r.note)
      : ('正班 ' + r.n + 'h  平时加班 ' + r.d + 'h  周末 ' + r.w + 'h');
    console.log('    ' + r.date + '  ' + r.type.padEnd(7) + tail);
  });

  const m = S.calcMonth(ym);
  console.log('\n  应出勤 ' + m.stdBase + 'h  截至今日 ' + m.stdElapsed + 'h  请假 ' + m.leaveHours + 'h');
  console.log('  正班合计 ' + m.attendHours + 'h   比例 ' + (Math.round(m.ratio * 10000) / 100) + '%');
  console.log('  正班工资 ¥' + m.base + '   平时加班 ' + m.sum.wd + 'h ¥' + m.otWd
    + '   周末加班 ' + m.sum.we + 'h ¥' + m.otWe);
  console.log('  奖金汇总 ¥' + m.bonusSum + '   全勤 ¥' + m.full + '   餐补 ¥' + m.meal);
  console.log('  应发 ¥' + m.taxBase + '   实发 ¥' + m.total);
  console.log('  漏卡 ' + m.absentAuto + ' 天（不影响工资）  请假 ' + m.absentLeave + ' 天');
}
