#!/usr/bin/env bash

# 导入通用变量与函数
dir_shell=/ql/shell
. $dir_shell/share.sh

echo -e "1. 开始安装青龙依赖\n"
npm_install_2 $dir_root
echo -e "青龙依赖安装完成\n"

echo -e "2. 开始安装脚本依赖\n"
cp -f $dir_sample/package.json $dir_scripts/package.json
npm_install_2 $dir_scripts
echo -e "脚本依赖安装完成\n"

exit 0
