# 青龙 2.x CLI / QingLong 2.x CLI

TypeScript CLI 位于 [`cli/`](../../cli/README.md)，统一使用 `ql` 二级命令管理认证、任务、订阅及本机执行/运维；`task` 是 `ql task` 的快捷入口。参数解析使用 Commander 15，最低 Node 22.12，推荐 Node 24。原 Shell 保留，面板通过 `QL_CLI_ROOT` 显式选择新入口。

The TypeScript CLI uses a unified `ql` command tree for authentication, tasks, subscriptions and local operations. `task` is a shortcut for `ql task`. Commander 15 requires Node 22.12 or newer; Node 24 is recommended. Original Shell entries remain, and panel integration is opt-in through `QL_CLI_ROOT`.

- [中文说明](../../cli/README.md) / [English guide](../../cli/README.en.md)
- [Commander 重构验收 / Migration validation](commander-refactor-20260925.md)
- [Shell 能力映射 / Shell capability audit](shell-capability-audit.md)
- [Agent Skill](../../cli/skills/qinglong-cli/SKILL.md)
