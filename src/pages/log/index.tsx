import { FileBrowser, FilePicker } from '@/components/fileBrowser';
import { readableLogName } from '@/components/fileBrowser/name';
import { SharedContext } from '@/layouts';
import config from '@/utils/config';
import { request } from '@/utils/http';
import { CloudDownloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-layout';
import Editor from '@monaco-editor/react';
import CodeMirror from '@uiw/react-codemirror';
import { useOutletContext } from '@umijs/max';
import {
  Button,
  message,
  Modal,
  Tooltip,
  Typography,
} from 'antd';
import { saveAs } from 'file-saver';
import prettyBytes from 'pretty-bytes';
import { useEffect, useRef, useState } from 'react';
import intl from 'react-intl-universal';
import SplitPane from 'react-split-pane';
import styles from './index.module.less';

const { Text } = Typography;

const Log = () => {
  const { headerStyle, isPhone, theme } = useOutletContext<SharedContext>();
  const [value, setValue] = useState(intl.get('请选择日志文件'));
  const [select, setSelect] = useState<string>(intl.get('请选择日志文件'));
  const [revision, setRevision] = useState(0);
  const selectedKey = useRef('');
  const detailRequest = useRef<AbortController>();
  const [readFailed, setReadFailed] = useState(false);
  useEffect(() => () => detailRequest.current?.abort(), []);
  const [currentNode, setCurrentNode] = useState<any>();

  const getLog = (node: any) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setReadFailed(false);
    request
      .get(
        `${config.apiPrefix}logs/detail`, { signal: controller.signal, retryInPlace: true, params: { file: node.title, path: node.parent || '', tail: true, limit: 1024 * 1024 } },
      )
      .then(({ code, data }) => {
        if (controller.signal.aborted || selectedKey.current !== node.key) return;
        if (code === 200) setValue(data);
        else setReadFailed(true);
      }).catch(() => { if (!controller.signal.aborted) setReadFailed(true); });
  };

  const downloadLog = () => {
    request
      .post<Blob>(
        `${config.apiPrefix}logs/download`,
        {
          filename: currentNode.title,
          path: currentNode.parent || '',
        },
        { responseType: 'blob' },
      )
      .then((res) => {
        saveAs(res, currentNode.title);
      });
  };

  const onSelect = (value: any, node: any) => {
    if (node.key === select || !value) {
      return;
    }

    detailRequest.current?.abort();
    setReadFailed(false);
    selectedKey.current = node.key;
    setCurrentNode(node);
    setSelect(value);

    if (node.type === 'directory') {
      setValue(intl.get('请选择日志文件'));
      return;
    }

    setValue(intl.get('加载中...'));
    getLog(node);
  };

  const deleteFile = () => {
    Modal.confirm({
      title: intl.get('确认删除'),
      content: (
        <>
          {intl.get('确认删除')}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {' '}
            {select}{' '}
          </Text>
          {intl.get('文件')}
          {currentNode.type === 'directory' ? intl.get('夹下所有日志') : ''}
          {intl.get('，删除后不可恢复')}
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}logs`, {
            data: {
              filename: currentNode.title,
              path: currentNode.parent || '',
              type: currentNode.type,
            },
          })
          .then(({ code }) => {
            if (code === 200) {
              message.success(intl.get('删除成功'));
              setRevision(n => n + 1);
              initState();
            }
          });
      },
    });
  };

  const initState = () => {
    detailRequest.current?.abort();
    selectedKey.current = '';
    setSelect('');
    setCurrentNode(null);
    setValue(intl.get('请选择日志文件'));
  };

  return (
    <PageContainer
      className="ql-container-wrapper log-wrapper"
      title={
        <>
          {currentNode?.type === 'file' ? <span title={select}>{readableLogName(currentNode.title)}</span> : select}
          {currentNode?.type === 'file' && readFailed && <Button type="link" onClick={() => getLog(currentNode)}>{intl.get('重试')}</Button>}
          {currentNode?.type === 'file' && (
            <span
              style={{
                marginLeft: 6,
                fontSize: 12,
                color: '#999',
                display: 'inline-block',
                height: 14,
              }}
            >
              {prettyBytes(currentNode.size)}
            </span>
          )}
        </>
      }
      extra={
        isPhone
          ? [
              <FilePicker source="logs" value={select} revision={revision} onSelect={node => onSelect(node.key, node)} />,
            ]
          : [
              <Tooltip title={intl.get('下载')}>
                <Button
                  disabled={!currentNode || currentNode.type === 'directory'}
                  type="primary"
                  onClick={downloadLog}
                  icon={<CloudDownloadOutlined />}
                />
              </Tooltip>,
              <Tooltip title={intl.get('删除')}>
                <Button
                  type="primary"
                  disabled={!currentNode}
                  onClick={deleteFile}
                  icon={<DeleteOutlined />}
                />
              </Tooltip>,
            ]
      }
      header={{
        style: headerStyle,
      }}
    >
      <div className={`${styles['log-container']} log-container`}>
        {!isPhone && (
          /*// @ts-ignore*/
          <SplitPane split="vertical" size={200} maxSize={-100}>
            <div className={styles['left-tree-container']}>
              <FileBrowser source="logs" value={select} revision={revision} onSelect={node => onSelect(node.key, node)} />
            </div>
            <Editor
              language="shell"
              theme={theme}
              value={value}
              options={{
                readOnly: true,
                fontSize: 12,
                minimap: { enabled: false },
                lineNumbersMinChars: 3,
                folding: false,
                glyphMargin: false,
              }}
            />
          </SplitPane>
        )}
        {isPhone && (
          <CodeMirror
            value={value}
            readOnly={true}
            theme={theme.includes('dark') ? 'dark' : 'light'}
            onChange={(value, viewUpdate) => {
              setValue(value);
            }}
          />
        )}
      </div>
    </PageContainer>
  );
};

export default Log;
