<p align="center">
  <a href="https://github.com/whyour/qinglong">
    <img width="150" src="https://z3.ax1x.com/2021/11/18/I7MpAe.png">
  </a>
</p>

<h1 align="center">青龙</h1>

<div align="center">

支持python3、javaScript、shell、typescript 的定时任务管理面板（A timed task management panel that supports typescript, javaScript, python3, and shell.）

[![docker version][docker-version-image]][docker-version-url] [![docker pulls][docker-pulls-image]][docker-pulls-url] [![docker stars][docker-stars-image]][docker-stars-url] [![docker image size][docker-image-size-image]][docker-image-size-url]

[docker-pulls-image]: https://img.shields.io/docker/pulls/whyour/qinglong?style=flat
[docker-pulls-url]: https://hub.docker.com/r/whyour/qinglong
[docker-version-image]: https://img.shields.io/docker/v/whyour/qinglong?style=flat
[docker-version-url]: https://hub.docker.com/r/whyour/qinglong/tags?page=1&ordering=last_updated
[docker-stars-image]: https://img.shields.io/docker/stars/whyour/qinglong?style=flat
[docker-stars-url]: https://hub.docker.com/r/whyour/qinglong
[docker-image-size-image]: https://img.shields.io/docker/image-size/whyour/qinglong?style=flat
[docker-image-size-url]: https://hub.docker.com/r/whyour/qinglong
</div>

[![](https://z3.ax1x.com/2021/11/18/I7KrTg.jpg)](https://whyour.cn)

简体中文 | [English](./README-en.md)

## 功能

- 支持python3、javaScript、shell、typescript脚本语言
- 支持在线编辑、新增、删除脚本
- 支持在线编辑、新增、删除环境变量
- 支持在线查看任务日志
- 支持秒级任务设置
- 支持暗黑模式
- 支持手机端操作

## 部署

### 本机部署

```bash
# 待补充
```

### docker 部署

1. docker 安装

```bash
sudo curl -sSL get.docker.com | sh
```

2. 启动容器

```bash
docker run -dit \
  -v $PWD/ql/config:/ql/config \
  -v $PWD/ql/log:/ql/log \
  -v $PWD/ql/db:/ql/db \
  -v $PWD/ql/repo:/ql/repo \
  -v $PWD/ql/raw:/ql/raw \
  -v $PWD/ql/scripts:/ql/scripts \
  -p 5700:5700 \
  --name qinglong \
  --hostname qinglong \
  --restart unless-stopped \
  whyour/qinglong:latest
```

### docker-compose 部署

1. docker-compose 安装

```bash
sudo curl -L https://github.com/docker/compose/releases/download/1.16.1/docker-compose-`uname -s`-`uname -m` -o /usr/local/bin/docker-compose
```

2. 启动容器

```bash
mkdir qinglong
wget https://raw.githubusercontent.com/whyour/qinglong/develop/docker-compose.yml

# 启动
docker-compose up -d
# 停止
docker-compose down
```

## 链接

- [nevinee](https://gitee.com/evine)
- [crontab-ui](https://github.com/alseambusher/crontab-ui)
- [Ant Design](https://ant.design)
- [Ant Design Pro](https://pro.ant.design/)
- [Umijs3.0](https://umijs.org)
- [darkreader](https://github.com/darkreader/darkreader)
- [admin-server](https://github.com/sunpu007/admin-server)

## 开发

```bash
$ git clone git@github.com:whyour/qinglong.git
$ cd qinglong
$ cp .env.example .env
$ yarn install
$ yarn start-back
$ yarn start
```

打开你的浏览器，访问 http://127.0.0.1:5601

## 名称来源

青龙，又名苍龙，在中国传统文化中是四象之一、[天之四灵](https://zh.wikipedia.org/wiki/%E5%A4%A9%E4%B9%8B%E5%9B%9B%E7%81%B5)之一，根据五行学说，它是代表东方的灵兽，为青色的龙，五行属木，代表的季节是春季，八卦主震。苍龙与应龙一样，都是身具羽翼。《张果星宗》称“又有辅翼，方为真龙”。

《后汉书·律历志下》记载：日周于天，一寒一暑，四时备成，万物毕改，摄提迁次，青龙移辰，谓之岁。

在中国[二十八宿](https://zh.wikipedia.org/wiki/%E4%BA%8C%E5%8D%81%E5%85%AB%E5%AE%BF)中，青龙是东方七宿（角、亢、氐、房、心、尾、箕）的总称。 在早期星宿信仰中，祂是最尊贵的天神。 但被道教信仰吸纳入其神系后，神格大跌，道教将其称为“孟章”，在不同的道经中有“帝君”、“圣将”、“神将”和“捕鬼将”等称呼，与白虎监兵神君一起，是道教的护卫天神。
