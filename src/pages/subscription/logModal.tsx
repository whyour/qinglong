import intl from 'react-intl-universal';
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
import Ansi from 'ansi-to-react';

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
  const [value, setValue] = useState<string>(intl.get('启动中...'));
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
          setValue(log || intl.get('暂无日志'));
          setExecuting(log && !logEnded(log));
          if (log && !logEnded(log)) {
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
      forceRender
      onOk={() => cancel()}
      onCancel={() => cancel()}
      footer={[
        <Button type="primary" onClick={() => cancel()}>
          {intl.get('知道了')}
        </Button>,
      ]}
    >
      <div className="log-container">
        {loading ? (
          <PageLoading />
        ) : (
          <pre
            style={
              isPhone
                ? {
                    fontFamily: 'Source Code Pro',
                    zoom: 0.83,
                  }
                : {}
            }
          >
            <Ansi>{value}</Ansi>
          </pre>
        )}
      </div>
    </Modal>
  );
};

export default SubscriptionLogModal;
