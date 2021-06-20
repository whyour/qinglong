import React, { PureComponent, Fragment, useState, useEffect } from 'react';
import { Button, message, Modal, TreeSelect } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { Controlled as CodeMirror } from 'react-codemirror2';
import { request } from '@/utils/http';

const Config = () => {
  const [width, setWidth] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('config.sh');
  const [select, setSelect] = useState('config.sh');
  const [data, setData] = useState<any[]>([]);

  const getConfig = (name: string) => {
    request.get(`${config.apiPrefix}configs/${name}`).then((data: any) => {
      setValue(data.data);
    });
  };

  const getFiles = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}configs/files`)
      .then((data: any) => {
        setData(data.data);
      })
      .finally(() => setLoading(false));
  };

  const updateConfig = () => {
    request
      .post(`${config.apiPrefix}configs/save`, {
        data: { content: value, name: select },
      })
      .then((data: any) => {
        message.success(data.msg);
      });
  };

  const onSelect = (value: any, node: any) => {
    setSelect(value);
    setTitle(node.value);
    getConfig(node.value);
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
    getFiles();
    getConfig('config.sh');
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper config-wrapper"
      title={title}
      extra={[
        <TreeSelect
          className="config-select"
          value={select}
          dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
          treeData={data}
          key="value"
          defaultValue="config.sh"
          onSelect={onSelect}
        />,
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

export default Config;
