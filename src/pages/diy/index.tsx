import React, { PureComponent, Fragment, useState, useEffect } from 'react';
import { Button, message, Modal } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { Controlled as CodeMirror } from 'react-codemirror2';
import { request } from '@/utils/http';

const Crontab = () => {
  const [width, setWidth] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);

  const getConfig = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}config/extra`)
      .then((data) => {
        setValue(data.data);
      })
      .finally(() => setLoading(false));
  };

  const updateConfig = () => {
    request
      .post(`${config.apiPrefix}save`, {
        data: { content: value, name: 'extra.sh' },
      })
      .then((data) => {
        message.success(data.msg);
      });
  };

  useEffect(() => {
    if (document.body.clientWidth < 768) {
      setWidth('auto');
      setMarginLeft(0);
      setMarginTop(0);
    } else {
      setWidth('100%');
      setMarginLeft(0);
      setMarginTop(-72);
    }
    getConfig();
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper"
      title="extra.sh"
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
    >
      <CodeMirror
        value={value}
        options={{
          lineNumbers: true,
          lineWrapping: true,
          styleActiveLine: true,
          matchBrackets: true,
          mode: 'shell',
        }}
        onBeforeChange={(editor, data, value) => {
          setValue(value);
        }}
        onChange={(editor, data, value) => {}}
      />
    </PageContainer>
  );
};

export default Crontab;
