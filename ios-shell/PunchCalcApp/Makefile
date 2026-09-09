# =====================================================================
# PunchCalc - WKWebView 壳（TrollStore / theos 打包）
# 无 Mac / 无苹果开发者账号，在 Linux 上用 theos 交叉编译 arm64。
#
# 前置：
#   1) export THEOS=/opt/theos                 (已安装 theos)
#   2) 让 theos 能找到 iPhoneOS SDK：
#        把下载好的 iPhoneOS<版本>.sdk 放入 $(THEOS)/sdks/
#   3) 把 打卡工资计算器.html 复制为 本目录 Resources/index.html
#   4) make            -> 编译出 .app
#   5) ./build-ipa.sh  -> 打出 punch-calculator.ipa（等价 make ipa）
#
# 产物：iOS 12+ / arm64 / cryptid=0 未加密，可用 TrollStore 直接安装。
# =====================================================================

export THEOS_DEVICE_IP = localhost
export ARCHS = arm64
export TARGET = iphone:12.0

include $(THEOS)/makefiles/common.mk

APPLICATION_NAME = PunchCalc

PunchCalc_FILES = main.m AppDelegate.m ViewController.m
PunchCalc_FRAMEWORKS = UIKit WebKit Foundation
PunchCalc_CFLAGS = -fobjc-arc

include $(THEOS_MAKE_PATH)/application.mk

# 编译完成后打 .ipa（把 HTML 一并塞入 .app 根目录）
ipa::
	@echo ">> 运行 build-ipa.sh 生成 punch-calculator.ipa"
	@./build-ipa.sh

after-package::
	@echo ">> 若产物是 .deb 且还需要 .ipa，请执行 ./build-ipa.sh"
