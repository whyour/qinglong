import React, { useEffect, useState } from 'react';
import { Typography, Input, Form, Button, message } from 'antd';
import styles from './index.less';

const { Link } = Typography;

const About = () => {
  return (
    <div className={styles.container}>
      <img
        alt="logo"
        style={{ width: 140, marginRight: 20 }}
        src="http://qn.whyour.cn/logo.png"
      />
      <div className={styles.right}>
        <span className={styles.title}>青龙</span>
        <span className={styles.desc}>
          支持python3、javaScript、shell、typescript 的定时任务管理面板（A timed
          task management panel that supports typescript, javaScript, python3,
          and shell.）
        </span>
        <div>
          <Link
            href="https://github.com/whyour/qinglong"
            target="_blank"
            style={{ marginRight: 15 }}
          >
            Github
          </Link>
          <Link
            href="https://t.me/jiao_long"
            target="_blank"
            style={{ marginRight: 15 }}
          >
            Telegram频道
          </Link>
          <Link
            href="https://github.com/whyour/qinglong/issues"
            target="_blank"
          >
            提交BUG
          </Link>
        </div>
      </div>
    </div>
  );
};

export default About;
