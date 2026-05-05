import { SharedContext } from '@/layouts';
import config from '@/utils/config';
import { request } from '@/utils/http';
import { BarChartOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-layout';
import { useOutletContext } from '@umijs/max';
import {
  Button,
  Card,
  Col,
  Row,
  Statistic,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import { ColumnProps } from 'antd/lib/table';
import React, { useEffect, useState } from 'react';
import intl from 'react-intl-universal';
import './index.less';

const { Title } = Typography;

interface StatsData {
  total: number;
  enabled: number;
  disabled: number;
  today: {
    count: number;
    avgDuration: number;
  };
}

interface TrendItem {
  date: string;
  count: number;
}

interface TopDurationItem {
  cron_id: number;
  cron_name: string;
  count: number;
  avgDuration: number;
  maxDuration: number;
}

interface TopCountItem {
  cron_id: number;
  cron_name: string;
  count: number;
  avgDuration: number;
}

const TrendChart = ({ data }: { data: TrendItem[] }) => {
  if (!data || data.length === 0) {
    return (
      <div className="trend-chart-empty">
        {intl.get('暂无数据')}
      </div>
    );
  }

  const width = 600;
  const height = 200;
  const paddingLeft = 40;
  const paddingRight = 20;
  const paddingTop = 20;
  const paddingBottom = 40;

  const chartWidth = width - paddingLeft - paddingRight;
  const chartHeight = height - paddingTop - paddingBottom;

  const maxCount = Math.max(...data.map((d) => d.count), 1);

  const points = data.map((d, i) => ({
    x: paddingLeft + (i / Math.max(data.length - 1, 1)) * chartWidth,
    y: paddingTop + chartHeight - (d.count / maxCount) * chartHeight,
    ...d,
  }));

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ');

  const areaD =
    pathD +
    ` L ${points[points.length - 1].x.toFixed(1)} ${(paddingTop + chartHeight).toFixed(1)}` +
    ` L ${points[0].x.toFixed(1)} ${(paddingTop + chartHeight).toFixed(1)} Z`;

  const yTicks = [0, Math.ceil(maxCount / 2), maxCount];

  return (
    <div className="trend-chart-wrapper">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        style={{ width: '100%', height: 200 }}
      >
        {/* Grid lines */}
        {yTicks.map((tick) => {
          const y =
            paddingTop + chartHeight - (tick / maxCount) * chartHeight;
          return (
            <g key={tick}>
              <line
                x1={paddingLeft}
                y1={y}
                x2={paddingLeft + chartWidth}
                y2={y}
                stroke="#f0f0f0"
                strokeWidth={1}
              />
              <text
                x={paddingLeft - 6}
                y={y + 4}
                textAnchor="end"
                fontSize={10}
                fill="#999"
              >
                {tick}
              </text>
            </g>
          );
        })}

        {/* Area fill */}
        <path d={areaD} fill="rgba(24, 144, 255, 0.1)" />

        {/* Line */}
        <path
          d={pathD}
          fill="none"
          stroke="#1890ff"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {/* Points */}
        {points.map((p, i) => (
          <Tooltip
            key={i}
            title={`${p.date}: ${p.count} ${intl.get('次')}`}
          >
            <circle
              cx={p.x}
              cy={p.y}
              r={4}
              fill="#1890ff"
              stroke="#fff"
              strokeWidth={2}
              style={{ cursor: 'pointer' }}
            />
          </Tooltip>
        ))}

        {/* X axis labels */}
        {points.map((p, i) => (
          <text
            key={i}
            x={p.x}
            y={height - 8}
            textAnchor="middle"
            fontSize={10}
            fill="#999"
          >
            {p.date}
          </text>
        ))}

        {/* Axes */}
        <line
          x1={paddingLeft}
          y1={paddingTop}
          x2={paddingLeft}
          y2={paddingTop + chartHeight}
          stroke="#e8e8e8"
          strokeWidth={1}
        />
        <line
          x1={paddingLeft}
          y1={paddingTop + chartHeight}
          x2={paddingLeft + chartWidth}
          y2={paddingTop + chartHeight}
          stroke="#e8e8e8"
          strokeWidth={1}
        />
      </svg>
    </div>
  );
};

const Statistics = () => {
  const { headerStyle, isPhone } = useOutletContext<SharedContext>();
  const [stats, setStats] = useState<StatsData | null>(null);
  const [trend, setTrend] = useState<TrendItem[]>([]);
  const [topDuration, setTopDuration] = useState<TopDurationItem[]>([]);
  const [topCount, setTopCount] = useState<TopCountItem[]>([]);
  const [loading, setLoading] = useState(true);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [
        statsRes,
        trendRes,
        topDurationRes,
        topCountRes,
      ] = await Promise.all([
        request.get(`${config.apiPrefix}crons/stats`),
        request.get(`${config.apiPrefix}crons/stats/trend`),
        request.get(`${config.apiPrefix}crons/stats/top-duration`),
        request.get(`${config.apiPrefix}crons/stats/top-count`),
      ]);
      if (statsRes.code === 200) setStats(statsRes.data);
      if (trendRes.code === 200) setTrend(trendRes.data);
      if (topDurationRes.code === 200) setTopDuration(topDurationRes.data);
      if (topCountRes.code === 200) setTopCount(topCountRes.data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
  }, []);

  const topDurationColumns: ColumnProps<TopDurationItem>[] = [
    {
      title: intl.get('排名'),
      key: 'rank',
      width: 60,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: intl.get('任务名称'),
      dataIndex: 'cron_name',
      key: 'cron_name',
      ellipsis: true,
    },
    {
      title: intl.get('平均耗时(秒)'),
      dataIndex: 'avgDuration',
      key: 'avgDuration',
      width: 120,
      render: (v: number) => `${v}s`,
    },
    {
      title: intl.get('最长单次(秒)'),
      dataIndex: 'maxDuration',
      key: 'maxDuration',
      width: 120,
      render: (v: number) => `${v}s`,
    },
  ];

  const topCountColumns: ColumnProps<TopCountItem>[] = [
    {
      title: intl.get('排名'),
      key: 'rank',
      width: 60,
      render: (_: any, __: any, index: number) => index + 1,
    },
    {
      title: intl.get('任务名称'),
      dataIndex: 'cron_name',
      key: 'cron_name',
      ellipsis: true,
    },
    {
      title: intl.get('今日执行次数'),
      dataIndex: 'count',
      key: 'count',
      width: 120,
    },
    {
      title: intl.get('平均耗时(秒)'),
      dataIndex: 'avgDuration',
      key: 'avgDuration',
      width: 120,
      render: (v: number) => `${v}s`,
    },
  ];

  return (
    <PageContainer
      header={{
        style: headerStyle,
      }}
      title={
        <span>
          <BarChartOutlined style={{ marginRight: 8 }} />
          {intl.get('统计面板')}
        </span>
      }
      extra={[
        <Button
          key="refresh"
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={loadAll}
        >
          {intl.get('刷新')}
        </Button>,
      ]}
    >
      {/* Section 1: Overview Cards */}
      <Card
        className="stats-section"
        title={intl.get('总体概览')}
        loading={loading}
      >
        <Row gutter={[16, 16]}>
          <Col xs={12} sm={8} md={6} lg={4}>
            <Statistic
              title={intl.get('总任务数量')}
              value={stats?.total ?? '-'}
            />
          </Col>
          <Col xs={12} sm={8} md={6} lg={4}>
            <Statistic
              title={intl.get('启用任务数')}
              value={stats?.enabled ?? '-'}
              valueStyle={{ color: '#52c41a' }}
            />
          </Col>
          <Col xs={12} sm={8} md={6} lg={4}>
            <Statistic
              title={intl.get('禁用任务数')}
              value={stats?.disabled ?? '-'}
              valueStyle={{ color: '#d9d9d9' }}
            />
          </Col>
          <Col xs={12} sm={8} md={6} lg={4}>
            <Statistic
              title={intl.get('今日总执行次数')}
              value={stats?.today?.count ?? '-'}
              valueStyle={{ color: '#1890ff' }}
            />
          </Col>
          <Col xs={12} sm={8} md={6} lg={4}>
            <Statistic
              title={intl.get('今日平均耗时(秒)')}
              value={stats?.today?.avgDuration ?? '-'}
              suffix="s"
              valueStyle={{ color: '#faad14' }}
            />
          </Col>
        </Row>
      </Card>

      {/* Section 2: 7-day Trend */}
      <Card
        className="stats-section"
        title={intl.get('近7日执行趋势')}
        loading={loading}
      >
        <TrendChart data={trend} />
      </Card>

      {/* Section 3 & 4: Top Tables */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            className="stats-section"
            title={intl.get('今日平均耗时 Top 5')}
            loading={loading}
          >
            <Table
              dataSource={topDuration}
              columns={topDurationColumns}
              rowKey="cron_id"
              pagination={false}
              size="small"
              locale={{ emptyText: intl.get('今日暂无执行记录') }}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <Card
            className="stats-section"
            title={intl.get('今日执行次数 Top 5')}
            loading={loading}
          >
            <Table
              dataSource={topCount}
              columns={topCountColumns}
              rowKey="cron_id"
              pagination={false}
              size="small"
              locale={{ emptyText: intl.get('今日暂无执行记录') }}
            />
          </Card>
        </Col>
      </Row>
    </PageContainer>
  );
};

export default Statistics;
