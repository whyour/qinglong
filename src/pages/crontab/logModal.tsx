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
  const [loading, setLoading] = useState<any>(true);

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
          if (log && !log.includes('执行结束') && visible) {
            setTimeout(() => {
              getCronLog();
            }, 2000);
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
    handleCancel();
  };

  useEffect(() => {
    if (cron) {
      getCronLog(true);
    }
  }, [cron]);

  return (
    <Modal
      title={`日志-${cron && cron.name}`}
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
