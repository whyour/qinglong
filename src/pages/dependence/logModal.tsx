import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Statistic, Button } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { PageLoading } from '@ant-design/pro-layout';

const DependenceLogModal = ({
  dependence,
  handleCancel,
  visible,
  ws,
}: {
  dependence?: any;
  visible: boolean;
  handleCancel: () => void;
  ws: any;
}) => {
  const [value, setValue] = useState<string>('');
  const [executing, setExecuting] = useState<any>(true);
  const [isPhone, setIsPhone] = useState(false);
  const [loading, setLoading] = useState<any>(true);

  const cancel = () => {
    localStorage.removeItem('logDependence');
    handleCancel();
  };

  const titleElement = () => {
    return (
      <>
        {executing && <Loading3QuartersOutlined spin />}
        {!executing && <CheckCircleOutlined />}
        <span style={{ marginLeft: 5 }}>
          日志 - {dependence && dependence.name}
        </span>{' '}
      </>
    );
  };

  const getDependenceLog = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}dependencies/${dependence._id}`)
      .then((data: any) => {
        if (localStorage.getItem('logDependence') === dependence._id) {
          const log = (data.data.log || []).join('\n') as string;
          setValue(log);
          setExecuting(!log.includes('安装结束'));
        }
      })
      .finally(() => {
        setLoading(false);
      });
  };

  useEffect(() => {
    if (dependence) {
      getDependenceLog();
      ws.onmessage = (e: any) => {
        const { type, message, references } = JSON.parse(e.data);
        if (
          type === 'installDependence' &&
          message === '安装结束' &&
          references.length > 0
        ) {
          setExecuting(false);
        }
        setValue(`${value} \n ${message}`);
      };
    }
  }, [dependence]);

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
        maxHeight: 'calc(70vh - var(--vh-offset, 0px))',
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

export default DependenceLogModal;
