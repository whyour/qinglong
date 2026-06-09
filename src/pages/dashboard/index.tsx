import { useEffect, useState, useCallback } from 'react';
import { Card, Col, Row, Statistic, Table, Tag, Spin, Empty } from 'antd';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ClockCircleOutlined,
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
import CronLogModal from '../crontab/logModal';

interface Overview {
  total: number;
  enabled: number;
  disabled: number;
  todayRuns: number;
  todaySuccess: number;
  todayFail: number;
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

  const fetchData = useCallback(async () => {
    try {
      const [overviewRes, trendRes, topTimeRes, topCountRes, runtimeRes, systemRes, labelsRes] =
        await Promise.allSettled([
          request.get('/api/dashboard/overview'),
          request.get('/api/dashboard/trend'),
          request.get('/api/dashboard/top-time'),
          request.get('/api/dashboard/top-count'),
          request.get('/api/dashboard/runtime'),
          request.get('/api/dashboard/system'),
          request.get('/api/dashboard/labels'),
        ]);

      if (overviewRes.status === 'fulfilled' && overviewRes.value.code === 200)
        setOverview(overviewRes.value.data);
      if (trendRes.status === 'fulfilled' && trendRes.value.code === 200)
        setTrend(trendRes.value.data);
      if (topTimeRes.status === 'fulfilled' && topTimeRes.value.code === 200)
        setTopTime(topTimeRes.value.data);
      if (topCountRes.status === 'fulfilled' && topCountRes.value.code === 200)
        setTopCount(topCountRes.value.data);
      if (runtimeRes.status === 'fulfilled' && runtimeRes.value.code === 200)
        setRuntime(runtimeRes.value.data);
      if (systemRes.status === 'fulfilled' && systemRes.value.code === 200)
        setSystem(systemRes.value.data);
      if (labelsRes.status === 'fulfilled' && labelsRes.value.code === 200)
        setLabels(labelsRes.value.data);
    } catch (e) {
      console.error('[dashboard] fetch error', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await fetchData();
      timer = setTimeout(poll, REFRESH_INTERVAL);
    };
    fetchData();
    timer = setTimeout(poll, REFRESH_INTERVAL);
    return () => clearTimeout(timer);
  }, [fetchData]);

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
    showTotal: (total: number) => `共 ${total} 个`,
  };

  if (loading) return <Spin size="large" style={{ display: 'block', marginTop: 100 }} />;

  return (
    <PageContainer
      title={intl.get('仪表盘')}
      header={{ style: headerStyle }}
      className={'ql-container-wrapper dashboard-wrapper'}
    >
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('总任务')} value={overview?.total || 0} prefix={<BarChartOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('已启用')} value={overview?.enabled || 0} valueStyle={{ color: '#1677ff' }} prefix={<CheckCircleOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('今日执行')} value={overview?.todayRuns || 0} valueStyle={{ color: '#1677ff' }} prefix={<ThunderboltOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('成功率')} value={`${overview?.successRate || '0'}%`} valueStyle={{ color: '#52c41a' }} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('今日成功')} value={overview?.todaySuccess || 0} valueStyle={{ color: '#52c41a' }} prefix={<CheckCircleOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('今日失败')} value={overview?.todayFail || 0} valueStyle={{ color: '#ff4d4f' }} prefix={<CloseCircleOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('平均耗时')} value={overview?.avgTime ? `${(overview.avgTime / 1000).toFixed(1)}s` : '-'} prefix={<ClockCircleOutlined />} /></Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={3}>
          <Card size="small"><Statistic title={intl.get('已禁用')} value={overview?.disabled || 0} prefix={<StopOutlined />} /></Card>
        </Col>
      </Row>

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
                <Tag color="warning">{intl.get('排队中')} {runtime?.queuedCount || 0}</Tag>
              </>
            }
          >
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
                { title: intl.get('日志'), dataIndex: 'id', width: 60, render: (id, record) => <a onClick={() => { localStorage.setItem('logCron', String(id)); setLogCron({ id, name: record.name }); }}>{intl.get('查看')}</a> },
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
                      name: '内存使用率',
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
                    {intl.get('负载 1m')}: {system.loadAvg?.[0] || '-'} | CPU: {system.cpus} {intl.get('核心')} | {system.platform}
                  </div>
                </Col>
              </Row>
            )}
          </Card>
        </Col>
      </Row>
      {logCron && (
        <CronLogModal
          cron={logCron}
          handleCancel={() => setLogCron(null)}
        />
      )}
    </PageContainer>
  );
};

export default Dashboard;
