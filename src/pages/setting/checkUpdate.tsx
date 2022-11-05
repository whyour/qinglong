import React, { useEffect, useState, useRef } from 'react';
import { Statistic, Modal, Tag, Button, Spin, message } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { version } from '../../version';

const { Countdown } = Statistic;

const CheckUpdate = ({ socketMessage }: any) => {
  const [updateLoading, setUpdateLoading] = useState(false);
  const [value, setValue] = useState('');
  const modalRef = useRef<any>();

  const checkUpgrade = () => {
    if (updateLoading) return;
    setUpdateLoading(true);
    message.loading('检查更新中...', 0);
    request
      .put(`${config.apiPrefix}system/update-check`)
      .then(({ code, data }) => {
        message.destroy();
        if (code === 200) {
          if (data.hasNewVersion) {
            showConfirmUpdateModal(data);
          } else {
            showForceUpdateModal();
          }
        }
      })
      .catch((error: any) => {
        message.destroy();
        console.log(error);
      })
      .finally(() => {
        setUpdateLoading(false);
      });
  };

  const showForceUpdateModal = () => {
    Modal.confirm({
      width: 500,
      title: '更新',
      content: (
        <>
          <div>已经是最新版了！</div>
          <div style={{ fontSize: 12, fontWeight: 400, marginTop: 5 }}>
            青龙 {version} 是目前检测到的最新可用版本了。
          </div>
        </>
      ),
      okText: '确认',
      cancelText: '强制更新',
      onCancel() {
        showUpdatingModal();
        request
          .put(`${config.apiPrefix}system/update`)
          .then((_data: any) => {})
          .catch((error: any) => {
            console.log(error);
          });
      },
    });
  };

  const showConfirmUpdateModal = (data: any) => {
    const { lastVersion, lastLog } = data;
    Modal.confirm({
      width: 500,
      title: (
        <>
          <div>更新可用</div>
          <div style={{ fontSize: 12, fontWeight: 400, marginTop: 5 }}>
            新版本{lastVersion}可用。你使用的版本为{version}。
          </div>
        </>
      ),
      content: (
        <pre
          style={{
            paddingTop: 15,
            fontSize: 12,
            fontWeight: 400,
          }}
        >
          {lastLog}
        </pre>
      ),
      okText: '更新',
      cancelText: '以后再说',
      onOk() {
        showUpdatingModal();
        request
          .put(`${config.apiPrefix}system/update`)
          .then((_data: any) => {})
          .catch((error: any) => {
            console.log(error);
          });
      },
    });
  };

  const showUpdatingModal = () => {
    setValue('');
    modalRef.current = Modal.info({
      width: 600,
      maskClosable: false,
      closable: false,
      okButtonProps: { disabled: true },
      title: '更新中...',
      centered: true,
      content: (
        <pre
          style={{
            fontSize: 12,
            fontWeight: 400,
          }}
        >
          {value}
        </pre>
      ),
    });
  };

  useEffect(() => {
    if (!modalRef.current || !socketMessage) {
      return;
    }
    const { type, message: _message, references } = socketMessage;

    if (type !== 'updateSystemVersion') {
      return;
    }

    const newMessage = `${value}${_message}`;
    const updateFailed = newMessage.includes('失败，请检查');

    modalRef.current.update({
      maskClosable: updateFailed,
      closable: updateFailed,
      okButtonProps: { disabled: !updateFailed },
      content: (
        <>
          <pre
            style={{
              fontSize: 12,
              fontWeight: 400,
            }}
          >
            {newMessage}
          </pre>
          <div id="log-identifier" style={{ paddingBottom: 5 }}></div>
        </>
      ),
    });

    if (updateFailed && !value.includes('失败，请检查')) {
      message.error('更新失败，请检查网络及日志或稍后再试');
    }

    setValue(newMessage);

    document.getElementById('log-identifier') &&
      document
        .getElementById('log-identifier')!
        .scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    if (_message.includes('重启面板')) {
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
        duration: 30,
      });
      setTimeout(() => {
        window.location.reload();
      }, 30000);
    }
  }, [socketMessage]);

  return (
    <>
      <Button type="primary" onClick={checkUpgrade}>
        检查更新
      </Button>
    </>
  );
};

export default CheckUpdate;
