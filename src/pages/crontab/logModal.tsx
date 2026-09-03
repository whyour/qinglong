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
  qingLong3Credential,
  type QingLong3Capabilities,
} from '@/utils/qinglong3';
import {
  Loading3QuartersOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import { PageLoading } from '@ant-design/pro-layout';
import { logEnded } from '@/utils';
import { CrontabStatus } from './type';
import Ansi from 'ansi-to-react';

const { Countdown } = Statistic;

const ACTIVE_RUN_STATUSES = new Set([
  'created',
  'queued',
  'dispatching',
  'running',
  'waiting_approval',
  'retry_wait',
  'lost',
]);

async function qingLong3Get(path: string, acceptedStatuses: number[] = []) {
  const credential = qingLong3Credential();
  if (!credential) throw new Error('QL3_AUTHENTICATION_REQUIRED');
  const response = await fetch(path, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${credential}`,
    },
  });
  const value = await response.json();
  if (!response.ok && !acceptedStatuses.includes(response.status)) {
    throw new Error(
      typeof value?.code === 'string' ? value.code : 'QL3_REQUEST_UNAVAILABLE',
    );
  }
  return { status: response.status, value };
}

function decodeQingLong3Log(content: unknown): string {
  if (typeof content !== 'string') throw new Error('QL3_LOG_INVALID');
  const binary = atob(content);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function readQingLong3CronLog(
  cron: any,
  capabilities: Readonly<QingLong3Capabilities>,
): Promise<Readonly<{ log: string; active: boolean }>> {
  const projectId = cron?.ql3?.projectId;
  const taskId = cron?.ql3?.taskId;
  const triggerId = cron?.ql3?.triggerId;
  if (
    typeof projectId !== 'string' ||
    typeof taskId !== 'string' ||
    typeof triggerId !== 'string'
  ) {
    throw new Error('QL3_CRON_IDENTITY_INVALID');
  }

  let remaining = capabilities.limits.cronRows;
  let cursor: { createdAtMs: number; runId: string } | undefined;
  let matchedRun: any;
  while (remaining > 0) {
    const limit = Math.min(capabilities.limits.cronPageSize, remaining);
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) {
      query.set('after_created_at_ms', String(cursor.createdAtMs));
      query.set('after_run_id', cursor.runId);
    }
    const { value: page } = await qingLong3Get(
      `/api/v3/projects/${projectId}/runs?${query.toString()}`,
    );
    if (!Array.isArray(page?.runs) || page.runs.length > limit) {
      throw new Error('QL3_RUN_PAGE_INVALID');
    }
    matchedRun = page.runs.find(
      (run: any) => run?.triggerId === triggerId && run?.taskId === taskId,
    );
    if (matchedRun) break;
    remaining -= page.runs.length;
    if (!page.hasMore || !page.next || page.runs.length === 0) break;
    cursor = page.next;
  }
  if (!matchedRun) {
    return { log: intl.get('暂无日志'), active: false };
  }

  const { value: detail } = await qingLong3Get(
    `/api/v3/projects/${projectId}/runs/${matchedRun.id}`,
  );
  const attempt = detail?.run?.latestAttempt;
  const status = detail?.run?.status;
  const active = ACTIVE_RUN_STATUSES.has(status);
  if (!attempt?.id || attempt.logAvailable !== true) {
    return {
      log: `${intl.get('暂无日志')}\n\nRun: ${matchedRun.id}\nStatus: ${
        status || 'unknown'
      }`,
      active,
    };
  }

  const length = capabilities.limits.logChunkBytes;
  const { status: responseStatus, value: logView } = await qingLong3Get(
    `/api/v3/projects/${projectId}/runs/${matchedRun.id}/attempts/${attempt.id}/log?offset=0&length=${length}`,
    [202, 410],
  );
  if (responseStatus === 202 || logView?.status === 'pending') {
    return { log: `日志尚未就绪\n\nRun: ${matchedRun.id}`, active };
  }
  if (responseStatus === 410 || logView?.status === 'retired') {
    return {
      log: `日志已按保留策略清理\n\nRun: ${matchedRun.id}`,
      active: false,
    };
  }
  if (logView?.status !== 'available' || logView?.encoding !== 'base64') {
    throw new Error('QL3_LOG_INVALID');
  }
  const suffix =
    logView.range?.nextOffset !== undefined
      ? `\n\n[仅显示前 ${length} 字节，可点击刷新重新读取当前片段]`
      : logView.truncation?.truncated === true
      ? '\n\n[日志已按运行时保留上限截断]'
      : '';
  return {
    log:
      `${decodeQingLong3Log(logView.content)}${suffix}` || intl.get('暂无日志'),
    active,
  };
}

const CronLogModal = ({
  cron,
  handleCancel,
  data,
  logUrl,
  qingLong3,
}: {
  cron?: any;
  handleCancel: () => void;
  data?: string;
  logUrl?: string;
  qingLong3?: Readonly<QingLong3Capabilities> | null;
}) => {
  const [value, setValue] = useState<string>(intl.get('启动中...'));
  const [loading, setLoading] = useState<any>(true);
  const [executing, setExecuting] = useState<any>(true);
  const [isPhone, setIsPhone] = useState(false);
  const scrollInfoRef = useRef({ value: 0, down: true });
  const uniqPath = logUrl ? logUrl : String(cron?.id);

  const getCronLog = (isFirst?: boolean) => {
    if (isFirst) {
      setLoading(true);
    }
    if (qingLong3) {
      readQingLong3CronLog(cron, qingLong3)
        .then(({ log, active }) => {
          if (localStorage.getItem('logCron') !== uniqPath) return;
          setValue(log);
          setExecuting(active);
          setTimeout(() => autoScroll());
        })
        .catch(() => {
          setValue('日志读取失败，请检查凭据或稍后重试');
          setExecuting(false);
        })
        .finally(() => setLoading(false));
      return;
    }
    request
      .get(logUrl ? logUrl : `${config.apiPrefix}crons/${cron.id}/log`)
      .then(({ code, data, logStatus }) => {
        if (
          code === 200 &&
          localStorage.getItem('logCron') === uniqPath &&
          data !== value
        ) {
          const log = (data as string) || intl.get('暂无日志');
          setValue(log);
          const hasNext = logStatus === 'running';
          if (!hasNext && !logEnded(value) && value !== intl.get('启动中...')) {
            setTimeout(() => {
              autoScroll();
            });
          }
          setExecuting(hasNext);
          if (hasNext) {
            setTimeout(() => {
              autoScroll();
              getCronLog();
            }, 2000);
          }
        }
      })
      .finally(() => {
        if (isFirst) {
          setLoading(false);
        }
      });
  };

  const autoScroll = () => {
    if (!scrollInfoRef.current.down) {
      return;
    }

    setTimeout(() => {
      document
        .querySelector('#log-flag')
        ?.scrollIntoView({ behavior: 'smooth' });
    }, 600);
  };

  const cancel = () => {
    localStorage.removeItem('logCron');
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
        {(executing || loading) && <Loading3QuartersOutlined spin />}
        {!executing && !loading && <CheckCircleOutlined />}
        <Typography.Text ellipsis={true} style={{ marginLeft: 5 }}>
          {cron && cron.name}
        </Typography.Text>
      </div>
    );
  };

  useEffect(() => {
    if (cron && cron.id) {
      getCronLog(true);
    }
  }, [cron]);

  useEffect(() => {
    if (data) {
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
        ...(qingLong3
          ? [
              <Button key="refresh" onClick={() => getCronLog(true)}>
                刷新
              </Button>,
            ]
          : []),
        <Button key="close" type="primary" onClick={() => cancel()}>
          {intl.get('知道了')}
        </Button>,
      ]}
    >
      <div onScroll={handleScroll} className="log-container">
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
            <Ansi>{value}</Ansi>
          </pre>
        )}
        <div id="log-flag"></div>
      </div>
    </Modal>
  );
};

export default CronLogModal;
