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
  Tooltip,
} from 'antd';
import {
  ClockCircleOutlined,
  CloseCircleOutlined,
  FieldTimeOutlined,
  Loading3QuartersOutlined,
  FileOutlined,
  PlayCircleOutlined,
  PauseCircleOutlined,
  FullscreenOutlined,
} from '@ant-design/icons';
import { CrontabStatus } from './index';
import { diffTime } from '@/utils/date';
import { request } from '@/utils/http';
import config from '@/utils/config';
import CronLogModal from './logModal';
import Editor from '@monaco-editor/react';
import IconFont from '@/components/iconfont';
import { getCommandScript } from '@/utils';

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
const LangMap: any = {
  '.py': 'python',
  '.js': 'javascript',
  '.sh': 'shell',
  '.ts': 'typescript',
};

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
  const [currentCron, setCurrentCron] = useState<any>({});

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
    script: scriptInfo.filename && (
      <Editor
        language={LangMap[scriptInfo.filename.slice(-3)] || ''}
        theme={theme}
        value={value}
        options={{
          fontSize: 12,
          lineNumbersMinChars: 3,
          fontFamily: 'Source Code Pro',
          glyphMargin: false,
          wordWrap: 'on',
        }}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
        }}
      />
    ),
  };

  const onClickItem = (item: LogItem) => {
    localStorage.setItem('logCron', currentCron.id);
    setLogUrl(
      `${config.apiPrefix}logs/${item.filename}?path=${item.directory || ''}`,
    );
    request
      .get(
        `${config.apiPrefix}logs/${item.filename}?path=${item.directory || ''}`,
      )
      .then(({ code, data }) => {
        if (code === 200) {
          setLog(data);
          setIsLogModalVisible(true);
        }
      });
  };

  const onTabChange = (key: string) => {
    setActiveTabKey(key);
  };

  const getLogs = () => {
    setLoading(true);
    request
      .get(`${config.apiPrefix}crons/${cron.id}/logs`)
      .then(({ code, data }) => {
        if (code === 200) {
          setLogs(data);
        }
      })
      .finally(() => setLoading(false));
  };

  const getScript = () => {
    const result = getCommandScript(cron.command);
    if (Array.isArray(result)) {
      setValidTabs(validTabs);
      const [s, p] = result;
      setScriptInfo({ parent: p, filename: s });
      request
        .get(`${config.apiPrefix}scripts/${s}?path=${p || ''}`)
        .then(({ code, data }) => {
          if (code === 200) {
            setValue(data);
          }
        });
    } else if (result) {
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
            .then(({ code, data }) => {
              if (code === 200) {
                setValue(content);
                message.success(`保存成功`);
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

  const runCron = () => {
    Modal.confirm({
      title: '确认运行',
      content: (
        <>
          确认运行定时任务{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {currentCron.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}crons/run`, { data: [currentCron.id] })
          .then(({ code, data }) => {
            if (code === 200) {
              setCurrentCron({ ...currentCron, status: CrontabStatus.running });
              setTimeout(() => {
                getLogs();
              }, 1000);
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const stopCron = () => {
    Modal.confirm({
      title: '确认停止',
      content: (
        <>
          确认停止定时任务{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {currentCron.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}crons/stop`, { data: [currentCron.id] })
          .then(({ code, data }) => {
            if (code === 200) {
              setCurrentCron({ ...currentCron, status: CrontabStatus.idle });
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const enabledOrDisabledCron = () => {
    Modal.confirm({
      title: `确认${currentCron.isDisabled === 1 ? '启用' : '禁用'}`,
      content: (
        <>
          确认{currentCron.isDisabled === 1 ? '启用' : '禁用'}
          定时任务{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {currentCron.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}crons/${
              currentCron.isDisabled === 1 ? 'enable' : 'disable'
            }`,
            {
              data: [currentCron.id],
            },
          )
          .then(({ code, data }) => {
            if (code === 200) {
              setCurrentCron({
                ...currentCron,
                isDisabled: currentCron.isDisabled === 1 ? 0 : 1,
              });
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const pinOrUnPinCron = () => {
    Modal.confirm({
      title: `确认${currentCron.isPinned === 1 ? '取消置顶' : '置顶'}`,
      content: (
        <>
          确认{currentCron.isPinned === 1 ? '取消置顶' : '置顶'}
          定时任务{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {currentCron.name}
          </Text>{' '}
          吗
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}crons/${
              currentCron.isPinned === 1 ? 'unpin' : 'pin'
            }`,
            {
              data: [currentCron.id],
            },
          )
          .then(({ code, data }) => {
            if (code === 200) {
              setCurrentCron({
                ...currentCron,
                isPinned: currentCron.isPinned === 1 ? 0 : 1,
              });
            }
          });
      },
      onCancel() {
        console.log('Cancel');
      },
    });
  };

  const fullscreen = () => {
    const editorElement = editorRef.current._domElement as HTMLElement;
    editorElement.parentElement?.requestFullscreen();
  };

  useEffect(() => {
    if (cron && cron.id) {
      setCurrentCron(cron);
      getLogs();
      getScript();
    }
  }, [cron]);

  return (
    <Modal
      title={
        <div className="crontab-title-wrapper">
          <div>
            <span>{currentCron.name}</span>
            {currentCron.labels?.length > 0 && currentCron.labels[0] !== '' && (
              <Divider type="vertical"></Divider>
            )}
            {currentCron.labels?.length > 0 &&
              currentCron.labels[0] !== '' &&
              currentCron.labels?.map((label: string, i: number) => (
                <Tag key={label} color="blue" style={{ marginRight: 5 }}>
                  {label}
                </Tag>
              ))}
          </div>

          <div className="operations">
            <Tooltip
              title={
                currentCron.status === CrontabStatus.idle ? '运行' : '停止'
              }
            >
              <Button
                type="link"
                icon={
                  currentCron.status === CrontabStatus.idle ? (
                    <PlayCircleOutlined />
                  ) : (
                    <PauseCircleOutlined />
                  )
                }
                size="small"
                onClick={
                  currentCron.status === CrontabStatus.idle ? runCron : stopCron
                }
              />
            </Tooltip>
            <Tooltip title={currentCron.isDisabled === 1 ? '启用' : '禁用'}>
              <Button
                type="link"
                icon={
                  <IconFont
                    type={
                      currentCron.isDisabled === 1
                        ? 'ql-icon-enable'
                        : 'ql-icon-disable'
                    }
                  />
                }
                size="small"
                onClick={enabledOrDisabledCron}
              />
            </Tooltip>
            <Tooltip title={currentCron.isPinned === 1 ? '取消置顶' : '置顶'}>
              <Button
                type="link"
                icon={
                  <IconFont
                    type={
                      currentCron.isPinned === 1
                        ? 'ql-icon-untop'
                        : 'ql-icon-top'
                    }
                  />
                }
                size="small"
                onClick={pinOrUnPinCron}
              />
            </Tooltip>
          </div>
        </div>
      }
      centered
      open={visible}
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
            <div className="cron-detail-info-value">{currentCron.command}</div>
          </div>
        </Card>
        <Card style={{ marginTop: 10 }}>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">状态</div>
            <div className="cron-detail-info-value">
              {(!currentCron.isDisabled ||
                currentCron.status !== CrontabStatus.idle) && (
                <>
                  {currentCron.status === CrontabStatus.idle && (
                    <Tag icon={<ClockCircleOutlined />} color="default">
                      空闲中
                    </Tag>
                  )}
                  {currentCron.status === CrontabStatus.running && (
                    <Tag
                      icon={<Loading3QuartersOutlined spin />}
                      color="processing"
                    >
                      运行中
                    </Tag>
                  )}
                  {currentCron.status === CrontabStatus.queued && (
                    <Tag icon={<FieldTimeOutlined />} color="default">
                      队列中
                    </Tag>
                  )}
                </>
              )}
              {currentCron.isDisabled === 1 &&
                currentCron.status === CrontabStatus.idle && (
                  <Tag icon={<CloseCircleOutlined />} color="error">
                    已禁用
                  </Tag>
                )}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">定时</div>
            <div className="cron-detail-info-value">{currentCron.schedule}</div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">最后运行时间</div>
            <div className="cron-detail-info-value">
              {currentCron.last_execution_time
                ? new Date(currentCron.last_execution_time * 1000)
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
              {currentCron.last_running_time
                ? diffTime(currentCron.last_running_time)
                : '-'}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">下次运行时间</div>
            <div className="cron-detail-info-value">
              {currentCron.nextRunTime &&
                currentCron.nextRunTime
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
              <>
                <Button
                  type="primary"
                  style={{ marginRight: 8 }}
                  onClick={saveFile}
                >
                  保存
                </Button>
                <Button
                  type="primary"
                  icon={<FullscreenOutlined />}
                  onClick={fullscreen}
                />
              </>
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
