import { FilePicker } from '@/components/fileBrowser';
import intl from 'react-intl-universal';
import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useReducer,
} from 'react';
import { Drawer, Button, Tabs, Badge, Select, Space, Switch } from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import SplitPane from 'react-split-pane';
import Editor from '@monaco-editor/react';
import SaveModal from './saveModal';
import SettingModal from './setting';
import { useTheme } from '@/utils/hooks';
import { getEditorMode, logEnded } from '@/utils';
import WebSocketManager from '@/utils/websocket';
import Ansi from 'ansi-to-react';

const { Option } = Select;

const EditModal = ({
  currentNode,
  content,
  wordWrap,
  onWordWrapChange,
  handleCancel,
}: {
  content?: string;
  currentNode: any;
  wordWrap: boolean;
  onWordWrapChange: (checked: boolean) => void;
  handleCancel: () => void;
}) => {
  const [value, setValue] = useState('');
  const [language, setLanguage] = useState<string>();
  const [cNode, setCNode] = useState<any>();
  const [selectedKey, setSelectedKey] = useState<string>();
  const [saveModalVisible, setSaveModalVisible] = useState<boolean>(false);
  const [settingModalVisible, setSettingModalVisible] =
    useState<boolean>(false);
  const [log, setLog] = useState('');
  const { theme } = useTheme();
  const editorRef = useRef<any>(null);
  const pendingFile = useRef<AbortController>();
  const pickedFile = useRef(false);
  const [fileReady, setFileReady] = useState(false);
  const [isRunning, setIsRunning] = useState(false);
  const [currentPid, setCurrentPid] = useState(null);
  const cancel = () => {
    handleCancel();
  };

  const onSelect = (value: any, node: any) => {
    if (
      (node.key === selectedKey && (fileReady || pendingFile.current)) ||
      !value
    ) {
      return;
    }

    if (node.type === 'directory') {
      return;
    }

    const newMode = getEditorMode(value);
    pickedFile.current = true;
    setCNode(node);
    setLanguage(newMode);
    getDetail(node);
    setSelectedKey(node.key);
  };

  const getDetail = (node: any) => {
    pendingFile.current?.abort();
    const controller = new AbortController();
    pendingFile.current = controller;
    setFileReady(false);
    setValue('');
    request
      .get(`${config.apiPrefix}scripts/detail`, {
        params: { file: node.title, path: node.parent || '' },
        signal: controller.signal,
      })
      .then(({ code, data }) => {
        if (code === 200 && !controller.signal.aborted) {
          setValue(data);
          setFileReady(true);
        }
      })
      .catch(() => {
        /* The HTTP handler reports errors. Selecting the file again retries it. */
      })
      .finally(() => {
        if (pendingFile.current === controller) pendingFile.current = undefined;
      });
  };

  const run = () => {
    setLog('');
    const content = editorRef.current.getValue().replace(/\r\n/g, '\n');
    request
      .put(`${config.apiPrefix}scripts/run`, {
        filename: cNode.title,
        path: cNode.parent || '',
        content,
      })
      .then(({ code, data }) => {
        if (code === 200) {
          setIsRunning(true);
          setCurrentPid(data);
        }
      });
  };

  const stop = () => {
    if (!cNode || !cNode.title || !currentPid) {
      return;
    }
    request
      .put(`${config.apiPrefix}scripts/stop`, {
        filename: cNode.title,
        path: cNode.parent || '',
        pid: currentPid,
      })
      .then(({ code, data }) => {
        if (code === 200) {
          setIsRunning(false);
        }
      });
  };

  const handleMessage = useCallback((payload: any) => {
    let { message: _message } = payload;
    if (logEnded(_message)) {
      setTimeout(() => {
        setIsRunning(false);
      }, 300);
    }

    setLog((p) => `${p}${_message}`);
  }, []);

  useEffect(() => {
    const ws = WebSocketManager.getInstance();
    ws.subscribe('manuallyRunScript', handleMessage);

    return () => {
      pendingFile.current?.abort();
      ws.unsubscribe('manuallyRunScript', handleMessage);
    };
  }, []);

  useEffect(() => {
    setLog('');
    if (currentNode?.type === 'file' && !pickedFile.current) {
      pendingFile.current?.abort();
      setCNode(currentNode);
      if (typeof content === 'string' && content !== intl.get('加载中...')) {
        setFileReady(true);
        setValue(content);
      } else {
        getDetail(currentNode);
      }
      setSelectedKey(currentNode.key);
      const newMode = getEditorMode(currentNode.title);
      setLanguage(newMode);
    }
  }, [content, currentNode]);

  return (
    <Drawer
      className="edit-modal"
      closable={false}
      title={
        <>
          <FilePicker
            source="scripts"
            value={selectedKey}
            onSelect={(node) => onSelect(node.key, node)}
          />
          <Select
            value={language}
            style={{ width: 110, marginRight: 8 }}
            onChange={(e) => {
              setLanguage(e);
            }}
          >
            <Option value="javascript">javascript</Option>
            <Option value="typescript">typescript</Option>
            <Option value="shell">shell</Option>
            <Option value="python">python</Option>
          </Select>
          <Button
            type="primary"
            style={{ marginRight: 8 }}
            onClick={isRunning ? stop : run}
            disabled={!isRunning && !fileReady}
          >
            {isRunning ? intl.get('停止') : intl.get('运行')}
          </Button>
          <Button
            type="primary"
            style={{ marginRight: 8 }}
            onClick={() => {
              setLog('');
            }}
          >
            {intl.get('清空日志')}
          </Button>
          {/* <Button
            type="primary"
            style={{ marginRight: 8 }}
            onClick={() => {
              setSettingModalVisible(true);
            }}
          >
            {intl.get('设置')}
          </Button> */}
          <Button
            type="primary"
            style={{ marginRight: 8 }}
            onClick={() => {
              setSaveModalVisible(true);
            }}
            disabled={!fileReady}
          >
            {intl.get('保存')}
          </Button>
          <Button
            type="primary"
            style={{ marginRight: 8 }}
            onClick={() => {
              stop();
              handleCancel();
            }}
          >
            {intl.get('退出')}
          </Button>
        </>
      }
      width={'100%'}
      extra={
        <Space size={8}>
          <span>{intl.get('自动换行')}</span>
          <Switch
            aria-label={intl.get('自动换行')}
            checked={wordWrap}
            onChange={onWordWrapChange}
          />
        </Space>
      }
      headerStyle={{ padding: '11px 24px' }}
      onClose={cancel}
      open={true}
    >
      {/* @ts-ignore */}
      <SplitPane
        split="vertical"
        minSize={200}
        defaultSize="50%"
        style={{ height: 'calc(100vh - 55px)' }}
        pane2Style={{ overflowY: 'auto' }}
      >
        <Editor
          language={language}
          value={value}
          theme={theme}
          options={{
            fontSize: 12,
            minimap: { enabled: false },
            lineNumbersMinChars: 3,
            glyphMargin: false,
            accessibilitySupport: 'off',
            wordWrap: wordWrap ? 'on' : 'off',
          }}
          onMount={(editor) => {
            editorRef.current = editor;
          }}
        />
        <pre
          style={{
            padding: '0 15px',
          }}
        >
          <Ansi>{log}</Ansi>
        </pre>
      </SplitPane>
      {saveModalVisible && (
        <SaveModal
          handleCancel={() => {
            setSaveModalVisible(false);
          }}
          file={{
            content:
              editorRef.current &&
              editorRef.current.getValue().replace(/\r\n/g, '\n'),
            ...cNode,
          }}
        />
      )}
      {settingModalVisible && (
        <SettingModal
          handleCancel={() => {
            setSettingModalVisible(false);
          }}
        />
      )}
    </Drawer>
  );
};

export default EditModal;
