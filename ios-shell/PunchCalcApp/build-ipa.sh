#!/usr/bin/env bash
# =====================================================================
# 在 theos 编译完成后，把 Resources/index.html 塞入 .app，并打成 .ipa。
# 用法：./build-ipa.sh      （会先执行 make，需已配置 THEOS/SDK）
# 产物：punch-calculator.ipa （cryptid=0，arm64，TrollStore 可装）
# =====================================================================
set -e

cd "$(dirname "$0")"

echo "==> 检查 Resources/index.html"
if [ ! -f "Resources/index.html" ]; then
  echo "!! 未找到 Resources/index.html"
  echo "   请先执行: cp <项目>/打卡工资计算器.html Resources/index.html"
  exit 1
fi

echo "==> theos 编译（若之前没跑过 make）"
if ! command -v make >/dev/null 2>&1; then
  echo "!! 未找到 make，请先安装（Linux: apt install make）"
  exit 1
fi
[ -z "$THEOS" ] && THEOS=/opt/theos
export THEOS
make

# ---- 定位编译出的 .app（theos 不同版本路径略有差异，逐一尝试）----
APP=""
for p in \
  "$THEOS"/_/Applications/PunchCalc.app \
  ./_/Applications/PunchCalc.app \
  ./build/PunchCalc.app \
  ./_/PunchCalc.app ; do
  if [ -d "$p" ]; then APP="$p"; break; fi
done
if [ -z "$APP" ]; then
  APP=$(find . -maxdepth 4 -type d -name "PunchCalc.app" -not -path "*/Payload/*" | head -1 || true)
fi
if [ -z "$APP" ]; then
  echo "!! 找不到 PunchCalc.app，编译可能失败。请查看上方 make 输出。"
  exit 1
fi
echo "==> 使用应用包：$APP"

echo "==> 注入 HTML（同时放根目录与 www/，壳会自动按路径查找）"
cp Resources/index.html "$APP/index.html"
mkdir -p "$APP/www"
cp Resources/index.html "$APP/www/index.html"
echo "==> 图标（可选）：存在则一并复制"
if [ -f Resources/AppIcon60x60@2x.png ]; then cp Resources/AppIcon60x60@2x.png "$APP/AppIcon60x60@2x.png"; fi
if [ -f Resources/AppIcon60x60@3x.png ]; then cp Resources/AppIcon60x60@3x.png "$APP/AppIcon60x60@3x.png"; fi

echo "==> 生成 punch-calculator.ipa"
OUT=$(pwd)/punch-calculator.ipa
rm -rf ./_payload
mkdir -p ./_payload/Payload
cp -R "$APP" ./_payload/Payload/PunchCalc.app
( cd ./_payload && zip -qry "$OUT" Payload )
rm -rf ./_payload

echo ""
echo "打包完成：$OUT"
echo "用 TrollStore 打开/导入该 .ipa 即可安装（无需签名账号）。"
