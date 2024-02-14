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
import Ansi from 'ansi-to-react';
import WebSocketManager from '@/utils/websocket';
import { Status } from './type';

const DependenceLogModal = ({
  dependence,
  handleCancel,
  visible,
}: {
  dependence?: any;
  visible: boolean;
  handleCancel: (needRemove?: boolean) => void;
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
          {intl.get('日志 -')} {dependence && dependence.name}
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
          const log = (data?.log || []).join('') as string;
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

  const handleMessage = (payload: any) => {
    const { message, references } = payload;
    if (
      references.length > 0 &&
      references.includes(dependence.id) &&
      [Status.删除中, Status.安装中].includes(dependence.status)
    ) {
      if (message.includes('结束时间')) {
        setExecuting(false);
        setIsRemoveFailed(message.includes('删除失败'));
      }
      setValue((p) => `${p}${message}`);
    }
  };

  useEffect(() => {
    const ws = WebSocketManager.getInstance();
    ws.subscribe('installDependence', handleMessage);
    ws.subscribe('uninstallDependence', handleMessage);

    return () => {
      ws.unsubscribe('installDependence', handleMessage);
      ws.unsubscribe('uninstallDependence', handleMessage);
    };
  }, [dependence]);

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
        <Button type="primary" onClick={footerClick} loading={removeLoading}>
          {isRemoveFailed ? intl.get('强制删除') : intl.get('知道了')}
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

export default DependenceLogModal;
