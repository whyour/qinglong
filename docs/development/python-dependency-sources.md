# Python 依赖来源

依赖管理中可手动添加 Python 包名、`git+https://` 等 pip 支持的源 URL，或脚本/订阅仓库目录内的 requirements 文件、pyproject.toml 路径。文件路径支持目录空格，必须位于持久化 scripts 或 repo 根目录内；越界与指向根目录外的符号链接会被拒绝。

requirements 使用 `pip install -r`，pyproject 使用完整项目目录安装，保留相对依赖文件和项目源码。拉取订阅不会自动安装仓库声明的依赖。

删除 requirements 条目会调用 `pip uninstall -r`。源 URL 或 pyproject 条目无法可靠逆向推断其安装的所有分发包，因此删除该条目只移除面板记录；需另外按包名卸载已安装的包，日志会明确提示。
