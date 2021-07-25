import React, { PureComponent, Fragment, useState, useEffect } from 'react';
import { Button, message, Modal } from 'antd';
import config from '@/utils/config';
import { PageContainer } from '@ant-design/pro-layout';
import { request } from '@/utils/http';
import ReactDiffViewer from 'react-diff-viewer';
import './index.less';
import { DiffEditor } from "@monaco-editor/react";

const Crontab = () => {
  const [width, setWidth] = useState('100%');
  const [marginLeft, setMarginLeft] = useState(0);
  const [marginTop, setMarginTop] = useState(-72);
  const [value, setValue] = useState('');
  const [sample, setSample] = useState('');
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<string>('');

  const getConfig = () => {
    request.get(`${config.apiPrefix}configs/config.sh`).then((data) => {
      setValue(data.data);
    });
  };

  const getSample = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}configs/config.sample.sh`)
      .then((data) => {
        setSample(data.data);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (document.body.clientWidth < 768) {
      setWidth('auto');
      setMarginLeft(0);
      setMarginTop(0);
    } else {
      setWidth('100%');
      setMarginLeft(0);
      setMarginTop(-72);
    }
    getConfig();
    getSample();
  }, []);

  useEffect(()=>{
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const storageTheme = localStorage.getItem('qinglong_dark_theme');
    const isDark = (media.matches && storageTheme !== 'light') || storageTheme === 'dark';
    setTheme(isDark?'vs-dark':'vs');
    media.addEventListener('change',(e)=>{
      if(storageTheme === 'auto' || !storageTheme){
        if(e.matches){
          setTheme('vs-dark')
        }else{
          setTheme('vs');
        }
      }
    })
  },[])

  return (
    <PageContainer
      className="ql-container-wrapper"
      title="对比工具"
      loading={loading}
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
      <DiffEditor
        language={"shell"}
        original={sample}
        modified={value}
        options={{
          readOnly: true,
          fontSize: 12,
          minimap: {enabled: width==='100%'},
          lineNumbersMinChars: 3,
          folding: false,
          glyphMargin: false,
          renderSideBySide: width==='100%',
          wordWrap: 'on'
        }}
        theme={theme}
      />
    </PageContainer>
  );
};

export default Crontab;
