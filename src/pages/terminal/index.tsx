import { useState, useEffect, useRef } from 'react';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';
import { AttachAddon } from 'xterm-addon-attach';
import { FitAddon } from 'xterm-addon-fit';
import { getToken } from '@/utils/auth';

const Log = () => {
  const [width, setWdith] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);

  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    request.post(`${config.apiPrefix}terminals?cols=80&rows=24`).then((pid) => {
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
    });
  }, []);

  useEffect(() => {
    if (document.body.clientWidth < 768) {
      setWdith('auto');
      setMarginLeft(0);
      setMarginTop(0);
    } else {
      setWdith('100%');
      setMarginLeft(0);
      setMarginTop(-72);
    }
  }, []);

  return (
    <PageContainer
      className="ql-container-wrapper terminal-wrapper"
      title={'终端管理'}
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
