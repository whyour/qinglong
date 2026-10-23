import { CloudDownloadOutlined } from '@ant-design/icons';
import { Modal, Tooltip } from 'antd';
import { useState } from 'react';
import intl from 'react-intl-universal';
import useUpgrade, {
  activeStatuses,
  upgradeStatusLabel,
} from '@/hooks/useUpgrade';
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
    job.status === 'failed' ||
    Boolean(job.migrationRequired);
  if (!showNotice && !open) return null;
  const text = !connected
    ? intl.get('连接已断开，正在重新连接')
    : intl.get(upgradeStatusLabel(job));
  const label =
    activeStatuses.includes(job.status) &&
    job.phase === 'downloading' &&
    job.percent != null
      ? `${text} ${job.percent}%`
      : text;
  return (
    <>
      {showNotice && !open && (
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
