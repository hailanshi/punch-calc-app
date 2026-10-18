/* 无 git 环境下的推送通道：把指定文件用 Git Data API 一次性推到 main，触发云端打包。
 *
 * 和 push-via-api.js 的区别：
 *   push-via-api.js  读本地 git HEAD，要求有 .git
 *   push-files.js    不依赖 git，直接列文件清单推送（FILES 数组），适合本机没有 git 的情况
 *
 * 用法（仓库根目录）：
 *   $env:GH_TOKEN = '...'      # PowerShell
 *   node tools/push-files.js
 */
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.GH_TOKEN;
const OWNER = 'hailanshi', REPO = 'punch-calc-app', BRANCH = 'main';
const ROOT = path.join(__dirname, '..');
const API = 'https://api.github.com';

const FILES = [
  '.gitignore',
  '打卡工资计算器.html',
  'README.md',
  'ios-shell/PunchCalcApp/Resources/index.html',
  'ios-shell/PunchCalcApp/ViewController.m',
  'ios-shell/PunchCalcApp/Info.plist',
  'ios-shell/PunchCalcApp/PunchCalc-Info.plist',
  'tools/selfcheck.js',
  'tools/verify-e2e.js',
  'tools/push-files.js',
  'tools/wait-ipa.js',
  'tools/tools-README.md',
];

async function gh(p, opt = {}) {
  const r = await fetch(API + p, {
    ...opt,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      'User-Agent': 'dsh',
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opt.headers || {}),
    },
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch (e) { j = t; }
  if (!r.ok) throw new Error(p + ' -> HTTP ' + r.status + ' ' + String(t).slice(0, 400));
  return j;
}

(async () => {
  if (!TOKEN) { console.error('缺少 GH_TOKEN'); process.exit(2); }

  const ref = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
  const parent = ref.object.sha;
  const pcommit = await gh(`/repos/${OWNER}/${REPO}/git/commits/${parent}`);
  console.log('父提交: ' + parent.slice(0, 12) + '  base_tree: ' + pcommit.tree.sha.slice(0, 12));

  const tree = [];
  for (const f of FILES) {
    const abs = path.join(ROOT, f);
    if (!fs.existsSync(abs)) { console.log('  [跳过·不存在] ' + f); continue; }
    const buf = fs.readFileSync(abs);
    const blob = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, {
      method: 'POST',
      body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
    });
    console.log('  blob  ' + f.padEnd(46) + blob.sha.slice(0, 10) + '  ' + buf.length + 'B');
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
  }

  const newTree = await gh(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ base_tree: pcommit.tree.sha, tree }),
  });

  const message =
    'v2.9: 修登录闸门不生效（DOM 顺序）\n\n' +
    '- v2.8 把闸门 HTML 插在 </body> 前，而 <script id="appJS"> 在它之前，boot() 执行时 loginGate 还没进 DOM\n' +
    '  gateShow() 拿到 null 静默返回 → 首次安装也不弹登录框，直接进软件\n' +
    '- 闸门/编辑弹窗移到 <script> 之前；boot 等 DOMContentLoaded；gateShow 加延迟重试兜底\n' +
    '- 实测：无账号→弹闸门；有账号密码对→自动登录进入；密码错→重弹并显示原因\n' +
    '- 版本 2.9 / build 11；selfcheck 301/301';
  const newCommit = await gh(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: newTree.sha, parents: [parent] }),
  });
  console.log('新提交: ' + newCommit.sha.slice(0, 12));

  await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  console.log('已更新 refs/heads/' + BRANCH);
  fs.writeFileSync(path.join(__dirname, 'last-commit.txt'), newCommit.sha, 'utf8');
})();
