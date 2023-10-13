import React, { useRef } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { Button } from 'antd';
import {
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';

const SystemLog = ({ data, height, theme }: any) => {
  const editorRef = useRef<any>(null);

  const scrollTo = (position: 'start' | 'end') => {
    editorRef.current.scrollDOM.scrollTo({
      top: position === 'start' ? 0 : editorRef.current.scrollDOM.scrollHeight,
    });
  };

  return (
    <div style={{ position: 'relative' }}>
      <CodeMirror
        maxHeight={`${height}px`}
        value={data}
        onCreateEditor={(view) => {
          editorRef.current = view;
        }}
        readOnly={true}
        theme={theme.includes('dark') ? 'dark' : 'light'}
      />
      <div
        style={{
          position: 'absolute',
          bottom: 20,
          right: 20,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <Button
          size='small'
          icon={<VerticalAlignTopOutlined />}
          onClick={() => {
            scrollTo('start');
          }}
        />
        <Button
          size='small'
          icon={<VerticalAlignBottomOutlined />}
          onClick={() => {
            scrollTo('end');
          }}
        />
      </div>
    </div>
  );
};

export default SystemLog;
