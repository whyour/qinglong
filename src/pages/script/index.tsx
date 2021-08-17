import { useState, useEffect, useCallback, Key, useRef } from 'react';
import { TreeSelect, Tree, Input, Button } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import Editor from '@monaco-editor/react';
import { request } from '@/utils/http';
import styles from './index.module.less';
import EditModal from './editModal';
import { Controlled as CodeMirror } from 'react-codemirror2';
import { useCtx, useTheme } from '@/utils/hooks';
import SplitPane from 'react-split-pane';

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
  const [select, setSelect] = useState();
  const [data, setData] = useState<any[]>([]);
  const [filterData, setFilterData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('');
  const [height, setHeight] = useState<number>();
  const treeDom = useRef<any>();
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const { headerStyle, isPhone } = useCtx();
  const { theme } = useTheme();

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
      const { tree } = getFilterData(keyword.toLocaleLowerCase(), data);
      setFilterData(tree);
    },
    [data, setFilterData],
  );

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
            ]
          : [
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
                readOnly: true,
                fontSize: 12,
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
