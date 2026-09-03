import React, { useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Modal,
  Space,
  Table,
  Typography,
} from 'antd';
import type { QingLong3Capabilities } from '@/utils/qinglong3';
import {
  createPanelRunControl,
  PanelRunControlError,
  type PanelTask,
  type PanelRun,
  type PreparedRunAction,
  type RunPage,
  type RunCursor,
} from './runControl';

const terminal = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);
const labels: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  timed_out: '已超时',
  created: '已创建',
  queued: '排队中',
  dispatching: '派发中',
  running: '运行中',
  waiting_approval: '等待审批',
  retry_wait: '等待重试',
  lost: '执行状态待核对',
};
const errors: Record<string, string> = {
  authentication_required: '凭据已失效，请重新登录。',
  authorization_denied: '当前身份没有执行该操作的权限。',
  task_start_fence_rejected:
    '任务版本或权限在确认期间已改变。本次启动被拒绝，请刷新任务后重新确认。',
  session_changed: '连接已改变，请关闭窗口并重新登录。',
  task_not_ready: '请先读取当前任务，已停用的任务不能启动。',
  run_not_active: '请选择并刷新一个尚未结束的运行。',
};

export default function QingLong3RunControlModal({
  cron,
  capabilities,
  onClose,
}: {
  cron: any;
  capabilities: Readonly<QingLong3Capabilities>;
  onClose(): void;
}) {
  const clientRef = useRef<ReturnType<typeof createPanelRunControl>>();
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [task, setTask] = useState<PanelTask>();
  const [page, setPage] = useState<RunPage>();
  const [cursor, setCursor] = useState<RunCursor>();
  const [run, setRun] = useState<PanelRun>();
  const [log, setLog] = useState('');
  const [prepared, setPrepared] = useState<PreparedRunAction>();
  const [uncertain, setUncertain] = useState(false);

  const work = async (
    action: (client: ReturnType<typeof createPanelRunControl>) => Promise<void>,
  ) => {
    const client = clientRef.current;
    if (!client || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action(client);
    } catch (caught) {
      if (clientRef.current !== client) return;
      const failure = caught instanceof PanelRunControlError ? caught : null;
      if (!client.isCurrent()) {
        setTask(undefined);
        setRun(undefined);
        setPage(undefined);
        setLog('');
        setPrepared(undefined);
        setError(errors.session_changed);
      } else {
        setError(
          failure?.uncertain
            ? '服务端可能已收到请求。请重试同一请求以核对结果；不要新建另一份启动请求。'
            : errors[failure?.code || ''] ||
                '读取或操作失败，请检查服务与权限后手动重试。',
        );
        setUncertain(Boolean(failure?.uncertain));
      }
    } finally {
      if (clientRef.current === client) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  const loadRuns = async (
    client: ReturnType<typeof createPanelRunControl>,
    after?: RunCursor,
  ) => {
    const result = await client.listRuns(after);
    if (!client.isCurrent()) return;
    setPage(result);
    setCursor(after);
    setRun(undefined);
    setLog('');
  };
  const selectRun = async (
    client: ReturnType<typeof createPanelRunControl>,
    id: string,
  ) => {
    const result = await client.readRun(id);
    if (client.isCurrent()) {
      setRun(result);
      setLog('');
    }
  };
  useEffect(() => {
    let client: ReturnType<typeof createPanelRunControl>;
    try {
      client = createPanelRunControl(cron, capabilities);
    } catch {
      setError('当前服务未开放执行管理，或条目标识无效。');
      return;
    }
    clientRef.current = client;
    void work(async () => {
      const current = await client.readTask();
      if (client.isCurrent()) setTask(current);
      await loadRuns(client);
    });
    return () => {
      client.dispose();
      clientRef.current = undefined;
      busyRef.current = false;
    };
  }, [cron, capabilities]);

  const prepare = (kind: 'start' | 'cancel') =>
    void work(async (client) => {
      const action =
        kind === 'start'
          ? client.prepareStart(task!)
          : client.prepareCancel(run!);
      setPrepared(action);
      setNotice('');
      setUncertain(false);
    });
  const execute = () =>
    void work(async (client) => {
      if (!prepared) return;
      const receipt = await prepared.execute();
      if (!client.isCurrent()) return;
      setPrepared(undefined);
      setUncertain(false);
      setNotice(
        prepared.kind === 'start'
          ? `运行已登记：${receipt.runId}。排队不代表已经执行成功。`
          : `取消请求结果：${receipt.status}。只有运行进入终态才表示已结束。`,
      );
      await selectRun(client, receipt.runId);
    });
  const close = () => {
    if (busy || uncertain) {
      Modal.confirm({
        title: '关闭执行管理？',
        content:
          '关闭窗口不会撤销已发送的请求。再次打开时请先核对运行记录，避免重复启动。',
        onOk: onClose,
      });
    } else onClose();
  };
  const blocked = busy || Boolean(prepared);
  return (
    <Modal
      open
      title="执行管理 · QingLong 3.0"
      width={860}
      onCancel={close}
      footer={<Button onClick={close}>关闭</Button>}
      destroyOnClose
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Alert
          type="info"
          showIcon
          message="手动运行使用 Task 当前版本，不修改定时计划。"
          description="取消针对选中的 Run；没有后台轮询，请手动刷新确认状态。实际操作仍受项目权限控制。"
        />
        {error && <Alert type="error" showIcon message={error} />}
        {notice && <Alert type="success" showIcon message={notice} />}
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="任务">
            {task?.name || cron.name} ·{' '}
            <Typography.Text code>{cron.ql3.taskId}</Typography.Text>
          </Descriptions.Item>
          <Descriptions.Item label="定时绑定版本">
            {cron.ql3.taskRevision}
          </Descriptions.Item>
          <Descriptions.Item label="本次运行版本">
            {task
              ? `${task.revision}${task.enabled ? '' : '（已停用）'}`
              : '未读取'}
          </Descriptions.Item>
        </Descriptions>
        <Space wrap>
          <Button
            disabled={blocked}
            onClick={() =>
              void work(async (client) => {
                const current = await client.readTask();
                if (client.isCurrent()) setTask(current);
              })
            }
          >
            刷新任务版本
          </Button>
          <Button
            type="primary"
            disabled={blocked || !task?.enabled}
            onClick={() => prepare('start')}
          >
            运行一次
          </Button>
        </Space>
        {prepared && (
          <Alert
            type="warning"
            showIcon
            message={
              prepared.kind === 'start'
                ? `确认运行 Task ${prepared.target} · revision ${task?.revision}？`
                : `确认请求取消 Run ${prepared.target}？`
            }
            description={
              <Space direction="vertical" style={{ width: '100%' }}>
                <Typography.Text type="secondary">
                  请求 ID：{prepared.mutationId}。重试会复用此 ID。
                </Typography.Text>
                <Space wrap>
                  <Button
                    danger={prepared.kind === 'cancel'}
                    type="primary"
                    loading={busy}
                    onClick={execute}
                  >
                    {uncertain
                      ? '重试同一请求'
                      : prepared.kind === 'start'
                      ? '确认运行一次'
                      : '确认请求取消'}
                  </Button>
                  <Button
                    disabled={busy || uncertain}
                    onClick={() => setPrepared(undefined)}
                  >
                    放弃确认
                  </Button>
                </Space>
              </Space>
            }
          />
        )}
        <Typography.Title level={5} style={{ margin: 0 }}>
          运行记录
        </Typography.Title>
        <Typography.Text type="secondary">
          每页扫描项目最近至多 64
          条，仅显示本任务匹配项；空页不表示没有更早的运行。翻页替换当前窗口。
        </Typography.Text>
        <Table<PanelRun>
          size="small"
          rowKey="id"
          pagination={false}
          loading={busy}
          dataSource={page?.runs || []}
          scroll={{ x: 600 }}
          locale={{
            emptyText: '当前窗口没有匹配运行，可继续查找或回到最近记录。',
          }}
          columns={[
            {
              title: 'Run ID',
              dataIndex: 'id',
              render: (id: string) => (
                <Button
                  type="link"
                  disabled={blocked}
                  style={{ padding: 0, maxWidth: '100%' }}
                  onClick={() => void work((client) => selectRun(client, id))}
                >
                  {id}
                </Button>
              ),
            },
            { title: '版本', dataIndex: 'taskRevision' },
            {
              title: '状态',
              dataIndex: 'status',
              render: (status: string) => labels[status],
            },
          ]}
        />
        <Space wrap>
          <Button
            disabled={blocked}
            onClick={() => void work((client) => loadRuns(client, cursor))}
          >
            刷新当前窗口
          </Button>
          <Button
            disabled={blocked || !cursor}
            onClick={() => void work((client) => loadRuns(client))}
          >
            最近记录
          </Button>
          <Button
            disabled={blocked || !page?.next}
            onClick={() => void work((client) => loadRuns(client, page?.next))}
          >
            继续查找更早运行
          </Button>
        </Space>
        {run && (
          <>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="已选 Run">
                <Typography.Text code>{run.id}</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                {labels[run.status]}
              </Descriptions.Item>
            </Descriptions>
            <Space wrap>
              <Button
                disabled={blocked}
                onClick={() => void work((client) => selectRun(client, run.id))}
              >
                刷新运行状态
              </Button>
              <Button
                disabled={blocked}
                onClick={() =>
                  void work(async (client) => {
                    const text = await client.readLog(run);
                    if (client.isCurrent()) setLog(text);
                  })
                }
              >
                读取本次日志
              </Button>
              <Button
                danger
                disabled={blocked || terminal.has(run.status)}
                onClick={() => prepare('cancel')}
              >
                请求取消本次运行
              </Button>
            </Space>
          </>
        )}
        {log && (
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              overflowWrap: 'anywhere',
              maxHeight: 320,
              overflow: 'auto',
            }}
          >
            {log}
          </pre>
        )}
      </Space>
    </Modal>
  );
}
