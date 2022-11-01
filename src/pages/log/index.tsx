import { useState, useEffect, useCallback, Key, useRef } from 'react';
import {
  TreeSelect,
  Tree,
  Input,
  Empty,
  Button,
  message,
  Modal,
  Tooltip,
  Typography,
} from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import Editor from '@monaco-editor/react';
import { request } from '@/utils/http';
import styles from './index.module.less';
import { Controlled as CodeMirror } from 'react-codemirror2';
import SplitPane from 'react-split-pane';
import { useOutletContext } from '@umijs/max';
import { SharedContext } from '@/layouts';
import { DeleteOutlined } from '@ant-design/icons';
import { depthFirstSearch } from '@/utils';
import debounce from 'lodash/groupBy';
import uniq from 'lodash/uniq';
import useFilterTreeData from '@/hooks/useFilterTreeData';

const { Text } = Typography;

const Log = () => {
  const { headerStyle, isPhone, theme } = useOutletContext<SharedContext>();
  const [value, setValue] = useState('请选择日志文件');
  const [select, setSelect] = useState<string>('');
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [height, setHeight] = useState<number>();
  const treeDom = useRef<any>();
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [currentNode, setCurrentNode] = useState<any>();
  const [searchValue, setSearchValue] = useState('');

  const getLogs = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}logs`)
      .then(({ code, data }) => {
        if (code === 200) {
          setData(data);
        }
      })
      .finally(() => setLoading(false));
  };

  const getLog = (node: any) => {
    request
      .get(`${config.apiPrefix}logs/${node.title}?path=${node.parent || ''}`)
      .then(({ code, data }) => {
        if (code === 200) {
          setValue(data);
        }
      });
  };

  const onSelect = (value: any, node: any) => {
    setCurrentNode(node);
    setSelect(value);

    if (node.key === select || !value) {
      return;
    }

    if (node.type === 'directory') {
      setValue('请选择日志文件');
      return;
    }

    setValue('加载中...');
    getLog(node);
  };

  const onTreeSelect = useCallback((keys: Key[], e: any) => {
    onSelect(keys[0], e.node);
  }, []);

  const onSearch = useCallback(
    (e) => {
      const keyword = e.target.value;
      debounceSearch(keyword);
    },
    [data],
  );

  const debounceSearch = useCallback(
    debounce((keyword) => {
      setSearchValue(keyword);
    }, 300),
    [data],
  );

  const { treeData: filterData, keys: searchExpandedKeys } = useFilterTreeData(
    data,
    searchValue,
    { treeNodeFilterProp: 'title' },
  );

  useEffect(() => {
    setExpandedKeys(uniq([...expandedKeys, ...searchExpandedKeys]));
  }, [searchExpandedKeys]);

  const deleteFile = () => {
    Modal.confirm({
      title: `确认删除`,
      content: (
        <>
          确认删除
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {select}
          </Text>
          文件{currentNode.type === 'directory' ? '夹下所以日志' : ''}
          ，删除后不可恢复
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
              message.success(`删除成功`);
              let newData = [...data];
              if (currentNode.parent) {
                newData = depthFirstSearch(
                  newData,
                  (c) => c.key === currentNode.key,
                );
              } else {
                const index = newData.findIndex(
                  (x) => x.key === currentNode.key,
                );
                if (index !== -1) {
                  newData.splice(index, 1);
                }
              }
              setData(newData);
              initState();
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const initState = () => {
    setSelect('');
    setCurrentNode(null);
    setValue('请选择脚本文件');
  };

  const onExpand = (expKeys: any) => {
    setExpandedKeys(expKeys);
  };

  useEffect(() => {
    getLogs();
  }, []);

  useEffect(() => {
    if (treeDom.current) {
      setHeight(treeDom.current.clientHeight);
    }
  }, [treeDom.current, data]);

  return (
    <PageContainer
      className="ql-container-wrapper log-wrapper"
      title={select}
      loading={loading}
      extra={
        isPhone
          ? [
              <TreeSelect
                treeExpandAction="click"
                className="log-select"
                value={select}
                dropdownStyle={{ maxHeight: 400, overflow: 'auto' }}
                treeData={data}
                placeholder="请选择日志"
                fieldNames={{ value: 'key' }}
                treeNodeFilterProp="title"
                showSearch
                allowClear
                onSelect={onSelect}
              />,
            ]
          : [
              <Tooltip title="删除">
                <Button
                  type="primary"
                  disabled={!select}
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
              {data.length > 0 ? (
                <>
                  <Input.Search
                    className={styles['left-tree-search']}
                    onChange={onSearch}
                    placeholder="请输入日志名"
                    allowClear
                  ></Input.Search>
                  <div className={styles['left-tree-scroller']} ref={treeDom}>
                    <Tree
                      expandAction="click"
                      className={styles['left-tree']}
                      treeData={filterData}
                      showIcon={true}
                      height={height}
                      selectedKeys={[select]}
                      showLine={{ showLeafIcon: true }}
                      onSelect={onTreeSelect}
                      expandedKeys={expandedKeys}
                      onExpand={onExpand}
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
                    description="暂无日志"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                  />
                </div>
              )}
            </div>
            <Editor
              language="shell"
              theme={theme}
              value={value}
              options={{
                readOnly: true,
                fontSize: 12,
                lineNumbersMinChars: 3,
                fontFamily: 'Source Code Pro',
                folding: false,
                glyphMargin: false,
                wordWrap: 'on',
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
              readOnly: true,
            }}
            onBeforeChange={(editor, data, value) => {
              setValue(value);
            }}
            onChange={(editor, data, value) => {}}
          />
        )}
      </div>
    </PageContainer>
  );
};

export default Log;
