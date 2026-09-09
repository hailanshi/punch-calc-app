# 打卡工资计算器

单文件 `打卡工资计算器.html` 实现全部功能，无后端、纯本机存储；可直接双击用浏览器打开，
iPhone Safari 打开后「添加到主屏幕」即作为 PWA 使用；`ios-shell/` 内含极简 WKWebView 壳工程，
可交叉编译为 TrollStore 可安装的 IPA。

## 交付物
| 路径 | 说明 |
| --- | --- |
| `打卡工资计算器.html` | 唯一业务文件：HTML+CSS+JS 全部内联，浏览器/Safari-PWA 直接运行 |
| `ios-shell/PunchCalcApp/` | iOS 壳工程（main/AppDelegate/ViewController + theos Makefile + Info.plist） |
| `ios-shell/PunchCalcApp/Resources/index.html` | 已随工程放入的业务文件副本 |
| `ios-shell/PunchCalcApp/build-ipa.sh` | Linux（theos）一键 `make` → 注入 HTML/图标 → 生成 `punch-calculator.ipa` |
| `ios-shell/README.md` | Linux 无 Mac 交叉编译 + TrollStore 安装步骤 |

> ⚠️ 本环境为 Windows 沙箱，**没有 iOS SDK / theos / clang-ios 工具链**，无法在此直接产出可安装的 .ipa。
> 拿 IPA 有两条现成路径（都免 Apple 开发者账号）：
> 1. **零代码**：走 GitHub 云端自动打包（免费借用苹果云 Mac 编译），见《打包教程-傻瓜版.md》/ `ios-shell/README.md`；
> 2. 有 Linux/macOS 终端能力：按 `ios-shell/README.md` 跑 `./build-ipa.sh`。
> `打卡工资计算器-打包源-*.zip` 是整理好的上传用压缩包。

## 功能速览
- 四种打卡：上班打卡 / 法定节假日休息 / 普通休息 / 缺勤；选日期自动识别「工作日 / 周末 / 法定节假日」
- 工时拆分：工作日 8h 内正常 + 超出平日加班；周末全周末加班(2倍)；法定节假日全节假日加班(3倍)
- 自动补卡：「补卡到今天 / 本月全部补卡」，跳过周末、法定节假日、已有记录，无确认弹窗直接执行，
  完成弹 toast（成功 X / 跳过 X / 失败 X）并回首页刷新
- 工资：底薪/岗位补贴/绩效按 出勤比例（有效工时÷标准工时,封顶 1）折算；全勤受缺勤清零；
  加班按时薪×倍数；餐补=min(上班天数×15,360)；社保固定扣
- 设置：底薪/倍数/社保/全勤/绩效/岗位/餐补/标准工时/自动工时全可改；每月标准工时支持「联网更新」=工作日×8（接口 `/api/v1/misc/holiday-calendar`，调休已算）
- 记录：按月浏览、编辑、删除单条、删除全部；导出文本；导入支持「追加 / 覆盖」
- 法定节假日：内置 2024–2026 国务院安排（含调休补班日），可增删自定义，改动立即生效
- 5 套主题、安全区适配、公告跑马灯（QQ 昵称+签名，失败显示欢迎语）

## 数据与隐私
所有数据存本机 `localStorage`（壳内同样持久化）。换机迁移：设置无需迁移，记录用「导出/导入」。

## 已规避的 iOS/WKWebView 坑（开发时已落实）
1. 不使用 JS 动态 `.onclick`；所有点击都是 HTML 内联 `onclick="window.全局函数()"`，函数显式挂到 `window`。
2. 弹窗确认不用闭包回调：先存 `{动作函数名, 参数}` 到全局，底部「确定」统一走 `doConfirmOK` 执行。
3. 弹窗/长列表：标题固定、内容独立滚动、取消/确定固定底部；无 `inset`；全站安全区适配（刘海+底部横条）。
4. 补卡无确认弹窗，直接执行 + toast；所有写操作均有 toast 反馈；关键业务外层 try/catch，单条出错不崩整体。

## 已知口径（按你的规则执行）
- 官方整段放假日期视为「法定节假日」，其中落在周末的日子上班同样计 3 倍（此为个人计算器简化口径）；
  周末调休补班日识别为工作日（正常 1.5 倍拆）。需要公司特殊口径时用「自定义节假日」/手工记录微调。
- 显示的数字均为四舍五入到分/0.1h；保存原始精度，仅展示取整。

## 快速改数据
改 `打卡工资计算器.html` 顶部常量后，若打包 iOS 需同步：
```bash
cp 打卡工资计算器.html ios-shell/PunchCalcApp/Resources/index.html
cd ios-shell/PunchCalcApp && ./build-ipa.sh
```
