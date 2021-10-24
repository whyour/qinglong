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
  socketMessage,
}: {
  dependence?: any;
  visible: boolean;
  handleCancel: (needRemove?: boolean) => void;
  socketMessage: any;
}) => {
  const [value, setValue] = useState<string>('');
  const [executing, setExecuting] = useState<any>(true);
  const [isPhone, setIsPhone] = useState(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [isRemoveFailed, setIsRemoveFailed] = useState(false);
  const [removeLoading, setRemoveLoading] = useState<boolean>(false);

  const cancel = (needRemove: boolean = false) => {
    localStorage.removeItem('logDependence');
    handleCancel(needRemove);
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
          setExecuting(!log.includes('结束时间'));
          setIsRemoveFailed(log.includes('删除失败'));
        }
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const forceRemoveDependence = () => {
    setRemoveLoading(true);
    request
      .delete(`${config.apiPrefix}dependencies/force`, {
        data: [dependence._id],
      })
      .then((data: any) => {
        cancel(true);
      })
      .finally(() => {
        setRemoveLoading(false);
      });
  };

  const footerClick = () => {
    if (isRemoveFailed) {
      forceRemoveDependence();
    } else {
      cancel();
    }
  };

  useEffect(() => {
    if (dependence) {
      getDependenceLog();
    }
  }, [dependence]);

  useEffect(() => {
    if (!socketMessage) return;
    const { type, message, references } = socketMessage;
    if (
      type === 'installDependence' &&
      message.includes('结束时间') &&
      references.length > 0
    ) {
      setExecuting(false);
      setIsRemoveFailed(message.includes('删除失败'));
    }
    setValue(`${value} \n ${message}`);
  }, [socketMessage]);

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
        <Button type="primary" onClick={footerClick} loading={removeLoading}>
          {isRemoveFailed ? '强制删除' : '知道了'}
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
