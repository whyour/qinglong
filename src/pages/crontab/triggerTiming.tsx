import dayjs from 'dayjs';
import intl from 'react-intl-universal';
import type { TriggerEntry } from './triggerUpdates';

function elapsed(start?: number, end?: number) {
  if (start == null || end == null || end < start) return;
  const ms = end - start;
  if (ms < 1000) return ms + ' ms';
  return ms / 1000 + ' s';
}

export function QueueReason({
  context,
  live = false,
}: {
  context: string;
  live?: boolean;
}) {
  const admission: {
    queue: string;
    limit: number;
    occupied: number;
    holders: { id?: string; name: string }[];
  } = JSON.parse(context);
  return (
    <div className="queue-reason">
      <strong>
        {intl.get(
          admission.queue === 'global'
            ? '全局执行队列'
            : admission.queue === 'manual'
            ? '手动执行队列'
            : '定时执行队列',
        )}
      </strong>
      {' · '}
      {intl.get(
        live
          ? '最近一次检查（运行 {used}，上限 {limit}）'
          : '入队时已达并发上限（运行 {used}，上限 {limit}）',
        { used: admission.occupied, limit: admission.limit },
      )}
      <ul>
        {admission.holders.map((holder, i) => (
          <li key={holder.id ?? i}>
            {holder.name}
            {holder.id && (
              <>
                {' '}
                · <code title={holder.id}>{holder.id.slice(-8)}</code>
              </>
            )}
          </li>
        ))}
      </ul>
      {admission.occupied > admission.holders.length &&
        intl.get('仅列出最早开始运行的 8 个实例')}
    </div>
  );
}

export default function TriggerTiming({
  row,
  open,
  onToggle,
}: {
  row: TriggerEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const queued = row.state === 'queued';
  const skipped = row.state === 'skipped';
  const unknown = row.state === 'unknown';
  const terminal = !queued && row.state !== 'running';
  const start =
    row.scheduled_at ?? row.queued_at ?? row.started_at ?? row.observed_at;
  const startLabel =
    row.scheduled_at != null
      ? '计划运行'
      : row.queued_at != null
      ? '进入队列'
      : row.started_at != null
      ? '记录启动'
      : '记录时间';
  const endLabel = skipped ? '跳过时间' : unknown ? '状态记录时间' : '结束时间';
  const queueEnd =
    row.dequeued_at ??
    row.started_at ??
    (queued
      ? Date.now()
      : skipped || row.state === 'stopped'
      ? row.finished_at
      : undefined);
  const wait =
    queued && row.queue_wait_ms != null
      ? elapsed(0, row.queue_wait_ms)
      : elapsed(row.queued_at, queueEnd);
  const launch = elapsed(row.scheduled_at, row.command_started_at);
  const entryDelay = elapsed(
    row.scheduled_at ?? row.queued_at ?? row.started_at,
    row.script_started_at,
  );
  const entryLabel =
    row.scheduled_at != null
      ? '计划到脚本开始'
      : row.queued_at != null
      ? '入队到脚本开始'
      : '启动记录到脚本开始';
  const time = (value: number, precise: boolean) => {
    const date = dayjs(value);
    const format = date.isSame(start, 'day')
      ? 'HH:mm:ss'
      : 'YYYY-MM-DD HH:mm:ss';
    return date.format(precise ? format + '.SSS' : format);
  };
  const timestamps: [string, number | undefined][] = [
    ['计划运行', row.scheduled_at],
    ['进入队列', row.queued_at],
    [
      row.queued_at != null ? '排队结束' : '记录启动',
      row.dequeued_at ?? row.started_at,
    ],
    ['命令启动', row.command_started_at],
    ['脚本开始执行（采样）', row.script_started_at],
    [endLabel, row.finished_at],
  ];

  return (
    <>
      <div className="trigger-history-summary">
        <span>
          {intl.get(startLabel)}{' '}
          <b>{dayjs(start).format('YYYY-MM-DD HH:mm:ss')}</b>
        </span>
        {queued && wait != null && (
          <span>
            {intl.get('已排队')} <b>{wait}</b>
          </span>
        )}
        {!skipped && !queued && launch != null && (
          <span>
            {intl.get('计划到命令启动')} <b>{launch}</b>
          </span>
        )}
        {row.scheduled_at == null && row.command_started_at != null && (
          <span>
            {intl.get('命令启动')} <b>{time(row.command_started_at, false)}</b>
          </span>
        )}
        {!skipped && !queued && wait != null && (
          <span>
            {intl.get('排队等待')} <b>{wait}</b>
          </span>
        )}
        {terminal && row.finished_at != null && !unknown && !skipped && (
          <span>
            {intl.get(endLabel)} <b>{time(row.finished_at, false)}</b>
          </span>
        )}
        {row.exit_code != null && row.exit_code !== 0 && (
          <span>
            {intl.get('退出码')} <b>{row.exit_code}</b>
          </span>
        )}
      </div>
      <details className="trigger-history-timing" open={open}>
        <summary
          onClick={(event) => {
            event.preventDefault();
            onToggle();
          }}
        >
          {intl.get('时间明细')}
        </summary>
        {queued && row.dequeued_at != null ? (
          <p>{intl.get('排队结束，正在准备命令')}</p>
        ) : queued && row.queue_live_context ? (
          <QueueReason live context={row.queue_live_context} />
        ) : (
          row.queue_context && <QueueReason context={row.queue_context} />
        )}
        {queued &&
          row.dequeued_at == null &&
          !row.queue_context &&
          !row.queue_live_context && (
            <p>{intl.get('正在排队，尚无同时运行的任务记录')}</p>
          )}
        <dl className="trigger-timestamps">
          {timestamps.map(([key, value]) => (
            <div key={key}>
              <dt>{intl.get(key)}</dt>
              <dd>
                {value != null
                  ? time(value, true)
                  : intl.get(
                      key === '脚本开始执行（采样）'
                        ? '未采集到开始时间'
                        : '未记录',
                    )}
              </dd>
            </div>
          ))}
        </dl>
        {(entryDelay != null || (skipped && wait != null)) && (
          <div className="trigger-history-summary">
            {skipped && wait != null && (
              <span>
                {intl.get('跳过前等待')} <b>{wait}</b>
              </span>
            )}
            {entryDelay != null && (
              <span>
                {intl.get(entryLabel)} <b>{entryDelay}</b>
              </span>
            )}
          </div>
        )}
      </details>
    </>
  );
}
