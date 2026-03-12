# TODO

## Projects 存储位置争议点

### 当前决定
- **暂时继续放在前端缓存（localStorage）**
- 不在这一轮把 projects 持久化迁到 Agent 本地

### 当前方案的问题
- 浏览器清缓存后，`projects` 列表会丢失
- 目录记录和 Agent 本地实际运行环境并不是同一个持久化边界

### 为什么现在先不改
- 前端缓存方案更轻，改动面更小
- 当前重点仍然是消息流、线程切换、运行状态稳定性
- 先保持简单，避免把 project 管理也扩成一套后端持久化逻辑

### 后续可选方向
- 在 Agent 本地增加一个轻量持久化文件，例如：
  - `~/.pty-remote/projects.json`
- 只保存最小字段：
  - `cwd`
  - `label`
  - `lastOpenedAt`
  - 可选 `pinned`
- **不要**持久化 thread 列表
  - thread 仍然按需从 Claude 的 jsonl 历史扫描得到

### 目标边界（候选）
- Agent 持久化：project 列表
- 前端缓存：UI 状态（active project/thread、sidebar 折叠态等）
- thread 历史：继续从 jsonl 动态获取

### 触发改造的时机
- 用户频繁反馈“清缓存后项目全没了”
- 需要跨浏览器/跨设备保留项目列表
- 侧边栏 project 管理开始变复杂，前端缓存已不够稳
