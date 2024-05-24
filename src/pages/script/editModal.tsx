import intl from 'react-intl-universal';
import React, {
  useEffect,
  useState,
  useRef,
  useCallback,
  useReducer,
} from 'react';
import { Drawer, Button, Tabs, Badge, Select, TreeSelect } from 'antd';
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
  treeData,
  currentNode,
  content,
  handleCancel,
  visible,
}: {
  treeData?: any;
  content?: string;
  visible: boolean;
  currentNode: any;
  handleCancel: () => void;
}) => {
  const [value, setValue] = useState('');
  const [language, setLanguage] = useState<string>('javascript');
  const [cNode, setCNode] = useState<any>();
  const [selectedKey, setSelectedKey] = useState<string>();
  const [saveModalVisible, setSaveModalVisible] = useState<boolean>(false);
  const [settingModalVisible, setSettingModalVisible] =
    useState<boolean>(false);
  const [log, setLog] = useState('');
  const { theme } = useTheme();
  const editorRef = useRef<any>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [currentPid, setCurrentPid] = useState(null);
  const cancel = () => {
    handleCancel();
  };

  const onSelect = (value: any, node: any) => {
    if (node.key === selectedKey || !value) {
      return;
    }

    if (node.type === 'directory') {
      return;
    }

    const newMode = getEditorMode(value);
    setCNode(node);
    setLanguage(newMode);
    getDetail(node);
    setSelectedKey(node.key);
  };

  const getDetail = (node: any) => {
    request
      .get(
        `${config.apiPrefix}scripts/detail?file=${node.title}&path=${
          node.parent || ''
        }`,
      )
      .then(({ code, data }) => {
        if (code === 200) {
          setValue(data);
        }
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
      ws.unsubscribe('manuallyRunScript', handleMessage);
    };
  }, []);

  useEffect(() => {
    setLog('');
    if (currentNode) {
      setCNode(currentNode);
      setValue(content as string);
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
          <TreeSelect
            treeExpandAction="click"
            style={{ marginRight: 8, width: 300 }}
            value={selectedKey}
            dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
            treeData={treeData}
            placeholder={intl.get('请选择脚本文件')}
            fieldNames={{ value: 'key', label: 'title' }}
            showSearch
            onSelect={onSelect}
            treeLine={{ showLeafIcon: true }}
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
      headerStyle={{ padding: '11px 24px' }}
      onClose={cancel}
      open={visible}
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
            accessibilitySupport: 'off'
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
      <SaveModal
        visible={saveModalVisible}
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
      <SettingModal
        visible={settingModalVisible}
        handleCancel={() => {
          setSettingModalVisible(false);
        }}
      />
    </Drawer>
  );
};

export default EditModal;
