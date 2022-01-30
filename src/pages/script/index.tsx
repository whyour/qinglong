import { useState, useEffect, useCallback, Key, useRef } from 'react';
import {
  TreeSelect,
  Tree,
  Input,
  Button,
  Modal,
  message,
  Typography,
  Tooltip,
  Dropdown,
  Menu,
  Empty,
} from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import Editor from '@monaco-editor/react';
import { request } from '@/utils/http';
import styles from './index.module.less';
import EditModal from './editModal';
import { Controlled as CodeMirror } from 'react-codemirror2';
import SplitPane from 'react-split-pane';
import {
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
  EllipsisOutlined,
  FormOutlined,
  PlusOutlined,
  PlusSquareOutlined,
  SearchOutlined,
  UserOutlined,
} from '@ant-design/icons';
import EditScriptNameModal from './editNameModal';
import debounce from 'lodash/debounce';
import { history } from 'umi';

const { Text } = Typography;

function getFilterData(keyword: string, data: any) {
  const expandedKeys: string[] = [];
  if (keyword) {
    const tree: any = [];
    data.forEach((item: any) => {
      if (item.title.toLocaleLowerCase().includes(keyword)) {
        tree.push(item);
      } else {
        const children: any[] = [];
        (item.children || []).forEach((subItem: any) => {
          if (subItem.title.toLocaleLowerCase().includes(keyword)) {
            children.push(subItem);
          }
        });
        if (children.length > 0) {
          tree.push({
            ...item,
            children,
          });
          expandedKeys.push(item.key);
        }
      }
    });
    return { tree, expandedKeys };
  }
  return { tree: data, expandedKeys };
}

const LangMap: any = {
  '.py': 'python',
  '.js': 'javascript',
  '.sh': 'shell',
  '.ts': 'typescript',
};

const Script = ({ headerStyle, isPhone, theme, socketMessage }: any) => {
  const [title, setTitle] = useState('请选择脚本文件');
  const [value, setValue] = useState('请选择脚本文件');
  const [select, setSelect] = useState<any>();
  const [data, setData] = useState<any[]>([]);
  const [filterData, setFilterData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('');
  const [height, setHeight] = useState<number>();
  const treeDom = useRef<any>();
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [searchValue, setSearchValue] = useState('');
  const [isEditing, setIsEditing] = useState(false);
  const editorRef = useRef<any>(null);
  const [isAddFileModalVisible, setIsAddFileModalVisible] = useState(false);
  const [currentNode, setCurrentNode] = useState<any>();
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

  const getScripts = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}scripts/files`)
      .then((data) => {
        setData(data.data);
        setFilterData(data.data);
        initGetScript();
      })
      .finally(() => setLoading(false));
  };

  const getDetail = (node: any) => {
    request
      .get(`${config.apiPrefix}scripts/${node.value}?path=${node.parent || ''}`)
      .then((data) => {
        setValue(data.data);
      });
  };

  const initGetScript = () => {
    const { p, s } = history.location.query as any;
    if (s) {
      const vkey = `${p}/${s}`;
      const obj = {
        node: {
          title: s,
          value: s,
          key: p ? vkey : s,
          parent: p,
        },
      };
      setExpandedKeys([p]);
      onTreeSelect([vkey], obj);
    }
  };

  const onSelect = (value: any, node: any) => {
    if (node.key === select || !value) {
      return;
    }
    setValue('加载中...');
    const newMode = value ? LangMap[value.slice(-3)] : '';
    setMode(isPhone && newMode === 'typescript' ? 'javascript' : newMode);
    setSelect(node.key);
    setTitle(node.parent || node.value);
    setCurrentNode(node);
    getDetail(node);
  };

  const onExpand = (expKeys: any) => {
    setExpandedKeys(expKeys);
  };

  const onTreeSelect = useCallback(
    (keys: Key[], e: any) => {
      const content = editorRef.current
        ? editorRef.current.getValue().replace(/\r\n/g, '\n')
        : value;
      if (content !== value) {
        Modal.confirm({
          title: `确认离开`,
          content: <>当前修改未保存，确定离开吗</>,
          onOk() {
            onSelect(keys[0], e.node);
            setIsEditing(false);
          },
          onCancel() {
            console.log('Cancel');
          },
        });
      } else {
        setIsEditing(false);
        onSelect(keys[0], e.node);
      }
    },
    [value],
  );

  const onSearch = useCallback(
    (e) => {
      const keyword = e.target.value;
      debounceSearch(keyword);
    },
    [data, setFilterData],
  );

  const debounceSearch = useCallback(
    debounce((keyword) => {
      setSearchValue(keyword);
      const { tree, expandedKeys } = getFilterData(
        keyword.toLocaleLowerCase(),
        data,
      );
      setExpandedKeys(expandedKeys);
      setFilterData(tree);
    }, 300),
    [data, setFilterData],
  );

  const editFile = () => {
    setTimeout(() => {
      setIsEditing(true);
    }, 300);
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setValue('加载中...');
    getDetail(currentNode);
  };

  const saveFile = () => {
    Modal.confirm({
      title: `确认保存`,
      content: (
        <>
          确认保存文件
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {currentNode.value}
          </Text>{' '}
          ，保存后不可恢复
        </>
      ),
      onOk() {
        const content = editorRef.current
          ? editorRef.current.getValue().replace(/\r\n/g, '\n')
          : value;
        return new Promise((resolve, reject) => {
          request
            .put(`${config.apiPrefix}scripts`, {
              data: {
                filename: currentNode.value,
                path: currentNode.parent || '',
                content,
              },
            })
            .then((_data: any) => {
              if (_data.code === 200) {
                message.success(`保存成功`);
                setValue(content);
                setIsEditing(false);
              } else {
                message.error(_data);
              }
              resolve(null);
            })
            .catch((e) => reject(e));
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
              filename: currentNode.value,
              path: currentNode.parent || '',
            },
          })
          .then((_data: any) => {
            if (_data.code === 200) {
              message.success(`删除成功`);
              let newData = [...data];
              if (currentNode.parent) {
                const parentNodeIndex = newData.findIndex(
                  (x) => x.key === currentNode.parent,
                );
                const parentNode = newData[parentNodeIndex];
                const index = parentNode.children.findIndex(
                  (y) => y.key === currentNode.key,
                );
                parentNode.children.splice(index, 1);
                newData.splice(parentNodeIndex, 1, { ...parentNode });
              } else {
                const index = newData.findIndex(
                  (x) => x.key === currentNode.key,
                );
                newData.splice(index, 1);
              }
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

  const addFile = () => {
    setIsAddFileModalVisible(true);
  };

  const addFileModalClose = (
    { filename, path, key }: { filename: string; path: string; key: string } = {
      filename: '',
      path: '',
      key: '',
    },
  ) => {
    if (filename) {
      const newData = [...data];
      const _file = { title: filename, key, value: filename, parent: path };
      if (path) {
        const parentNodeIndex = newData.findIndex((x) => x.key === path);
        const parentNode = newData[parentNodeIndex];
        if (parentNode.children && parentNode.children.length > 0) {
          parentNode.children.unshift(_file);
        } else {
          parentNode.children = [_file];
        }
        newData.splice(parentNodeIndex, 1, { ...parentNode });
      } else {
        newData.unshift(_file);
      }
      setData(newData);
      onSelect(_file.value, _file);
      setIsEditing(true);
    }
    setIsAddFileModalVisible(false);
  };

  const downloadFile = () => {
    request
      .post(`${config.apiPrefix}scripts/download`, {
        data: {
          filename: currentNode.value,
        },
      })
      .then((_data: any) => {
        const blob = new Blob([_data], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = currentNode.value;
        document.documentElement.appendChild(a);
        a.click();
        document.documentElement.removeChild(a);
      });
  };

  useEffect(() => {
    const word = searchValue || '';
    const { tree } = getFilterData(word.toLocaleLowerCase(), data);
    setFilterData(tree);
    setSelect('');
    setCurrentNode(null);
    setTitle('请选择脚本文件');
    setValue('请选择脚本文件');
  }, [data]);

  useEffect(() => {
    getScripts();
    if (treeDom && treeDom.current) {
      setHeight(treeDom.current.clientHeight);
    }
  }, []);

  const menu = isEditing ? (
    <Menu>
      <Menu.Item key="save" icon={<PlusOutlined />} onClick={saveFile}>
        保存
      </Menu.Item>
      <Menu.Item key="exit" icon={<EditOutlined />} onClick={cancelEdit}>
        退出编辑
      </Menu.Item>
    </Menu>
  ) : (
    <Menu>
      <Menu.Item key="add" icon={<PlusOutlined />} onClick={addFile}>
        新建
      </Menu.Item>
      <Menu.Item
        key="edit"
        icon={<EditOutlined />}
        onClick={editFile}
        disabled={!select}
      >
        编辑
      </Menu.Item>
      <Menu.Item
        key="delete"
        icon={<DeleteOutlined />}
        onClick={deleteFile}
        disabled={!select}
      >
        删除
      </Menu.Item>
    </Menu>
  );

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
                placeholder="请选择脚本"
                showSearch
                onSelect={onSelect}
              />,
              <Dropdown overlay={menu} trigger={['click']}>
                <Button type="primary" icon={<EllipsisOutlined />} />
              </Dropdown>,
            ]
          : isEditing
          ? [
              <Button type="primary" onClick={saveFile}>
                保存
              </Button>,
              <Button type="primary" onClick={cancelEdit}>
                退出编辑
              </Button>,
            ]
          : [
              <Tooltip title="新建">
                <Button
                  type="primary"
                  onClick={addFile}
                  icon={<PlusOutlined />}
                />
              </Tooltip>,
              <Tooltip title="编辑">
                <Button
                  disabled={!select}
                  type="primary"
                  onClick={editFile}
                  icon={<EditOutlined />}
                />
              </Tooltip>,
              <Tooltip title="删除">
                <Button
                  type="primary"
                  disabled={!select}
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
              {data.length > 0 ? (
                <>
                  <Input.Search
                    className={styles['left-tree-search']}
                    onChange={onSearch}
                    placeholder="请输入脚本名"
                    allowClear
                  ></Input.Search>
                  <div className={styles['left-tree-scroller']} ref={treeDom}>
                    <Tree
                      className={styles['left-tree']}
                      treeData={filterData}
                      showIcon={true}
                      height={height}
                      selectedKeys={[select]}
                      expandedKeys={expandedKeys}
                      onExpand={onExpand}
                      showLine={{ showLeafIcon: true }}
                      onSelect={onTreeSelect}
                    ></Tree>
                  </div>
                </>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'center',
                    alignItems: 'center',
                    height: '100%',
                  }}
                >
                  <Empty
                    description="暂无脚本"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                </div>
              )}
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
              readOnly: !isEditing,
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
          currentNode={currentNode}
          content={value}
          socketMessage={socketMessage}
          handleCancel={() => {
            setIsLogModalVisible(false);
          }}
        />
        <EditScriptNameModal
          visible={isAddFileModalVisible}
          treeData={data}
          handleCancel={addFileModalClose}
        />
      </div>
    </PageContainer>
  );
};

export default Script;
