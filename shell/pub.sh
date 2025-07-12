#!/usr/bin/env bash
echo -e "开始发布"

echo -e "切换master分支"
git branch -D master
git checkout -b master
git push --set-upstream origin master -f

echo -e "更新cdn文件"
ts-node-transpile-only sample/tool.ts

string=$(cat version.yaml | grep "version" | egrep "[^ ]*" -o | egrep "\d\.*")
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
