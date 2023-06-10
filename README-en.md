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

[Demo](http://demo.dlww.cc:4433/) / [Issues](https://github.com/whyour/qinglong/issues) / [Telegram Channel](https://t.me/jiao_long) / [Buy Me a Coffee](https://www.buymeacoffee.com/qinglong)

[演示](http://demo.dlww.cc:4433/) / [反馈](https://github.com/whyour/qinglong/issues) / [Telegram 频道](https://t.me/jiao_long) / [打赏开发者](https://user-images.githubusercontent.com/22700758/244744295-29cd0cd1-c8bb-4ea1-adf6-29bd390ad4dd.jpg)
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

## Deployment

### Docker (Recommended)

```bash
# curl -sSL get.docker.com | sh
docker run -dit \
  -v $PWD/ql/data:/ql/data \
  -p 5700:5700 \
  --name qinglong \
  --hostname qinglong \
  --restart unless-stopped \
  whyour/qinglong:latest
```

### Docker-compose (Recommended)

```bash
# curl -L https://github.com/docker/compose/releases/download/1.16.1/docker-compose-`uname -s`-`uname -m` -o /usr/local/bin/docker-compose
mkdir qinglong
wget https://raw.githubusercontent.com/whyour/qinglong/master/docker/docker-compose.yml

# start
docker-compose up -d
# stop
docker-compose down
```

### Podman (Recommended)

```bash
# https://podman.io/getting-started/installation
podman run -dit \
  --network bridge \
  -v $PWD/ql/data:/ql/data \
  -p 5700:5700 \
  --name qinglong \
  --hostname qinglong \
  docker.io/whyour/qinglong:latest
```

### Local

It is recommended to use a pure system installation to avoid losing the original system data, you need to install node/npm/python3/pip3 yourself

```bash
npm install -g @whyour/qinglong
qinglong
# Add the environment variables QL_DIR and QL_DATA_DIR when prompted
export QL_DIR=""
export QL_DATA_DIR=""
# Run again
qinglong
```

## Use

1. built-in commands

```bash
# Update and restart Green Dragon
ql update                                                    
# Run custom scripts extra.sh
ql extra                                                     
# Adding a single script file
ql raw <file_url>                                             
# Add a specific script for a single repository
ql repo <repo_url> <whitelist> <blacklist> <dependence> <branch>   
# Delete old logs
ql rmlog <days>                                              
# Start bot
ql bot                                                       
# Detecting the Green Dragon environment and repairing it
ql check                                                     
# Reset the number of login errors
ql resetlet                                                  
# Disable two-step login
ql resettfa                                                  

# Execute in sequence, if a random delay is set, it will be randomly delayed by a certain number of seconds
task <file_path>                                             
# Execute in sequence, regardless of whether a random delay is set, all run immediately, 
# and the foreground will output the day, while recorded in the log file
task <file_path> now                                         
# Concurrent execution, regardless of whether a random delay is set, are run immediately, 
# the foreground does not generate the day, directly recorded in the log file, and can be specified account execution
task <file_path> conc <env_name> <account_number>(Optional) 
# Specify the account to execute and run immediately regardless of whether a random delay is set 
task <file_path> desi <env_name> <account_number>       
# Set task timeout   
task -m <max_time> <file_path>
# Print task log in real time, no need to carry this parameter when creating timed tasks
task -l <file_path>  
```

2. parameter description

* file_url: Script address
* repo_url: Repository address
* whitelist: The whitelist when pulling the repository, i.e., the string contained in the path of the script to be pulled
* blacklist: Blacklisting when pulling repositories, i.e. strings that are not included in the path of the script to be pulled
* dependence: Pulling the dependencies needed for the repository will be copied directly from the repository to the repository directory under scripts, regardless of the blacklist
* branch: Pull the branch of the repository
* days: Number of days of logs to be kept
* file_path: File path for task execution
* env_name: The name of the environment variable that needs to be concurrent or specified at the time of task execution
* account_number: Specify the account number of an environment variable to be executed when the task is executed
* max_time: Timeout, suffix "s" for seconds (default), "m" for minutes, "h" for hours, "d" for days

## Development

```bash
$ git clone git@github.com:whyour/qinglong.git
$ cd qinglong
$ cp .env.example .env
# Recommended use pnpm https://pnpm.io/zh/installation
$ npm install -g pnpm@8.3.1
$ pnpm install
$ pnpm start
```

Open your browser and visit http://127.0.0.1:5700

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