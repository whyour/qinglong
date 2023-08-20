import intl from 'react-intl-universal'
import React, {
  PureComponent,
  Fragment,
  useState,
  useEffect,
  useRef,
} from 'react';
import { Button, message, Modal, TreeSelect } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import Editor from '@monaco-editor/react';
import CodeMirror from '@uiw/react-codemirror';
import { useOutletContext } from '@umijs/max';
import { SharedContext } from '@/layouts';
import { langs } from '@uiw/codemirror-extensions-langs';

const Config = () => {
  const { headerStyle, isPhone, theme } = useOutletContext<SharedContext>();
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('config.sh');
  const [select, setSelect] = useState('config.sh');
  const [data, setData] = useState<any[]>([]);
  const editorRef = useRef<any>(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const getConfig = (name: string) => {
    request.get(`${config.apiPrefix}configs/${name}`).then(({ code, data }) => {
      if (code === 200) {
        setValue(data);
      }
    });
  };

  const getFiles = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}configs/files`)
      .then(({ code, data }) => {
        if (code === 200) {
          setData(data);
        }
      })
      .finally(() => setLoading(false));
  };

  const updateConfig = () => {
    setConfirmLoading(true);
    const content = editorRef.current
      ? editorRef.current.getValue().replace(/\r\n/g, '\n')
      : value;

    request
      .post(`${config.apiPrefix}configs/save`, { content, name: select })
      .then(({ code, data }) => {
        if (code === 200) {
          message.success(intl.get('保存成功'));
        }
        setConfirmLoading(false);
      });
  };

  const onSelect = (value: any, node: any) => {
    setSelect(value);
    setTitle(node.value);
    getConfig(node.value);
  };

  useEffect(() => {
    getFiles();
    getConfig('config.sh');
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper config-wrapper"
      title={title}
      loading={loading}
      extra={[
        <TreeSelect
          treeExpandAction="click"
          className="config-select"
          value={select}
          dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
          treeData={data}
          key="value"
          defaultValue="config.sh"
          onSelect={onSelect}
        />,
        <Button
          key="1"
          loading={confirmLoading}
          type="primary"
          onClick={updateConfig}
        >
          {intl.get('保存')}
        </Button>,
      ]}
      header={{
        style: headerStyle,
      }}
    >
      {isPhone ? (
        <CodeMirror
          value={value}
          theme={theme.includes('dark') ? 'dark' : 'light'}
          extensions={[langs.shell()]}
          onChange={(value) => {
            setValue(value);
          }}
        />
      ) : (
        <Editor
          defaultLanguage="shell"
          value={value}
          theme={theme}
          options={{
            fontSize: 12,
            lineNumbersMinChars: 3,
            folding: false,
            glyphMargin: false,
          }}
          onMount={(editor) => {
            editorRef.current = editor;
          }}
        />
      )}
    </PageContainer>
  );
};

export default Config;
