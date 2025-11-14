<div align="center">
<img width="100" src="https://user-images.githubusercontent.com/22700758/191449379-f9f56204-0e31-4a16-be5a-331f52696a73.png">

<h1 align="center">Qinglong</h1>

[简体中文](./README.md) | English

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

## Features

- Support for multiple scripting languages (python3, javaScript, shell, typescript)
- Support online management of scripts, environment variables, configuration files
- Support online view task log
- Support second-level task setting
- Support system level notification
- Support dark mode
- Support cell phone operation

## Version

### docker

The `latest` image is built on `alpine` and the `debian` image is built on `debian-slim`. If you need to use a dependency that is not supported by `alpine`, it is recommended that you use the `debian` image.

**⚠️ Important**: If you need to run Docker as a **non-root user**, please use the `debian` image. Alpine's `crond` requires root privileges.

```bash
docker pull whyour/qinglong:latest
docker pull whyour/qinglong:debian
```

### npm

The npm version supports `debian/ubuntu/alpine` systems and requires `node/npm/python3/pip3/pnpm` to be installed.

```bash
npm i @whyour/qinglong
```

## Deployment

[View Documentation](https://qinglong.online/guide/getting-started/installation-guide)

## Built-in API

[View Documentation](https://qinglong.online/guide/user-guide/built-in-api)

## Built-in commands

[View Documentation](https://qinglong.online/guide/user-guide/basic-explanation)

## Development

```bash
git clone https://github.com/whyour/qinglong.git
cd qinglong
cp .env.example .env
# Recommended use pnpm https://pnpm.io/zh/installation
npm install -g pnpm@8.3.1
pnpm install
pnpm start
```

Open your browser and visit <http://127.0.0.1:5700>

## Links

- [nevinee](https://gitee.com/evine)
- [crontab-ui](https://github.com/alseambusher/crontab-ui)
- [Ant Design](https://ant.design)
- [Ant Design Pro](https://pro.ant.design/)
- [Umijs](https://umijs.org)
- [darkreader](https://github.com/darkreader/darkreader)
- [admin-server](https://github.com/sunpu007/admin-server)

## Name Origin

The Green Dragon, also known as the Canglong, is one of the four elephants and one of the [four spirits of the heavens](https://zh.wikipedia.org/wiki/%E5%A4%A9%E4%B9%8B%E5%9B%9B%E7%81%B5) in traditional Chinese culture. According to the Five Elements, it is a spirit animal representing the East as a green dragon, the five elements are wood, and the season represented is spring, with the eight trigrams dominating vibration. Like the Ying Long, the Cang Long has feathered wings. According to the Zhang Guo Xing Zong (Zhang Guo Xing Zong), "a true dragon is one that has complementary wings".

In the Book of the Later Han Dynasty (後漢書-律曆志下), it is written: "The sun is in the sky, a cold and a summer, the four seasons are ready, all things are changed, the regency moves, and the green dragon moves to the star, which is called the year. (The Year of the Star)

Among the [twenty-eight Chinese constellations](https://zh.wikipedia.org/wiki/%E4%BA%8C%E5%8D%81%E5%85%AB%E5%AE%BF), the Green Dragon is the generic name for the seven eastern constellations (Horn, Hyper, Diao, Fang, Heart, Tail and Minchi). It is known in Taoism as "Mengzhang" and in different Taoist scriptures as "Dijun", "Shengjian", "Shenjian" and He is also known in different Daoist scriptures as "Dijun", "Shengjun", "Shenjun" and "Ghost Catcher"[1], and is the guardian deity of Daoism, together with the White Tiger Supervisor of Soldiers.
