import React, { useEffect, useState } from 'react';
import { Modal, notification, Input, Form } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

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
  const [logTimer, setLogTimer] = useState<any>();

  const getCronLog = () => {
    request
      .get(`${config.apiPrefix}crons/${cron._id}/log`)
      .then((data: any) => {
        setValue(data.data || '暂无日志');
      });
  };

  const cancel = () => {
    clearInterval(logTimer);
    handleCancel();
  };

  useEffect(() => {
    if (cron) {
      const timer = setInterval(() => {
        getCronLog();
      }, 2000);
      setLogTimer(timer);
    }
  }, [cron]);

  return (
    <Modal
      title={`日志-${cron && cron.name}`}
      visible={visible}
      forceRender
      onOk={() => cancel()}
      onCancel={() => cancel()}
      destroyOnClose
    >
      <pre style={{ whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
        {value}
      </pre>
    </Modal>
  );
};

export default CronLogModal;
