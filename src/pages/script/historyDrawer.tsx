import { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Drawer,
  Empty,
  Modal,
  Select,
  Space,
  Spin,
  Typography,
  message,
} from 'antd';
import { DiffEditor } from '@monaco-editor/react';
import ReactDiffViewer from 'react-diff-viewer';
import intl from 'react-intl-universal';
import config from '@/utils/config';
import { request } from '@/utils/http';
import styles from './historyDrawer.module.less';

interface Version {
  id: string;
  createdAt: string;
  source: 'baseline' | 'save' | 'restore' | 'external';
  identical: boolean;
}
interface Detail {
  version: Version & { content: string };
  current: string;
  currentHash: string;
}
interface Props {
  filename: string;
  directory: string;
  isPhone: boolean;
  theme: string;
  language: string;
  hasUnsavedChanges: () => boolean;
  onClose: () => void;
  onRestored: (content: string) => void;
}

const sourceLabel = (source: Version['source']) =>
  intl.get(
    {
      baseline: '首次修改前',
      save: '手动保存',
      restore: '从历史版本恢复',
      external: '面板外修改后',
    }[source],
  );
const versionLabel = (v: Version) =>
  `${new Date(v.createdAt).toLocaleString()} · ${sourceLabel(v.source)}`;

export default function HistoryDrawer(props: Props) {
  const {
    filename,
    directory,
    isPhone,
    theme,
    language,
    onClose,
    onRestored,
    hasUnsavedChanges,
  } = props;
  const [versions, setVersions] = useState<Version[]>([]);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Detail>();
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState(false);
  const [limit, setLimit] = useState(20);
  const active = useRef(true);
  const detailRequest = useRef(0);
  const params = { filename, path: directory };

  const load = async () => {
    setLoading(true);
    setError('');
    setDetail(undefined);
    setSelected(undefined);
    detailRequest.current++;
    try {
      const result = await request.get(`${config.apiPrefix}scripts/history`, {
        params,
      });
      if (result.code !== 200) throw new Error(result.message);
      if (!active.current) return;
      setVersions(result.data.versions);
      setLimit(result.data.limit);
      setSelected(result.data.versions[0]?.id);
    } catch (e: any) {
      if (active.current)
        setError(e?.response?.data?.message || intl.get('加载失败'));
    } finally {
      if (active.current) setLoading(false);
    }
  };

  const loadDetail = async (id: string) => {
    const sequence = ++detailRequest.current;
    setDetail(undefined);
    setDetailLoading(true);
    setDetailError(false);
    try {
      const result = await request.get(
        `${config.apiPrefix}scripts/history/detail`,
        { params: { ...params, id } },
      );
      if (result.code !== 200) throw new Error(result.message);
      if (active.current && sequence === detailRequest.current)
        setDetail(result.data);
    } catch {
      if (active.current && sequence === detailRequest.current)
        setDetailError(true);
    } finally {
      if (active.current && sequence === detailRequest.current)
        setDetailLoading(false);
    }
  };

  useEffect(() => {
    active.current = true;
    load();
    return () => {
      active.current = false;
      detailRequest.current++;
    };
  }, []);
  useEffect(() => {
    if (selected) loadDetail(selected);
  }, [selected]);

  const restore = () => {
    if (!detail) return;
    if (hasUnsavedChanges()) {
      message.warning(intl.get('请先保存或取消当前修改，再恢复历史版本'));
      return;
    }
    Modal.confirm({
      title: intl.get('恢复此版本'),
      content: (
        <>
          <p>{versionLabel(detail.version)}</p>
          <p>{intl.get('当前已保存的内容会保留在历史版本中。')}</p>
        </>
      ),
      okText: intl.get('恢复此版本'),
      onOk: async () => {
        if (hasUnsavedChanges()) {
          message.warning(intl.get('请先保存或取消当前修改，再恢复历史版本'));
          throw new Error('Unsaved changes');
        }
        setRestoring(true);
        try {
          const result = await request.put(
            `${config.apiPrefix}scripts/history/restore`,
            {
              ...params,
              id: detail.version.id,
              expectedHash: detail.currentHash,
            },
          );
          if (result.code !== 200) throw new Error(result.message);
          if (!active.current) return;
          onRestored(result.data.content);
          if (result.data.cleanupPending) {
            message.warning(
              intl.get('已保存，但旧历史清理失败，请检查存储权限和空间'),
            );
          } else {
            message.success(intl.get('已恢复，恢复前的内容已保留'));
          }
          await load();
        } catch (e: any) {
          if (e?.response?.status === 409) {
            setDetail(undefined);
            setDetailError(true);
          }
          throw e;
        } finally {
          if (active.current) setRestoring(false);
        }
      },
    });
  };
  const identical = detail?.version.content === detail?.current;

  return (
    <Drawer
      title={
        <Space direction="vertical" size={0}>
          <span>{intl.get('历史版本')}</span>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, wordBreak: 'break-all' }}
          >
            {directory ? `${directory}/` : ''}
            {filename}
          </Typography.Text>
        </Space>
      }
      open
      width={isPhone ? '100%' : 'min(1100px, 90vw)'}
      onClose={restoring ? undefined : onClose}
      closable={!restoring}
      maskClosable={!restoring}
      keyboard={!restoring}
      bodyStyle={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: isPhone ? 16 : 24,
      }}
      footer={
        <div className={styles.footer}>
          <Typography.Text type="secondary">
            {intl.get(
              '最多保留 {count} 个历史版本，容量不足时自动清理旧历史。',
              { count: limit },
            )}
          </Typography.Text>
          <Button
            type="primary"
            onClick={restore}
            loading={restoring}
            disabled={!detail || detailLoading || identical}
          >
            {intl.get('恢复此版本')}
          </Button>
        </div>
      }
    >
      <Alert
        type="info"
        showIcon
        message={intl.get(
          '仅记录通过面板保存的修改；订阅更新仍可能覆盖恢复后的文件。',
        )}
      />
      {loading ? (
        <Spin />
      ) : error ? (
        <Alert
          type="error"
          message={error}
          action={<Button onClick={load}>{intl.get('重试')}</Button>}
        />
      ) : versions.length === 0 ? (
        <Empty
          description={intl.get(
            '暂无历史版本，下次保存修改时会自动保留当前内容',
          )}
        />
      ) : (
        <>
          <Select
            aria-label={intl.get('选择历史版本')}
            value={selected}
            onChange={setSelected}
            disabled={restoring}
            options={versions.map((v) => ({
              value: v.id,
              label: versionLabel(v),
            }))}
          />
          {detailLoading ? (
            <Spin />
          ) : detailError ? (
            <Alert
              type="error"
              message={intl.get('历史版本加载失败，请刷新重试')}
              action={<Button onClick={load}>{intl.get('重试')}</Button>}
            />
          ) : (
            detail && (
              <>
                <div className={styles.labels}>
                  <span>
                    {isPhone ? '− ' : ''}
                    {intl.get('历史版本')}
                  </span>
                  <span>
                    {isPhone ? '＋ ' : ''}
                    {intl.get('当前已保存文件')}
                  </span>
                </div>
                {identical && (
                  <Alert type="success" message={intl.get('与当前文件一致')} />
                )}
                <div className={styles.diff}>
                  {isPhone ? (
                    <ReactDiffViewer
                      oldValue={detail.version.content}
                      newValue={detail.current}
                      splitView={false}
                      disableWordDiff
                      useDarkTheme={theme.includes('dark')}
                      styles={{
                        contentText: {
                          wordBreak: 'break-all',
                          whiteSpace: 'pre-wrap',
                        },
                      }}
                    />
                  ) : (
                    <DiffEditor
                      language={language}
                      original={detail.version.content}
                      modified={detail.current}
                      theme={theme}
                      options={{
                        readOnly: true,
                        originalEditable: false,
                        fontSize: 12,
                        minimap: { enabled: false },
                        scrollBeyondLastLine: false,
                        renderSideBySide: true,
                        automaticLayout: true,
                      }}
                    />
                  )}
                </div>
              </>
            )
          )}
        </>
      )}
    </Drawer>
  );
}
