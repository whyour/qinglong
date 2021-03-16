import React, { PureComponent, Fragment, useState, useEffect } from 'react';
import { Button, notification, Modal } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { Controlled as CodeMirror } from 'react-codemirror2';
import { request } from '@/utils/http';
import QRCode from 'qrcode.react';

const Config = () => {
  const [width, setWdith] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);

  const getConfig = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}config/config`)
      .then((data) => {
        setValue(data.content);
      })
      .finally(() => setLoading(false));
  };

  const updateConfig = () => {
    request
      .post(`${config.apiPrefix}save`, {
        data: { content: value, name: 'config.sh' },
      })
      .then((data) => {
        notification.success({
          message: data.msg,
        });
      });
  };

  function sleep(time: number) {
    return new Promise((resolve) => setTimeout(resolve, time));
  }

  const showQrCode = () => {
    request.get(`${config.apiPrefix}qrcode`).then(async (data) => {
      const modal = Modal.info({
        title: '二维码',
        content: (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              marginLeft: -38,
            }}
          >
            <QRCode
              style={{
                width: 200,
                height: 200,
                marginBottom: 10,
                marginTop: 20,
              }}
              value={data.qrcode}
            />
          </div>
        ),
      });
      getCookie(modal);
    });
  };

  const getCookie = async (modal: { destroy: () => void }) => {
    for (let i = 0; i < 50; i++) {
      const {
        data: { cookie, errcode, message },
      } = await request.get(`${config.apiPrefix}cookie`);
      if (cookie) {
        notification.success({
          message: 'Cookie获取成功',
        });
        modal.destroy();
        Modal.success({
          title: '获取Cookie成功',
          content: <div>{cookie}</div>,
        });
        break;
      }
      if (errcode !== 176) {
        notification.error({ message });
        break;
      }
      await sleep(2000);
    }
  };

  useEffect(() => {
    if (document.body.clientWidth < 768) {
      setWdith('auto');
      setMarginLeft(0);
      setMarginTop(0);
    } else {
      setWdith('100%');
      setMarginLeft(0);
      setMarginTop(-72);
    }
    getConfig();
  }, []);

  return (
    <PageContainer
      className="code-mirror-wrapper"
      title="config.sh"
      loading={loading}
      extra={[
        <Button key="1" type="primary" onClick={updateConfig}>
          保存
        </Button>,
      ]}
      header={{
        style: {
          padding: '4px 16px 4px 15px',
          position: 'sticky',
          top: 0,
          left: 0,
          zIndex: 20,
          marginTop,
          width,
          marginLeft,
        },
      }}
      style={{
        height: '100vh',
      }}
    >
      <CodeMirror
        value={value}
        options={{
          lineNumbers: true,
          lineWrapping: true,
          styleActiveLine: true,
          matchBrackets: true,
          mode: 'shell',
          theme: 'dracula',
        }}
        onBeforeChange={(editor, data, value) => {
          setValue(value);
        }}
        onChange={(editor, data, value) => {}}
      />
    </PageContainer>
  );
};

export default Config;
