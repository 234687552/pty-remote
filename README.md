# pty-remote

`pty-remote` 把本地 AI CLI（`claude` / `codex`）托管成可远程访问的 Web + Socket 服务。

## 组件关系

### 角色分工
- `relay`（`pty-remote server`）:
  - 提供 Web 静态页面（`public/build`）
  - 提供 Socket 网关（`/web` 和 `/cli` 两个 namespace）
  - 转发命令、广播状态，并缓存快照/消息/终端回放
- `cli`（`pty-remote cli`）:
  - 连接 relay 的 `/cli`
  - 管理 provider 运行时（PTY、消息、会话）
  - 接收 relay 下发命令并回传 `snapshot/messages/terminal`

### 数据链路
```text
Browser(Web UI)
    <-> relay (/web namespace)
relay (/cli namespace)
    <-> CLI runtime (claude/codex PTY)
```

核心流程：
1. `cli` 连接 relay 并 `cli:register` 注册自身与支持的 provider。
2. `web` 连接 relay，订阅某个 `cli + provider + conversation`。
3. 用户在 Web 发命令 -> relay 转发给 cli（`cli:command`）。
4. cli 执行后持续上报：
   - `cli:snapshot`（会话状态）
   - `cli:messages-upsert`（增量消息）
   - `cli:terminal-chunk`（终端输出）
5. relay 将事件广播给订阅中的 web 客户端，并做断线恢复缓存。

## 部署说明

前置：
- Node.js `>=23`
- 在 **CLI 部署机** 上安装可执行文件：`claude` 或 `codex`

### 方案 A：同机部署（快速启动）
```bash
# 启动 relay（含 Web）
HOST=0.0.0.0 PORT=3001 npx @lzdi/pty-remote server

# 另一个终端启动 cli
SOCKET_URL=http://127.0.0.1:3001 npx @lzdi/pty-remote cli
```

浏览器访问：`http://127.0.0.1:3001`

### 方案 B：分机部署（推荐）
1. Relay 机：
```bash
HOST=0.0.0.0 PORT=3001 npx @lzdi/pty-remote server
```
2. CLI 机：
```bash
SOCKET_URL=http://<relay-host>:3001 npx @lzdi/pty-remote cli
```
3. Web 用户直接访问：
```text
http://<relay-host>:3001
```

## 本地开发

```bash
npm install
npm run dev
```

`npm run dev` 会并行启动：
- `dev:web`（Vite build --watch）
- `dev:socket`（relay）
- `dev:cli`（cli）

## 配置优先级

优先级：环境变量 > `~/.pty-remote/*.conf`

首次运行会自动将模板复制到用户目录（若文件不存在）：
- `relay.conf` -> `~/.pty-remote/relay.conf`
- `cli.conf` -> `~/.pty-remote/cli.conf`

最常用变量：
- relay：`HOST`、`PORT`
- cli：`SOCKET_URL`、`PTY_REMOTE_PROVIDERS`、`PTY_REMOTE_CLI_ID`
- web 构建：`VITE_SOCKET_URL`（未设置时默认 `window.location.origin`）

## 常用命令

```bash
# 启动 relay
pty-remote server

# 启动 cli
pty-remote cli

# 查看历史线程（等价于 pty-remote cli threads）
pty-remote threads
```

`threads` 当前读取 Claude 本地会话文件。

健康检查：
```bash
curl http://127.0.0.1:3001/healthz
```
