import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Table } from 'antd';
import intl from 'react-intl-universal';
import { request } from '@/utils/http';
import config from '@/utils/config';
import type { Overview } from './index';

const titles = {
  missing: '未收到触发记录',
  skipped: '触发后跳过',
  unconfirmed: '启动未确认',
};
export interface AnomalySelection {
  kind: keyof typeof titles;
  source: 'panel' | 'system';
  at: number;
  count: number;
  session?: number;
  deadline?: number;
}
interface Row {
  task: number;
  name?: string;
  time: number | null;
  observed: number | null;
  source: string;
  rule: string | null;
  ruleIndex?: number;
  trigger: string | null;
  reason: string | null;
  hasLog: boolean;
}
interface Result {
  summary: NonNullable<Overview['triggers']>;
  rows: Row[];
  page: number;
  total: number;
  pageSize: number;
  revision: string;
  changed: boolean;
  zone: string;
}

export function AnomalyMetric({
  kind,
  count,
  open,
}: {
  kind: AnomalySelection['kind'];
  count?: number;
  open: () => void;
}) {
  return (
    <div className="ant-statistic">
      <div className="ant-statistic-title">{intl.get(titles[kind])}</div>
      <div className="ant-statistic-content">
        {count != null && count > 0 ? (
          <button
            className="anomaly-count"
            onClick={open}
            aria-label={intl.get('{title}，查看 {count} 条明细', {
              title: intl.get(titles[kind]),
              count,
            })}
          >
            {count.toLocaleString()}
          </button>
        ) : (
          count ?? '—'
        )}
      </div>
    </div>
  );
}

const reasons: Record<string, string> = {
  pending: '上一次定时触发仍在排队或运行',
  overlap: '上一次执行仍在运行',
  changed: '任务已变更或取消',
  queue_timeout: '超过排队时限',
  capacity: '该任务的待执行次数已达上限',
  restart: '服务重启',
  spawn: '启动或执行失败',
  cancelled: '已取消',
};

function explanation(kind: AnomalySelection['kind'], row: Row) {
  if (kind === 'missing')
    return intl.get(
      row.source === 'system'
        ? '规则已生效，计划过了一分钟仍无匹配的系统触发记录。'
        : '规则已生效，统计时未找到本轮计划的触发记录。',
    );
  const reason =
    row.reason &&
    (reasons[row.reason] ? intl.get(reasons[row.reason]) : row.reason);
  if (kind === 'skipped')
    return reason || intl.get('已记录跳过，未提供具体原因。');
  return [intl.get('已收到触发，缺少可核实命令已启动的记录。'), reason]
    .filter(Boolean)
    .join(' ');
}

export default function ScheduleAnomalies({
  selection,
  close,
  openLog,
  onUpdate,
  onInvalidate,
}: {
  onUpdate: (
    selection: AnomalySelection,
    summary: NonNullable<Overview['triggers']>,
  ) => void;
  onInvalidate: (
    selection: AnomalySelection,
    reason: 'expired' | 'unavailable',
  ) => void;
  selection: AnomalySelection;
  close: () => void;
  openLog: (id: number, trigger: string, name?: string) => void;
}) {
  const [query, setQuery] = useState<{ page: number; revision?: string }>({
    page: 1,
  });
  const [response, setResponse] = useState<{
    query: typeof query;
    result: Result;
  }>();
  const data = response?.query === query ? response.result : undefined;
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const expiresAt = useRef<number>();
  useEffect(() => {
    const ctrl = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let deadline: ReturnType<typeof setTimeout>;
    const invalidate = (reason: 'expired' | 'unavailable') => {
      ctrl.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
      onInvalidate(selection, reason);
    };
    const deadlineAt = expiresAt.current ?? selection.deadline;
    if (deadlineAt != null) {
      const remaining = deadlineAt - performance.now();
      if (remaining <= 0) {
        invalidate('expired');
        return () => ctrl.abort();
      }
      deadline = setTimeout(() => invalidate('expired'), remaining);
    }
    let cursor = { ...query };
    setFailed(false);
    setLoading(true);
    async function refresh() {
      try {
        const requestedAt = performance.now();
        const { code, data } = await request.get(
          config.apiPrefix + 'dashboard/schedule-anomalies',
          {
            params: {
              kind: selection.kind,
              source: selection.source,
              at: selection.at,
              live: true,
              ...cursor,
            },
            signal: ctrl.signal,
            retryInPlace: true,
          },
        );
        if (ctrl.signal.aborted) return;
        if (code !== 200) throw new Error();
        if (data.status === 'expired' || data.status === 'unavailable') {
          invalidate(data.status);
          return;
        }
        const remaining =
          data.expiresAt - data.serverNow - (performance.now() - requestedAt);
        if (Number.isFinite(remaining)) {
          if (remaining <= 0) {
            invalidate('expired');
            return;
          }
          clearTimeout(deadline);
          expiresAt.current = performance.now() + remaining;
          deadline = setTimeout(() => invalidate('expired'), remaining);
        }
        cursor = { page: data.page, revision: data.revision };
        setResponse({ query, result: data });
        onUpdate(selection, data.summary);
        timer = setTimeout(refresh, 5000);
      } catch {
        if (!ctrl.signal.aborted) setFailed(true);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }
    void refresh();
    return () => {
      ctrl.abort();
      clearTimeout(timer);
      clearTimeout(deadline);
    };
  }, [selection, query, onUpdate, onInvalidate]);
  const format = (ms: number) =>
    new Date(ms).toLocaleString(undefined, {
      timeZone: data?.zone,
      hour12: false,
    });
  return (
    <Modal
      open
      width={860}
      title={
        <>
          {intl.get(titles[selection.kind])} ·{' '}
          {intl.get(
            selection.source === 'panel' ? '内置调度' : '系统调度（crond）',
          )}
        </>
      }
      onCancel={close}
      footer={null}
    >
      <p>
        {intl.get('截至 {time} 的计划，明细随回报更新。', {
          time: format(selection.at - 5000),
        })}
      </p>
      {failed ? (
        <Alert
          type="error"
          message={
            <>
              {intl.get('加载失败')}{' '}
              <Button type="link" onClick={() => setQuery({ ...query })}>
                {intl.get('重试')}
              </Button>
            </>
          }
        />
      ) : (
        <>
          {data && (data.changed || data.total !== selection.count) && (
            <Alert
              type="info"
              showIcon
              message={intl.get(
                data.changed
                  ? '记录已更新，已返回第一页，当前共 {count} 条。'
                  : '触发记录已有更新，当前共 {count} 条。',
                { count: data.total },
              )}
            />
          )}
          <Table<Row>
            size="small"
            loading={loading}
            dataSource={data?.rows ?? []}
            scroll={{ x: 660 }}
            rowKey={(row) =>
              row.trigger ??
              [row.task, row.time, row.ruleIndex, row.rule].join('/')
            }
            pagination={
              data && {
                current: data.page,
                pageSize: data.pageSize,
                total: data.total,
                showSizeChanger: false,
                showTotal: (total) => intl.get('总条数', { total }),
                onChange: (page) => setQuery({ page, revision: data.revision }),
              }
            }
            columns={[
              {
                title: intl.get('任务'),
                render: (_, r) => (
                  <>
                    {r.name || '#' + r.task}
                    <br />
                    <small>{r.rule}</small>
                  </>
                ),
              },
              {
                title: intl.get('计划时间'),
                render: (_, r) =>
                  r.time != null ? (
                    format(r.time)
                  ) : (
                    <>
                      {intl.get('计划时间无法确定')}
                      <br />
                      <small>
                        {r.observed != null &&
                          intl.get('收到于 {time}', {
                            time: format(r.observed),
                          })}
                      </small>
                    </>
                  ),
              },
              {
                title: intl.get('调度来源'),
                render: (_, r) =>
                  intl.get(
                    r.source === 'system'
                      ? '系统调度（crond）'
                      : r.source === 'recovery'
                      ? '重启补跑'
                      : '内置调度',
                  ),
              },
              {
                title: intl.get('判断原因'),
                render: (_, r) => explanation(selection.kind, r),
              },
              {
                title: intl.get('日志'),
                render: (_, r) =>
                  r.hasLog && r.trigger ? (
                    <Button
                      type="link"
                      size="small"
                      onClick={() => openLog(r.task, r.trigger!, r.name)}
                    >
                      {intl.get('查看日志')}
                    </Button>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        </>
      )}
    </Modal>
  );
}
