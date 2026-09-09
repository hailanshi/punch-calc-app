# 打卡工资计算器 · iOS 壳工程（TrollStore）

壳层只做一件事：把本地单文件 HTML（`打卡工资计算器.html`）装进 `WKWebView` 并加载。
所有业务逻辑 100% 在 HTML/JS 内，壳不含任何业务，避免前后逻辑不一致。

## 目录
```
ios-shell/
├─ README.md
└─ PunchCalcApp/
   ├─ Makefile            theos 工程文件
   ├─ Info.plist          应用配置（iOS 12+，ATS 允许联网）
   ├─ main.m / AppDelegate.{h,m} / ViewController.{h,m}  极简壳
   ├─ build-ipa.sh        make 后把 HTML+图标注入 .app 并打成 .ipa
   └─ Resources/
      ├─ index.html           ← 已放入主 HTML（改业务时重新复制）
      ├─ AppIcon60x60@2x.png / @3x.png
      └─ README.txt
```

## 直接打包（Linux 无 Mac、无需开发者账号）
前置：安装 theos + iOS SDK + ldid
```bash
# 1) theos（第三方，无 Mac 交叉编译用）
sudo apt install -y git curl make clang ldid zip
git clone --recursive https://github.com/theos/theos.git /opt/theos
# 2) iOS SDK：把下载的 iPhoneOS<版本>.sdk 解压到 /opt/theos/sdks/
#    （例：iPhoneOS16.x.sdk 之类；theos 需要 SDK 才能链接系统库）

export THEOS=/opt/theos
cd ios-shell/PunchCalcApp

# 3) 若要改页面，先同步 HTML：
#    cp <项目>/打卡工资计算器.html Resources/index.html

# 4) 编译并打包
./build-ipa.sh
#    生成 punch-calculator.ipa（arm64 / iOS 12+ / cryptid=0）
```
`Resources/index.html` 已随本工程放入，跳过第 3 步也能直接打包。

## 安装
- iPhone 需已安装 **TrollStore（巨魔商店）**。
- 把 `punch-calculator.ipa` 通过 AirDrop / 文件传到 iPhone，用 TrollStore 打开即安装。
- 不能上 App Store，也不能用于未越狱普通设备的正式分发（这正是 TrollStore 定位）。

## 不会用命令？走 GitHub 云端自动打包（免费 Mac，零操作）
仓库根目录已带 `.github/workflows/build-ipa.yml` 与 `project.yml`：
1. 把整个项目文件夹传到一个 GitHub 仓库（网页“Add file → Upload files”整夹拖入，含隐藏 `.github`）。
2. 上传后自动触发云端 macOS 编译，`Actions` 页约 1–3 分钟出结果。
3. 在 Actions 记录底部 `Artifacts` 下载 `punch-calculator.ipa` → 用 TrollStore 打开安装。

傻瓜版点鼠标教程见根目录《打包教程-傻瓜版.md》。编译失败时把 Actions 日志发我排查。

## 为什么不在这里直接给出 .ipa？
本环境是 Windows 沙箱，没有 iOS SDK / theos / clang-ios 工具链，
无法在本机交叉编译出可安装的 arm64 .ipa（产物需在你的 Linux 上跑 `build-ipa.sh` 生成）。
以上脚本与源码已按 TrollStore 常见路径组织；如你的 theos 版本产物目录不同，
`build-ipa.sh` 会自动用 `find` 兜底定位 `.app`。

## 如需改日期/节假日/参数
改 HTML 里的 `HOLI_OFF` / `MAKEUP` / `DEFAULTS` 等常量，再重新 `cp … Resources/index.html && ./build-ipa.sh`。

## 双通道使用
- 网页/PWA：直接双击 `打卡工资计算器.html`，或在 iPhone Safari 打开并「添加到主屏幕」。
- 本地壳：按上面打包安装。两者共用同一份 HTML，数据都存在本机。
