import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  message,
  Input,
  Form,
  Button,
  Card,
  Tag,
  List,
  Divider,
  Typography,
} from 'antd';
import {
  ClockCircleOutlined,
  CloseCircleOutlined,
  FieldTimeOutlined,
  Loading3QuartersOutlined,
  FileOutlined,
} from '@ant-design/icons';
import { CrontabStatus } from './index';
import { diffTime } from '@/utils/date';
import { request } from '@/utils/http';
import config from '@/utils/config';
import CronLogModal from './logModal';
import Editor from '@monaco-editor/react';

const { Text } = Typography;

const tabList = [
  {
    key: 'log',
    tab: '日志',
  },
  {
    key: 'script',
    tab: '脚本',
  },
];

interface LogItem {
  directory: string;
  filename: string;
}

const language = navigator.language || navigator.languages[0];

const CronDetailModal = ({
  cron = {},
  handleCancel,
  visible,
  theme,
  isPhone,
}: {
  cron?: any;
  visible: boolean;
  handleCancel: (needUpdate?: boolean) => void;
  theme: string;
  isPhone: boolean;
}) => {
  const [activeTabKey, setActiveTabKey] = useState('log');
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [log, setLog] = useState('');
  const [value, setValue] = useState('');
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const editorRef = useRef<any>(null);
  const [scriptInfo, setScriptInfo] = useState<any>({});
  const [logUrl, setLogUrl] = useState('');
  const [validTabs, setValidTabs] = useState(tabList);

  const contentList: any = {
    log: (
      <List
        dataSource={logs}
        loading={loading}
        renderItem={(item) => (
          <List.Item className="log-item" onClick={() => onClickItem(item)}>
            <FileOutlined style={{ marginRight: 10 }} />
            {item.directory}/{item.filename}
          </List.Item>
        )}
      />
    ),
    script: (
      <Editor
        language="shell"
        theme={theme}
        value={value}
        options={{
          fontSize: 12,
          lineNumbersMinChars: 3,
          fontFamily: 'Source Code Pro',
          folding: false,
          glyphMargin: false,
          wordWrap: 'on',
        }}
        onMount={(editor) => {
          editorRef.current = editor;
        }}
      />
    ),
  };

  const onClickItem = (item: LogItem) => {
    localStorage.setItem('logCron', cron.id);
    setLogUrl(`${config.apiPrefix}logs/${item.directory}/${item.filename}`);
    request
      .get(`${config.apiPrefix}logs/${item.directory}/${item.filename}`)
      .then((data) => {
        setLog(data.data);
        setIsLogModalVisible(true);
      });
  };

  const onTabChange = (key: string) => {
    setActiveTabKey(key);
  };

  const getLogs = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}crons/${cron.id}/logs`)
      .then((data: any) => {
        if (data.code === 200) {
          setLogs(data.data);
        }
      })
      .finally(() => setLoading(false));
  };

  const getScript = () => {
    const cmd = cron.command.split(' ') as string[];
    if (cmd[0] === 'task') {
      setValidTabs(validTabs);
      if (cmd[1].startsWith('/ql/data/scripts')) {
        cmd[1] = cmd[1].replace('/ql/data/scripts/', '');
      }

      let [p, s] = cmd[1].split('/');
      if (!s) {
        s = p;
        p = '';
      }
      setScriptInfo({ parent: p, filename: s });
      request
        .get(`${config.apiPrefix}scripts/${s}?path=${p || ''}`)
        .then((data) => {
          setValue(data.data);
        });
    } else {
      setValidTabs([validTabs[0]]);
    }
  };

  const saveFile = () => {
    Modal.confirm({
      title: `确认保存`,
      content: (
        <>
          确认保存文件
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {scriptInfo.filename}
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
                filename: scriptInfo.filename,
                path: scriptInfo.parent || '',
                content,
              },
            })
            .then((_data: any) => {
              if (_data.code === 200) {
                setValue(content);
                message.success(`保存成功`);
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

  useEffect(() => {
    if (cron && cron.id) {
      getLogs();
      getScript();
    }
  }, [cron]);

  return (
    <Modal
      title={
        <>
          <span>{cron.name}</span>
          {cron.labels?.length > 0 && cron.labels[0] !== '' && (
            <Divider type="vertical"></Divider>
          )}
          {cron.labels?.length > 0 &&
            cron.labels[0] !== '' &&
            cron.labels?.map((label: string, i: number) => (
              <Tag color="blue" style={{ marginRight: 5 }}>
                {label}
              </Tag>
            ))}
        </>
      }
      centered
      visible={visible}
      forceRender
      footer={false}
      onCancel={() => handleCancel()}
      wrapClassName="crontab-detail"
      width={!isPhone ? '80vw' : ''}
    >
      <div className="card-wrapper">
        <Card>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">任务</div>
            <div className="cron-detail-info-value">{cron.command}</div>
          </div>
        </Card>
        <Card style={{ marginTop: 10 }}>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">状态</div>
            <div className="cron-detail-info-value">
              {(!cron.isDisabled || cron.status !== CrontabStatus.idle) && (
                <>
                  {cron.status === CrontabStatus.idle && (
                    <Tag icon={<ClockCircleOutlined />} color="default">
                      空闲中
                    </Tag>
                  )}
                  {cron.status === CrontabStatus.running && (
                    <Tag
                      icon={<Loading3QuartersOutlined spin />}
                      color="processing"
                    >
                      运行中
                    </Tag>
                  )}
                  {cron.status === CrontabStatus.queued && (
                    <Tag icon={<FieldTimeOutlined />} color="default">
                      队列中
                    </Tag>
                  )}
                </>
              )}
              {cron.isDisabled === 1 && cron.status === CrontabStatus.idle && (
                <Tag icon={<CloseCircleOutlined />} color="error">
                  已禁用
                </Tag>
              )}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">定时</div>
            <div className="cron-detail-info-value">{cron.schedule}</div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">最后运行时间</div>
            <div className="cron-detail-info-value">
              {cron.last_execution_time
                ? new Date(cron.last_execution_time * 1000)
                    .toLocaleString(language, {
                      hour12: false,
                    })
                    .replace(' 24:', ' 00:')
                : '-'}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">最后运行时长</div>
            <div className="cron-detail-info-value">
              {cron.last_running_time ? diffTime(cron.last_running_time) : '-'}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">下次运行时间</div>
            <div className="cron-detail-info-value">
              {cron.nextRunTime &&
                cron.nextRunTime
                  .toLocaleString(language, {
                    hour12: false,
                  })
                  .replace(' 24:', ' 00:')}
            </div>
          </div>
        </Card>
        <Card
          style={{ marginTop: 10 }}
          tabList={validTabs}
          activeTabKey={activeTabKey}
          onTabChange={(key) => {
            onTabChange(key);
          }}
          tabBarExtraContent={
            activeTabKey === 'script' && (
              <Button
                type="primary"
                style={{ marginRight: 8 }}
                onClick={saveFile}
              >
                保存
              </Button>
            )
          }
        >
          {contentList[activeTabKey]}
        </Card>
      </div>
      <CronLogModal
        visible={isLogModalVisible}
        handleCancel={() => {
          setIsLogModalVisible(false);
        }}
        cron={cron}
        data={log}
        logUrl={logUrl}
      />
    </Modal>
  );
};

export default CronDetailModal;
