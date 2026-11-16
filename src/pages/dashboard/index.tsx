import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Card, Col, Popover, Row, Statistic, Table, Tabs, Tag, Spin, Empty } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
  InfoCircleOutlined,
  ThunderboltOutlined,
  StopOutlined,
  BarChartOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-layout';
import { useOutletContext } from '@umijs/max';
import { Area, Gauge } from '@ant-design/plots';
import intl from 'react-intl-universal';
import { SharedContext } from '@/layouts';
import { request } from '@/utils/http';
import config from '@/utils/config';
import CronLogModal from '../crontab/logModal';
import { QueueReason } from '../crontab/triggerTiming';
import TimingStatistic from './timingStatistic';
import TaskResultModal from './taskResultModal';
import './index.less';

interface Overview {
  total: number;
  enabled: number;
  disabled: number;
  triggers?: { audit?: {
    since: number; through: number; zone: string; partial?: boolean; expected: number; observed: number; missing: number;
    onTime: number; dispatched: number; commandSamples: number; skipped: number; queued: number; unconfirmed: number;
    waitSamples?: number;
    triggerDeviationP95: number | null; waitP95: number | null; commandStartP95: number | null;
    scriptStartP95: number | null; scriptSamples: number;
  } | null; systemAudit?: {
    since: number; confirmedAt: number | null; pending: boolean; partial: boolean; expected: number; observed: number;
    dispatched: number; skipped: number; missing: number; unmatched: number; duplicates: number; actualStarts: number; actualSkips?: number; uncertain: number; awaiting: number; switchSlots: number;
    recent: { time: number; task: number; name?: string; status: string; id?: string; triggerCount?: number; startCount?: number; skipCount?: number; unknownExitCount?: number }[];
  } | null };
  todayRuns: number;
  todaySuccess: number;
  todayFail: number;
  todayStopped: number;
  successRate: string;
  avgTime: number;
}

interface TrendItem {
  date: string;
  total: number;
  success: number;
  fail: number;
}

interface TopItem {
  rank: number;
  name: string;
  avgTime?: number;
  maxTime?: number;
  runCount?: number;
  successRate?: string;
}

interface Runtime {
  runningCount: number;
  queuedCount: number;
  queuedTasks: number;
  oldestQueued?: { id: string; name: string; queued_at: number; queue_context?: string; queue_live_context?: string }[];
  running: Array<{ instanceId: number; id: number; name: string; pid: number; elapsed: number; logPath: string }>;
  idleTasks: Array<{ id: number; name: string; lastRun: string }>;
}

interface SystemInfo {
  platform: string;
  uptime: number;
  memTotal: number;
  memFree: number;
  memUsagePercent: string;
  heapUsed: number;
  heapTotal: number;
  loadAvg: number[];
  cpus: number;
  hostCpus: number;
  hostMemory: number;
}

const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
};

const formatSeconds = (s: number) => {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
};

const REFRESH_INTERVAL = 30000;

function ScheduleRate({ title, count, total }: { title: string; count?: number; total: number }) {
  const measured = count != null && total > 0;
  const percent = measured ? (100 * count / total).toFixed(1) : null;
  return (
    <Statistic
      title={title}
      value={measured && percent === '100.0' && count < total ? '>99.9%' : measured ? `${percent}%` : '—'}
      suffix={measured ? <small>({count}/{total})</small> : undefined}
    />
  );
}

function formatCount(raw: number | string) {
  const count = Number(raw);
  const locale = document.documentElement.lang || navigator.language;
  return <span title={count.toLocaleString(locale)}>{count.toLocaleString(locale,
    count >= 100000 ? { notation: 'compact', maximumFractionDigits: 1 } : {})}</span>;
}

const Dashboard = () => {
  const { headerStyle, theme } = useOutletContext<SharedContext>();
  const isDark = theme === 'vs-dark';
  const [overview, setOverview] = useState<Overview | null>(null);
  const [trend, setTrend] = useState<TrendItem[]>([]);
  const [topTime, setTopTime] = useState<TopItem[]>([]);
  const [topCount, setTopCount] = useState<TopItem[]>([]);
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [labels, setLabels] = useState<any[]>([]);
  const [logCron, setLogCron] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [overviewFailed, setOverviewFailed] = useState(false);
  const [result, setResult] = useState<'success' | 'failure' | null>(null);

  const [selectedSource, setSelectedSource] = useState<string>();
  const [helpOpen, setHelpOpen] = useState(false);
  const helpButton = useRef<HTMLButtonElement>(null);
  const helpPopover = useRef<{ forcePopupAlign(): void }>(null);
  const [helpContent, setHelpContent] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const button = helpButton.current;
    const popup = helpContent?.closest<HTMLElement>('.ant-popover');
    const arrow = popup?.querySelector<HTMLElement>('.ant-popover-arrow');
    if (!helpOpen || !button || !helpContent || !popup || !arrow) return;

    // Ant moves the popup to fit the viewport. Center the arrow on the trigger
    // after each alignment, even when the popup itself can no longer be centered.
    const alignArrow = () => {
      const trigger = button.getBoundingClientRect();
      const box = popup.getBoundingClientRect();
      if (box.width) arrow.style.left = `${(trigger.left + trigger.width / 2 - box.left) * popup.offsetWidth / box.width}px`;
    };
    const viewport = window.visualViewport;
    const positionHelp = () => {
      const trigger = button.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const height = viewport?.height ?? window.innerHeight;
      const space = Math.max(trigger.top - top, top + height - trigger.bottom);
      const chromeHeight = popup.offsetHeight - helpContent.offsetHeight;
      // Leave room for the pointer, padding and viewport edge on the side that fits.
      helpContent.style.maxHeight = `${Math.max(0, Math.min(height * 0.65, space - chromeHeight - 8))}px`;
      helpPopover.current?.forcePopupAlign();
      alignArrow();
    };
    const onScroll = (event: Event) => {
      if (!(event.target instanceof Node && popup.contains(event.target))) positionHelp();
    };
    positionHelp();
    const resize = new ResizeObserver(positionHelp);
    resize.observe(button.closest('.schedule-overview')!);
    resize.observe(helpContent);
    const visibility = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) setHelpOpen(false);
    });
    visibility.observe(button);
    const observer = new MutationObserver(alignArrow);
    observer.observe(popup, { attributes: true, attributeFilter: ['style', 'class'] });
    popup.addEventListener('animationend', alignArrow);
    window.addEventListener('resize', positionHelp);
    window.addEventListener('scroll', onScroll, true);
    viewport?.addEventListener('resize', positionHelp);
    viewport?.addEventListener('scroll', positionHelp);
    return () => {
      observer.disconnect();
      resize.disconnect();
      visibility.disconnect();
      popup.removeEventListener('animationend', alignArrow);
      window.removeEventListener('resize', positionHelp);
      window.removeEventListener('scroll', onScroll, true);
      viewport?.removeEventListener('resize', positionHelp);
      viewport?.removeEventListener('scroll', positionHelp);
    };
  }, [helpOpen, helpContent]);
  const audit = overview?.triggers?.audit;
  const systemAudit = overview?.triggers?.systemAudit;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const pending = new Set<string>();

    async function refresh<T>(section: string, apply: (data: T) => void) {
      if (pending.has(section)) return;
      pending.add(section);
      try {
        const response = await request.get<{ code: number; data: T }>(
          `${config.apiPrefix}dashboard/${section}`, { signal, retryInPlace: true },
        );
        if (signal.aborted) return;
        if (response.code === 200) apply(response.data);
        if (section === 'overview') setOverviewFailed(response.code !== 200);
      } catch {
        if (!signal.aborted && section === 'overview') setOverviewFailed(true);
      } finally {
        pending.delete(section);
        if (!signal.aborted && section === 'overview') setLoading(false);
      }
    }

    function poll() {
      void refresh<Overview>('overview', setOverview);
      void refresh<TrendItem[]>('trend', setTrend);
      void refresh<TopItem[]>('top-time', setTopTime);
      void refresh<TopItem[]>('top-count', setTopCount);
      void refresh<Runtime>('runtime', setRuntime);
      void refresh<SystemInfo>('system', setSystem);
      void refresh<any[]>('labels', setLabels);
    }

    poll();
    const timer = setInterval(poll, REFRESH_INTERVAL);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, []);

  const trendConfig = {
    data: trend.flatMap((d) => [
      { date: d.date, value: d.total, type: intl.get('总执行') },
      { date: d.date, value: d.success, type: intl.get('成功') },
      { date: d.date, value: d.fail, type: intl.get('失败') },
    ]),
    xField: 'date',
    yField: 'value',
    seriesField: 'type',
    smooth: true,
    height: 260,
    color: ['#1677ff', '#52c41a', '#ff4d4f'],
    legend: { position: 'top' as const },
    theme: isDark ? 'dark' : 'light',
    xAxis: {
      label: { style: { fill: isDark ? '#aaa' : '#333' } },
    },
    yAxis: {
      label: { style: { fill: isDark ? '#aaa' : '#333' } },
      grid: { line: { style: { stroke: isDark ? '#333' : '#eee' } } },
    },
  };

  const runtimePagination = {
    pageSize: 5,
    showSizeChanger: false,
    showTotal: (total: number) => intl.get('总条数', { total }),
  };

  if (loading) return <Spin size="large" style={{ display: 'block', marginTop: 100 }} />;

  const sources = [];
  if (audit) {
    const timings = [
      { title: intl.get('触发时间偏差 P95'), ms: audit.triggerDeviationP95, samples: audit.observed },
      { title: intl.get('排队等待 P95'), ms: audit.waitP95, samples: audit.waitSamples },
      { title: intl.get('计划到命令启动 P95'), ms: audit.commandStartP95, samples: audit.commandSamples },
      { title: intl.get('计划到脚本开始 P95'), ms: audit.scriptStartP95, samples: audit.scriptSamples },
    ];
    sources.push({
      key: 'panel',
      label: intl.get('由青龙触发'),
      help: <>
        {audit.partial && <p className="schedule-note">{intl.get('规则切换期间有些计划无法确认。这里只统计能确认的计划，暂不显示准时率。')}</p>}
        <p className="schedule-note">{intl.get('从 {time} 起统计，最近 5 秒暂不计入。触发时间与计划相差不超过 5 秒算准时。准时率 = 准时触发次数 ÷ 计划触发次数。', {
          time: new Date(audit.since).toLocaleTimeString(undefined, {timeZone: audit.zone, hour12: false}),
        })}</p>
        <h4>{intl.get('样本与计算方式')}</h4>
        <dl className="schedule-metrics timing-samples">
          {timings.map(({ title, samples }) => <div key={title}>
            <dt>{title}</dt>
            <dd>{samples == null ? '—' : intl.get('{count} 个样本', { count: samples })}</dd>
          </div>)}
        </dl>
        <p className="schedule-note">{intl.get('P95 取各项样本从小到大排列的第 95 百分位。触发偏差比较计划时间与收到触发的时间，包含迟到后跳过的记录。排队等待只统计从入队到取得执行资格的耗时，旧记录用开始派发时间估算。直接执行命令时可能没有脚本开始样本。')}</p>
      </>,
      children: <>
        <div className="schedule-metrics">
          <Statistic title={intl.get('计划触发次数')} value={audit.expected} />
          <Statistic title={intl.get('未收到触发记录')} value={audit.missing} />
          <Statistic title={intl.get('有触发记录的计划')} value={audit.observed} />
          <ScheduleRate title={intl.get('准时触发率')} count={audit.partial ? undefined : audit.onTime} total={audit.expected} />
          <Statistic title={intl.get('命令已启动')} value={audit.dispatched} />
          <Statistic title={intl.get('触发后跳过')} value={audit.skipped} />
          <Statistic title={intl.get('仍在排队')} value={audit.queued} />
          <Statistic title={intl.get('启动未确认')} value={audit.unconfirmed} />
        </div>
        <details className="schedule-details">
          <summary>{intl.get('查看启动耗时')}</summary>
          <div className="schedule-metrics">
            {timings.map(({ title, ms }) => <TimingStatistic key={title} title={title} ms={ms} />)}
          </div>
        </details>
      </>,
    });
  }
  if (systemAudit) {
    sources.push({
      key: 'system',
      label: intl.get('由系统触发（crond）'),
      help: <>
        <p className="schedule-note">{intl.get('同一计划多出的记录计为重复。只有明确记录的跳过才计入跳过次数。记录写入前中断的派发无法核实。')}</p>
        <p className="schedule-note">{intl.get('上次成功安装规则')} {systemAudit.confirmedAt ? new Date(systemAudit.confirmedAt).toLocaleString() : '—'}
          {' · '}{intl.get('按任务、规则和系统发出命令的分钟匹配。超过计划时间一分钟仍无记录，显示“未收到触发记录”。')}</p>
        {(systemAudit.uncertain>0 || systemAudit.awaiting>0 || systemAudit.switchSlots>0) &&
          <p>{intl.get('等待触发记录 {waiting} 次，无法确定触发分钟 {uncertain} 次，无法确定生效规则 {switches} 次。', {waiting:systemAudit.awaiting,uncertain:systemAudit.uncertain,switches:systemAudit.switchSlots})}</p>}
        {(systemAudit.partial || systemAudit.pending) && <p>{intl.get('部分时段的计划还无法确定，只统计能确认的计划。')}</p>}
      </>,
      children: <>
        <h4>{intl.get('按计划统计')}</h4>
        <div className="schedule-metrics">
          <Statistic title={intl.get('计划触发次数')} value={systemAudit.expected} />
          <Statistic title={intl.get('有触发记录的计划')} value={systemAudit.observed} />
          <Statistic title={intl.get('未收到触发记录')} value={systemAudit.missing} />
        </div>
        <h4 className="schedule-group-title">{intl.get('按触发记录统计（共 {count} 条）', {
          count: systemAudit.observed + systemAudit.duplicates + systemAudit.unmatched,
        })}</h4>
        <div className="schedule-metrics">
          <Statistic title={intl.get('命令启动次数')} value={systemAudit.actualStarts} />
          <Statistic title={intl.get('跳过次数')} value={systemAudit.actualSkips ?? '—'} />
          <Statistic title={intl.get('重复触发次数')} value={systemAudit.duplicates} />
          <Statistic title={intl.get('找不到对应计划的触发记录')} value={systemAudit.unmatched} />
        </div>
        <details className="schedule-details"><summary>{intl.get('查看最近 25 次计划触发')}</summary>
          <Table size="small" pagination={false} dataSource={systemAudit.recent} rowKey={r => r.task + '/' + r.time} columns={[
            {title:intl.get('计划时间'),render:(_,r) => new Date(r.time).toLocaleTimeString()},
            {title:intl.get('任务'),render:(_,r) => r.name || '#' + r.task},
            {title:intl.get('匹配的触发记录'),dataIndex:'triggerCount',render:count => count ?? '—'},
            {title:intl.get('执行情况'),render:(_, row) => {
              const { triggerCount = 0, startCount = 0, skipCount = 0, unknownExitCount = 0 } = row;
              const unconfirmed = triggerCount - startCount - skipCount;
              const status = triggerCount > 1 ? [
                startCount > 0 && intl.get('启动 {count} 次', {count: startCount}),
                skipCount > 0 && intl.get('跳过 {count} 次', {count: skipCount}),
                unconfirmed > 0 && intl.get('启动未确认 {count} 次', {count: unconfirmed}),
              ].filter(Boolean).join(' · ') : intl.get(({
                started:'命令已启动', skipped:'已跳过', unconfirmed:'启动未确认', missing:'未收到触发记录',
                switch:'生效规则不确定', uncertain:'触发分钟不确定', awaiting:'等待触发记录',
              } as Record<string,string>)[row.status]);
              if (!unknownExitCount) return status;
              return <>{status} · {triggerCount === 1 ? intl.get('结果未知') :
                intl.get('其中 {count} 次执行结果未知', { count: unknownExitCount })}</>;
            }},
            {title:intl.get('执行 ID（示例）'),render:(_,r) => r.id ? <code title={r.id}>{r.id.slice(-8)}</code> : '—'},
          ]} />
        </details>
      </>,
    });
  }

  const activeSource = sources.find(source => source.key === selectedSource)
    ?? sources.find(source => source.key === (audit?.expected || audit?.partial ? 'panel' : 'system'))
    ?? sources[0];

  return (
    <PageContainer
      title={intl.get('仪表盘')}
      header={{ style: headerStyle }}
      className={'ql-container-wrapper dashboard-wrapper'}
    >
      <Row className="dashboard-totals" gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('总任务')} value={overview?.total || 0} formatter={formatCount} prefix={<BarChartOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('已启用')} value={overview?.enabled || 0} formatter={formatCount} valueStyle={{ color: '#1677ff' }} prefix={<CheckCircleOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('今日执行')} value={overview?.todayRuns || 0} formatter={formatCount}
            valueStyle={{ color: '#1677ff' }} prefix={<ThunderboltOutlined />} />
            {!!overview?.todayStopped && <small>{intl.get('已停止')} {overview.todayStopped}</small>}
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('成功率')} value={`${overview?.successRate || '0'}%`} valueStyle={{ color: '#52c41a' }} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small" hoverable role="button" tabIndex={0}
            aria-label={intl.get('今日成功')}
            onClick={() => setResult('success')}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setResult('success');
              }
            }}
          ><Statistic title={intl.get('今日成功')} value={overview?.todaySuccess || 0} formatter={formatCount} valueStyle={{ color: '#52c41a' }} prefix={<CheckCircleOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small" hoverable role="button" tabIndex={0}
            aria-label={intl.get('今日失败')}
            onClick={() => setResult('failure')}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setResult('failure');
              }
            }}
          ><Statistic title={intl.get('今日失败')} value={overview?.todayFail || 0} formatter={formatCount} valueStyle={{ color: '#ff4d4f' }} prefix={<CloseCircleOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('平均耗时')} value={overview?.avgTime ? `${(overview.avgTime / 1000).toFixed(1)}s` : '-'} prefix={<ClockCircleOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('已禁用')} value={overview?.disabled || 0} formatter={formatCount} prefix={<StopOutlined />} /></Card>
        </Col>
      </Row>
      {overviewFailed && overview && <p role="status">{intl.get('刷新失败，仍显示上次的数据')}</p>}
      <Card size="small" className="schedule-overview" title={<>
        {intl.get('今日定时调度')}
        {activeSource && <Popover
          ref={helpPopover}
          trigger={['hover', 'focus', 'click']}
          placement="bottom"
          open={helpOpen}
          onOpenChange={setHelpOpen}
          content={<div ref={setHelpContent} className="schedule-help">{activeSource.help}</div>}
        >
          <Button ref={helpButton} className="schedule-help-button" type="text" size="small"
            aria-label={intl.get('调度统计说明')} aria-expanded={helpOpen}
            icon={<InfoCircleOutlined />} onKeyDown={event => {
              if (event.key === 'Escape') setHelpOpen(false);
            }} />
        </Popover>}
      </>}>
        {sources.length === 2 ? (
          <Tabs items={sources.map(({ key, label, children }) => ({ key, label, children }))}
            activeKey={activeSource?.key} onChange={setSelectedSource} />
        ) : sources.length === 1 ? (
          sources[0].children
        ) : (
          <p>{intl.get(overview?.triggers ? '暂时无法确认应触发的计划，未收到触发的次数和准时率未知。' : '暂时无法显示调度数据。')}</p>
        )}
        {overview?.triggers && systemAudit === undefined && (
          <p className="schedule-note">{intl.get('当前面板服务未提供系统定时任务统计。')}</p>
        )}
      </Card>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={24}>
          <Card title={intl.get('近 7 日趋势')} size="small">
            {trend.length > 0 ? <Area {...trendConfig} /> : <Empty description={intl.get('暂无数据')} />}
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card title={intl.get('今日耗时 Top 5')} size="small">
            <Table
              dataSource={topTime}
              rowKey="rank"
              pagination={false}
              size="small"
              columns={[
                { title: '#', dataIndex: 'rank', width: 40 },
                { title: intl.get('定时任务'), dataIndex: 'name', ellipsis: true },
                { title: intl.get('平均耗时'), dataIndex: 'avgTime', width: 100, render: (v: number) => v ? `${(v / 1000).toFixed(1)}s` : '-' },
                { title: intl.get('最长单次'), dataIndex: 'maxTime', width: 100, render: (v: number) => v ? `${(v / 1000).toFixed(1)}s` : '-' },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card title={intl.get('今日执行次数 Top 5')} size="small">
            <Table
              dataSource={topCount}
              rowKey="rank"
              pagination={false}
              size="small"
              columns={[
                { title: '#', dataIndex: 'rank', width: 40 },
                { title: intl.get('定时任务'), dataIndex: 'name', ellipsis: true },
                { title: intl.get('次数'), dataIndex: 'runCount', width: 60 },
                { title: intl.get('平均耗时'), dataIndex: 'avgTime', width: 100, render: (v: number) => v ? `${(v / 1000).toFixed(1)}s` : '-' },
                { title: intl.get('成功率'), dataIndex: 'successRate', width: 80, render: (v: string) => `${v}%` },
              ]}
            />
          </Card>
        </Col>
      </Row>

      {labels.length > 0 && (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col span={24}>
            <Card title={intl.get('标签统计')} size="small">
              <Table
                dataSource={labels}
                rowKey="label"
                pagination={false}
                size="small"
                columns={[
                  { title: intl.get('标签'), dataIndex: 'label', width: 150, render: (v: string) => <Tag>{v}</Tag> },
                  { title: intl.get('任务数'), dataIndex: 'count', width: 80 },
                  { title: intl.get('今日执行'), dataIndex: 'todayRuns', width: 100 },
                  { title: intl.get('成功率'), dataIndex: 'successRate', width: 100, render: (v: string) => `${v}%` },
                  { title: intl.get('平均耗时'), dataIndex: 'avgTime', width: 120, render: (v: number) => v ? `${(v / 1000).toFixed(1)}s` : '-' },
                ]}
              />
            </Card>
          </Col>
        </Row>
      )}

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={12}>
          <Card
            title={intl.get('实时运行态')}
            size="small"
            extra={
              <>
                <Tag color="processing">{intl.get('运行中')} {runtime?.runningCount || 0}</Tag>
                <Tag color="warning">{intl.get('排队中 {runs} 次，涉及 {tasks} 个任务', { runs: runtime?.queuedCount || 0, tasks: runtime?.queuedTasks || 0 })}</Tag>
              </>
            }
          >
            {!!runtime?.oldestQueued?.length && <details className="schedule-details"><summary>{intl.get('查看排队原因')}</summary>
              {runtime.oldestQueued.map(row => <div className="queue-entry" key={row.id}>
                <b>{row.name}</b>{' · '}{intl.get('已排队')} {formatSeconds(Math.max(0, Math.floor((Date.now()-row.queued_at)/1000)))}
                {row.queue_live_context ? <QueueReason live context={row.queue_live_context} /> : row.queue_context ? <QueueReason context={row.queue_context} /> : <p>{intl.get('正在排队，尚无同时运行的任务记录')}</p>}
              </div>)}
              {runtime.queuedCount > runtime.oldestQueued.length && intl.get('仅显示等待最久的 25 个实例')}
            </details>}
            <Table
              dataSource={runtime?.running || []}
              rowKey="instanceId"
              pagination={runtime && runtime.running.length > 5 ? runtimePagination : false}
              size="small"
              locale={{ emptyText: <Empty description={intl.get('暂无运行中任务')} /> }}
              columns={[
                { title: intl.get('定时任务'), dataIndex: 'name', ellipsis: true, render: (name: string, record) => {
                  const sameTaskCount = (runtime?.running || []).filter(r => r.id === record.id).length;
                  return sameTaskCount > 1 ? <span>{name} <Tag color="processing" style={{ fontSize: 10, lineHeight: '16px' }}>×{sameTaskCount}</Tag></span> : name;
                } },
                { title: 'PID', dataIndex: 'pid', width: 80 },
                { title: intl.get('已运行'), dataIndex: 'elapsed', width: 100, render: (v: number) => v ? formatSeconds(v) : '-' },
                { title: intl.get('日志'), dataIndex: 'id', width: 60, render: (id, record) => <a onClick={() => { setLogCron({ id, instanceId: record.instanceId, name: record.name }); }}>{intl.get('查看')}</a> },
              ]}
            />
            {runtime?.idleTasks && runtime.idleTasks.length > 0 && (
              <>
                <div style={{ marginTop: 12, fontSize: 13, color: '#ff7a00' }}>
                  {intl.get('24小时未运行')} ({runtime.idleTasks.length})
                </div>
                <Table
                  dataSource={runtime.idleTasks}
                  rowKey="id"
                  pagination={false}
                  size="small"
                  showHeader={false}
                  columns={[
                    { dataIndex: 'name', ellipsis: true },
                    { dataIndex: 'lastRun', width: 110, render: (v: string) => <span style={{ color: '#999' }}>{v}</span> },
                  ]}
                />
              </>
            )}
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card title={intl.get('系统资源')} size="small">
            {system && (
              <Row gutter={[16, 16]} align="middle">
                <Col span={12}>
                  <Gauge
                    height={300}
                    data={{
                      target: Number(system.memUsagePercent),
                      total: 100,
                      name: intl.get('内存使用'),
                    }}
                    style={{
                      textY: '70%',
                      textContent: (target: number, total: number) => {
                        return `${intl.get('内存')}：${target}%`;
                      },
                    }}
                  />
                </Col>
                <Col span={12}>
                  <Statistic title={intl.get('系统运行')} value={formatSeconds(system.uptime)} />
                  <Statistic title={intl.get('堆内存')} value={`${system.heapUsed} MB`} valueStyle={{ fontSize: 16 }} />
                  <div style={{ marginTop: 8, color: '#888', fontSize: 12 }}>
                    {intl.get('负载 1m')}: {system.loadAvg?.[0] ?? '-'} | CPU: {system.cpus} {intl.get('核心')} | {system.platform}
                    <br />{intl.get('可用内存上限')} {(system.memTotal / 1024 ** 3).toFixed(2)} GiB
                    {(system.hostCpus !== system.cpus || system.hostMemory !== system.memTotal) &&
                      <> · {intl.get('宿主机资源')} {system.hostCpus} CPU / {(system.hostMemory / 1024 ** 3).toFixed(2)} GiB</>}
                  </div>
                </Col>
              </Row>
            )}
          </Card>
        </Col>
      </Row>
      {result && <TaskResultModal key={result} result={result} onCancel={() => setResult(null)} />}
      {logCron && (
        <CronLogModal
          key={logCron.instanceId}
          cron={logCron}
          logUrl={`${config.apiPrefix}crons/${logCron.id}/log?instanceId=${logCron.instanceId}`}
          handleCancel={() => setLogCron(null)}
        />
      )}
    </PageContainer>
  );
};

export default Dashboard;
