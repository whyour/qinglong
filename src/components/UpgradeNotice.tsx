import { CloudDownloadOutlined } from '@ant-design/icons';
import { Modal, Tooltip } from 'antd';
import { useState } from 'react';
import intl from 'react-intl-universal';
import useUpgrade, { activeStatuses, phaseLabels } from '@/hooks/useUpgrade';
import CheckUpdate from '@/pages/setting/checkUpdate';

export default function UpgradeNotice({
  collapsed,
  systemInfo,
}: {
  collapsed: boolean;
  systemInfo: any;
}) {
  const { job, connected } = useUpgrade();
  const [open, setOpen] = useState(false);
  const showNotice =
    activeStatuses.includes(job.status) ||
    job.status === 'ready' ||
    job.status === 'failed';
  if (!showNotice && !open) return null;
  const text = !connected
    ? intl.get('连接已断开，正在重新连接')
    : job.status === 'failed'
    ? intl.get('更新失败')
    : intl.get(phaseLabels[job.phase || ''] || '检查更新');
  const label =
    job.phase === 'downloading' && job.percent != null
      ? `${text} ${job.percent}%`
      : text;
  return (
    <>
      {showNotice && (
        <Tooltip title={label} placement="right">
          <button
            type="button"
            className={`upgrade-notice${
              collapsed ? ' upgrade-notice-collapsed' : ''
            }`}
            onClick={() => setOpen(true)}
            aria-label={label}
          >
            <CloudDownloadOutlined />
            {!collapsed && <span>{label}</span>}
          </button>
        </Tooltip>
      )}
      <Modal
        open={open}
        title={intl.get('更新')}
        footer={null}
        onCancel={() => setOpen(false)}
        width={650}
        destroyOnClose
      >
        <CheckUpdate systemInfo={systemInfo} />
      </Modal>
    </>
  );
}
