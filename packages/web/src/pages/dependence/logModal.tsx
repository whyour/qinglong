import React, { useEffect, useState } from 'react';
import { Modal, message, Input, Form, Statistic, Button } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { PageLoading } from '@ant-design/pro-layout';
import Ansi from 'ansi-to-react';

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
      .get(`${config.apiPrefix}dependencies/${dependence.id}`)
      .then(({ code, data }) => {
        if (
          code === 200 &&
          localStorage.getItem('logDependence') === String(dependence.id)
        ) {
          const log = (data.log || []).join('') as string;
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
        data: [dependence.id],
      })
      .then(({ code, data }) => {
        if (code === 200) {
          cancel(true);
        }
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
    if (!socketMessage || !dependence) return;
    const { type, message, references } = socketMessage;
    if (
      type === 'installDependence' &&
      references.length > 0 &&
      references.includes(dependence.id)
    ) {
      if (message.includes('结束时间')) {
        setExecuting(false);
        setIsRemoveFailed(message.includes('删除失败'));
      }
      setValue(`${value}${message}`);
    }
  }, [socketMessage]);

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
          <Ansi>{value}</Ansi>
        </pre>
      )}
    </Modal>
  );
};

export default DependenceLogModal;
