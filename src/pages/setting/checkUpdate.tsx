import { disableBody } from '@/utils';
import config from '@/utils/config';
import { request } from '@/utils/http';
import WebSocketManager from '@/utils/websocket';
import Ansi from 'ansi-to-react';
import { Button, Modal, Statistic, message } from 'antd';
import { useCallback, useEffect, useRef, useState } from 'react';
import intl from 'react-intl-universal';

const { Countdown } = Statistic;

const CheckUpdate = ({ systemInfo }: any) => {
  const [updateLoading, setUpdateLoading] = useState(false);
  const [value, setValue] = useState('');
  const modalRef = useRef<any>();

  const checkUpgrade = () => {
    if (updateLoading) return;
    setUpdateLoading(true);
    message.loading(intl.get('检查更新中...'), 0);
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
        <pre>
          <Ansi>{lastLog}</Ansi>
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
        <pre>
          <Ansi>{value}</Ansi>
        </pre>
      ),
    });
  };

  const reloadSystem = (type?: string) => {
    request
      .put(`${config.apiPrefix}update/${type}`)
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
        disableBody();
        setTimeout(() => {
          window.location.reload();
        }, 30000);
      })
      .catch((error: any) => {
        console.log(error);
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
        reloadSystem('system');
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
    if (!value) return;
    const updateFailed = value.includes('失败，请检查');

    modalRef.current.update({
      maskClosable: updateFailed,
      closable: updateFailed,
      okButtonProps: { disabled: !updateFailed },
      content: (
        <>
          <pre>
            <Ansi>{value}</Ansi>
          </pre>
          <div id="log-identifier" style={{ paddingBottom: 5 }}></div>
        </>
      ),
    });
  }, [value]);

  const handleMessage = useCallback((payload: any) => {
    let { message: _message } = payload;
    const updateFailed = _message.includes('失败，请检查');

    if (updateFailed) {
      message.error(intl.get('更新失败，请检查网络及日志或稍后再试'));
    }

    setTimeout(() => {
      document
        .querySelector('#log-identifier')!
        .scrollIntoView({ behavior: 'smooth' });
    }, 600);

    if (_message.includes('更新包下载成功')) {
      setTimeout(() => {
        showReloadModal();
      }, 1000);
    }

    setValue((p) => `${p}${_message}`);
  }, []);

  useEffect(() => {
    const ws = WebSocketManager.getInstance();
    ws.subscribe('updateSystemVersion', handleMessage);

    return () => {
      ws.unsubscribe('updateSystemVersion', handleMessage);
    };
  }, []);

  return (
    <>
      <Button type="primary" onClick={checkUpgrade}>
        {intl.get('检查更新')}
      </Button>
      <Button
        type="primary"
        onClick={() => reloadSystem('reload')}
        style={{ marginLeft: 8 }}
      >
        {intl.get('重新启动')}
      </Button>
    </>
  );
};

export default CheckUpdate;
