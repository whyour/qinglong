import React, { PureComponent, useRef, useState, useEffect } from 'react';
import { Button, message, Select, Form, Row, Col } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import './index.less';
import { DiffEditor } from '@monaco-editor/react';
import ReactDiffViewer from 'react-diff-viewer';
import { useOutletContext } from '@umijs/max';
import { SharedContext } from '@/layouts';

const { Option } = Select;

const Diff = () => {
  const { headerStyle, isPhone, theme } = useOutletContext<SharedContext>();
  const [origin, setOrigin] = useState('config.sample.sh');
  const [current, setCurrent] = useState('config.sh');
  const [originValue, setOriginValue] = useState('');
  const [currentValue, setCurrentValue] = useState('');
  const [loading, setLoading] = useState(true);
  const [files, setFiles] = useState<any[]>([]);
  const editorRef = useRef<any>(null);

  const getConfig = () => {
    request
      .get(`${config.apiPrefix}configs/${current}`)
      .then(({ code, data }) => {
        if (code === 200) {
          setCurrentValue(data);
        }
      });
  };

  const getSample = () => {
    request
      .get(`${config.apiPrefix}configs/${origin}`)
      .then(({ code, data }) => {
        if (code === 200) {
          setOriginValue(data);
        }
      });
  };

  const updateConfig = () => {
    const content = editorRef.current
      ? editorRef.current.getModel().modified.getValue().replace(/\r\n/g, '\n')
      : currentValue;

    request
      .post(`${config.apiPrefix}configs/save`, {
        data: { content, name: current },
      })
      .then(({ code, data }) => {
        if (code === 200) {
          message.success('保存成功');
        }
      });
  };

  const getFiles = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}configs/files`)
      .then(({ code, data }) => {
        if (code === 200) {
          setFiles(data);
        }
      })
      .finally(() => setLoading(false));
  };

  const originFileChange = (value: string) => {
    setOrigin(value);
  };

  const currentFileChange = (value: string) => {
    setCurrent(value);
  };

  useEffect(() => {
    getFiles();
  }, []);

  useEffect(() => {
    getSample();
  }, [origin]);

  useEffect(() => {
    getConfig();
  }, [current]);

  return (
    <PageContainer
      className="ql-container-wrapper"
      title="对比工具"
      loading={loading}
      header={{
        style: headerStyle,
      }}
      extra={
        !isPhone && [
          <Button key="1" type="primary" onClick={updateConfig}>
            保存
          </Button>,
        ]
      }
    >
      <Row gutter={24} className="diff-switch-file">
        <Col span={12}>
          <Form.Item label="源文件">
            <Select value={origin} onChange={originFileChange}>
              {files.map((x) => (
                <Option key={x.value} value={x.value}>
                  {x.title}
                </Option>
              ))}
            </Select>
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="当前文件">
            <Select value={current} onChange={currentFileChange}>
              {files.map((x) => (
                <Option key={x.value} value={x.value}>
                  {x.title}
                </Option>
              ))}
            </Select>
          </Form.Item>
        </Col>
      </Row>
      {isPhone ? (
        <ReactDiffViewer
          styles={{
            diffContainer: {
              overflowX: 'auto',
              minWidth: 768,
            },
            diffRemoved: {
              overflowX: 'auto',
              maxWidth: 300,
            },
            diffAdded: {
              overflowX: 'auto',
              maxWidth: 300,
            },
            line: {
              wordBreak: 'break-word',
            },
          }}
          oldValue={originValue}
          newValue={currentValue}
          splitView={true}
          leftTitle="config.sh"
          rightTitle="config.sample.sh"
          disableWordDiff={true}
        />
      ) : (
        <DiffEditor
          language={'shell'}
          original={originValue}
          modified={currentValue}
          options={{
            fontSize: 12,
            lineNumbersMinChars: 3,
            folding: false,
            glyphMargin: false,
            wordWrap: 'on',
          }}
          theme={theme}
          onMount={(editor) => {
            editorRef.current = editor;
          }}
        />
      )}
    </PageContainer>
  );
};

export default Diff;
