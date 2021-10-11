import React, { useEffect, useState, useRef } from 'react';
import { Typography, Modal, Tag, Button, Spin, message } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { version } from '../../version';

const { Text, Link } = Typography;

const CheckUpdate = ({ ws }: any) => {
  const [updateLoading, setUpdateLoading] = useState(false);
  const [value, setValue] = useState('');
  const modalRef = useRef<any>();

  const checkUpgrade = () => {
    if (updateLoading) return;
    setUpdateLoading(true);
    const hide = message.loading('检查更新中...', 0);
    request
      .put(`${config.apiPrefix}system/update-check`)
      .then((_data: any) => {
        const { code, data } = _data;
        if (code === 200 && !data.hasNewVersion) {
          showConfirmUpdateModal(data);
        } else {
          message.success('已经是最新版了！');
        }
      })
      .catch((error: any) => {
        console.log(error);
      })
      .finally(() => {
        setUpdateLoading(false);
        hide();
      });
  };

  const showConfirmUpdateModal = (data: any) => {
    const { version: newVersion, changeLog } = data;
    Modal.confirm({
      width: 500,
      title: (
        <>
          <div>更新可用</div>
          <div style={{ fontSize: 12, fontWeight: 400, marginTop: 5 }}>
            新版本{newVersion}可用。你使用的版本为{version}。
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
          {changeLog}
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
      title: <span></span>,
      centered: true,
      content: (
        <pre
          style={{
            wordBreak: 'break-all',
            whiteSpace: 'pre-wrap',
            paddingTop: 15,
            fontSize: 12,
            fontWeight: 400,
            minHeight: '60vh',
          }}
        >
          {value}
        </pre>
      ),
    });
  };

  useEffect(() => {
    ws.onmessage = (e) => {
      modalRef.current.update({
        content: (
          <pre
            style={{
              wordBreak: 'break-all',
              whiteSpace: 'pre-wrap',
              paddingTop: 15,
              fontSize: 12,
              fontWeight: 400,
              minHeight: '60vh',
            }}
          >
            {e.data + value}
          </pre>
        ),
      });
      setValue(e.data);
    };
  }, []);

  return (
    <>
      {value}
      <Button type="primary" onClick={checkUpgrade}>
        检查更新
      </Button>
    </>
  );
};

export default CheckUpdate;
