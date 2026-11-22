import { useEffect, useRef, useState } from 'react';
import { Button, List, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import intl from 'react-intl-universal';
import TriggerTiming from './triggerTiming';
import {
  pageSize,
  createTriggerPoll,
  type TriggerEntry as Entry,
} from './triggerUpdates';
import config from '@/utils/config';
import { request } from '@/utils/http';

const names: Record<string, string> = {
  client: '客户端执行',
  legacy: '旧版客户端',
  manual: '手动运行',
  boot: '开机运行',
  node: '定时触发',
  system: '系统定时',
  recovery: '重启补跑',
  queued: '队列中',
  running: '运行中',
  finished: '已完成',
  failed: '失败',
  skipped: '已跳过',
  pending: '上一次定时触发仍在排队或运行',
  cancelled: '已取消',
  unknown: '结果未知',
  exit_pending: '等待确认执行结果',
  exit_conflict: '收到的结束记录不一致',
  stopped: '已停止',
  overlap: '上一次执行仍在运行',
  changed: '任务已变更或取消',
  queue_timeout: '超过排队时限',
  capacity: '该任务的待执行次数已达上限',
  restart: '服务重启',
  spawn: '启动或执行失败',
};
export default function TriggerList({
  id,
  onViewLog,
}: {
  id: number;
  onViewLog: (row: Entry) => void;
}) {
  const [before, setBefore] = useState<Entry | null>(null);
  const [rows, setRows] = useState<Entry[]>([]);
  const [nextCursor, setNextCursor] = useState<Entry | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [hasNew, setHasNew] = useState(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const updateStatus = useRef<ReturnType<typeof createTriggerPoll>>();
  const rowsRef = useRef(rows);
  const headRef = useRef<Entry>();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(new Set());
  const expanded = !!before;
  // Pinning only the first page supports an immediate full refresh on reopen.
  // Once paging, changes in selection share the existing workers and queue.
  const firstPageSelection = expanded ? null : openIds;
  const inspecting = rows.some((row) => openIds.has(row.id));
  const paused = !before && inspecting;
  const pinned = expanded || inspecting;
  const pageRequest = useRef<AbortController>();
  const statusRequest = useRef<AbortController>();
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(() => {
    const controller = new AbortController();
    pageRequest.current = controller;
    if (paused) {
      setLoading(false);
      return () => controller.abort();
    }
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const { data } = await request.get(
          `${config.apiPrefix}crons/${id}/triggers`,
          {
            signal,
            retryInPlace: true,
            params: {
              limit: pageSize + 1,
              withQueueWait: true,
              ...(before && {
                beforeTime: before.observed_at,
                beforeId: before.id,
              }),
            },
          },
        );
        if (signal.aborted) return;
        if (!Array.isArray(data)) throw new Error('Invalid trigger history');
        const entries = data.slice(0, pageSize);
        setRows((previous) => (before ? [...previous, ...entries] : entries));
        setNextCursor(data.length > pageSize ? entries[pageSize - 1] : null);
        setFailed(false);
      } catch {
        if (!signal.aborted) setFailed(true);
      } finally {
        if (!signal.aborted) {
          setLoading(false);
          if (!before) timer = setTimeout(refresh, 5000);
        }
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, before, attempt, paused]);

  useEffect(() => {
    const head = headRef.current;
    if (!pinned || !head) return;
    const controller = new AbortController();
    statusRequest.current = controller;
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    const update = createTriggerPoll(
      head,
      async (params) => {
        params.set('withQueueWait', 'true');
        const { data } = await request.get(
          `${config.apiPrefix}crons/${id}/triggers`,
          // Give waiting batches a turn after two polling intervals.
          { params, signal, retryInPlace: true, timeout: 10000 },
        );
        if (!Array.isArray(data)) throw new Error('Invalid trigger history');
        return data;
      },
      () => !signal.aborted,
      setHasNew,
      (ids, entries) => {
        const requested = new Set(ids);
        const updated = new Map(entries.map((entry) => [entry.id, entry]));
        setRows((previous) =>
          previous.flatMap((row) => {
            if (!requested.has(row.id)) return [row];
            const current = updated.get(row.id);
            return current ? [current] : [];
          }),
        );
      },
      setRefreshFailed,
      openIds,
    );
    updateStatus.current = update;
    function poll() {
      if (signal.aborted) return;
      update(rowsRef.current);
      timer = setTimeout(poll, 5000);
    }
    poll();
    return () => {
      updateStatus.current = undefined;
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, pinned, firstPageSelection]);

  useEffect(() => {
    if (expanded) updateStatus.current?.(rowsRef.current, openIds);
  }, [expanded, openIds]);

  const label = (key: string) => (names[key] ? intl.get(names[key]) : key);
  return (
    <section aria-label={intl.get('触发记录')}>
      {pinned && (hasNew || refreshFailed) && (
        <Space wrap role="status">
          {hasNew && (
            <Button
              type="link"
              onClick={() => {
                pageRequest.current?.abort();
                pageRequest.current = undefined;
                statusRequest.current?.abort();
                setOpenIds(new Set());
                setRows([]);
                setNextCursor(null);
                setHasNew(false);
                setRefreshFailed(false);
                setFailed(false);
                setLoading(true);
                setBefore(null);
              }}
            >
              {intl.get('查看新的触发记录')}
            </Button>
          )}
          {refreshFailed && (
            <>
              <Typography.Text type="secondary">
                {intl.get('触发状态刷新失败')}
              </Typography.Text>
              <Button
                type="link"
                onClick={() => updateStatus.current?.(rowsRef.current, 'retry')}
              >
                {intl.get('重试')}
              </Button>
            </>
          )}
        </Space>
      )}
      <List
        rowKey="id"
        className="trigger-history"
        loading={loading && !rows.length}
        dataSource={rows}
        renderItem={(row) => (
          <List.Item key={row.id}>
            <div className="trigger-history-entry" data-trigger-id={row.id}>
              <div className="trigger-history-header">
                <Space size={8} wrap>
                  <Tag>{label(row.state)}</Tag>
                  <span>{label(row.source)}</span>
                  {row.reason && (
                    <Typography.Text type="secondary">
                      {label(row.reason)}
                    </Typography.Text>
                  )}
                </Space>
                {row.log_path && row.log_path !== '/dev/null' && (
                  <Button
                    type="link"
                    size="small"
                    onClick={() => onViewLog(row)}
                  >
                    {intl.get('查看日志')}
                  </Button>
                )}
              </div>
              <TriggerTiming
                row={row}
                open={openIds.has(row.id)}
                onToggle={() => {
                  if (!expanded) statusRequest.current?.abort();
                  if (!pinned) {
                    headRef.current = rows[0];
                    pageRequest.current?.abort();
                    // An open and close may be batched without ever committing a pinned page.
                    setAttempt((value) => value + 1);
                    setFailed(false);
                    setHasNew(false);
                    setRefreshFailed(false);
                  }
                  setOpenIds((previous) => {
                    const next = new Set(previous);
                    if (next.has(row.id)) next.delete(row.id);
                    else next.add(row.id);
                    return next;
                  });
                }}
              />
            </div>
          </List.Item>
        )}
      />
      {(nextCursor || failed) && (
        <div className="trigger-history-pagination">
          {failed && <span role="status">{intl.get('加载失败')}</span>}
          <Button
            type="link"
            loading={loading}
            icon={failed ? <ReloadOutlined aria-hidden /> : undefined}
            onClick={() => {
              if (loading || !pageRequest.current) return;
              pageRequest.current.abort();
              // Reserve this transition until the effect installs its next controller.
              pageRequest.current = undefined;
              setLoading(true);
              if (failed) setAttempt((value) => value + 1);
              else {
                if (!expanded) headRef.current = rows[0];
                setBefore(nextCursor);
              }
            }}
          >
            {intl.get(failed ? '重试' : '加载更早记录')}
          </Button>
        </div>
      )}
    </section>
  );
}
