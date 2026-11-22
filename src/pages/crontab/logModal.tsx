import intl from 'react-intl-universal';
import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  message,
  Input,
  Form,
  Statistic,
  Button,
  Typography,
} from 'antd';
import { request } from '@/utils/http';
import config from '@/utils/config';
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { PageLoading } from '@ant-design/pro-layout';
import { CrontabStatus } from './type';
import Ansi from 'ansi-to-react';

const { Countdown } = Statistic;
const LOG_CHUNK_BYTES = 256 * 1024;
const MAX_LOG_VIEW_CHARS = 1024 * 1024;

const CronLogModal = ({
  cron,
  handleCancel,
  data,
  logUrl,
}: {
  cron?: any;
  handleCancel: () => void;
  data?: string;
  logUrl?: string;
}) => {
  const [value, setValue] = useState<string>(intl.get('启动中...'));
  const [loading, setLoading] = useState<any>(true);
  const [executing, setExecuting] = useState<any>(true);
  const [readFailed, setReadFailed] = useState(false);
  const [isPhone, setIsPhone] = useState(false);
  const scrollInfoRef = useRef({ value: 0, down: true });
  const logOffsetRef = useRef<number>();
  const valueRef = useRef(value);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const session = useRef<AbortController>();
  const reading = useRef(false);
  const pinnedTrigger = useRef<string>();
  const lastPath = useRef<string>();
  const drained = useRef(false);
  const lastCursor = useRef<string>();
  const scrollTimer = useRef<ReturnType<typeof setTimeout>>();
  const logEndRef = useRef<HTMLDivElement>(null);

  const getCronLog = (isFirst?: boolean) => {
    const signal = session.current?.signal;
    if (!signal || signal.aborted || reading.current) return;
    reading.current = true;
    drained.current = false;
    if (isFirst) {
      setLoading(true);
    }
    const baseUrl = logUrl ? logUrl : `${config.apiPrefix}crons/${cron.id}/log`;
    const triggerParam =
      !logUrl && pinnedTrigger.current
        ? '&triggerId=' + encodeURIComponent(pinnedTrigger.current)
        : '';
    const separator = baseUrl.includes('?') ? '&' : '?';
    const offset = isFirst ? undefined : logOffsetRef.current;
    const pagination = `${separator}limit=${LOG_CHUNK_BYTES}${
      isFirst ? '&tail=true' : offset !== undefined ? `&offset=${offset}` : ''
    }`;
    const pathParam =
      offset !== undefined && lastPath.current
        ? '&previousPath=' + encodeURIComponent(lastPath.current)
        : '';
    const cursorParam =
      offset !== undefined && lastCursor.current
        ? '&cursor=' + lastCursor.current
        : '';
    request
      .get(
        `${baseUrl}${pagination}${pathParam}${cursorParam}${triggerParam}&follow=true`,
        { signal, retryInPlace: true },
      )
      .then(
        ({
          code,
          data,
          logStatus,
          logPath,
          triggerId,
          cursor,
          reset,
          nextOffset,
          total,
        }) => {
          if (signal.aborted) {
            return;
          }

          if (code !== 200) throw new Error('Log read failed');
          setReadFailed(false);
          const isRunning = logStatus === 'running';
          // A completed process can still have multiple unread chunks. Drain
          // them before stopping, without presenting it as a running task.
          if (triggerId) pinnedTrigger.current = triggerId;
          const changedFile = reset === true || lastPath.current !== logPath;
          const hasUnread =
            typeof nextOffset === 'number' &&
            typeof total === 'number' &&
            nextOffset > (changedFile ? 0 : offset ?? 0) &&
            nextOffset < total;
          const hasNext = isRunning || hasUnread;
          const chunk = (data as string) || '';
          lastPath.current = logPath;
          lastCursor.current = cursor;
          // A missing file can return a localized status message with zero bytes.
          // Keep that message out of the buffer used for subsequent appends.
          const noBytes = total === 0;
          if (
            !isFirst &&
            !changedFile &&
            offset !== undefined &&
            total > 0 &&
            total < offset
          ) {
            logOffsetRef.current = undefined;
            pollTimerRef.current = setTimeout(() => getCronLog(true), 0);
            return;
          }
          let log =
            isFirst || changedFile || noBytes || offset === undefined
              ? chunk
              : valueRef.current + chunk;
          if (!log && !hasNext) {
            log = intl.get('暂无日志');
          }
          if (log.length > MAX_LOG_VIEW_CHARS) {
            log = log.slice(-MAX_LOG_VIEW_CHARS);
          }
          valueRef.current = noBytes ? '' : log;
          setValue(log);
          if (typeof nextOffset === 'number') {
            logOffsetRef.current = nextOffset;
          }
          drained.current = !hasNext;
          setExecuting(isRunning);

          if (chunk || !hasNext) {
            autoScroll();
          }
          if (hasNext) {
            pollTimerRef.current = setTimeout(
              () => getCronLog(),
              hasUnread ? 0 : 2000,
            );
          }
        },
      )
      .catch(() => {
        if (!signal.aborted) setReadFailed(true);
      })
      .finally(() => {
        if (!signal.aborted) {
          reading.current = false;
          if (isFirst) setLoading(false);
        }
      });
  };

  const autoScroll = () => {
    if (!scrollInfoRef.current.down) {
      return;
    }

    clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(() => {
      logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, 600);
  };

  const stopReading = () => {
    session.current?.abort();
    clearTimeout(pollTimerRef.current);
    clearTimeout(scrollTimer.current);
  };

  const cancel = () => {
    stopReading();
    handleCancel();
  };

  const handleScroll: React.UIEventHandler<HTMLDivElement> = (e) => {
    const sTop = (e.target as HTMLDivElement).scrollTop;
    if (scrollInfoRef.current.down) {
      scrollInfoRef.current = {
        value: sTop,
        down: sTop - scrollInfoRef.current.value > -5 || !sTop,
      };
    }
  };

  const titleElement = () => {
    return (
      <div style={{ display: 'flex', alignItems: 'center' }}>
        {!readFailed && (executing || loading) && (
          <Loading3QuartersOutlined spin />
        )}
        {!readFailed && !executing && !loading && <CheckCircleOutlined />}
        <Typography.Text ellipsis={true} style={{ marginLeft: 5 }}>
          {cron && cron.name}
          {pinnedTrigger.current &&
            lastPath.current &&
            ` · ${lastPath.current.split('/').pop()}`}
        </Typography.Text>
      </div>
    );
  };

  useEffect(() => {
    session.current = new AbortController();
    reading.current = false;
    logOffsetRef.current = undefined;
    pinnedTrigger.current = undefined;
    lastPath.current = undefined;
    lastCursor.current = undefined;
    if (cron?.id) getCronLog(true);
    return stopReading;
  }, [cron?.id, logUrl]);

  // The list already refreshes while the dialog is open. A later run can
  // start (and finish) after this viewer drained the previous file.
  useEffect(() => {
    if (logUrl || pinnedTrigger.current || !cron || !drained.current) return;
    if (
      (cron.log_path && cron.log_path !== lastPath.current) ||
      cron.status === CrontabStatus.running ||
      cron.status === CrontabStatus.queued
    ) {
      getCronLog();
    }
  }, [cron]);

  useEffect(() => {
    if (data) {
      valueRef.current = data;
      setValue(data);
    }
  }, [data]);

  useEffect(() => {
    setIsPhone(document.body.clientWidth < 768);
  }, []);

  return (
    <Modal
      title={titleElement()}
      open={true}
      centered
      className="log-modal"
      forceRender
      onOk={() => cancel()}
      onCancel={() => cancel()}
      footer={[
        <Button type="primary" onClick={() => cancel()}>
          {intl.get('知道了')}
        </Button>,
      ]}
    >
      <div onScroll={handleScroll} className="log-container">
        {readFailed && (
          <div role="status">
            {intl.get('加载失败')}
            <Button
              type="link"
              onClick={() => {
                setReadFailed(false);
                getCronLog(logOffsetRef.current === undefined);
              }}
            >
              {intl.get('重试')}
            </Button>
          </div>
        )}
        {loading ? (
          <PageLoading />
        ) : (
          <pre
            style={
              isPhone
                ? {
                    fontFamily: 'Source Code Pro',
                    zoom: 0.83,
                  }
                : {}
            }
          >
            <Ansi>
              {readFailed && logOffsetRef.current === undefined ? '' : value}
            </Ansi>
          </pre>
        )}
        <div ref={logEndRef} />
      </div>
    </Modal>
  );
};

export default CronLogModal;
