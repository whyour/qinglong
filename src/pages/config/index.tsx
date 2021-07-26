import React, { PureComponent, Fragment, useState, useEffect } from 'react';
import { Button, message, Modal, TreeSelect } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import Editor from '@monaco-editor/react';

const Config = () => {
  const [width, setWidth] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('config.sh');
  const [select, setSelect] = useState('config.sh');
  const [data, setData] = useState<any[]>([]);
  const [theme, setTheme] = useState<string>('');

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

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const storageTheme = localStorage.getItem('qinglong_dark_theme');
    const isDark =
      (media.matches && storageTheme !== 'light') || storageTheme === 'dark';
    setTheme(isDark ? 'vs-dark' : 'vs');
    media.addEventListener('change', (e) => {
      if (storageTheme === 'auto' || !storageTheme) {
        if (e.matches) {
          setTheme('vs-dark');
        } else {
          setTheme('vs');
        }
      }
    });
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper config-wrapper"
      title={title}
      loading={loading}
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
      <Editor
        defaultLanguage="shell"
        value={value}
        theme={theme}
        options={{
          fontSize: 12,
          minimap: { enabled: width === '100%' },
          lineNumbersMinChars: 3,
          folding: false,
          glyphMargin: false,
        }}
        onChange={(val) => {
          setValue((val as string).replace(/\r\n/g, '\n'));
        }}
      />
    </PageContainer>
  );
};

export default Config;
