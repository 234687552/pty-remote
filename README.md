# pty-remote

**简版部署（两端）**
前置条件
- Node.js >= 23

服务端（Socket + Web 静态）
- 启动 Socket：`HOST=0.0.0.0 PORT=3001 npx @lzdi/pty-remote server`

客户端（CLI）
- 确保已安装 `claude` 或 `codex`
- 启动 CLI：`SOCKET_URL=http://<server-host>:3001 npx @lzdi/pty-remote cli`

说明
- 首次运行会自动构建 `public/build`（由 `postinstall` 触发）
- `pty-remote threads` 等同于 `pty-remote cli threads`

本地启动（开发）：`npm run dev`

**发布流水线**
触发方式
- 打 tag：`vX.Y.Z`（例如 `v0.1.0`）推送后自动发布到 npm
- 或在 GitHub Actions 手动触发 `Publish to npm`

所需 Secret
- `NPM_TOKEN`：npm 访问令牌（npmjs.org）

**配置说明**
配置文件路径约定（两层）
- 包内默认模板：`<package-root>/relay.conf`、`<package-root>/cli.conf`
- 用户生效配置：`~/.pty-remote/relay.conf`、`~/.pty-remote/cli.conf`
- 首次启动会将包内模板复制到 `~/.pty-remote/`（若目标文件不存在）
- 环境变量优先级高于上述配置文件

服务端（`src/socket/server.ts`）
- `HOST`：监听地址，默认 `127.0.0.1`
- `PORT`：监听端口，默认 `3001`
- 生效位置：启动 Socket 进程的环境变量（优先级最高）
- 未设置时会读取 `~/.pty-remote/relay.conf` 的 `HOST` / `PORT`

Relay 缓存（`relay.conf`）
- `HOST` / `PORT`：服务端监听地址与端口
- `RELAY_REPLAY_BUFFER_SIZE`：每会话消息回放条数
- `RELAY_SNAPSHOT_CACHE_MAX`：缓存会话快照数量上限（LRU）
- `RELAY_SNAPSHOT_MAX_BYTES`：单个快照最大字节数，超限丢弃
- `RELAY_TERMINAL_REPLAY_MAX_BYTES`：终端回放最大缓存字节数
- `RELAY_CLI_COMMAND_TIMEOUT_MS`：转发 CLI 命令超时时间（毫秒）
- 配置文件位置：`~/.pty-remote/relay.conf`
- 默认模板来源：`<package-root>/relay.conf`
- 首次启动会复制默认模板到 `~/.pty-remote/relay.conf`（若不存在）

CLI（`src/cli/client.ts`）
- `SOCKET_URL`：CLI 连接服务端地址（优先级最高）
- `HOST` / `PORT`：未设置 `SOCKET_URL` 时拼接使用
- `PTY_REMOTE_PROVIDER` / `PTY_REMOTE_PROVIDERS`：启用 provider（如 `claude,codex`）
- `PTY_REMOTE_CLI_ID`：固定 CLI 标识；未设置会写入 `~/.pty-remote/cli-id`
- `PTY_REMOTE_MAX_DETACHED_PTYS`：分离 PTY 缓存上限，默认 `5`
- `TERMINAL_COLS` / `TERMINAL_ROWS`：终端列/行
- `TERMINAL_REPLAY_MAX_BYTES`：终端回放最大缓存字节数
- `RECENT_OUTPUT_MAX_CHARS`：最近输出最大字符数
- `CLAUDE_READY_TIMEOUT_MS` / `CODEX_READY_TIMEOUT_MS`：就绪超时（毫秒）
- `PROMPT_SUBMIT_DELAY_MS`：提交 prompt 延迟（毫秒）
- `JSONL_REFRESH_DEBOUNCE_MS`：JSONL 刷新去抖（毫秒）
- `SNAPSHOT_EMIT_DEBOUNCE_MS`：快照发送去抖（毫秒）
- `SNAPSHOT_MESSAGES_MAX`：快照最多消息数
- `OLDER_MESSAGES_PAGE_MAX`：拉取旧消息最大条数
- `GC_INTERVAL_MS`：GC 间隔（毫秒）
- `DETACHED_PTY_TTL_MS`：分离 PTY 保留时长（毫秒）
- `DETACHED_DRAFT_TTL_MS`：草稿保留时长（毫秒）
- `DETACHED_JSONL_MISSING_TTL_MS`：JSONL 缺失等待时长（毫秒）
- `CLAUDE_BIN` / `CODEX_BIN`：provider 可执行文件路径
- `CLAUDE_PERMISSION_MODE`：`default | acceptEdits | dontAsk | plan | bypassPermissions`
- `CODEX_HOME`：Codex 根目录，默认 `~/.codex`
- `CODEX_HISTORY_PATH` / `CODEX_SESSIONS_ROOT_PATH`：Codex 历史记录与会话根目录
- 配置文件位置：`~/.pty-remote/cli.conf`
- 默认模板来源：`<package-root>/cli.conf`
- 首次启动会复制默认模板到 `~/.pty-remote/cli.conf`（若不存在）
- 环境变量优先级最高

Web（`web/src/lib/runtime.ts`）
- `VITE_SOCKET_URL`：前端构建时注入服务端地址；未设置则使用 `window.location.origin`
- 生效位置：Web 构建时环境变量
