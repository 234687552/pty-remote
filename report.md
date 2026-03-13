# pty-remote 验证与逻辑分析报告

## 1. 范围与方法

- 验证时间：2026-03-12
- 验证方式：本地运行中的真实服务 + Playwright 实操
- 桌面端视口：1440 x 960
- 移动端视口：390 x 844
- 联网查询：未使用，当前结论均来自本地代码与真实交互

本次重点验证：

- thread 创建与切换
- 消息发送
- 带工具调用的问题
- messages 面板内容
- terminal 面板内容
- 移动端 Chat / Terminal pane 切换

未自动化覆盖项：

- 添加项目：依赖系统目录选择器 `osascript choose folder`，不适合用页面内 Playwright 直接完成

## 2. Playwright 实测结论

### 2.1 桌面端

已验证通过：

- 新建 thread 成功
- 发送带工具调用的问题成功
- `messages` 能显示用户消息、工具卡片、工具结果
- `terminal` 能显示 prompt、工具执行过程、最终输出
- 在两个新建 thread 之间切换后，`messages` 与 `terminal` 都能切到对应内容

实际跑过的用例：

1. `PLAYWRIGHT_DESKTOP_CASE_A_*`
   - 问题：读取 `package.json`，只返回 `name` 和 `version`
   - 工具表现：`Read(package.json)`
   - 会话片段：`e909b5fc`

2. `PLAYWRIGHT_DESKTOP_CASE_B_*`
   - 问题：列出 `src` 目录前 3 个文件名
   - 工具表现：`Bash(ls src | head -3)`
   - 会话片段：`53dc4c9a`

thread 切换验证结果：

- 从 `53dc4c9a` 切回 `e909b5fc` 成功
- 两个 thread 的 header、messages、terminal 回放内容都正确对应

### 2.2 移动端

已验证通过：

- 移动端输入框可继续发送消息
- `Chat` / `Terminal` pane 切换正常
- 切到 `Terminal` 后能看到对应 thread 的终端内容
- 移动端切 thread 后，`Chat` 与 `Terminal` 内容保持一致

实际跑过的用例：

1. `PLAYWRIGHT_MOBILE_CASE_C_*`
   - 问题：读取 `shared/protocol.ts` 中 `CliRegisterResult` 的字段名
   - 工具表现：`Read(shared/protocol.ts)`
   - 返回结果：`ok`、`cliId`、`error`

2. 移动端切到桌面端测试生成的 `53dc4c9a` thread
   - `Chat` 显示 `Bash(ls src | head -3)` 的消息内容
   - `Terminal` 显示同一 thread 的终端回放

## 3. 交互层面发现

### 3.1 明确通过

- 核心主路径是通的：`thread -> send -> tool call -> messages -> terminal -> switch thread`
- 桌面端和移动端都能消费同一份会话状态
- 之前修过的 thread 切换 terminal 空白问题，这次没有复现

### 3.2 观察到的行为

1. 每次 Claude 完成后，terminal 都停在：
   - `Ran 2 stop hooks`
   - `Stop hook prevented continuation`
   - `-- INSERT --`

2. 但 UI 顶部状态已经显示 `status: idle`

这说明：

- “是否还在真正可继续交互” 与 “runtime status 是否 idle” 不是同一个概念
- 当前 UI 暴露的是一个较粗粒度状态，不足以表达 PTY 真实可输入状态

3. 桌面端侧边栏虽然功能可用，但它本质仍是一个全屏 overlay drawer
   - 当 drawer 打开时，整层蒙版会拦截右侧交互
   - drawer 收起后，thread 相关按钮仍在 DOM 中，只是被移到视口左侧
   - 这也是自动化点击时频繁出现 “element is outside of the viewport / backdrop intercepts pointer events” 的直接原因

## 4. 第一性原则分析

### 4.1 状态源过多，前端同步成本偏高

代码位置：

- `web/src/app.tsx:1452-1468`
- `web/src/app.tsx:1706-1888`

当前前端同时维护：

- `workspaceState.projects`
- `projectThreadsById`
- `snapshot`
- `clis`
- `activeCliIdRef`

然后再通过一组 `useEffect` 去互相修正：

- 补 `activeCliId`
- 补 `activeThreadId`
- 根据 snapshot 回写 thread 标题和 preview
- 根据 sidebar 状态触发 project 刷新
- 根据 activeCliId 拉取 runtime snapshot

从第一性原则看，一个 UI 选择状态应该尽量只有一个事实来源。现在属于“能跑，但靠同步维持一致性”的结构。

更优雅的方向：

- 用一个 reducer 或 store 统一管理：
  - `selection`
  - `projects`
  - `threads`
  - `clis`
  - `runtime`
- 把“派生修正型 effect”变成显式 action
- 避免多个 effect 在不同时间片里互相补状态

### 4.2 桌面端与移动端共用同一套 drawer 语义，不够干净

代码位置：

- `web/src/app.tsx:2408-2429`
- `web/src/app.tsx:2627-2648`

当前 sidebar 容器对所有尺寸都使用：

- `fixed inset-0` overlay
- backdrop
- 左侧抽屉 `translate-x`

这对移动端是合理的，对桌面端则不够自然。

第一性原则上：

- 移动端适合 modal drawer
- 桌面端适合 persistent rail / docked sidebar

更优雅的方向：

- `lg` 以下保留当前 drawer
- `lg` 以上改成常驻侧栏，不要全屏蒙版
- 桌面端只做折叠，不做 modal 化

这样能直接消掉：

- backdrop 抢事件
- 控件离屏但仍存在于 DOM
- 自动化和真实交互都需要“先开抽屉再操作”的额外步骤

### 4.3 runtime status 语义过粗，和 PTY 真实状态不完全一致

代码位置：

- `shared/runtime-types.ts:3`
- `src/cli/jsonl.ts:311-355`
- `src/cli/pty-manager.ts:1094-1114`
- `web/src/app.tsx:1894-1902`

现在状态模型只有：

- `idle`
- `starting`
- `running`
- `error`

但从实测看，Claude 结束后虽然 JSONL 已进入 idle，terminal 仍可能停在：

- stop hook 截断后的 prompt
- insert mode
- 需要进一步人工介入的状态

而代码里其实已经有 PTY 侧的 readiness heuristics：

- `looksReadyForInput`
- `looksLikeBypassPrompt`

只是这些信息没有被提升到 UI runtime model。

更优雅的方向：

- 保留 `RuntimeStatus`
- 另外增加一个更贴近终端真实状态的字段，例如：
  - `promptReady`
  - `terminalMode`
  - `blockedByHook`

这样前端就可以明确区分：

- Claude 任务结束了
- 终端已经真正可继续输入

### 4.4 CLI 注册表缺少生命周期收敛

代码位置：

- `src/socket/server.ts:54`
- `src/socket/server.ts:130-134`
- `src/socket/server.ts:475-489`

当前 server 对 CLI 的处理是：

- 注册时放入 `cliRecords`
- 断开时只标记 `connected: false`
- 不做淘汰、不做 TTL、不做显式清理

这会带来两个后果：

1. 已断开的 CLI 仍然可能长期出现在列表里
2. server 更像一个“历史登记簿”，而不是“当前在线目录”

更优雅的方向：

- 如果产品目标是“只关心当前在线 CLI”，断开就删除
- 如果要保留最近离线实例，至少做 TTL 清理
- UI 默认只展示在线项，离线项放到二级视图

### 4.5 `app.tsx` 的职责已经过重

代码位置：

- `web/src/app.tsx` 整体，尤其 `1439-1888` 与 `2390-2853`

当前单文件同时负责：

- socket 生命周期
- terminal 生命周期
- workspace 持久化
- CLI / project / thread 选择
- runtime snapshot 同步
- message 渲染
- terminal 渲染
- sidebar / mobile pane / composer UI

这会让未来的任何小改动都容易跨模块产生连锁影响。

更优雅的方向：

- `useCliSocket()`
- `useTerminalBridge()`
- `useWorkspaceStore()`
- `Sidebar`
- `ChatPane`
- `TerminalPane`
- `Composer`

不是为了“拆而拆”，而是为了把 transport、state、render 三层分开。

## 5. 优先级建议

### P1

- 桌面端 sidebar 改成常驻侧栏，移动端继续使用 drawer
- 给 runtime 增加“终端是否真正 ready”的状态，不再只显示粗粒度 `idle`
- 把 `workspaceState + projectThreadsById + snapshot` 收敛成单一状态模型

### P2

- 为断开的 CLI 增加 TTL 清理或默认隐藏
- 把 `app.tsx` 按 transport / state / view 拆开

### P3

- 增加正式的 E2E 用例，至少覆盖：
  - 新 thread
  - 工具调用
  - 桌面端 thread 切换
  - 移动端 pane 切换
  - CLI 重连 / 重复启动拒绝

## 6. 最终判断

当前系统不是“逻辑混乱”，而是“主路径已经可用，但状态模型和桌面/移动交互语义还不够收敛”。

如果只看能不能用，答案是可以。

如果看未来继续迭代的稳定性和优雅程度，最应该优先收紧的是三件事：

1. sidebar 的桌面/移动语义分离
2. frontend 单一状态源
3. runtime status 与 PTY 真实可交互状态对齐
