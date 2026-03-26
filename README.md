# pty-remote

`pty-remote` 把本地 AI CLI 会话托管成可远程访问的 Web + Socket 服务。当前仓库已经拆成 3 个 npm workspace，用来隔离 `relay` 和 `cli` 的安装依赖。

## 包划分

- `@lzdi/pty-remote-relay`
  - 部署在服务端
  - 提供 Web 静态页面和 Socket 网关
  - 不依赖 `node-pty`
- `@lzdi/pty-remote-cli`
  - 部署在实际运行 `claude` / `codex` 的机器
  - 负责 PTY、会话管理、消息同步
  - 依赖 `node-pty`
- `@lzdi/pty-remote-protocol`
  - 共享协议和运行时类型
  - 作为 `relay` 和 `cli` 的传递依赖，通常不需要单独安装

## 链路

```text
Browser
  <-> relay (/web namespace)
relay
  <-> cli (/cli namespace)
cli
  <-> claude / codex PTY
```

核心过程：

1. `cli` 连接 `relay`，上报自身信息和支持的 provider。
2. 浏览器连接 `relay`，订阅某个 `cli + provider + conversation`。
3. Web 侧发出的命令由 `relay` 转发给目标 `cli`。
4. `cli` 持续回传 `snapshot`、`messages-upsert`、`terminal-chunk`。
5. `relay` 负责广播、缓存、断线恢复和 Web UI 展示。

## 开发启动

开发模式面向当前 monorepo workspace。

前置条件：

- Node.js `>=23`
- 本机可执行 `claude` 和/或 `codex`

安装依赖：

```bash
npm install
```

一键启动本地开发：

```bash
npm run dev
```

默认行为：

- `relay`：启动 socket server，并同时 watch 构建 Web 静态资源
- `cli`：启动本地 CLI runtime，默认同时启用 `claude,codex`

如果只想单独启动某一部分：

```bash
# 只启动 relay
npm run dev:relay

# 只启动 cli
npm run dev:cli

# 只启动 claude provider
npm run dev:cli:claude

# 只启动 codex provider
npm run dev:cli:codex
```

本地开发下的访问方式：

```text
Web:    http://127.0.0.1:3001
Health: http://127.0.0.1:3001/healthz
```

常用命令：

```bash
npm run build:relay
npm run build:cli
npm run start:relay
npm run start:cli
npm run start:cli:claude
npm run start:cli:codex
npm run threads -- --cwd .
```

## 生产部署

前置条件：

- Node.js `>=23`
- `cli` 部署机上需要能直接执行 `claude` 或 `codex`

推荐使用分机部署：

- `relay` 部署在服务端，负责 Web 和 Socket 网关
- `cli` 部署在执行 AI CLI 的机器上，负责 PTY 和会话

### 1. 部署 relay

Relay 机器安装并启动：

```bash
npm i -g @lzdi/pty-remote-relay
HOST=0.0.0.0 PORT=3001 pty-remote-relay
```

如果希望常驻运行，建议交给 `systemd`、`pm2` 或容器来托管，而不是直接挂在交互 shell 里。

### 2. 部署 cli

CLI 机器安装并启动：

```bash
npm i -g @lzdi/pty-remote-cli
SOCKET_URL=http://<relay-host>:3001 pty-remote-cli
```

如果只启一个 provider：

```bash
SOCKET_URL=http://<relay-host>:3001 PTY_REMOTE_PROVIDER=claude pty-remote-cli
SOCKET_URL=http://<relay-host>:3001 PTY_REMOTE_PROVIDER=codex pty-remote-cli
```

如果同一台机器要同时接多个 provider，直接使用：

```bash
SOCKET_URL=http://<relay-host>:3001 PTY_REMOTE_PROVIDERS=claude,codex pty-remote-cli
```

### 3. 访问 Web

浏览器访问：

```text
http://<relay-host>:3001
```

### 4. 同机快速验证

```bash
npx -y @lzdi/pty-remote-relay
SOCKET_URL=http://127.0.0.1:3001 npx -y @lzdi/pty-remote-cli
```

## 配置

优先级：环境变量 > `~/.pty-remote/*.conf`

首次运行时会自动把模板复制到：

- `~/.pty-remote/relay.conf`
- `~/.pty-remote/cli.conf`

常用变量：

- relay: `HOST`, `PORT`
- cli: `SOCKET_URL`, `PTY_REMOTE_PROVIDERS`, `PTY_REMOTE_PROVIDER`, `PTY_REMOTE_CLI_ID`
- web: `VITE_SOCKET_URL`

Claude / Codex PTY 默认通过当前用户的登录交互 shell 启动，因此会尽量复用 `~/.zshrc`、`alias claude=...`、`alias codex=...`、shell function 和代理环境。

要求：

- 启动 `pty-remote-cli` 的环境里必须存在 `SHELL`
- 你的 shell 配置需要能在登录交互模式下解析 `claude` / `codex`

```bash
curl http://127.0.0.1:3001/healthz
```

## GitHub 自动发包

仓库内置了 GitHub Actions 工作流：

- workflow: `.github/workflows/publish-npm.yml`
- 触发方式：
  - 手动 `workflow_dispatch`
  - 推送 tag：`v*`

发布行为：

- 先执行 `npm ci`
- 再执行 `npm run build`
- 最后按 workspace 依赖顺序自动发布所有 `private: false` 的包
- 已经存在于 npm 的同版本会自动跳过

需要在 GitHub 仓库里配置：

- `NPM_TOKEN`

如果只是本地预演发布顺序，可以运行：

```bash
DRY_RUN=1 npm run release:publish
```
