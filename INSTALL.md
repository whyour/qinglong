# 安装说明

## 前置要求

需要安装`docker-ce`及`docker-compose`  
点击以下连接了解如何安装`docker`及`compose`

- [Debian](https://docs.docker.com/engine/install/debian/)
- [Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
- [CentOS](https://docs.docker.com/engine/install/centos/)
- [Fedora](https://docs.docker.com/engine/install/fedora/)
- [Red Hat Enterprise Linux](https://docs.docker.com/engine/install/rhel/)
- [SUSE Linux Enterprise Server](https://docs.docker.com/engine/install/sles/)

## 安装

1. 新建一个文件夹，用于存放相关数据
2. 下载本仓库中的`docker-compose.yml`至本地，或是复制文件内容后在本地自行建立并粘贴内容
3. 使用docker-compose启动
4. 打开浏览器使用

```bash
# 新建数据文件夹
mkdir qinglong
cd qinglong
# 下载docker-compose.yml文件
wget https://raw.githubusercontent.com/whyour/qinglong/develop/docker-compose.yml
# 启动
docker-compose up -d
```

默认情况下qinglong将会在`5700`端口启动，并将端口映射至容器所在宿主机，启动之后打开浏览器访问宿主机的5700端口即可（例如http://192.168.100.123:5700）。第一次账号密码均输入`admin`，会生成`auth.json`，运行如下命令可查看具体的密码

```bash
cat data/config/auth.json
```

cat查看之后返回的结果类似如下字段

```json
{"username":"admin","password":"Xb-ZYP526wmg4_h6q1WqIO"}
```

输入此处记录的`username`及`password`，即可成功登陆qinglong面板，登陆后即可正常使用

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

请直接pull最新的docker镜像即可

```bash
cd qinglong
docker-compose down
docker pull whyour/qinglong:latest
docker-compose up -d
```
