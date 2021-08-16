import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Statistic } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';

enum CrontabStatus {
  'running',
  'idle',
  'disabled',
  'queued',
}
const { Countdown } = Statistic;

const CronLogModal = ({
  cron,
  handleCancel,
  visible,
}: {
  cron?: any;
  visible: boolean;
  handleCancel: () => void;
}) => {
  const [value, setValue] = useState<string>('启动中...');
  const [loading, setLoading] = useState<any>(true);
  const [excuting, setExcuting] = useState<any>(true);
  const [isPhone, setIsPhone] = useState(false);
  const [theme, setTheme] = useState<string>('');

  const getCronLog = (isFirst?: boolean) => {
    if (isFirst) {
      setLoading(true);
    }
    request
      .get(`${config.apiPrefix}crons/${cron._id}/log`)
      .then((data: any) => {
        if (localStorage.getItem('logCron') === cron._id) {
          const log = data.data as string;
          setValue(log || '暂无日志');
          setExcuting(
            log && !log.includes('执行结束') && !log.includes('重启面板'),
          );
          if (log && !log.includes('执行结束') && !log.includes('重启面板')) {
            setTimeout(() => {
              getCronLog();
            }, 2000);
          }
          if (
            log &&
            log.includes('重启面板') &&
            cron.status === CrontabStatus.running
          ) {
            message.warning({
              content: (
                <span>
                  系统将在
                  <Countdown format="ss" value={Date.now() + 1000 * 10} />
                  秒后自动刷新
                </span>
              ),
              duration: 10,
            });
            setTimeout(() => {
              window.location.reload();
            }, 10000);
          }
        }
      })
      .finally(() => {
        if (isFirst) {
          setLoading(false);
        }
      });
  };

  const cancel = () => {
    localStorage.removeItem('logCron');
    handleCancel();
  };

  const titleElement = () => {
    return (
      <>
        {excuting && <Loading3QuartersOutlined spin />}
        {!excuting && <CheckCircleOutlined />}
        <span style={{ marginLeft: 5 }}>日志-{cron && cron.name}</span>{' '}
      </>
    );
  };

  useEffect(() => {
    if (cron) {
      getCronLog(true);
    }
  }, [cron]);

  useEffect(() => {
    setIsPhone(document.body.clientWidth < 768);
  }, []);

  return (
    <Modal
      title={titleElement()}
      visible={visible}
      centered
      className="log-modal"
      bodyStyle={{
        overflowY: 'auto',
        maxHeight: 'calc(80vh - var(--vh-offset, 0px))',
      }}
      forceRender
      onOk={() => cancel()}
      onCancel={() => cancel()}
    >
      {!loading && value && (
        <pre
          style={
            isPhone
              ? {
                  fontFamily: 'Source Code Pro',
                  width: 375,
                  zoom: 0.83,
                }
              : {}
          }
        >
          {value}
        </pre>
      )}
    </Modal>
  );
};

export default CronLogModal;
