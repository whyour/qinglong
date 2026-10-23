import { database } from '.';

// Aggregate SQL stays explicit and bound; public input is never used as an SQL
// identifier. These queries preserve the dashboard response names.
export const statistics = {
  async totals(date: string) {
    const rows = await database.query(
      `SELECT SUM(run_count) AS total_runs,
      SUM(success_count) AS total_success, SUM(fail_count) AS total_fail,
      SUM(total_time) AS total_time FROM CrontabStats WHERE date=?`,
      [date],
    );
    return rows[0];
  },
  results(date: string, column: 'success_count' | 'fail_count') {
    if (!['success_count', 'fail_count'].includes(column))
      throw new Error('Invalid statistic');
    return database.query(
      `SELECT ref_id,SUM(${column}) AS result_count FROM CrontabStats
      WHERE date=? AND ${column}>0 GROUP BY ref_id ORDER BY result_count DESC,ref_id ASC`,
      [date],
    );
  },
  trend(dates: string[]) {
    if (!dates.length) return Promise.resolve([]);
    return database.query(
      `SELECT date,SUM(run_count) AS total_runs,
      SUM(success_count) AS total_success,SUM(fail_count) AS total_fail FROM CrontabStats
      WHERE date IN (${dates
        .map(() => '?')
        .join(',')}) GROUP BY date ORDER BY date ASC`,
      dates,
    );
  },
  ranking(date: string, metric: 'total_time' | 'run_count') {
    if (!['total_time', 'run_count'].includes(metric))
      throw new Error('Invalid statistic');
    return database.query(
      `SELECT ref_id,SUM(total_time) AS total_time,SUM(run_count) AS run_count,
      SUM(success_count) AS success_count,MAX(max_time) AS max_time FROM CrontabStats
      WHERE date=? AND run_count>0 GROUP BY ref_id ORDER BY SUM(${metric}) DESC LIMIT 5`,
      [date],
    );
  },
};
