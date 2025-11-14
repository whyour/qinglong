<div align="center">
<img width="100" src="https://user-images.githubusercontent.com/22700758/191449379-f9f56204-0e31-4a16-be5a-331f52696a73.png">

<h1 align="center">青龙</h1>

简体中文 | [English](./README-en.md)

支持 Python3、JavaScript、Shell、Typescript 的定时任务管理平台

Timed task management platform supporting Python3, JavaScript, Shell, Typescript

[![npm version][npm-version-image]][npm-version-url] [![docker pulls][docker-pulls-image]][docker-pulls-url] [![docker stars][docker-stars-image]][docker-stars-url] [![docker image size][docker-image-size-image]][docker-image-size-url]

[npm-version-image]: https://img.shields.io/npm/v/@whyour/qinglong?style=flat
[npm-version-url]: https://www.npmjs.com/package/@whyour/qinglong?activeTab=readme
[docker-pulls-image]: https://img.shields.io/docker/pulls/whyour/qinglong?style=flat
[docker-pulls-url]: https://hub.docker.com/r/whyour/qinglong
[docker-stars-image]: https://img.shields.io/docker/stars/whyour/qinglong?style=flat
[docker-stars-url]: https://hub.docker.com/r/whyour/qinglong
[docker-image-size-image]: https://img.shields.io/docker/image-size/whyour/qinglong?style=flat
[docker-image-size-url]: https://hub.docker.com/r/whyour/qinglong

[Demo](http://demo.qinglong.online:4433/) / [Issues](https://github.com/whyour/qinglong/issues) / [Telegram Channel](https://t.me/jiao_long) / [Buy Me a Coffee](https://www.buymeacoffee.com/qinglong)

[演示](http://demo.qinglong.online:4433/) / [反馈](https://github.com/whyour/qinglong/issues) / [Telegram 频道](https://t.me/jiao_long) / [打赏开发者](https://user-images.githubusercontent.com/22700758/244744295-29cd0cd1-c8bb-4ea1-adf6-29bd390ad4dd.jpg)
</div>

![cover](https://user-images.githubusercontent.com/22700758/244847235-8dc1ca21-e03f-4606-9458-0541fab60413.png)

## 功能

- 支持多种脚本语言（python3、javaScript、shell、typescript）
- 支持在线管理脚本、环境变量、配置文件
- 支持在线查看任务日志
- 支持秒级任务设置
- 支持系统级通知
- 支持暗黑模式
- 支持手机端操作

## 版本

### docker

`latest` 镜像是基于 `alpine` 构建，`debian` 镜像是基于 `debian-slim` 构建。如果需要使用 `alpine` 不支持的依赖，建议使用 `debian` 镜像

**⚠️ 重要提示**: 如果您需要以**非 root 用户**运行 Docker，请使用 `debian` 镜像。Alpine 的 `crond` 需要 root 权限。

```bash
docker pull whyour/qinglong:latest
docker pull whyour/qinglong:debian
```

### npm

npm 版本支持 `debian/ubuntu/alpine` 系统，需要自行安装 `node/npm/python3/pip3/pnpm`

```bash
npm i @whyour/qinglong
```

## 部署

[查看文档](https://qinglong.online/guide/getting-started/installation-guide)

## 内置 API

[查看文档](https://qinglong.online/guide/user-guide/built-in-api)

## 内置命令

[查看文档](https://qinglong.online/guide/user-guide/basic-explanation)

## 开发

```bash
git clone https://github.com/whyour/qinglong.git
cd qinglong
cp .env.example .env
# 推荐使用 pnpm https://pnpm.io/zh/installation
npm install -g pnpm@8.3.1
pnpm install
pnpm start
```

打开你的浏览器，访问 <http://127.0.0.1:5700>

## 链接

- [nevinee](https://gitee.com/evine)
- [crontab-ui](https://github.com/alseambusher/crontab-ui)
- [Ant Design](https://ant.design)
- [Ant Design Pro](https://pro.ant.design/)
- [Umijs](https://umijs.org)
- [darkreader](https://github.com/darkreader/darkreader)
- [admin-server](https://github.com/sunpu007/admin-server)

## 名称来源

青龙，又名苍龙，在中国传统文化中是四象之一、[天之四灵](https://zh.wikipedia.org/wiki/%E5%A4%A9%E4%B9%8B%E5%9B%9B%E7%81%B5)之一，根据五行学说，它是代表东方的灵兽，为青色的龙，五行属木，代表的季节是春季，八卦主震。苍龙与应龙一样，都是身具羽翼。《张果星宗》称“又有辅翼，方为真龙”。

《后汉书·律历志下》记载：日周于天，一寒一暑，四时备成，万物毕改，摄提迁次，青龙移辰，谓之岁。

在中国[二十八宿](https://zh.wikipedia.org/wiki/%E4%BA%8C%E5%8D%81%E5%85%AB%E5%AE%BF)中，青龙是东方七宿（角、亢、氐、房、心、尾、箕）的总称。 在早期星宿信仰中，祂是最尊贵的天神。 但被道教信仰吸纳入其神系后，神格大跌，道教将其称为“孟章”，在不同的道经中有“帝君”、“圣将”、“神将”和“捕鬼将”等称呼，与白虎监兵神君一起，是道教的护卫天神。
