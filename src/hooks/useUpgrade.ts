import config from '@/utils/config';
import { notification } from 'antd';
import intl from 'react-intl-universal';
import { useSyncExternalStore } from 'react';

export interface UpgradeJob {
  id?: string;
  action?: 'download' | 'apply';
  status: string;
  phase?: string;
  artifact?: string;
  downloadedBytes?: number;
  totalBytes?: number | null;
  percent?: number | null;
  version?: string;
  error?: string;
  log?: string;
}

export const activeStatuses = ['starting', 'running', 'restarting'];
export const reloadKey = 'qinglong-upgrade-reload';
export const completionKey = 'qinglong-upgrade-completed';
export const phaseLabels: Record<string, string> = {
  downloading: '下载更新中...',
  extracting: '正在解压更新包',
  verifying: '正在校验更新包',
  dependencies: '正在准备依赖',
  ready: '更新已就绪',
  restarting: '正在重启并更新',
  completed: '更新完成',
};

// The sidebar and settings share one poller and one mutation state.
export function createUpgradeStore() {
  let snapshot = {
    job: { status: 'loading' } as UpgradeJob,
    busy: false,
    connected: true,
  };
  const listeners = new Set<() => void>();
  let revision = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const publish = (patch: Partial<typeof snapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.forEach((listener) => listener());
  };
  const poll = async () => {
    const current = revision;
    const attempt = new AbortController();
    controller = attempt;
    const timeout = setTimeout(() => attempt.abort(), 5000);
    try {
      const token = localStorage.getItem(config.authKey);
      const response = await fetch(`${config.apiPrefix}system/update-status`, {
        cache: 'no-store',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: attempt.signal,
      });
      if (!response.ok) throw new Error('Upgrade status unavailable');
      const result = await response.json();
      if (result.code !== 200 || !result.data)
        throw new Error('Invalid upgrade status');
      if (!listeners.size || current !== revision || attempt.signal.aborted)
        return;
      publish({ job: result.data, connected: true });
      if (
        result.data.status === 'completed' &&
        result.data.id === sessionStorage.getItem(reloadKey)
      ) {
        sessionStorage.setItem(completionKey, result.data.id);
        sessionStorage.removeItem(reloadKey);
        window.location.reload();
        return;
      }
      if (
        result.data.status === 'completed' &&
        result.data.id === sessionStorage.getItem(completionKey)
      ) {
        sessionStorage.removeItem(completionKey);
        notification.success({
          message: intl.get('升级成功'),
          description: intl.get('已重新启动并运行新版本，无需再次重启。'),
          duration: 8,
        });
      }
    } catch {
      if (listeners.size && current === revision && controller === attempt)
        publish({ connected: false });
    } finally {
      clearTimeout(timeout);
      if (listeners.size && controller === attempt)
        timer = setTimeout(
          poll,
          !snapshot.connected || activeStatuses.includes(snapshot.job.status)
            ? 1000
            : 15000,
        );
    }
  };
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) poll();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          clearTimeout(timer);
          controller?.abort();
          revision++;
        }
      };
    },
    beginMutation() {
      if (snapshot.busy) return false;
      revision++;
      publish({ busy: true });
      return true;
    },
    finishMutation() {
      revision++;
      controller?.abort();
      controller = undefined;
      clearTimeout(timer);
      publish({ busy: false });
      if (listeners.size) timer = setTimeout(poll, 1000);
    },
    setJob(job: UpgradeJob) {
      publish({ job });
    },
  };
}

export const upgradeStore = createUpgradeStore();
export default function useUpgrade() {
  return useSyncExternalStore(upgradeStore.subscribe, upgradeStore.getSnapshot);
}
