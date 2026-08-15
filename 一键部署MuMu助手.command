#!/bin/bash
# MuMu 助手一键部署(Mac)
# 用法:双击运行;若提示没有执行权限,在终端执行: bash 一键部署MuMu助手.command
cd "$(dirname "$0")" || exit 1
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.pslib.layerlibrary"
mkdir -p "$DEST" || exit 1
cp -R CSXS JSX images index.html main.js styles.css "$DEST/" 2>/dev/null
if [ $? -ne 0 ]; then
  echo "部署失败:请确认解压完整(需要 CSXS/JSX/images/index.html/main.js/styles.css)"
  exit 1
fi
# 启用未签名扩展(PS 2020~2026 对应 CSXS.9 ~ CSXS.13)
for v in 9 10 11 12 13; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done
echo ""
echo "=============================================="
echo "  部署完成!"
echo "  请重启 Photoshop,然后:"
echo "  菜单 -> 窗口 -> 扩展(旧版) -> MuMu助手"
echo "=============================================="
exit 0
