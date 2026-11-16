import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Empty, Input, Popover, Spin, Typography } from 'antd';
import { FileOutlined, FolderOutlined, ArrowUpOutlined, ReloadOutlined } from '@ant-design/icons';
import intl from 'react-intl-universal';
import config from '@/utils/config';
import { request } from '@/utils/http';
import { readableLogName } from './name';
import './index.less';

type Entry = { key: string; title: string; parent: string; type: 'file' | 'directory'; size?: number };
type Listing = { rows: Entry[]; next: string; versions: Map<string, string | null>; retryMinimum?: number; retryAfter?: string };
type ReadingPosition = { scrollTop: number; offsets: Map<string, number> };
const emptyListing: Listing = { rows: [], next: '', versions: new Map() };
type Props = {
  source: 'logs' | 'scripts'; value?: string; initialDirectory?: string; revision?: number; folders?: boolean;
  onSelect: (entry: Entry) => void; onDoubleClick?: (entry: Entry) => void;
};

// Match readDirectoryPage's depth-first search and directory-first listing order.
function pastCursor(cursor: string, boundary: string, source: Props['source'], search: string) {
  if (search) {
    // A directory's children precede its next sibling. NUL cannot occur in a filename.
    return cursor.replace(/\//g, '\0') > boundary.replace(/\//g, '\0');
  }
  if (source === 'logs' && cursor.startsWith('1') && boundary.startsWith('1')) return cursor < boundary;
  return cursor > boundary;
}

function Entries({ source, path, search, folders, value, open, onDoubleClick }: Props & {
  path: string; search: string; open: (entry: Entry) => void;
}) {
  const listing = useRef(emptyListing);
  const [visible, setListing] = useState(listing.current);
  const { rows, next } = visible;
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController>();
  const viewport = useRef<HTMLDivElement>(null);
  const position = useRef<ReadingPosition>();
  function rememberPosition() {
    const element = viewport.current;
    if (!element || position.current) return;
    const top = element.getBoundingClientRect().top;
    const offsets = new Map<string, number>();
    for (const row of Array.from(element.querySelectorAll<HTMLButtonElement>('button[title]'))) {
      const rect = row.getBoundingClientRect();
      if (rect.top >= top + element.clientHeight) break;
      if (rect.bottom > top) offsets.set(row.title, rect.top - top);
    }
    if (offsets.size) position.current = { scrollTop: element.scrollTop, offsets };
  }
  useLayoutEffect(() => {
    const element = viewport.current;
    const saved = position.current;
    if (!element || !saved || visible.retryMinimum !== undefined) return;
    position.current = undefined;
    const top = element.getBoundingClientRect().top;
    for (const [key, offset] of saved.offsets) {
      const row = element.querySelector<HTMLButtonElement>(`button[title="${CSS.escape(key)}"]`);
      if (row) {
        element.scrollTop += row.getBoundingClientRect().top - top - offset;
        return;
      }
    }
    element.scrollTop = saved.scrollTop;
  }, [visible]);
  async function read(previous: Listing) {
    if (pending.current || listing.current !== previous) return;
    const after = previous.next;
    const controller = new AbortController();
    pending.current = controller;
    setLoading(true);
    setFailed(false);
    try {
      const url = config.apiPrefix + source + '/entries';
      const options = { signal: controller.signal, retryInPlace: true };
      const minimum = previous.retryMinimum ?? (previous.rows.length + 1);
      const boundary = previous.retryAfter ?? after;
      // Rebuild the visible prefix if an external change crossed the cursor.
      // Bound automatic restarts so a busy directory still offers a manual retry.
      for (let attempt = 0; attempt < 3; attempt++) {
        const append = attempt === 0 && Boolean(after);
        const batch = append ? [...previous.rows] : [];
        const seen = new Map(append ? previous.versions : emptyListing.versions);
        let current = true;
        let cursor = append ? after : '';
        do {
          const result = await request.get<{code: number; data: Entry[]; next: string | null; versions?: [string, string | null][]}>(url, {
            ...options, params: { path, after: cursor, search, folders },
          });
          if (controller.signal.aborted) return;
          if (result.code !== 200 || !Array.isArray(result.data)) throw new Error();
          for (const [dir, version] of result.versions || []) {
            if (seen.has(dir) && seen.get(dir) !== version) current = false;
            seen.set(dir, version);
          }
          batch.push(...result.data);
          cursor = result.next || '';
        } while (current && cursor && (batch.length < minimum ||
          (!append && boundary && !pastCursor(cursor, boundary, source, search))));

        // Recheck even a terminal page: the response itself may have been delayed.
        const stamps = [...seen];
        for (let i = 0; current && i < stamps.length; i += 128) {
          const check = await request.post<{code: number; current: boolean}>(url + '/check', stamps.slice(i, i + 128), options);
          if (controller.signal.aborted) return;
          if (check.code !== 200) throw new Error();
          current = check.current;
        }
        if (current) {
          listing.current = { rows: batch, next: cursor, versions: seen };
          setListing(listing.current);
          return;
        }
        // The old rows and cursor are stale, but a manual retry must reach the
        // same depth even if this read exhausts its retries or loses the network.
        rememberPosition();
        listing.current = { ...emptyListing, retryMinimum: minimum, retryAfter: boundary };
        setListing(listing.current);
      }
      setFailed(true);
    } catch {
      if (!controller.signal.aborted) setFailed(true);
    } finally {
      if (!controller.signal.aborted) { pending.current = undefined; setLoading(false); }
    }
  }
  useEffect(() => {
    void read(listing.current);
    return () => { pending.current?.abort(); pending.current = undefined; };
  }, []);
  return <div className="file-browser-entries" ref={viewport}>
    {rows.map(item => {
      const name = source === 'logs' ? readableLogName(item.title) : item.title;
      // Prefer a complete suffix such as "_register.js" or "___init__".
      const tail = name.match(/[_ .-].{4,14}$/su)?.[0] ?? Array.from(name).slice(-10).join('');
      return <button type="button" key={item.key} title={item.key} aria-label={item.key} aria-pressed={value === item.key}
        onClick={() => open(item)} onDoubleClick={() => onDoubleClick?.(item)}>
        {item.type === 'directory' ? <FolderOutlined /> : <FileOutlined />}
        <span className="file-browser-label">
          <span className="file-browser-name">
            <span>{name.slice(0, name.length - tail.length)}</span><span>{tail}</span>
          </span>
          {search && item.parent && <Typography.Text type="secondary" className="file-browser-parent">{item.parent}</Typography.Text>}
        </span>
      </button>;
    })}
    {loading || failed || next ? <div className="file-browser-pagination">
      {loading ? <Spin size="small" /> : <Button type="link"
        icon={failed ? <ReloadOutlined aria-hidden /> : undefined} onClick={() => read(visible)}>
        {intl.get(failed ? '重试' : '加载更多')}</Button>}
    </div> : !rows.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
  </div>;
}

export function FileBrowser(props: Props) {
  const [path, setPath] = useState(props.initialDirectory || '');
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => { setPath(props.initialDirectory || ''); }, [props.initialDirectory]);
  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), 220);
    return () => clearTimeout(timer);
  }, [input]);
  const open = (entry: Entry) => {
    if (entry.type === 'directory') { setPath(entry.key); setInput(''); setSearch(''); }
    props.onSelect(entry);
  };
  return <div className="file-browser">
    <Input.Search allowClear value={input} onChange={e => setInput(e.target.value)}
      placeholder={intl.get(props.source === 'logs' ? '搜索日志名称' : '搜索脚本名称')} />
    {!input.trim() && path && <div className="file-browser-location">
      <Button size="small" type="text" icon={<ArrowUpOutlined aria-hidden="true" />}
        onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}>{intl.get('上一级')}</Button>
      <Typography.Text type="secondary" className="file-browser-path" dir="auto" title={path}>{path}</Typography.Text>
    </div>}
    {input.trim() === search
      ? <Entries key={JSON.stringify([props.source, path, search, props.revision, props.folders])} {...props} path={path} search={search} open={open} />
      : <Spin size="small" />}
  </div>;
}

export function FilePicker({ onChange, ...props }: Omit<Props,'onSelect'> & { onSelect?: Props['onSelect']; onChange?: (key: string) => void }) {
  const [visible, setVisible] = useState(false);
  return <Popover trigger="click" open={visible} onOpenChange={setVisible} content={<div className="file-picker">
    {visible && <FileBrowser {...props} onSelect={entry => {
      if (props.folders || entry.type === 'file') {
        onChange?.(entry.key); props.onSelect?.(entry);
        if (!props.folders) setVisible(false);
      }
    }} />}
    {props.folders && <Button onClick={() => { onChange?.(''); setVisible(false); }}>{intl.get('根目录')}</Button>}
  </div>}>
    <Button className="file-picker-label" title={props.value}>{props.value || intl.get(props.folders ? '请选择父目录' : props.source === 'logs' ? '请选择日志' : '请选择脚本')}</Button>
  </Popover>;
}
