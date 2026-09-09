本文件夹存放打包到 .app 内的静态资源。

必做（打包前）：
  把  项目根目录/打卡工资计算器.html
  复制为  本目录/index.html

可选：
  AppIcon60x60@2x.png（120x120）
  AppIcon60x60@3x.png（180x180，已内置）
  不提供图标也能安装，只是桌面无图标。

build-ipa.sh 会自动把 index.html 注入 .app，无需手动放置其他位置。
