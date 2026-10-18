/* 等 CI 跑完，下载 punch-calculator.ipa 到工作目录 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TOKEN = process.env.GH_TOKEN;
const OWNER = 'hailanshi', REPO = 'punch-calc-app';
const SHA = fs.readFileSync(path.join(__dirname, '..', 'last-commit.txt'), 'utf8').trim();
const API = 'https://api.github.com';
const OUT = __dirname;

async function gh(p, opt = {}) {
  const r = await fetch(API + p, {
    ...opt,
    headers: {
      Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'dsh',
      Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(opt.headers || {}),
    },
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch (e) { j = t; }
  if (!r.ok) throw new Error(p + ' -> ' + r.status + ' ' + String(t).slice(0, 300));
  return j;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log('等待 workflow（commit ' + SHA.slice(0, 12) + '）…');
  let run = null;
  for (let i = 0; i < 40; i++) {
    const runs = await gh(`/repos/${OWNER}/${REPO}/actions/runs?head_sha=${SHA}&per_page=5`);
    run = (runs.workflow_runs || [])[0];
    if (run && run.status === 'completed') break;
    if (run) process.stdout.write('.');
    await sleep(15000);
  }
  if (!run) { console.error('\n没有找到该 commit 的 workflow'); process.exit(1); }
  console.log('\nrun #' + run.run_number + '  status=' + run.status + '  conclusion=' + run.conclusion);
  if (run.conclusion !== 'success') {
    console.log('构建未成功，日志地址: ' + run.html_url);
    try {
      const jobs = await gh(`/repos/${OWNER}/${REPO}/actions/runs/${run.id}/jobs`);
      for (const j of jobs.jobs || []) {
        console.log('  job: ' + j.name + ' -> ' + j.conclusion);
        for (const s of j.steps || []) if (s.conclusion === 'failure') console.log('    失败步骤: ' + s.name);
      }
    } catch (e) {}
    process.exit(1);
  }

  const arts = await gh(`/repos/${OWNER}/${REPO}/actions/runs/${run.id}/artifacts`);
  const a = (arts.artifacts || [])[0];
  if (!a) { console.error('没有 artifact'); process.exit(1); }
  console.log('artifact: ' + a.name + '  ' + (a.size_in_bytes / 1024).toFixed(1) + 'KB  expired=' + a.expired);

  const r = await fetch(a.archive_download_url, {
    headers: { Authorization: 'Bearer ' + TOKEN, 'User-Agent': 'dsh' },
    redirect: 'follow',
  });
  if (!r.ok) { console.error('下载失败 HTTP ' + r.status); process.exit(1); }
  const buf = Buffer.from(await r.arrayBuffer());
  const zip = path.join(OUT, 'ci-artifact.zip');
  fs.writeFileSync(zip, buf);
  console.log('已下载: ' + zip + '  ' + (buf.length / 1024).toFixed(1) + 'KB');

  // 解压（Windows 自带 PowerShell 解压）
  const ex = path.join(OUT, 'ci-out');
  if (fs.existsSync(ex)) fs.rmSync(ex, { recursive: true, force: true });
  execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zip}' -DestinationPath '${ex}' -Force"`, { stdio: 'inherit' });
  const ipa = path.join(ex, 'punch-calculator.ipa');
  if (!fs.existsSync(ipa)) { console.error('解压后没有 punch-calculator.ipa'); process.exit(1); }
  const final = path.join(OUT, 'punch-calculator-2.3.ipa');
  fs.copyFileSync(ipa, final);
  console.log('IPA 就绪: ' + final + '  ' + (fs.statSync(final).size / 1024).toFixed(1) + 'KB');
})();
