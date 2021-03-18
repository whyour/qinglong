import React, { PureComponent, Fragment, useState, useEffect } from 'react';
import { Button, notification, Modal, TreeSelect } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { Controlled as CodeMirror } from 'react-codemirror2';
import { request } from '@/utils/http';
const Log = () => {
  const [width, setWdith] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [title, setTitle] = useState('log');
  const [value, setValue] = useState('请选择日志文件');
  const [select, setSelect] = useState();
  const [data, setData] = useState();
  const [loading, setLoading] = useState(false);

  const getConfig = () => {
    request.get(`${config.apiPrefix}logs`).then((data) => {
      setData(formatData(data.dirs) as any);
    });
  };

  const formatData = (tree: any[]) => {
    return tree.map((x) => {
      x.title = x.name;
      x.value = x.name;
      x.disabled = x.isDir;
      x.children = x.files.map((y: string) => ({
        title: y,
        key: y,
        value: y,
        parent: x.name,
      }));
      return x;
    });
  };

  const getLog = (node: any) => {
    setLoading(true);
    let url = `${node.parent}/${node.value}`;
    if (!node.isDir) {
      url = node.value;
    }
    request
      .get(`${config.apiPrefix}logs/${url}`)
      .then((data) => {
        setValue(data.data);
      })
      .finally(() => setLoading(false));
  };

  const onSelect = (value: any, node: any) => {
    setSelect(value);
    setTitle(node.parent);
    getLog(node);
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
      title={title}
      extra={[
        <TreeSelect
          style={{ width: 280 }}
          value={select}
          dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
          treeData={data}
          placeholder="请选择日志文件"
          showSearch
          key="title"
          onSelect={onSelect}
        />,
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
          readOnly: 'nocursor',
        }}
        onBeforeChange={(editor, data, value) => {
          setValue(value);
        }}
        onChange={(editor, data, value) => {}}
      />
    </PageContainer>
  );
};

export default Log;
