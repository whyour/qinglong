import { Statistic } from 'antd';
import intl from 'react-intl-universal';

export function formatTiming(ms: number | null) {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60000) return intl.get('{value} 秒', { value: ms / 1000 });
  const seconds = Math.round(ms / 1000);
  return intl.get('{minutes} 分 {seconds} 秒', {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  });
}

export default function TimingStatistic({ title, ms }: {
  title: string;
  ms: number | null;
}) {
  return <Statistic title={title} value={ms ?? '—'} formatter={() => (
      <span title={ms == null ? undefined : `${ms} ms`}>{formatTiming(ms)}</span>
    )} />;
}
