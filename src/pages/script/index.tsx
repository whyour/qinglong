import { useState, useEffect, useCallback, Key } from 'react';
import { TreeSelect, Tree, Input } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { Controlled as CodeMirror } from 'react-codemirror2';
import { request } from '@/utils/http';
import styles from './index.module.less';

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
};

const Script = () => {
  const [width, setWidth] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [title, setTitle] = useState('请选择脚本文件');
  const [value, setValue] = useState('请选择脚本文件');
  const [select, setSelect] = useState();
  const [data, setData] = useState<any[]>([]);
  const [filterData, setFilterData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isPhone, setIsPhone] = useState(false);
  const [mode, setMode] = useState('');

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
    setMode(newMode);
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
    if (document.body.clientWidth < 768) {
      setWidth('auto');
      setMarginLeft(0);
      setMarginTop(0);
      setIsPhone(true);
    } else {
      setWidth('100%');
      setMarginLeft(0);
      setMarginTop(-72);
      setIsPhone(false);
    }
    getScripts();
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper log-wrapper"
      title={title}
      loading={loading}
      extra={
        isPhone && [
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
      }
      header={{
        style: {
          padding: '4px 16px 4px 15px',
          position: 'sticky',
          top: 0,
          left: 0,
          zIndex: 20,
          marginTop,
          width,
          marginLeft,
        },
      }}
    >
      <div className={`${styles['log-container']}`}>
        {!isPhone && (
          <div className={styles['left-tree-container']}>
            <Input.Search
              className={styles['left-tree-search']}
              onChange={onSearch}
            ></Input.Search>
            <div className={styles['left-tree-scroller']}>
              <Tree
                className={styles['left-tree']}
                treeData={filterData}
                onSelect={onTreeSelect}
              ></Tree>
            </div>
          </div>
        )}
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
      </div>
    </PageContainer>
  );
};

export default Script;
