import intl from 'react-intl-universal';
import React, { useEffect, useState } from 'react';
import { Typography, Input, Form, Button, message, Descriptions } from 'antd';
import styles from './index.less';
import { SharedContext } from '@/layouts';
import dayjs from 'dayjs';

const { Link } = Typography;

const About = ({ systemInfo }: { systemInfo: SharedContext['systemInfo'] }) => {
  return (
    <div className={styles.container}>
      <img
        alt="logo"
        style={{ width: 140, marginRight: 20 }}
        src="https://qn.whyour.cn/logo.png"
      />
      <div className={styles.right}>
        <span className={styles.title}>{intl.get('青龙')}</span>
        <span className={styles.desc}>
          {intl.get(
            '支持python3、javascript、shell、typescript 的定时任务管理面板',
          )}
        </span>
        <Descriptions>
          <Descriptions.Item label={intl.get('版本')} span={3}>
            {systemInfo?.branch === 'develop'
              ? intl.get('开发版')
              : intl.get('正式版')}{' '}
            v{systemInfo.version}
          </Descriptions.Item>
          <Descriptions.Item label={intl.get('更新时间')} span={3}>
            {dayjs(systemInfo.publishTime * 1000).format('YYYY-MM-DD HH:mm')}
          </Descriptions.Item>
          <Descriptions.Item label={intl.get('更新日志')} span={3}>
            <Link
              href={`https://qn.whyour.cn/version.yaml?t=${Date.now()}`}
              target="_blank"
            >
              {intl.get('查看')}
            </Link>
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
            {intl.get('Telegram频道')}
          </Link>
          <Link
            href="https://github.com/whyour/qinglong/issues"
            target="_blank"
          >
            {intl.get('提交BUG')}
          </Link>
        </div>
      </div>
    </div>
  );
};

export default About;
