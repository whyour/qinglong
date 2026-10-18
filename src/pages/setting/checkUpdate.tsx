import config from '@/utils/config';
import { request } from '@/utils/http';
import Ansi from 'ansi-to-react';
import { Button, Modal, Progress, Space, Typography, message } from 'antd';
import { useState } from 'react';
import useUpgrade, {
  activeStatuses,
  upgradeStatusLabel,
  reloadKey,
  upgradeStore,
} from '@/hooks/useUpgrade';
import intl from 'react-intl-universal';

const sizeLabel = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const CheckUpdate = ({ systemInfo }: any) => {
  const { job, busy, connected } = useUpgrade();
  const [details, setDetails] = useState(false);
  const active = activeStatuses.includes(job.status);
  const ready = job.status === 'ready';
  const completed = job.status === 'completed';

  const startUpdate = async () => {
    if (busy || active) return;
    if (!upgradeStore.beginMutation()) return;
    try {
      const result = await request.put(`${config.apiPrefix}system/update`);
      if (result.code !== 200) throw new Error(result.message);
      upgradeStore.setJob(result.data);
    } catch {
      message.error(intl.get('更新失败，请检查网络及日志或稍后再试'));
    } finally {
      upgradeStore.finishMutation();
    }
  };

  const checkUpgrade = async () => {
    if (!upgradeStore.beginMutation()) return;
    try {
      const { code, data } = await request.put(
        `${config.apiPrefix}system/update-check`,
      );
      if (code !== 200) throw new Error('Update check failed');
      Modal.confirm({
        width: 500,
        title: intl.get(data.hasNewVersion ? '更新可用' : '已经是最新版了！'),
        content: data.hasNewVersion ? (
          <>
            <p>
              {intl.get('新版本可用，当前版本', {
                version: data.lastVersion,
                current: systemInfo.version,
              })}
            </p>
            <pre>
              <Ansi>{data.lastLog}</Ansi>
            </pre>
          </>
        ) : (
          `${intl.get('青龙')} ${data.lastVersion}`
        ),
        okText: intl.get(data.hasNewVersion ? '下载更新' : '重新下载'),
        cancelText: intl.get('以后再说'),
        onOk: startUpdate,
      });
    } catch {
      message.error(intl.get('检查更新失败，请检查网络后重试'));
    } finally {
      upgradeStore.finishMutation();
    }
  };

  const reloadSystem = async (apply: boolean) => {
    if (!upgradeStore.beginMutation()) return;
    try {
      const result = await request.put(
        `${config.apiPrefix}update/${apply ? 'system' : 'reload'}`,
      );
      if (result.code !== 200) throw new Error(result.message);
      if (apply) {
        upgradeStore.setJob(result.data);
        sessionStorage.setItem(reloadKey, result.data.id);
      } else {
        message.success(intl.get('系统将在30秒后自动刷新'));
        setTimeout(() => window.location.reload(), 30000);
      }
    } catch {
      message.error(intl.get('升级任务启动失败，请检查日志后重试'));
    } finally {
      upgradeStore.finishMutation();
    }
  };

  const showReloadModal = () =>
    Modal.confirm({
      title: intl.get('确认重启'),
      content: intl.get('更新已就绪，重启后应用新版本'),
      okText: intl.get('重启并更新'),
      cancelText: intl.get('以后再说'),
      onOk: () => reloadSystem(true),
    });

  const label = intl.get(upgradeStatusLabel(job));
  const hasJob = job.status !== 'idle' && job.status !== 'loading';
  const actions = !active && (
    <Space wrap>
      <Button
        type="primary"
        loading={busy}
        disabled={!connected || job.status === 'loading'}
        onClick={ready ? showReloadModal : checkUpgrade}
      >
        {intl.get(ready ? '重启并更新' : '检查更新')}
      </Button>
      {!ready && !completed && (
        <Button
          disabled={busy || !connected || job.status === 'loading'}
          onClick={() => reloadSystem(false)}
        >
          {intl.get('重新启动')}
        </Button>
      )}
    </Space>
  );

  return (
    <div className="upgrade-panel">
      {!connected && (
        <Typography.Text type="warning" role="status">
          {intl.get('连接已断开，正在重新连接')}
        </Typography.Text>
      )}
      {!hasJob && actions}
      {hasJob && (
        <div
          className="upgrade-status-content"
          role="status"
          aria-live="polite"
        >
          <Typography.Text strong>
            {label}
            {job.version ? ` · v${job.version}` : ''}
          </Typography.Text>
          <Typography.Text
            type={job.status === 'failed' ? 'danger' : 'secondary'}
          >
            {job.status === 'failed'
              ? intl.get(job.error || '更新失败，请检查网络及日志或稍后再试') ||
                job.error
              : intl.get(
                  completed
                    ? '已重新启动并运行新版本，无需再次重启。'
                    : ready
                    ? '更新已就绪，重启后应用新版本'
                    : '更新在后台进行，可以继续使用面板',
                )}
          </Typography.Text>
          {job.phase === 'downloading' && active && (
            <div className="upgrade-progress">
              <div className="upgrade-progress-meta">
                <Typography.Text type="secondary">
                  {intl.get(
                    job.artifact === 'qinglong-bundle'
                      ? '下载更新包'
                      : job.artifact === 'qinglong-static'
                      ? '下载构建产物'
                      : '下载源码',
                  )}
                </Typography.Text>
                <Typography.Text type="secondary">
                  {sizeLabel(job.downloadedBytes || 0)}
                  {job.totalBytes ? ` / ${sizeLabel(job.totalBytes)}` : ''}
                </Typography.Text>
              </div>
              <Progress
                percent={job.percent ?? 0}
                showInfo={job.percent != null}
                status="active"
              />
            </div>
          )}
          <div className="upgrade-actions">
            {actions}
            <Button
              type="link"
              className="upgrade-log-link"
              onClick={() => setDetails(true)}
            >
              {intl.get('查看更新日志')}
            </Button>
          </div>
        </div>
      )}
      <Modal
        open={details}
        title={intl.get('更新日志')}
        footer={null}
        onCancel={() => setDetails(false)}
        width={700}
      >
        <pre
          style={{
            maxHeight: '60vh',
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          <Ansi>{job.log || intl.get('暂无日志')}</Ansi>
        </pre>
      </Modal>
    </div>
  );
};

export default CheckUpdate;
