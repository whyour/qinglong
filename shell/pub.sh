#!/usr/bin/env bash
echo -e "开始发布"

echo -e "切换master分支"
git checkout master

echo -e "合并develop代码"
git merge origin/develop

echo -e "提交master代码"
git push

echo -e "更新cdn文件"
ts-node sample/tool.ts

string=$(cat src/version.ts | grep "version" | egrep "[^\']*" -o | egrep "\d\.*")
version="v$string"
echo -e "当前版本$version"

echo -e "删除已经存在的本地tag"
git tag -d "$version" &>/dev/null

echo -e "删除已经存在的远程tag"
git push origin :refs/tags/$version &>/dev/null

echo -e "创建新tag"
git tag -a "$version" -m "release $version"

echo -e "提交tag"
git push --tags

echo -e "完成发布"
