/* 备用推送通道：通过 GitHub Git Data API 把本地 HEAD 提交「原样」推上去。
 *
 * 什么时候用：`git push` 报 Failed to connect to github.com，但 `gh api rate_limit` 正常
 *           —— 说明只是 github.com:443 被挡，api.github.com 还通。
 *
 * 用法（在仓库根目录）:
 *     $env:GH_TOKEN = (gh auth token)          # PowerShell
 *     node tools/push-via-api.js .
 *     # 或 bash: GH_TOKEN=$(gh auth token) node tools/push-via-api.js .
 *
 * 安全性（重要）：
 *   它读本地 HEAD 的原始 commit 对象，tree / parent / author / committer / 时间 / 消息
 *   全部照抄，逐个上传 blob，再建 tree 和 commit，**每一步都核对 SHA**：
 *     本地 blob 哈希 ↔ 工作区实算哈希（不一致直接退出，防止推上去的内容不是提交里的那份）
 *     父提交 tree    → 用它作 base_tree，保证其余文件原样保留
 *     新建 tree      ↔ 本地 HEAD 的 tree
 *     新建 commit    ↔ 本地 HEAD 的 SHA  ← 只要这个不等就中止，绝不更新分支引用
 *   因此成功后远端 main 就是本地 HEAD 本身，不产生分叉、不需要事后 reset。
 *   失败时最多在远端留下几个游离对象，不影响任何分支。
 *
 * 限制：只处理新增/修改的文件；遇到删除或重命名会直接报错退出（请改用 git push）。
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const REPO = process.env.PUSH_REPO || 'hailanshi/punch-calc-app';
const BRANCH = process.env.PUSH_BRANCH || 'main';
const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺少 GH_TOKEN（先执行 gh auth token 并赋给它）'); process.exit(1); }

const cwd = process.argv[2] || '.';
/* 用 execFileSync + 参数数组：绕开 cmd.exe 对 ^ 等字符的转义（HEAD^ 会被吃掉） */
function git(args, opts) {
  return execFileSync('git', args, Object.assign({ cwd, maxBuffer: 1 << 28 }, opts || {}));
}

/* ---- 1. 读取本地 HEAD 的原始 commit 对象 ---- */
const raw = git(['cat-file', 'commit', 'HEAD'], { encoding: 'buffer' });
const sep = raw.indexOf(Buffer.from('\n\n'));
const headers = raw.slice(0, sep).toString('utf8');
const msgBuf = raw.slice(sep + 2);
const H = {};
for (const line of headers.split('\n')) {
  const i = line.indexOf(' ');
  if (i > 0) H[line.slice(0, i)] = line.slice(i + 1);
}
const localTree = H.tree, localParent = H.parent;
const localSha = git(['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const authorLine = H.author, committerLine = H.committer;

function parseIdent(s) {
  const m = s.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!m) throw new Error('无法解析身份: ' + s);
  return { name: m[1], email: m[2], epoch: +m[3], tz: m[4] };
}
const A = parseIdent(authorLine), C = parseIdent(committerLine);
function iso(epoch, tz) {
  const sign = tz[0] === '-' ? -1 : 1;
  const offMin = sign * (+tz.slice(1, 3) * 60 + +tz.slice(3, 5));
  const d = new Date((epoch + offMin * 60) * 1000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T` +
         `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}` +
         `${tz.slice(0, 3)}:${tz.slice(3, 5)}`;
}
console.log('本地 commit :', localSha);
console.log('tree/parent :', localTree, '/', localParent);
console.log('author      :', authorLine, '→', iso(A.epoch, A.tz));
console.log('message 字节:', msgBuf.length);

/* ---- 2. 组装要写的文件（git 存的是 LF，工作区是 CRLF） ---- */
function blobSha(buf) {
  return crypto.createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf])).digest('hex');
}
/* 改动文件从 diff 自动推导（含新增/修改/删除）；
 * core.quotepath=false 否则中文路径会被转义成 \346\211\223... 认不出来 */
const nameStatus = git(['-c', 'core.quotepath=false', 'diff', '--name-status', 'HEAD~1', 'HEAD'], { encoding: 'utf8' }).trim().split('\n');
const targets = [];
for (const line of nameStatus) {
  if (!line.trim()) continue;
  const parts = line.split('\t');
  const st = parts[0];
  let p = parts[1];
  if (p && p.length > 1 && p[0] === '"' && p[p.length - 1] === '"') p = p.slice(1, -1);
  if (st === 'D') { console.error('本脚本不处理删除：' + p); process.exit(2); }
  if (st[0] === 'R' || st[0] === 'C') { console.error('本脚本不处理重命名/复制：' + line); process.exit(2); }
  targets.push({ path: p });
}
console.log('本次改动 ' + targets.length + ' 个文件:');
targets.forEach(t => console.log('  ' + t.path));
// 用本地 HEAD 的 blob sha 作为期望值，确保上传的就是提交里的那份内容
const expectBlobs = {};
for (const t of targets) {
  expectBlobs[t.path] = git(['rev-parse', 'HEAD:' + t.path], { encoding: 'utf8' }).trim();
}
for (const t of targets) {
  let buf = fs.readFileSync(path.join(cwd, t.path));
  const lf = Buffer.from(buf.toString('binary').replace(/\r\n/g, '\n'), 'binary');
  const sha = blobSha(lf);
  t.buf = lf;
  console.log(`blob ${t.path}\n  期望 ${expectBlobs[t.path]}\n  实算 ${sha}  ${sha === expectBlobs[t.path] ? 'OK' : '★不一致★'}`);
  if (sha !== expectBlobs[t.path]) {
    console.error('中止：工作区内容与提交内容不一致，不能安全重建。');
    process.exit(2);
  }
}

/* ---- 3. 调 API ---- */
const api = async (method, url, body) => {
  const r = await fetch('https://api.github.com' + url, {
    method,
    headers: {
      Authorization: 'Bearer ' + TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dsh-push-helper',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch (e) {}
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${text.slice(0, 400)}`);
  return j;
};

(async () => {
  const ref = await api('GET', `/repos/${REPO}/git/ref/heads/${BRANCH}`);
  console.log('\n远端 ' + BRANCH + ' 当前:', ref.object.sha);
  if (ref.object.sha !== localParent) {
    console.error('中止：远端 HEAD 不是本地 HEAD 的父提交，说明远端已有新提交，需先同步。');
    process.exit(3);
  }

  /* base_tree 必须是父提交的树，这样其余文件原样保留、只有这 3 个文件被替换 */
  const parentCommit = await api('GET', `/repos/${REPO}/git/commits/${localParent}`);
  const baseTree = parentCommit.tree.sha;
  console.log('父提交 tree:', baseTree);

  const blobShas = {};
  for (const t of targets) {
    const b = await api('POST', `/repos/${REPO}/git/blobs`, {
      content: t.buf.toString('base64'), encoding: 'base64',
    });
    blobShas[t.path] = b.sha;
    console.log('blob 已上传', t.path, b.sha, b.sha === expectBlobs[t.path] ? 'OK' : '★SHA 不符★');
  }

  const tree = await api('POST', `/repos/${REPO}/git/trees`, {
    base_tree: baseTree,
    tree: targets.map(t => ({ path: t.path, mode: '100644', type: 'blob', sha: blobShas[t.path] })),
  });
  console.log('tree 已建:', tree.sha, tree.sha === localTree ? 'OK' : '★与本地 tree 不符★');
  if (tree.sha !== localTree) { console.error('中止：tree 不一致，不提交。'); process.exit(4); }

  const commit = await api('POST', `/repos/${REPO}/git/commits`, {
    message: msgBuf.toString('utf8'),
    tree: tree.sha,
    parents: [localParent],
    author: { name: A.name, email: A.email, date: iso(A.epoch, A.tz) },
    committer: { name: C.name, email: C.email, date: iso(C.epoch, C.tz) },
  });
  console.log('commit 已建:', commit.sha, commit.sha === localSha ? 'OK' : '★与本地 commit 不符★');
  if (commit.sha !== localSha) {
    console.error('中止：commit SHA 不一致（可能时间格式被规范化），未更新分支引用。');
    console.error('远端会留下一个游离对象，不影响任何分支，可忽略。');
    process.exit(5);
  }

  const upd = await api('PATCH', `/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    sha: commit.sha, force: false,
  });
  console.log('\n✅ 分支引用已更新：' + BRANCH + ' → ' + upd.object.sha);
  console.log('与本地 HEAD 一致，无分叉。');
})().catch(e => { console.error('失败: ' + e.message); process.exit(1); });
