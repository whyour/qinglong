import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, List, Space } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import useScrollHeight from '@/hooks/useScrollHeight';
import intl from 'react-intl-universal';
import VirtualList from 'rc-virtual-list';
import type { ListRef } from 'rc-virtual-list';
import config from '@/utils/config';
import { request } from '@/utils/http';
import { pageSize } from './triggerUpdates';

const paginationRow = { id: 'pagination' };

export default function InstanceHistory({
  id,
  revision,
  children,
}: {
  id: number;
  revision: number;
  children: (row: any) => React.ReactElement;
}) {
  const state = useRef({
    rows: [] as any[],
    next: null as number | null,
    expanded: false,
    head: 0,
    hasNew: false,
  });
  const visibleIds = useRef(new Set<number>());
  const [view, setView] = useState(state.current);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState<'' | 'older' | 'refresh' | 'latest'>('');
  const pending = useRef<AbortController>();
  const paging = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const list = useRef<ListRef>(null);
  const listHeight = useScrollHeight(viewport);
  const showPagination = Boolean(failed || view.next || view.expanded);
  const items = useMemo(
    () => (showPagination ? [...view.rows, paginationRow] : view.rows),
    [view.rows, showPagination],
  );
  async function load(action: 'older' | 'refresh' | 'latest') {
    if (action === 'older' && !state.current.next) return;
    if (pending.current && (action === 'refresh' || paging.current)) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    paging.current = action !== 'refresh';
    setBusy(true);
    // A failed first page request must retry from the snapshot the user opened.
    if (action === 'older' && !state.current.expanded) {
      state.current = { ...state.current, expanded: true };
      setView(state.current);
    }
    const previous = state.current;
    const read = async (params: any) => {
      const result = await request.get<{
        code: number;
        data: any[];
        next?: number | null;
      }>(`${config.apiPrefix}crons/${id}/instances`, {
        params: { paged: true, ...params },
        signal: controller.signal,
        retryInPlace: true,
      });
      if (result.code !== 200 || !Array.isArray(result.data)) throw new Error();
      return result;
    };
    try {
      let result = previous;
      if (action === 'refresh' && previous.expanded) {
        const latest = await read({ limit: 1 });
        if (controller.signal.aborted) return;
        const active = previous.rows.filter(
          (row) =>
            row.status === 0 ||
            row.status === 4 ||
            visibleIds.current.has(row.id),
        );
        const updates = new Map<number, any>();
        for (let i = 0; i < active.length; i += pageSize) {
          const ids = active.slice(i, i + pageSize).map((row) => row.id);
          const page = await read({ ids: ids.join(',') });
          if (controller.signal.aborted) return;
          ids.forEach((id) => updates.set(id, undefined));
          page.data.forEach((r: any) => updates.set(r.id, r));
        }
        result = {
          ...previous,
          hasNew: latest.data[0]?.id > previous.head,
          rows: previous.rows
            .map((r) => (updates.has(r.id) ? updates.get(r.id) : r))
            .filter(Boolean),
        };
      } else {
        const more = action === 'older';
        const page = await read({
          limit: pageSize,
          ...(more && { before: previous.next }),
        });
        result = {
          rows: more ? [...previous.rows, ...page.data] : page.data,
          next: page.next ?? null,
          expanded: more,
          head: more ? previous.head : page.data[0]?.id ?? 0,
          hasNew: more && previous.hasNew,
        };
      }
      if (!controller.signal.aborted) {
        state.current = result;
        setView(result);
        if (action === 'latest') list.current?.scrollTo(0);
        setFailed((old) =>
          action === 'refresh' && old !== 'refresh' ? old : '',
        );
      }
    } catch {
      if (!controller.signal.aborted)
        setFailed((old) => (action === 'refresh' && old ? old : action));
    } finally {
      if (!controller.signal.aborted) {
        pending.current = undefined;
        paging.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    void load('refresh');
    const timer = setInterval(() => void load('refresh'), 10000);
    return () => {
      clearInterval(timer);
      pending.current?.abort();
      pending.current = undefined;
      paging.current = false;
    };
  }, [id, revision]);
  const pagination = (
    <div className="instance-history-pagination">
      <Space wrap>
        {failed && (
          <Button
            type="link"
            icon={<ReloadOutlined aria-hidden />}
            onClick={() => load(failed)}
          >
            {intl.get('重试')}
          </Button>
        )}
        {!!view.next && failed !== 'older' && (
          <Button
            type="link"
            disabled={busy && paging.current}
            onClick={() => load('older')}
          >
            {intl.get('加载更早记录')}
          </Button>
        )}
        {view.expanded && failed !== 'latest' && (
          <Button
            type="link"
            disabled={busy && paging.current}
            onClick={() => load('latest')}
          >
            {intl.get(view.hasNew ? '查看新的运行记录' : '查看最新记录')}
          </Button>
        )}
      </Space>
    </div>
  );
  return (
    <div className="instance-history" ref={viewport}>
      <List loading={busy && !view.rows.length}>
        {listHeight > 0 && (
          <VirtualList
            ref={list}
            data={items}
            height={listHeight}
            itemHeight={52}
            itemKey="id"
            onVisibleChange={(rows) => {
              visibleIds.current = new Set(
                rows
                  .filter((row) => row !== paginationRow)
                  .map((row) => row.id),
              );
            }}
          >
            {(row) => (row === paginationRow ? pagination : children(row))}
          </VirtualList>
        )}
      </List>
    </div>
  );
}
