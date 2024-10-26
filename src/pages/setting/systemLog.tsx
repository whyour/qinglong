import intl from 'react-intl-universal';
import React, { useRef, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { Button, DatePicker, Empty, message, Spin } from 'antd';
import {
  VerticalAlignBottomOutlined,
  VerticalAlignTopOutlined,
} from '@ant-design/icons';
import { request } from '@/utils/http';
import config from '@/utils/config';
import { useRequest } from 'ahooks';
import moment from 'moment';
import {
  systemLogDebugHighlightPlugin,
  systemLogErrorHighlightPlugin,
  systemLogInfoHighlightPlugin,
  systemLogTheme,
  systemLogWarnHighlightPlugin,
} from '@/utils/codemirror/systemLog';

const { RangePicker } = DatePicker;

const SystemLog = ({ height, theme }: any) => {
  const editorRef = useRef<any>(null);
  const panelVisiableRef = useRef<[string, string] | false>();
  const [range, setRange] = useState<string[]>(['', '']);
  const [systemLogData, setSystemLogData] = useState<string>('');

  const { loading, refresh } = useRequest(
    () => {
      return request.get<Blob>(
        `${config.apiPrefix}system/log?startTime=${range[0]}&endTime=${range[1]}`,
        {
          responseType: 'blob',
        },
      );
    },
    {
      refreshDeps: [range],
      async onSuccess(res) {
        setSystemLogData(await res.text());
      },
    },
  );

  const scrollTo = (position: 'start' | 'end') => {
    editorRef.current.scrollDOM.scrollTo({
      top: position === 'start' ? 0 : editorRef.current.scrollDOM.scrollHeight,
    });
  };

  const deleteLog = () => {
    request.delete(`${config.apiPrefix}system/log`).then((x) => {
      message.success('删除成功');
      refresh();
    });
  };

  return (
    <div style={{ position: 'relative' }}>
      <div>
        <RangePicker
          style={{ marginBottom: 12, marginRight: 12 }}
          disabledDate={(date) =>
            date > moment() || date < moment().subtract(7, 'days')
          }
          defaultValue={[moment(), moment()]}
          onOpenChange={(v) => {
            panelVisiableRef.current = v ? ['', ''] : false;
          }}
          onCalendarChange={(_, dates, { range }) => {
            if (
              !panelVisiableRef.current ||
              typeof panelVisiableRef.current === 'boolean'
            ) {
              return;
            }
            if (range === 'start') {
              panelVisiableRef.current[0] = dates[0];
            }
            if (range === 'end') {
              panelVisiableRef.current[1] = dates[1];
            }
            if (panelVisiableRef.current[0] && panelVisiableRef.current[1]) {
              setRange(dates);
            }
          }}
        />
        <Button
          onClick={() => {
            deleteLog();
          }}
        >
          {intl.get('清空日志')}
        </Button>
      </div>
      {systemLogData ? (
        <>
          <CodeMirror
            maxHeight={`${height}px`}
            value={systemLogData}
            onCreateEditor={(view) => {
              editorRef.current = view;
            }}
            extensions={[
              systemLogDebugHighlightPlugin,
              systemLogErrorHighlightPlugin,
              systemLogInfoHighlightPlugin,
              systemLogWarnHighlightPlugin,
              systemLogTheme,
            ]}
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
              size="small"
              icon={<VerticalAlignTopOutlined />}
              onClick={() => {
                scrollTo('start');
              }}
            />
            <Button
              size="small"
              icon={<VerticalAlignBottomOutlined />}
              onClick={() => {
                scrollTo('end');
              }}
            />
          </div>
        </>
      ) : loading ? (
        <Spin />
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
      )}
    </div>
  );
};

export default SystemLog;
