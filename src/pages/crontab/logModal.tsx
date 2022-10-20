import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Statistic, Button } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { PageLoading } from '@ant-design/pro-layout';
import { logEnded } from '@/utils';

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
  data,
  logUrl,
}: {
  cron?: any;
  visible: boolean;
  handleCancel: () => void;
  data?: string;
  logUrl?: string;
}) => {
  const [value, setValue] = useState<string>('启动中...');
  const [loading, setLoading] = useState<any>(true);
  const [executing, setExecuting] = useState<any>(true);
  const [isPhone, setIsPhone] = useState(false);
  const [theme, setTheme] = useState<string>('');

  const getCronLog = (isFirst?: boolean) => {
    if (isFirst) {
      setLoading(true);
    }
    request
      .get(logUrl ? logUrl : `${config.apiPrefix}crons/${cron.id}/log`)
      .then(({ code, data }) => {
        if (
          code === 200 &&
          localStorage.getItem('logCron') === String(cron.id)
        ) {
          const log = data as string;
          setValue(log || '暂无日志');
          setExecuting(
            log && !logEnded(log) && !log.includes('重启面板'),
          );
          if (log && !logEnded(log) && !log.includes('重启面板')) {
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
                  <Countdown
                    className="inline-countdown"
                    format="ss"
                    value={Date.now() + 1000 * 30}
                  />
                  秒后自动刷新
                </span>
              ),
              duration: 10,
            });
            setTimeout(() => {
              window.location.reload();
            }, 30000);
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
        {(executing || loading) && <Loading3QuartersOutlined spin />}
        {!executing && !loading && <CheckCircleOutlined />}
        <span style={{ marginLeft: 5 }}>{cron && cron.name}</span>
      </>
    );
  };

  useEffect(() => {
    if (cron && cron.id && visible) {
      getCronLog(true);
    }
  }, [cron, visible]);

  useEffect(() => {
    if (data) {
      setValue(data);
    }
  }, [data]);

  useEffect(() => {
    setIsPhone(document.body.clientWidth < 768);
  }, []);

  return (
    <Modal
      title={titleElement()}
      open={visible}
      centered
      className="log-modal"
      bodyStyle={{
        minHeight: '300px',
      }}
      forceRender
      onOk={() => cancel()}
      onCancel={() => cancel()}
      footer={[
        <Button type="primary" onClick={() => cancel()}>
          知道了
        </Button>,
      ]}
    >
      {loading ? (
        <PageLoading />
      ) : (
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
