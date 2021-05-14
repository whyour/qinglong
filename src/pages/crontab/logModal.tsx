import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form } from 'antd';
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
}

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
          setExcuting(log && !log.includes('执行结束'));
          if (log && !log.includes('执行结束')) {
            setTimeout(() => {
              getCronLog();
            }, 2000);
          }
          if (log && log.includes('重启面板完成')) {
            message.warning({ content: '系统将在5秒后刷新', duration: 5 });
            setTimeout(() => {
              window.location.reload();
            }, 5000);
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
        <span style={{ marginRight: 5 }}>日志-{cron && cron.name}</span>{' '}
        {excuting && <Loading3QuartersOutlined spin />}
        {!excuting && <CheckCircleOutlined />}
      </>
    );
  };

  useEffect(() => {
    if (cron) {
      getCronLog(true);
    }
  }, [cron]);

  return (
    <Modal
      title={titleElement()}
      visible={visible}
      forceRender
      onOk={() => cancel()}
      onCancel={() => cancel()}
    >
      <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
        {!loading && value}
      </pre>
    </Modal>
  );
};

export default CronLogModal;
