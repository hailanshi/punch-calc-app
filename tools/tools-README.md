# tools/ — 开发与验证工具

全部是 Node 脚本，不需要装任何依赖（Node 18+）。

| 脚本 | 作用 | 用法 |
| --- | --- | --- |
| `selfcheck.js` | 单文件 HTML 的全量自检（语法 / DOM id / 内联 onclick 导出 / 计算逻辑 / HR 映射），当前 301 条断言 | `node tools/selfcheck.js 打卡工资计算器.html` |
| `verify-e2e.js` | 用真实工资条 + 日考勤做端到端回归，逐项比对金额 | 见下方「真实数据回归」 |
| `push-files.js` | 本机没有 git 时，用 Git Data API 推指定文件到 main，触发 Actions 打包 | `$env:GH_TOKEN='...'; node tools/push-files.js` |
| `wait-ipa.js` | 轮询最新一次 Actions 运行，成功后把 IPA artifact 拉下来 | `node tools/wait-ipa.js` |
| `push-via-api.js` | 备用通道：读本地 git HEAD 原样推到远端（要求有 .git） | `node tools/push-via-api.js .` |

## 真实数据回归（verify-e2e.js）

它从仓库根目录的 `hr-data/` 读真实抓包数据。**这个目录不入库**（含账号 cookie 和真实工资），
要跑得自己放数据进去，文件格式：

```
hr-data/
  gzs-2026-09.decoded.json     # 工资条接口返回（含 gz_result）
  kqdetail-full.decoded.json   # 日考勤接口返回（含 rows，整月）
  kq-2026-09-full.json         # 原始打卡接口返回（含 rows）
  kqdetail-m0.decoded.json     # 当月日考勤
  kq-m0.decoded.json           # 当月原始打卡
```

跑法：

```bash
node tools/verify-e2e.js
```

9 月那组应该输出 10 项金额零误差（2209.09 / 1187.07 / 682.76 / 4078.92 / 409.09 /
285.00 / 4773.01 / 421.04 / 4351.97）。

## 一次完整发版

```bash
# 1. 改完 HTML 后自检
node tools/selfcheck.js 打卡工资计算器.html

# 2. 同步给 iOS 壳（CI 用的是这份拷贝，必须一致）
cp 打卡工资计算器.html ios-shell/PunchCalcApp/Resources/index.html

# 3. 推送（无 git 环境）
GH_TOKEN=... node tools/push-files.js

# 4. 等 CI 出 IPA 并下载
node tools/wait-ipa.js
```

> 第 2 步别忘：`Resources/index.html` 和根目录那份必须字节一致，否则 App 里跑的还是旧版。
