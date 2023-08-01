import intl from 'react-intl-universal';
import React, { useEffect, useState, useRef } from 'react';
import { Statistic, Modal, Tag, Button, Spin, message } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';

const { Countdown } = Statistic;

const CheckUpdate = ({ socketMessage, systemInfo }: any) => {
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
            showForceUpdateModal(data);
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

  const showForceUpdateModal = (data: any) => {
    Modal.confirm({
      width: 500,
      title: intl.get('更新'),
      content: (
        <>
          <div>{intl.get('已经是最新版了！')}</div>
          <div style={{ fontSize: 12, fontWeight: 400, marginTop: 5 }}>
            {intl.get('青龙')} {data.lastVersion}{' '}
            {intl.get('是目前检测到的最新可用版本了。')}
          </div>
        </>
      ),
      okText: intl.get('重新下载'),
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

  const showConfirmUpdateModal = (data: any) => {
    const { lastVersion, lastLog } = data;
    Modal.confirm({
      width: 500,
      title: (
        <>
          <div>{intl.get('更新可用')}</div>
          <div style={{ fontSize: 12, fontWeight: 400, marginTop: 5 }}>
            {intl.get('新版本')} {lastVersion}{' '}
            {intl.get('可用，你使用的版本为')} {systemInfo.version}。
          </div>
        </>
      ),
      content: (
        <pre
          style={{
            fontSize: 12,
            fontWeight: 400,
          }}
        >
          {lastLog}
        </pre>
      ),
      okText: intl.get('下载更新'),
      cancelText: intl.get('以后再说'),
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
      keyboard: false,
      okButtonProps: { disabled: true },
      title: intl.get('下载更新中...'),
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

  const showReloadModal = () => {
    Modal.confirm({
      width: 600,
      maskClosable: false,
      title: intl.get('确认重启'),
      centered: true,
      content: intl.get('系统安装包下载成功，确认重启'),
      okText: intl.get('重启'),
      onOk() {
        request
          .put(`${config.apiPrefix}system/reload`, { type: 'system' })
          .then((_data: any) => {
            message.success({
              content: (
                <span>
                  {intl.get('系统将在')}
                  <Countdown
                    className="inline-countdown"
                    format="ss"
                    value={Date.now() + 1000 * 30}
                  />
                  {intl.get('秒后自动刷新')}
                </span>
              ),
              duration: 30,
            });
            setTimeout(() => {
              window.location.reload();
            }, 30000);
          })
          .catch((error: any) => {
            console.log(error);
          });
      },
      onCancel() {
        modalRef.current.update({
          maskClosable: true,
          closable: true,
          okButtonProps: { disabled: false },
        });
      },
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
    const updateFailed = newMessage.includes('失败');

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

    if (_message.includes('更新包下载成功')) {
      setTimeout(() => {
        showReloadModal();
      }, 1000);
    }
  }, [socketMessage]);

  return (
    <>
      <Button type="primary" onClick={checkUpgrade}>
        {intl.get('检查更新')}
      </Button>
    </>
  );
};

export default CheckUpdate;
