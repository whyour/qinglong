import { useEffect, useState } from 'react';
import { Button, Table, Typography } from 'antd';
import intl from 'react-intl-universal';
import { request } from '@/utils/http';
import config from '@/utils/config';

type DailyResult = {
  day: string;
  exitSuccess: number;
  exitFail: number;
  bookedSuccess: number;
  bookedFail: number;
  supplement: number;
};

export default function DailyResults({ id }: { id: number }) {
  const [rows, setRows] = useState<DailyResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const { code, data } = await request.get(
          `${config.apiPrefix}crons/${id}/daily-results`,
          { signal, retryInPlace: true },
        );
        if (code !== 200) throw new Error();
        if (signal.aborted) return;
        setRows(data);
        setFailed(false);
        timer = setTimeout(load, 10000);
      } catch {
        if (!signal.aborted) setFailed(true);
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, attempt]);

  return (
    <section>
      <Typography.Paragraph type="secondary">
        {intl.get(
          '近 7 天按面板日期显示。执行明细按任务结束日期统计仍可核实的结果。每日汇总包含升级时补记的次数。清理明细或旧版客户端跨日报告时，两组次数可能不同。',
        )}
      </Typography.Paragraph>
      {failed && (
        <div role="status">
          {intl.get(rows.length ? '刷新失败，仍显示上次的数据' : '加载失败')}
          <Button
            type="link"
            onClick={() => {
              setFailed(false);
              setLoading(true);
              setAttempt((a) => a + 1);
            }}
          >
            {intl.get('重试')}
          </Button>
        </div>
      )}
      <Table<DailyResult>
        size="small"
        rowKey="day"
        dataSource={rows}
        pagination={false}
        loading={loading}
        scroll={{ x: 520 }}
        columns={[
          { title: intl.get('日期'), dataIndex: 'day' },
          {
            title: intl.get('按执行明细统计'),
            children: [
              {
                title: intl.get('成功'),
                dataIndex: 'exitSuccess',
                align: 'right',
              },
              {
                title: intl.get('失败'),
                dataIndex: 'exitFail',
                align: 'right',
              },
            ],
          },
          {
            title: intl.get('每日汇总'),
            children: [
              {
                title: intl.get('成功'),
                dataIndex: 'bookedSuccess',
                align: 'right',
              },
              {
                title: intl.get('失败'),
                dataIndex: 'bookedFail',
                align: 'right',
              },
              {
                title: intl.get('其中升级时补记'),
                dataIndex: 'supplement',
                align: 'right',
              },
            ],
          },
        ]}
      />
    </section>
  );
}
