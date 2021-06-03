import { useState, useEffect, useCallback, Key, useRef } from 'react';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';
import { AttachAddon } from 'xterm-addon-attach';
import { FitAddon } from 'xterm-addon-fit';
import { getToken } from '@/utils/auth';

function getFilterData(keyword: string, data: any) {
  const expandedKeys: string[] = [];
  if (keyword) {
    const tree: any = [];
    data.forEach((item) => {
      if (item.title.includes(keyword)) {
        tree.push(item);
        expandedKeys.push(...item.children.map((x) => x.key));
      } else {
        const children: any[] = [];
        (item.children || []).forEach((subItem: any) => {
          if (subItem.title.includes(keyword)) {
            children.push(subItem);
          }
        });
        if (children.length > 0) {
          tree.push({
            ...item,
            children,
          });
          expandedKeys.push(...children.map((x) => x.key));
        }
      }
    });
    return { tree, expandedKeys };
  }
  return { tree: data, expandedKeys };
}

const Log = () => {
  const [width, setWdith] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [title, setTitle] = useState('请选择日志文件');
  const [value, setValue] = useState('请选择日志文件');
  const [select, setSelect] = useState();
  const [data, setData] = useState<any[]>([]);
  const [filterData, setFilterData] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const [isPhone, setIsPhone] = useState(false);

  const getConfig = () => {
    request.get(`${config.apiPrefix}logs`).then((data) => {
      const result = formatData(data.dirs) as any;
      setData(result);
      setFilterData(result);
    });
  };

  const formatData = (tree: any[]) => {
    return tree.map((x) => {
      x.title = x.name;
      x.value = x.name;
      x.disabled = x.isDir;
      x.key = x.name;
      x.children = x.files.map((y: string) => ({
        title: y,
        value: `${x.name}/${y}`,
        key: `${x.name}/${y}`,
        parent: x.name,
        isLeaf: true,
      }));
      return x;
    });
  };

  const getLog = (node: any) => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}logs/${node.value}`)
      .then((data) => {
        setValue(data.data);
      })
      .finally(() => setLoading(false));
  };

  const onSelect = (value: any, node: any) => {
    setSelect(value);
    setTitle(node.parent || node.value);
    getLog(node);
  };

  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    setLoading(true);
    request
      .post(`${config.apiPrefix}terminals?cols=80&rows=24`)
      .then((pid) => {
        const ws = new WebSocket(
          `ws://${location.host}${
            config.apiPrefix
          }terminals/${pid}?token=${getToken()}`,
        );
        ws.onopen = () => {
          const term = new Terminal();
          const attachAddon = new AttachAddon(ws);
          const fitAddon = new FitAddon();
          term.loadAddon(attachAddon);
          term.loadAddon(fitAddon);
          term.open(ref.current);
          fitAddon.fit();
          term.focus();
        };
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (document.body.clientWidth < 768) {
      setWdith('auto');
      setMarginLeft(0);
      setMarginTop(0);
      setIsPhone(true);
    } else {
      setWdith('100%');
      setMarginLeft(0);
      setMarginTop(-72);
      setIsPhone(false);
    }
    getConfig();
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper terminal-wrapper"
      title={title}
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
      <div ref={ref}></div>
    </PageContainer>
  );
};

export default Log;
