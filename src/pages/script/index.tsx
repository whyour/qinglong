import IconFont from '@/components/iconfont';
import { FileBrowser, FilePicker } from '@/components/fileBrowser';
import { SharedContext } from '@/layouts';
import { getEditorMode } from '@/utils';
import config from '@/utils/config';
import { request } from '@/utils/http';
import { getCodeMirrorExtensions } from '@/utils/codemirror/language';
import { canPreviewInMonaco } from '@/utils/monaco';
import {
  CloudDownloadOutlined,
  DeleteOutlined,
  EditOutlined,
  EllipsisOutlined,
  HistoryOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-layout';
import { EditorView } from '@codemirror/view';
import Editor from '@monaco-editor/react';
import CodeMirror from '@uiw/react-codemirror';
import { history, useOutletContext } from '@umijs/max';
import {
  Button,
  Dropdown,
  MenuProps,
  message,
  Modal,
  Space,
  Switch,
  Tooltip,
  Typography,
} from 'antd';
import { saveAs } from 'file-saver';
import prettyBytes from 'pretty-bytes';
import { parse } from 'query-string';
import { Key, useCallback, useEffect, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import intl from 'react-intl-universal';
import SplitPane from 'react-split-pane';
import EditModal from './editModal';
import HistoryDrawer from './historyDrawer';
import { saveWithHistory } from './saveWithHistory';
import EditScriptNameModal from './editNameModal';
import styles from './index.module.less';
import RenameModal from './renameModal';
import UnsupportedFilePreview from './components/UnsupportedFilePreview';
const { Text } = Typography;

const Script = () => {
  const { headerStyle, isPhone, theme } = useOutletContext<SharedContext>();
  const [value, setValue] = useState(intl.get('请选择脚本文件'));
  const [select, setSelect] = useState<string>(intl.get('请选择脚本文件'));
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState('');
  const [directory, setDirectory] = useState('');
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const editorRef = useRef<any>(null);
  const [isAddFileModalVisible, setIsAddFileModalVisible] = useState(false);
  const [isRenameFileModalVisible, setIsRenameFileModalVisible] =
    useState(false);
  const [currentNode, setCurrentNode] = useState<any>();
  const [showMonaco, setShowMonaco] = useState(true);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [wordWrap, setWordWrap] = useState(
    () =>
      (localStorage.getItem('qinglong_editor_word_wrap') ??
        localStorage.getItem('qinglong_config_word_wrap')) === 'true',
  );
  const savingRef = useRef(false);
  const savedContentRef = useRef('');
  const currentKeyRef = useRef(currentNode?.key);
  const detailRequest = useRef<AbortController>();
  const [readState, setReadState] = useState<'loading' | 'ready' | 'failed'>('loading');
  useEffect(() => () => detailRequest.current?.abort(), []);
  currentKeyRef.current = currentNode?.key;

  useEffect(() => {
    setHistoryVisible(false);
  }, [currentNode?.key]);

  const hasUnsavedChanges = () => {
    const content =
      !isPhone && editorRef.current ? editorRef.current.getValue() : value;
    return (
      isEditing && readState === 'ready' &&
      content.replace(/\r\n/g, '\n') !==
        savedContentRef.current.replace(/\r\n/g, '\n')
    );
  };

  const handleIsEditing = (filename: string, value: boolean) => {
    setIsEditing(value && canPreviewInMonaco(filename));
  };

  const getDetail = (node: any, options: any = {}) => {
    detailRequest.current?.abort();
    const controller = new AbortController();
    detailRequest.current = controller;
    setReadState('loading');
    request
      .get(
        `${config.apiPrefix}scripts/detail?file=${encodeURIComponent(
          node.title,
        )}&path=${encodeURIComponent(node.parent || '')}`, { signal: controller.signal, retryInPlace: true },
      )
      .then(({ code, data }) => {
        if (controller.signal.aborted || currentKeyRef.current !== node.key) return;
        if (code === 200) {
          setReadState('ready');
          savedContentRef.current = data;
          setValue(data);
          if (options.callback) {
            options.callback();
          }
        } else setReadState('failed');
      }).catch(() => { if (!controller.signal.aborted) setReadState('failed'); });
  };

  const downloadScript = () => {
    request
      .post<Blob>(
        `${config.apiPrefix}scripts/download`,
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
    setReadState('loading');
    currentKeyRef.current = node.key;
    setSelect(node.key);
    setCurrentNode(node);

    if (node.type === 'directory') {
      setValue(intl.get('请选择脚本文件'));
      setShowMonaco(true);
      return;
    }

    if (!canPreviewInMonaco(node.title)) {
      setShowMonaco(false);
      return;
    }

    setShowMonaco(true);
    const newMode = getEditorMode(value);
    setMode(isPhone && newMode === 'typescript' ? 'javascript' : newMode);
    setValue(intl.get('加载中...'));

    getDetail(node);
  };

  const onTreeSelect = useCallback(
    (keys: Key[], e: any) => {
      const node = e.node;
      if (node.key === select && isEditing) {
        return;
      }

      const currentContent = editorRef.current
        ? editorRef.current.getValue().replace(/\r\n/g, '\n')
        : value;
      const originalContent = savedContentRef.current.replace(/\r\n/g, '\n');

      if (currentContent !== originalContent && isEditing && readState === 'ready') {
        Modal.confirm({
          title: intl.get('确认离开'),
          content: <>{intl.get('当前文件未保存，确认离开吗')}</>,
          onOk() {
            onSelect(keys[0], e.node);
            handleIsEditing(e.node.title, false);
          },
        });
      } else {
        handleIsEditing(e.node.title, false);
        onSelect(keys[0], e.node);
      }
    },
    [value, select, isEditing, readState],
  );

  const onDoubleClick = (e: any, node: any) => {
    if (node.type === 'file' && node.key === currentKeyRef.current) {
      handleIsEditing(node.title, true);
    }
  };

  const editFile = () => {
    handleIsEditing(currentNode.title, true);
  };

  const cancelEdit = () => {
    handleIsEditing(currentNode.title, false);
    setValue(intl.get('加载中...'));
    getDetail(currentNode);
  };

  const saveFile = async () => {
    if (savingRef.current || !currentNode || readState !== 'ready') return;
    const node = currentNode;
    const selection = detailRequest.current;
    const content =
      !isPhone && editorRef.current
        ? editorRef.current.getValue().replace(/\r\n/g, '\n')
        : value;
    savingRef.current = true;
    setSaving(true);
    try {
      const result = await saveWithHistory(
        'put',
        `${config.apiPrefix}scripts`,
        {
          filename: node.title,
          path: node.parent || '',
          content,
        },
      );
      if (result?.code === 200 && currentKeyRef.current === node.key && selection === detailRequest.current && !selection?.signal.aborted) {
        savedContentRef.current = content;
        setValue(content);
        handleIsEditing(node.title, false);
      }
    } catch {
      // The shared HTTP handler presents the server's error; keep the draft.
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
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
          {currentNode.type === 'directory' ? intl.get('夹及其子文件') : ''}
          {intl.get('，删除后不可恢复')}
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}scripts`, {
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

  const renameFile = () => {
    setIsRenameFileModalVisible(true);
  };

  const handleRenameFileCancel = () => {
    setIsRenameFileModalVisible(false);
    setRevision(n => n + 1);
    initState();
  };

  const addFile = () => {
    setIsAddFileModalVisible(true);
  };

  const addFileModalClose = async (
    {
      filename,
      path,
      key,
      type,
    }: { filename: string; path: string; key: string; type?: string } = {
      filename: '',
      path: '',
      key: '',
    },
  ) => {
    if (filename) {
      const parts = key.split('/');
      const item = { key, title: parts.pop()!, parent: parts.join('/'), type };
      setDirectory(item.parent);
      setRevision(n => n + 1);
      onSelect(key, item);
      handleIsEditing(item.title, true);
    }
    setIsAddFileModalVisible(false);
  };

  const initState = () => {
    detailRequest.current?.abort();
    setSelect(intl.get('请选择脚本文件'));
    setCurrentNode(null);
    setValue(intl.get('请选择脚本文件'));
  };

  useEffect(() => {
    const { p, s } = parse(history.location.search);
    if (typeof s === 'string' && s) {
      const parent = typeof p === 'string' ? p : '';
      const key = parent ? parent + '/' + s : s;
      setDirectory(parent);
      onSelect(key, { key, parent, title: s, type: 'file' });
    }
  }, []);

  useHotkeys(
    'mod+s',
    (e) => {
      if (isEditing) {
        saveFile();
      }
    },
    { enableOnFormTags: ['textarea'], preventDefault: true },
  );

  useHotkeys(
    'mod+d',
    (e) => {
      if (currentNode.title) {
        deleteFile();
      }
    },
    { preventDefault: true },
  );

  useHotkeys(
    'mod+o',
    (e) => {
      if (!isEditing) {
        addFile();
      }
    },
    { preventDefault: true },
  );

  useHotkeys(
    'mod+e',
    (e) => {
      if (currentNode.title) {
        cancelEdit();
      }
    },
    { preventDefault: true },
  );

  const action = (key: string | number) => {
    switch (key) {
      case 'save':
        saveFile();
        break;
      case 'exit':
        cancelEdit();
        break;
      default:
        break;
    }
  };

  const menuAction = (key: string | number) => {
    switch (key) {
      case 'add':
        addFile();
        break;
      case 'edit':
        editFile();
        break;
      case 'delete':
        deleteFile();
        break;
      case 'rename':
        renameFile();
        break;
      default:
        break;
    }
  };

  const menu: MenuProps = isEditing
    ? {
        items: [
          { label: intl.get('保存'), key: 'save', icon: <PlusOutlined /> },
          { label: intl.get('退出编辑'), key: 'exit', icon: <EditOutlined /> },
        ],
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          action(key);
        },
      }
    : {
        items: [
          { label: intl.get('创建'), key: 'add', icon: <PlusOutlined /> },
          {
            label: intl.get('编辑'),
            key: 'edit',
            icon: <EditOutlined />,
            disabled: !currentNode,
          },
          {
            label: intl.get('重命名'),
            key: 'rename',
            icon: <IconFont type="ql-icon-rename" />,
            disabled: !currentNode,
          },
          {
            label: intl.get('删除'),
            key: 'delete',
            icon: <DeleteOutlined />,
            disabled: !currentNode,
          },
        ],
        onClick: ({ key, domEvent }) => {
          domEvent.stopPropagation();
          menuAction(key);
        },
      };

  const handleForceOpen = () => {
    if (!currentNode) return;

    setMode('plaintext');
    setValue(intl.get('加载中...'));
    setShowMonaco(true);

    getDetail(currentNode, {
      callback: () => {
        setIsEditing(true);
      },
    });
  };

  const changeWordWrap = (checked: boolean) => {
    setWordWrap(checked);
    localStorage.setItem('qinglong_editor_word_wrap', String(checked));
  };

  return (
    <PageContainer
      className="ql-container-wrapper log-wrapper"
      title={
        <>
          {select}
          {currentNode && readState === 'failed' && <Button type="link" onClick={() => getDetail(currentNode)}>{intl.get('重试')}</Button>}
          {currentNode?.size != null && (
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
      extra={[
        <Space key="word-wrap" size={8} className="editor-wrap-setting">
          <span className="editor-wrap-label">{intl.get('自动换行')}</span>
          <Switch
            aria-label={intl.get('自动换行')}
            checked={wordWrap}
            onChange={changeWordWrap}
          />
        </Space>,
        ...(currentNode?.type === 'file' && showMonaco
          ? [
              <Button
                key="history"
                icon={<HistoryOutlined />}
                disabled={saving}
                onClick={() => setHistoryVisible(true)}
              >
                {!isPhone && intl.get('历史版本')}
              </Button>,
            ]
          : []),
        ...(isPhone
          ? [
              <FilePicker source="scripts" value={select} revision={revision} initialDirectory={directory} onSelect={node => onTreeSelect([node.key], { node })} />,
              <Dropdown menu={menu} trigger={['click']}>
                <Button type="primary" icon={<EllipsisOutlined />} />
              </Dropdown>,
            ]
          : isEditing
          ? [
              <Button type="primary" onClick={saveFile} loading={saving} disabled={readState !== 'ready'}>
                {intl.get('保存')}
              </Button>,
              <Button type="primary" onClick={cancelEdit}>
                {intl.get('退出编辑')}
              </Button>,
            ]
          : [
              <Tooltip title={intl.get('创建')}>
                <Button
                  type="primary"
                  onClick={addFile}
                  icon={<PlusOutlined />}
                />
              </Tooltip>,
              <Tooltip title={intl.get('编辑')}>
                <Button
                  disabled={!currentNode}
                  type="primary"
                  onClick={editFile}
                  icon={<EditOutlined />}
                />
              </Tooltip>,
              <Tooltip title={intl.get('重命名')}>
                <Button
                  disabled={!currentNode}
                  type="primary"
                  onClick={renameFile}
                  icon={<IconFont type="ql-icon-rename" />}
                />
              </Tooltip>,
              <Tooltip title={intl.get('下载')}>
                <Button
                  disabled={!currentNode || currentNode.type === 'directory'}
                  type="primary"
                  onClick={downloadScript}
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
              <Button
                type="primary"
                onClick={() => {
                  setIsLogModalVisible(true);
                }}
              >
                {intl.get('调试')}
              </Button>,
            ]),
      ]}
      header={{
        style: headerStyle,
      }}
    >
      {historyVisible && currentNode && (
        <HistoryDrawer
          key={currentNode.key}
          filename={currentNode.title}
          directory={currentNode.parent || ''}
          isPhone={isPhone}
          theme={theme}
          language={mode}
          hasUnsavedChanges={hasUnsavedChanges}
          onClose={() => setHistoryVisible(false)}
          onRestored={(content) => {
            detailRequest.current?.abort();
            detailRequest.current = undefined;
            setReadState('ready');
            savedContentRef.current = content;
            setValue(content);
            setIsEditing(false);
          }}
        />
      )}
      <div className={`${styles['log-container']} log-container`}>
        {!isPhone && (
          /*// @ts-ignore*/
          <SplitPane split="vertical" size={200} maxSize={-100}>
            <div className={styles['left-tree-container']}>
              <FileBrowser source="scripts" value={select} revision={revision} initialDirectory={directory} onSelect={node => onTreeSelect([node.key], { node })} onDoubleClick={node => onDoubleClick(null, node)} />
            </div>
            {showMonaco ? (
              <Editor
                language={mode}
                value={value}
                theme={theme}
                options={{
                  readOnly: !isEditing || saving || readState !== 'ready',
                  fontSize: 12,
                  lineNumbersMinChars: 3,
                  glyphMargin: false,
                  accessibilitySupport: 'off',
                  wordWrap: wordWrap ? 'on' : 'off',
                }}
                onMount={(editor) => {
                  editorRef.current = editor;
                }}
              />
            ) : (
              <UnsupportedFilePreview onForceOpen={handleForceOpen} />
            )}
          </SplitPane>
        )}
        {isPhone && (
          <CodeMirror
            value={value}
            extensions={[
              ...getCodeMirrorExtensions(mode),
              ...(wordWrap ? [EditorView.lineWrapping] : []),
            ]}
            theme={theme.includes('dark') ? 'dark' : 'light'}
            readOnly={!isEditing || saving || readState !== 'ready'}
            onChange={(value) => {
              setValue(value);
            }}
          />
        )}
        {isLogModalVisible && isLogModalVisible && (
          <EditModal
            currentNode={currentNode}
            content={value}
            wordWrap={wordWrap}
            onWordWrapChange={changeWordWrap}
            handleCancel={() => {
              setIsLogModalVisible(false);
            }}
          />
        )}
        {isAddFileModalVisible && (
          <EditScriptNameModal
            handleCancel={addFileModalClose}
          />
        )}
        {isRenameFileModalVisible && (
          <RenameModal
            handleCancel={handleRenameFileCancel}
            currentNode={currentNode}
          />
        )}
      </div>
    </PageContainer>
  );
};

export default Script;
