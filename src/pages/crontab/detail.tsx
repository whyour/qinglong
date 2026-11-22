import { createStopRequest } from './stopRequest';
import DailyResults from './dailyResults';
import TriggerList from './triggerList';
import intl from 'react-intl-universal';
import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  message,
  Button,
  Card,
  Tag,
  List,
  Divider,
  Typography,
  Tooltip,
  Space,
  Switch,
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
  StopOutlined,
} from '@ant-design/icons';
import { CrontabStatus } from './type';
import { diffTime } from '@/utils/date';
import { request } from '@/utils/http';
import config from '@/utils/config';
import CronLogModal from './logModal';
import Editor from '@monaco-editor/react';
import IconFont from '@/components/iconfont';
import { getCommandScript, getEditorMode } from '@/utils';
import InstanceHistory from './instanceHistory';
import { readableLogName } from '@/components/fileBrowser/name';
import dayjs from 'dayjs';

const { Text } = Typography;

function instanceTitle(item: { id: number; log_path?: string | null }) {
  const filename = item.log_path?.split('/').pop();
  return filename
    ? readableLogName(filename)
    : intl.get('执行实例 #{id}', { id: String(item.id) });
}

const tabList = [
  { key: 'runningHistory', tab: intl.get('运行历史') },
  { key: 'triggers', tab: intl.get('触发记录') },
  { key: 'daily', tab: intl.get('日统计') },
  {
    key: 'script',
    tab: intl.get('脚本'),
  },
];

const CronDetailModal = ({
  cron = {},
  handleCancel,
  theme,
  isPhone,
}: {
  cron?: any;
  handleCancel: (needUpdate?: boolean) => void;
  theme: string;
  isPhone: boolean;
}) => {
  const [activeTabKey, setActiveTabKey] = useState('runningHistory');
  const [value, setValue] = useState('');
  const [wordWrap, setWordWrap] = useState(
    () =>
      (localStorage.getItem('qinglong_editor_word_wrap') ??
        localStorage.getItem('qinglong_config_word_wrap')) === 'true',
  );
  const [scriptState, setScriptState] = useState<
    'loading' | 'ready' | 'failed'
  >('loading');
  const editorRef = useRef<any>(null);
  const [scriptInfo, setScriptInfo] = useState<any>({});
  const [validTabs, setValidTabs] = useState(tabList);
  const [currentCron, setCurrentCron] = useState<any>({});
  const [historyRevision, setHistoryRevision] = useState(0);
  const needRefreshRef = useRef(false);
  const [isLogModalVisible, setIsLogModalVisible] = useState(false);
  const [logUrl, setLogUrl] = useState('');

  const refreshVersion = useRef(0);
  const session = useRef<AbortController>();
  const [refreshFailed, setRefreshFailed] = useState(false);
  const refreshDetails = async () => {
    const signal = session.current?.signal;
    if (!cron.id || !signal || signal.aborted) return;
    const options = { signal, retryInPlace: true };
    const version = ++refreshVersion.current;
    const base = `${config.apiPrefix}crons/${cron.id}`;
    try {
      const { code, data } = await request.get(base, options);
      if (code !== 200) throw new Error();
      if (!signal.aborted && version === refreshVersion.current) {
        setCurrentCron(data);
        setRefreshFailed(false);
      }
    } catch {
      if (!signal.aborted && version === refreshVersion.current)
        setRefreshFailed(true);
    }
  };
  const refreshAfterChange = () => {
    needRefreshRef.current = true;
    setHistoryRevision((n) => n + 1);
    return refreshDetails();
  };

  useEffect(() => {
    if (!cron.id) return;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    session.current = controller;
    const poll = async () => {
      await refreshDetails();
      if (!controller.signal.aborted) timer = setTimeout(poll, 10000);
    };
    void poll();
    return () => {
      controller.abort();
      ++refreshVersion.current;
      clearTimeout(timer);
    };
  }, [cron.id]);

  const contentList: any = {
    daily: <DailyResults key={cron.id} id={cron.id} />,
    triggers: activeTabKey === 'triggers' && (
      <TriggerList
        key={cron.id}
        id={cron.id}
        onViewLog={(row) => viewInstanceLog(row, row.id)}
      />
    ),
    script:
      scriptState === 'failed' ? (
        <span role="status">
          {intl.get('加载失败')}{' '}
          <Button type="link" onClick={() => getScript()}>
            {intl.get('重试')}
          </Button>
        </span>
      ) : scriptState === 'loading' ? (
        intl.get('加载中...')
      ) : (
        scriptInfo.filename && (
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
              wordWrap: wordWrap ? 'on' : 'off',
            }}
            onMount={(editor, monaco) => {
              editorRef.current = editor;
            }}
          />
        )
      ),
    runningHistory: activeTabKey === 'runningHistory' && (
      <InstanceHistory key={cron.id} id={cron.id} revision={historyRevision}>
        {(item) => (
          <List.Item
            className="log-item"
            onClick={() => item.log_path && viewInstanceLog(item)}
            style={{ cursor: item.log_path ? 'pointer' : 'default' }}
            actions={[
              item.log_path && (
                <Tooltip title={intl.get('查看日志')} key="log">
                  <Button
                    type="link"
                    size="small"
                    icon={<FileOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      viewInstanceLog(item);
                    }}
                  />
                </Tooltip>
              ),
              item.status === 0 && (
                <Tooltip title={intl.get('停止')} key="stop">
                  <Button
                    type="link"
                    size="small"
                    icon={<StopOutlined />}
                    danger
                    onClick={(e) => {
                      e.stopPropagation();
                      stopRunningInstance(item);
                    }}
                  />
                </Tooltip>
              ),
            ].filter(Boolean)}
          >
            <List.Item.Meta
              title={
                <span>
                  <span
                    style={{ marginRight: 8 }}
                    title={item.log_path || undefined}
                  >
                    {instanceTitle(item)}
                  </span>
                  {item.status === 0 && (
                    <Tag
                      icon={<Loading3QuartersOutlined spin />}
                      color="processing"
                    >
                      {intl.get('运行中')}
                    </Tag>
                  )}
                  {item.status === 1 && (
                    <Tag color="success">{intl.get('已完成')}</Tag>
                  )}
                  {item.status === 2 && (
                    <Tag color="default">{intl.get('已停止')}</Tag>
                  )}
                  {item.status === 4 && <Tag>{intl.get('结果未知')}</Tag>}
                  {item.status === 3 && (
                    <Tag color="error">{intl.get('错误')}</Tag>
                  )}
                </span>
              }
              description={
                <span style={{ color: '#999' }}>
                  {item.status === 0 && item.pid && (
                    <span>
                      PID: {item.pid}
                      {' | '}
                    </span>
                  )}
                  {intl.get('启动')}:{' '}
                  {dayjs.unix(item.started_at).format('YYYY-MM-DD HH:mm:ss')}
                  {item.finished_at && (
                    <span>
                      {' | '}
                      {intl.get('结束')}:{' '}
                      {dayjs
                        .unix(item.finished_at)
                        .format('YYYY-MM-DD HH:mm:ss')}
                    </span>
                  )}
                  {item.exit_code != null && item.exit_code !== 0 && (
                    <span>
                      {' | '}
                      {intl.get('退出码')}: {item.exit_code}
                    </span>
                  )}
                </span>
              }
            />
          </List.Item>
        )}
      </InstanceHistory>
    ),
  };

  const stopDialogs = useRef(new Set<number>());
  const stopRunningInstance = (instance: any) => {
    if (stopDialogs.current.has(instance.id)) return;
    stopDialogs.current.add(instance.id);
    Modal.confirm({
      afterClose: () => stopDialogs.current.delete(instance.id),
      title: intl.get('确认停止实例'),
      content: (
        <>
          {intl.get('确认停止运行实例')} PID: {instance.pid} {intl.get('吗')}
        </>
      ),
      onOk() {
        return request
          .post(
            `${config.apiPrefix}crons/${cron.id}/instances/${instance.id}/stop`,
          )
          .then(({ code, data }) => {
            if (code === 200) {
              if (data?.outcome === 'ended')
                message.info(intl.get('实例已结束'));
              else message.success(intl.get('实例已停止'));
              return refreshAfterChange();
            }
          });
      },
    });
  };

  const viewInstanceLog = (instance: any, triggerId?: string) => {
    if (!instance.log_path) return;
    const base = `${config.apiPrefix}crons/${cron.id}/log`;
    let url: string;
    if (triggerId) url = `${base}?${new URLSearchParams({ triggerId })}`;
    else if (instance.id)
      url = `${base}?${new URLSearchParams({
        instanceId: String(instance.id),
      })}`;
    else {
      const parts = instance.log_path.split('/');
      const file = parts.pop()!;
      url = `${config.apiPrefix}logs/detail?${new URLSearchParams({
        file,
        path: parts.join('/'),
      })}`;
    }
    setLogUrl(url);
    setIsLogModalVisible(true);
  };

  const onTabChange = (key: string) => {
    setActiveTabKey(key);
    void refreshDetails();
  };

  const getScript = () => {
    const signal = session.current?.signal;
    const result = getCommandScript(cron.command);
    if (Array.isArray(result)) {
      setValidTabs(tabList);
      const [s, p] = result;
      setScriptInfo({ parent: p, filename: s });
      setScriptState('loading');
      request
        .get(`${config.apiPrefix}scripts/detail`, {
          params: { file: s, path: p || '' },
          signal,
          retryInPlace: true,
        })
        .then(({ code, data }) => {
          if (signal?.aborted) return;
          if (code !== 200) throw new Error('Script read failed');
          setValue(data);
          setScriptState('ready');
        })
        .catch(() => {
          if (!signal?.aborted) setScriptState('failed');
        });
    } else {
      setValidTabs(tabList.filter((tab) => tab.key !== 'script'));
      setActiveTabKey('runningHistory');
    }
  };

  const saveFile = () => {
    Modal.confirm({
      title: intl.get('确认保存'),
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
                message.success(intl.get('保存成功'));
              }
              resolve(null);
            })
            .catch((e) => reject(e));
        });
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
              return refreshAfterChange();
            }
          });
      },
    });
  };

  const stopCron = () => {
    const stop = createStopRequest([currentCron.id]);
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
        return stop().then(({ code, data }) => {
          if (code === 200) {
            return refreshAfterChange();
          }
        });
      },
    });
  };

  const enabledOrDisabledCron = () => {
    Modal.confirm({
      title: intl.get('确认操作', {
        operation:
          currentCron.isDisabled === 1 ? intl.get('启用') : intl.get('禁用'),
      }),
      content: (
        <>
          {intl.get('确认操作对象', {
            operation:
              currentCron.isDisabled === 1
                ? intl.get('启用')
                : intl.get('禁用'),
            object: intl.get('定时任务'),
          })}{' '}
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
          .then(async ({ code }) => {
            if (code === 200) {
              return refreshAfterChange();
            }
          });
      },
    });
  };

  const pinOrUnPinCron = () => {
    Modal.confirm({
      title: intl.get('确认操作', {
        operation:
          currentCron.isPinned === 1 ? intl.get('取消置顶') : intl.get('置顶'),
      }),
      content: (
        <>
          {intl.get('确认操作对象', {
            operation:
              currentCron.isPinned === 1
                ? intl.get('取消置顶')
                : intl.get('置顶'),
            object: intl.get('定时任务'),
          })}{' '}
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
              return refreshAfterChange();
            }
          });
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
      getScript();
    }
  }, [cron]);

  const scriptActions = activeTabKey === 'script' &&
    scriptState === 'ready' && (
      <Space size={8} wrap>
        <Space size={8} className="editor-wrap-setting">
          <span className="editor-wrap-label">{intl.get('自动换行')}</span>
          <Switch
            aria-label={intl.get('自动换行')}
            checked={wordWrap}
            onChange={(checked) => {
              setWordWrap(checked);
              localStorage.setItem(
                'qinglong_editor_word_wrap',
                String(checked),
              );
            }}
          />
        </Space>
        <Button type="primary" onClick={saveFile}>
          {intl.get('保存')}
        </Button>
        <Button
          type="primary"
          icon={<FullscreenOutlined />}
          onClick={fullscreen}
        />
      </Space>
    );

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
      open={true}
      forceRender
      footer={false}
      onCancel={() => handleCancel(needRefreshRef.current)}
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
              {refreshFailed && (
                <span role="status">
                  {intl.get('任务状态刷新失败')}
                  <Button
                    type="link"
                    size="small"
                    onClick={() => {
                      setRefreshFailed(false);
                      void refreshDetails();
                    }}
                  >
                    {intl.get('重试')}
                  </Button>
                </span>
              )}
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
              {currentCron.last_execution_time &&
              currentCron.last_running_time != null
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
          tabBarExtraContent={!isPhone && scriptActions}
        >
          {isPhone && scriptActions ? (
            <div className="cron-detail-script-panel">
              <div className="cron-detail-script-actions">{scriptActions}</div>
              <div className="cron-detail-script-editor">
                {contentList[activeTabKey]}
              </div>
            </div>
          ) : (
            contentList[activeTabKey]
          )}
        </Card>
      </div>
      {isLogModalVisible && (
        <CronLogModal
          handleCancel={() => {
            setIsLogModalVisible(false);
            void refreshDetails();
          }}
          cron={cron}
          key={logUrl}
          logUrl={logUrl}
        />
      )}
    </Modal>
  );
};

export default CronDetailModal;
