import React, { useEffect, useState, useRef } from 'react';
import { Statistic, Modal, Tag, Button, Spin, message } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { version } from '../../version';

const { Countdown } = Statistic;

const CheckUpdate = ({ ws }: any) => {
  const [updateLoading, setUpdateLoading] = useState(false);
  const modalRef = useRef<any>();

  const checkUpgrade = () => {
    if (updateLoading) return;
    setUpdateLoading(true);
    const hide = message.loading('检查更新中...', 0);
    request
      .put(`${config.apiPrefix}system/update-check`)
      .then((_data: any) => {
        message.destroy();
        const { code, data } = _data;
        if (code === 200) {
          if (data.hasNewVersion) {
            showConfirmUpdateModal(data);
          } else {
            message.success('已经是最新版了！');
          }
        } else {
          message.error(data);
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
            wordBreak: 'break-all',
            whiteSpace: 'pre-wrap',
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
    modalRef.current = Modal.info({
      width: 600,
      maskClosable: false,
      closable: false,
      okButtonProps: { disabled: true },
      title: '更新日志',
      centered: true,
      content: (
        <div style={{ height: '60vh', overflowY: 'auto' }}>
          <pre
            style={{
              wordBreak: 'break-all',
              whiteSpace: 'pre-wrap',
              fontSize: 12,
              fontWeight: 400,
            }}
          >
            更新中...
          </pre>
        </div>
      ),
    });
  };

  useEffect(() => {
    let _message = '';
    ws.onmessage = (e: any) => {
      if (!modalRef.current) {
        return;
      }
      _message = `${_message}\n${e.data}`;
      modalRef.current.update({
        content: (
          <div style={{ height: '60vh', overflowY: 'auto' }}>
            <pre
              style={{
                wordBreak: 'break-all',
                whiteSpace: 'pre-wrap',
                fontSize: 12,
                fontWeight: 400,
              }}
            >
              {_message}
            </pre>
            <div id="log-identifier" style={{ paddingBottom: 5 }}></div>
          </div>
        ),
      });
      document.getElementById('log-identifier') &&
        document
          .getElementById('log-identifier')!
          .scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      if (e.data.includes('重启面板')) {
        message.warning({
          content: (
            <span>
              系统将在
              <Countdown
                className="inline-countdown"
                format="ss"
                value={Date.now() + 1000 * 10}
              />
              秒后自动刷新
            </span>
          ),
          duration: 10,
        });
        setTimeout(() => {
          window.location.reload();
        }, 10000);
      }
    };
  }, []);

  return (
    <>
      <Button type="primary" onClick={checkUpgrade}>
        检查更新
      </Button>
    </>
  );
};

export default CheckUpdate;
