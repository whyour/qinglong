import { useState, useEffect, useCallback, Key, useRef } from 'react';
import {
  TreeSelect,
  Tree,
  Input,
  Button,
  Modal,
  message,
  Typography,
} from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import Editor from '@monaco-editor/react';
import { request } from '@/utils/http';
import styles from './index.module.less';
import EditModal from './editModal';
import { Controlled as CodeMirror } from 'react-codemirror2';
import { useCtx, useTheme } from '@/utils/hooks';
import SplitPane from 'react-split-pane';

const { Text } = Typography;

function getFilterData(keyword: string, data: any) {
  if (keyword) {
    const tree: any = [];
    data.forEach((item: any) => {
      if (item.title.toLocaleLowerCase().includes(keyword)) {
        tree.push(item);
      }
    });
    return { tree };
  }
  return { tree: data };
}

const LangMap: any = {
  '.py': 'python',
  '.js': 'javascript',
  '.sh': 'shell',
  '.ts': 'typescript',
};

const Script = () => {
  const [title, setTitle] = useState('请选择脚本文件');
  const [value, setValue] = useState('请选择脚本文件');
  const [select, setSelect] = useState<string>();
  const [data, setData] = useState<any[]>([]);
  const [filterData, setFilterData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('');
  const [height, setHeight] = useState<number>();
  const treeDom = useRef<any>();
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const { headerStyle, isPhone } = useCtx();
  const { theme } = useTheme();
  const [searchValue, setSearchValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const editorRef = useRef<any>(null);

  const getScripts = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}scripts/files`)
      .then((data) => {
        setData(data.data);
        setFilterData(data.data);
      })
      .finally(() => setLoading(false));
  };

  const getDetail = (node: any) => {
    request.get(`${config.apiPrefix}scripts/${node.value}`).then((data) => {
      setValue(data.data);
    });
  };

  const onSelect = (value: any, node: any) => {
    const newMode = LangMap[value.slice(-3)] || '';
    setMode(isPhone && newMode === 'typescript' ? 'javascript' : newMode);
    setSelect(value);
    setTitle(node.parent || node.value);
    getDetail(node);
  };

  const onTreeSelect = useCallback((keys: Key[], e: any) => {
    onSelect(keys[0], e.node);
  }, []);

  const onSearch = useCallback(
    (e) => {
      const keyword = e.target.value;
      setSearchValue(keyword);
      const { tree } = getFilterData(keyword.toLocaleLowerCase(), data);
      setFilterData(tree);
    },
    [data, setFilterData],
  );

  const editFile = () => {
    setIsEditing(true);
  };

  const saveFile = () => {
    Modal.confirm({
      title: `确认保存`,
      content: (
        <>
          确认保存文件
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {select}
          </Text>{' '}
          ，保存后不可恢复
        </>
      ),
      onOk() {
        const content = editorRef.current
          ? editorRef.current.getValue().replace(/\r\n/g, '\n')
          : value;
        request
          .put(`${config.apiPrefix}scripts`, {
            data: {
              filename: select,
              content,
            },
          })
          .then((_data: any) => {
            if (_data.code === 200) {
              message.success(`保存成功`);
            } else {
              message.error(_data);
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const deleteFile = () => {
    Modal.confirm({
      title: `确认删除`,
      content: (
        <>
          确认删除文件
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {select}
          </Text>{' '}
          ，删除后不可恢复
        </>
      ),
      onOk() {
        request
          .delete(`${config.apiPrefix}scripts`, {
            data: {
              filename: select,
            },
          })
          .then((_data: any) => {
            if (_data.code === 200) {
              message.success(`删除成功`);
              let newData = [...data];
              const index = newData.findIndex((x) => x.value === select);
              newData.splice(index, 1);
              setData(newData);
            } else {
              message.error(_data);
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  useEffect(() => {
    const word = searchValue || '';
    const { tree } = getFilterData(word.toLocaleLowerCase(), data);
    console.log(word);
    console.log(tree);
    setFilterData(tree);
    setSelect('');
    setTitle('请选择脚本文件');
    setValue('请选择脚本文件');
  }, [data]);

  useEffect(() => {
    getScripts();
    setHeight(treeDom.current.clientHeight);
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper log-wrapper"
      title={title}
      loading={loading}
      extra={
        isPhone
          ? [
              <TreeSelect
                className="log-select"
                value={select}
                dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
                treeData={data}
                placeholder="请选择脚本文件"
                showSearch
                key="value"
                onSelect={onSelect}
              />,
              <Button type="primary" onClick={deleteFile}>
                删除
              </Button>,
            ]
          : isEditing
          ? [
              <Button type="primary" onClick={saveFile}>
                保存
              </Button>,
            ]
          : [
              <Button type="primary" onClick={editFile}>
                编辑
              </Button>,
              <Button type="primary" onClick={deleteFile}>
                删除
              </Button>,
              <Button
                type="primary"
                onClick={() => {
                  setIsLogModalVisible(true);
                }}
              >
                调试
              </Button>,
            ]
      }
      header={{
        style: headerStyle,
      }}
    >
      <div className={`${styles['log-container']} log-container`}>
        {!isPhone && (
          <SplitPane split="vertical" size={200} maxSize={-100}>
            <div className={styles['left-tree-container']}>
              <Input.Search
                className={styles['left-tree-search']}
                onChange={onSearch}
              ></Input.Search>
              <div className={styles['left-tree-scroller']} ref={treeDom}>
                <Tree
                  className={styles['left-tree']}
                  treeData={filterData}
                  showIcon={true}
                  height={height}
                  showLine={{ showLeafIcon: true }}
                  onSelect={onTreeSelect}
                ></Tree>
              </div>
            </div>
            <Editor
              language={mode}
              value={value}
              theme={theme}
              options={{
                readOnly: !isEditing,
                fontSize: 12,
                lineNumbersMinChars: 3,
                folding: false,
                glyphMargin: false,
              }}
              onMount={(editor) => {
                editorRef.current = editor;
              }}
            />
          </SplitPane>
        )}
        {isPhone && (
          <CodeMirror
            value={value}
            options={{
              lineNumbers: true,
              lineWrapping: true,
              styleActiveLine: true,
              matchBrackets: true,
              mode,
              readOnly: true,
            }}
            onBeforeChange={(editor, data, value) => {
              setValue(value);
            }}
            onChange={(editor, data, value) => {}}
          />
        )}
        <EditModal
          visible={isLogModalVisible}
          treeData={data}
          currentFile={select}
          content={value}
          handleCancel={() => {
            setIsLogModalVisible(false);
          }}
        />
      </div>
    </PageContainer>
  );
};

export default Script;
