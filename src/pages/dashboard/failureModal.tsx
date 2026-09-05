import { useEffect, useState } from 'react';
import { Alert, Button, Modal, Table, Tag } from 'antd';
import intl from 'react-intl-universal';
import { request } from '@/utils/http';
import config from '@/utils/config';
import CronLogModal from '../crontab/logModal';

interface FailedTask {
  id: number;
  name: string;
  command: string;
  failCount: number;
  deleted: boolean;
}

export default function FailureModal({ onCancel }: { onCancel: () => void }) {
  const [tasks, setTasks] = useState<FailedTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [logCron, setLogCron] = useState<FailedTask | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setFailed(false);
    request
      .get(`${config.apiPrefix}dashboard/failures`)
      .then((response) => {
        if (!active) return;
        if (response.code !== 200)
          throw new Error('Failed to load dashboard failures');
        setTasks(response.data);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reload]);

  return (
    <>
      <Modal
        title={intl.get('今日失败')}
        open
        onCancel={onCancel}
        footer={null}
        width={900}
      >
        {failed ? (
          <Alert
            type="error"
            showIcon
            message={intl.get('加载失败')}
            action={
              <Button onClick={() => setReload((value) => value + 1)}>
                {intl.get('重试')}
              </Button>
            }
          />
        ) : (
          <Table<FailedTask>
            loading={loading}
            dataSource={tasks}
            rowKey="id"
            size="small"
            scroll={{ x: 650 }}
            pagination={{ pageSize: 10, showSizeChanger: false }}
            columns={[
              {
                title: intl.get('定时任务'),
                dataIndex: 'name',
                ellipsis: true,
                render: (name, task) => (
                  <>
                    {name} {task.deleted && <Tag>{intl.get('已删除')}</Tag>}
                  </>
                ),
              },
              { title: intl.get('命令'), dataIndex: 'command', ellipsis: true },
              {
                title: intl.get('失败次数'),
                dataIndex: 'failCount',
                width: 100,
              },
              {
                title: intl.get('日志'),
                width: 120,
                render: (_, task) => (
                  <Button
                    type="link"
                    size="small"
                    disabled={task.deleted}
                    onClick={() => {
                      localStorage.setItem('logCron', String(task.id));
                      setLogCron(task);
                    }}
                  >
                    {intl.get('最新日志')}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Modal>
      {logCron && (
        <CronLogModal cron={logCron} handleCancel={() => setLogCron(null)} />
      )}
    </>
  );
}
