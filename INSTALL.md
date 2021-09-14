# 安装说明

## 前置要求
```bash
1.已安装docker-ce
2.选装docker-compose
```
## 安装方式1
```bash
1. 新建一个文件夹，用于存放相关数据
2. 下载本仓库中的`docker-compose.yml`至本地，或是复制文件内容后在本地自行建立并粘贴内容
3. 使用docker-compose启动
4. 浏览器输入ip:5700即可进入面板

# 新建数据文件夹
mkdir qinglong
cd qinglong
# 下载docker-compose.yml文件
wget https://raw.githubusercontent.com/whyour/qinglong/develop/docker-compose.yml
# 启动
docker-compose up -d
```

## 安装方式2
```bash
# 复制下列命令在ssh执行(先安装docker)
# 注:$PWD请修改为实际你想安装的路径
 docker run -dit \
   -v $PWD/ql/config:/ql/config \
   -v $PWD/ql/log:/ql/log \
   -v $PWD/ql/db:/ql/db \
   -v $PWD/ql/repo:/ql/repo \
   -v $PWD/ql/raw:/ql/raw \
   -v $PWD/ql/scripts:/ql/scripts \
   -v $PWD/ql/jbot:/ql/jbot \
   -p 5700:5700 \
   --name qinglong \
   --hostname qinglong \
   --restart unless-stopped \
   whyour/qinglong:latest
```
## 登录
```bash

打开浏览器访问宿主机ip的5700端口即可
例如http://192.168.100.123:5700即ip:5700

首次登录
账号:admin 密码:admin
会生成`auth.json`

在ssh输入 
1.docker exec it qinglong bash
2.cat /ql/config/auth.json

cat查看之后返回的结果类似如下字段

{"username":"admin","password":"Xb-ZYP526wmg4_h6q1WqIO"}
# admin即为登录名;Xb-ZYP526wmg4_h6q1WqIO为登录密码
```

输入此处记录的`username`及`password`，即可成功登陆qinglong面板，登陆后即可正常使用

## 拉取脚本
```bash
示例
ql repo https://github.com/xxx.git #拉取仓库
ql raw https://raw.githubusercontent.com/xxx #拉取单个脚本
```
## 备份

所有数据都将保存在`docker-compose.yml`所在的同级目录的`data`文件夹中，如需要备份，请直接备份`docker-compose.yml`及`data`文件夹即可

```bash
root@debian:/opt/qinglong# ls -lah
总用量 8.0K
drwxr-xr-x 3 root root 4.0K  8月 30 01:29 .
drwxr-xr-x 4 root root 4.0K  8月 30 00:51 ..
drwxr-xr-x 8 root root 4.0K  8月 30 01:30 data
-rw-r--r-- 1 root root  386  8月 30 01:29 docker-compose.yml
```
## 更新

在面板执行"更新面板"任务即可

或者
```bash
cd qinglong
docker-compose down
docker pull whyour/qinglong:latest
docker-compose up -d
```
