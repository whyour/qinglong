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
  const [title, setTitle] = useState('请选择日志文件');
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
        value: `${x.name}/${y}`,
        parent: x.name,
      }));
      return x;
    });
  };

  const getLog = (node: any) => {
    console.log(node);
    setLoading(true);
    request
      .get(`${config.apiPrefix}logs/${node.value}`)
      .then((data) => {
        setValue(data.data);
      })
      .finally(() => setLoading(false));
  };

  const onSelect = (value: any, node: any) => {
    setSelect(value);
    setTitle(node.parent || node.value);
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
      className="ql-container-wrapper log-wrapper"
      title={title}
      extra={[
        <TreeSelect
          className="log-select"
          value={select}
          dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
          treeData={data}
          placeholder="请选择日志文件"
          showSearch
          key="value"
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
    >
      <CodeMirror
        value={value}
        options={{
          lineNumbers: true,
          lineWrapping: true,
          styleActiveLine: true,
          matchBrackets: true,
          mode: 'shell',
          readOnly: true,
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
