import intl from 'react-intl-universal';
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
import { CrontabStatus } from './type';
import { diffTime } from '@/utils/date';
import { request } from '@/utils/http';
import config from '@/utils/config';
import CronLogModal from './logModal';
import Editor from '@monaco-editor/react';
import IconFont from '@/components/iconfont';
import { getCommandScript, getEditorMode } from '@/utils';
import VirtualList from 'rc-virtual-list';
import useScrollHeight from '@/hooks/useScrollHeight';
import dayjs from 'dayjs';

const { Text } = Typography;

const tabList = [
  {
    key: 'log',
    tab: intl.get('日志'),
  },
  {
    key: 'script',
    tab: intl.get('脚本'),
  },
];

interface LogItem {
  directory: string;
  filename: string;
}

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
  const listRef = useRef<HTMLDivElement>(null);
  const tableScrollHeight = useScrollHeight(listRef);

  const contentList: any = {
    log: (
      <div ref={listRef}>
        <List>
          <VirtualList
            data={logs}
            height={tableScrollHeight}
            itemHeight={47}
            itemKey="filename"
          >
            {(item) => (
              <List.Item className="log-item" onClick={() => onClickItem(item)}>
                <FileOutlined style={{ marginRight: 10 }} />
                {item.directory}/{item.filename}
              </List.Item>
            )}
          </VirtualList>
        </List>
      </div>
    ),
    script: scriptInfo.filename && (
      <Editor
        language={getEditorMode(scriptInfo.filename)}
        theme={theme}
        value={value}
        options={{
          fontSize: 12,
          minimap: { enabled: false },
          lineNumbersMinChars: 3,
          glyphMargin: false,
          accessibilitySupport: 'off',
        }}
        onMount={(editor, monaco) => {
          editorRef.current = editor;
        }}
      />
    ),
  };

  const onClickItem = (item: LogItem) => {
    const url = `${config.apiPrefix}logs/detail?file=${item.filename}&path=${
      item.directory || ''
    }`;
    localStorage.setItem('logCron', url);
    setLogUrl(url);
    request.get(url).then(({ code, data }) => {
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
        .get(`${config.apiPrefix}scripts/detail?file=${s}&path=${p || ''}`)
        .then(({ code, data }) => {
          if (code === 200) {
            setValue(data);
          }
        });
    } else {
      setValidTabs([validTabs[0]]);
      setActiveTabKey('log');
    }
  };

  const saveFile = () => {
    Modal.confirm({
      title: `确认保存`,
      content: (
        <>
          {intl.get('确认保存文件')}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {' '}
            {scriptInfo.filename}
          </Text>
          {intl.get('，保存后不可恢复')}
        </>
      ),
      onOk() {
        const content = editorRef.current
          ? editorRef.current.getValue().replace(/\r\n/g, '\n')
          : value;
        return new Promise((resolve, reject) => {
          request
            .put(`${config.apiPrefix}scripts`, {
              filename: scriptInfo.filename,
              path: scriptInfo.parent || '',
              content,
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
      title: intl.get('确认运行'),
      content: (
        <>
          {intl.get('确认运行定时任务')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {currentCron.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}crons/run`, [currentCron.id])
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
      title: intl.get('确认停止'),
      content: (
        <>
          {intl.get('确认停止定时任务')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {currentCron.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(`${config.apiPrefix}crons/stop`, [currentCron.id])
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
      title: `确认${
        currentCron.isDisabled === 1 ? intl.get('启用') : intl.get('禁用')
      }`,
      content: (
        <>
          {intl.get('确认')}
          {currentCron.isDisabled === 1 ? intl.get('启用') : intl.get('禁用')}
          {intl.get('定时任务')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {currentCron.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}crons/${
              currentCron.isDisabled === 1 ? 'enable' : 'disable'
            }`,
            [currentCron.id],
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
      title: `确认${
        currentCron.isPinned === 1 ? intl.get('取消置顶') : intl.get('置顶')
      }`,
      content: (
        <>
          {intl.get('确认')}
          {currentCron.isPinned === 1 ? intl.get('取消置顶') : intl.get('置顶')}
          {intl.get('定时任务')}{' '}
          <Text style={{ wordBreak: 'break-all' }} type="warning">
            {currentCron.name}
          </Text>{' '}
          {intl.get('吗')}
        </>
      ),
      onOk() {
        request
          .put(
            `${config.apiPrefix}crons/${
              currentCron.isPinned === 1 ? 'unpin' : 'pin'
            }`,
            [currentCron.id],
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
          <div style={{ minWidth: 0, display: 'flex', alignItems: 'center' }}>
            <Typography.Text
              style={{ width: 200, boxSizing: 'content-box' }}
              ellipsis={{
                onEllipsis(ellipsis) {
                  return ellipsis;
                },
                tooltip: currentCron.name,
              }}
            >
              {currentCron.name}
            </Typography.Text>
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
                currentCron.status === CrontabStatus.idle
                  ? intl.get('运行')
                  : intl.get('停止')
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
            <Tooltip
              title={
                currentCron.isDisabled === 1
                  ? intl.get('启用')
                  : intl.get('禁用')
              }
            >
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
            <Tooltip
              title={
                currentCron.isPinned === 1
                  ? intl.get('取消置顶')
                  : intl.get('置顶')
              }
            >
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
            <div className="cron-detail-info-title">{intl.get('任务')}</div>
            <div className="cron-detail-info-value">{currentCron.command}</div>
          </div>
        </Card>
        <Card style={{ marginTop: 10 }}>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">{intl.get('状态')}</div>
            <div className="cron-detail-info-value">
              {(!currentCron.isDisabled ||
                currentCron.status !== CrontabStatus.idle) && (
                <>
                  {currentCron.status === CrontabStatus.idle && (
                    <Tag icon={<ClockCircleOutlined />} color="default">
                      {intl.get('空闲中')}
                    </Tag>
                  )}
                  {currentCron.status === CrontabStatus.running && (
                    <Tag
                      icon={<Loading3QuartersOutlined spin />}
                      color="processing"
                    >
                      {intl.get('运行中')}
                    </Tag>
                  )}
                  {currentCron.status === CrontabStatus.queued && (
                    <Tag icon={<FieldTimeOutlined />} color="default">
                      {intl.get('队列中')}
                    </Tag>
                  )}
                </>
              )}
              {currentCron.isDisabled === 1 &&
                currentCron.status === CrontabStatus.idle && (
                  <Tag icon={<CloseCircleOutlined />} color="error">
                    {intl.get('已禁用')}
                  </Tag>
                )}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">{intl.get('定时')}</div>
            <div className="cron-detail-info-value">
              <div>{currentCron.schedule}</div>
              {currentCron.extra_schedules?.map((x) => (
                <div key={x.schedule}>{x.schedule}</div>
              ))}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">
              {intl.get('最后运行时间')}
            </div>
            <div className="cron-detail-info-value">
              {currentCron.last_execution_time
                ? dayjs(currentCron.last_execution_time * 1000).format(
                    'YYYY-MM-DD HH:mm:ss',
                  )
                : '-'}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">
              {intl.get('最后运行时长')}
            </div>
            <div className="cron-detail-info-value">
              {currentCron.last_running_time
                ? diffTime(currentCron.last_running_time)
                : '-'}
            </div>
          </div>
          <div className="cron-detail-info-item">
            <div className="cron-detail-info-title">
              {intl.get('下次运行时间')}
            </div>
            <div className="cron-detail-info-value">
              {currentCron.nextRunTime &&
                dayjs(currentCron.nextRunTime).format('YYYY-MM-DD HH:mm:ss')}
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
                  {intl.get('保存')}
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
