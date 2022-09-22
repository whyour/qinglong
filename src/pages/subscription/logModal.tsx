import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Statistic, Button } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { PageLoading } from '@ant-design/pro-layout';

const SubscriptionLogModal = ({
  subscription,
  handleCancel,
  visible,
  data,
  logUrl,
}: {
  subscription?: any;
  visible: boolean;
  handleCancel: () => void;
  data?: string;
  logUrl?: string;
}) => {
  const [value, setValue] = useState<string>('启动中...');
  const [loading, setLoading] = useState<any>(true);
  const [executing, setExecuting] = useState<any>(true);
  const [isPhone, setIsPhone] = useState(false);

  const getCronLog = (isFirst?: boolean) => {
    if (isFirst) {
      setLoading(true);
    }
    request
      .get(
        logUrl
          ? logUrl
          : `${config.apiPrefix}subscriptions/${subscription.id}/log`,
      )
      .then(({ code, data }) => {
        if (
          code === 200 &&
          localStorage.getItem('logSubscription') === String(subscription.id)
        ) {
          const log = data as string;
          setValue(log || '暂无日志');
          setExecuting(log && !log.includes('执行结束'));
          if (log && !log.includes('执行结束')) {
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
    localStorage.removeItem('logSubscription');
    handleCancel();
  };

  const titleElement = () => {
    return (
      <>
        {(executing || loading) && <Loading3QuartersOutlined spin />}
        {!executing && !loading && <CheckCircleOutlined />}
        <span style={{ marginLeft: 5 }}>
          {subscription && subscription.name}
        </span>
      </>
    );
  };

  useEffect(() => {
    if (subscription && subscription.id && visible) {
      getCronLog(true);
    }
  }, [subscription, visible]);

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

export default SubscriptionLogModal;
