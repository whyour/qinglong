import React, { useEffect, useState } from 'react';
import { Typography, Input, Form, Button, message, Descriptions } from 'antd';
import styles from './index.less';
import { SharedContext } from '@/layouts';
import dayjs from 'dayjs';

const { Link } = Typography;

enum TVersion {
  'develop' = '开发版',
  'master' = '正式版',
}

const About = ({ systemInfo }: { systemInfo: SharedContext['systemInfo'] }) => {
  return (
    <div className={styles.container}>
      <img
        alt="logo"
        style={{ width: 140, marginRight: 20 }}
        src="https://qn.whyour.cn/logo.png"
      />
      <div className={styles.right}>
        <span className={styles.title}>青龙</span>
        <span className={styles.desc}>
          支持python3、javaScript、shell、typescript 的定时任务管理面板（A timed
          task management panel that supports typescript, javaScript, python3,
          and shell.）
        </span>
        <Descriptions>
          <Descriptions.Item label="版本" span={3}>
            {TVersion[systemInfo.branch]} v{systemInfo.version}
          </Descriptions.Item>
          <Descriptions.Item label="更新时间" span={3}>
            {dayjs(systemInfo.lastCommitTime * 1000).format(
              'YYYY-MM-DD HH:mm:ss',
            )}
          </Descriptions.Item>
          <Descriptions.Item label="更新ID" span={3}>
            {systemInfo.lastCommitId}
          </Descriptions.Item>
        </Descriptions>
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
