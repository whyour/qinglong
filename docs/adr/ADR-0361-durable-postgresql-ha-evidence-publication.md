# ADR-0361：PostgreSQL HA 证据的私有持久发布与离线审计

- 状态：Accepted
- 日期：2026-08-11
- 关联：QL-RFC-0001 D-123、D-273、ADR-0125、ADR-0356

## 上下文

`qinglong/postgresql-ha-contract@v1` 已经能在真实 PostgreSQL 18 Docker 拓扑中证明物理流复制、
`remote_apply`、复制链分区、旧主 fencing、timeline promotion、`pg_rewind` 只读重入、两套 Control
摘流/重建，以及多个领域的 COMMIT-response-loss 收敛。此前脚本只把完整 JSON 写到 stdout；当前报告
约 67 KiB、112 个 gate，终端或 CI 日志截断后无法作为稳定、可离线复核的证据。stdout 成功退出只能
证明当次进程没有抛错，不能证明后来读取的报告与当次运行是同一内容。

## 决策

1. HA contract 在启动 Docker 之前先解析报告目标。调用方可以通过唯一的绝对
   `--report=/path/report.json` 或 `QL3_HA_REPORT` 指定路径；两者同时出现、路径非规范、父目录为
   symlink/非 canonical 或目标已存在时失败关闭。未指定时只为本机交互运行选择一个随机私有临时路径。
2. 完整报告以同目录随机 `0600` 临时文件写入并 fsync，随后以 hard-link no-replace 原子发布，再 fsync
   父目录；无论成功或失败均删除临时文件。脚本不覆盖已有证据，也不使用跨文件系统 rename、shell
   重定向或可预测临时名。
3. stdout 只保留单行低敏 envelope：fixture、状态、报告绝对路径、完整序列化 SHA-256、架构、PostgreSQL
   version number、promotion 前后 timeline 和 gate 数。完整领域记录不再挤入 CI 日志。
4. 独立 `ql3-postgres-ha-evidence-audit` 只读接受 canonical、当前 UID/root 拥有、精确 `0600`、不超过
   4 MiB 的普通文件。它复核 PostgreSQL 18、x64/arm64、物理 streaming/`remote_apply`、同步 standby、
   timeline 单调提升、旧 control 摘流、新 control 重建、分区写不被确认、promotion guard、`pg_rewind`
   只读同步重入、ambiguous/uncommitted transaction 窗口、至少 100 个且全部为 true 的 gate、关键 timeline
   顺序、固定 limitation 和已知测试 credential/material 字符串不存在。
5. 默认双架构 HA CI 必须为每个 matrix runner 创建私有报告目录，运行 contract 后立即运行独立 auditor，
   并以包含 architecture/run ID/attempt 的名称保存 14 天 artifact。workflow run metadata 提供 commit/run
   归属；本机 dirty-worktree 报告不得冒充 release provenance。

## 不采用方案

- **继续依赖 stdout 日志**：大报告会被截断，不能 no-replace，也不能离线复核文件身份。
- **直接覆盖固定报告路径**：重跑会抹掉旧事实，无法区分新旧拓扑结果。
- **只检查 `gates.passed`**：单个总布尔值不能发现 gate 集合缩小、timeline 倒序、limitation 漂移或私有材料泄漏。
- **把 Docker HA 称为生产 STONITH/代理证据**：现有 test-only endpoint 和 promotion guard 的限制保持不变；
  CloudNativePG/基础设施 fencing 仍由独立门负责。

## 结果

2026-08-11 在 arm64 重新运行修改后的完整门禁，退出码为 0。报告为 67,585 bytes、mode `0600`，
SHA-256 `4793bb15bf3fa680a7a5d8873d0d4e58604e944fc7207d38a50470f83beaa0a4`；stdout envelope
记录 PostgreSQL 18.4 (`180004`)、timeline `1 → 2` 和 112 个 gate。独立 auditor 返回
`compatible=true`、`findings=[]`，临时 `ql3-ha-*` 容器零残留。

该变更不修改 migration、数据库角色、HA 故障注入、生产 Pool、Profile closure 或任何常驻进程；只是把
已有真实门的输出从易失日志升级为可保存、不可覆盖、可离线审计的证据。

## 验证

```bash
install -d -m 0700 /absolute/private/ql3-postgres-ha
QL3_HA_REPORT=/absolute/private/ql3-postgres-ha/report.json \
  pnpm test:postgres-ha:ql3
pnpm audit:postgres-ha-evidence:ql3 -- \
  --report=/absolute/private/ql3-postgres-ha/report.json
```
