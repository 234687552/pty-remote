# Hermes-Agent Built-in Memory 流程说明

## 结论

Hermes-agent 的 built-in memory 不是“每轮都去大记忆库检索”的模式，而是：

1. 会话启动时读取 `MEMORY.md` 和 `USER.md`
2. 把这两份内容整理成一份 frozen snapshot
3. 注入到 system prompt
4. 当前会话后续每次模型调用都带着这份 snapshot
5. 模型在对话过程中可以主动调用 `memory` tool 做 `add / replace / remove`
6. 新写入会落盘，但不会立刻刷新当前会话的 frozen snapshot
7. 下一次新会话启动时，才会读取到更新后的记忆

## 核心流程图

```text
┌───────────────────────────────┐
│ 1. 会话启动                   │
│ 读取 MEMORY.md / USER.md      │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ 2. 构建 system prompt         │
│ 把记忆做成 frozen snapshot    │
│ 注入到系统提示中              │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ 3. 用户发来一轮消息           │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ 4. 模型基于当前输入回答       │
│ 同时看到：                    │
│ - system prompt               │
│ - frozen memory snapshot      │
│ - 当前用户消息                │
└───────────────┬───────────────┘
                ↓
      ┌──────────────────────────────┐
      │ 5. 模型在生成过程中判断      │
      │ 这条信息是否值得长期记忆？   │
      └──────────────┬───────────────┘
                     │
          ┌──────────┴──────────┐
          │                     │
          ↓                     ↓
┌──────────────────────┐   ┌──────────────────────┐
│ 不值得记             │   │ 值得记               │
│ 继续正常回答         │   │ 调用 memory tool     │
└──────────┬───────────┘   └──────────┬───────────┘
           │                          │
           │                          ↓
           │              ┌──────────────────────────┐
           │              │ 6. memory tool 动作选择 │
           │              │ add / replace / remove   │
           │              └──────────┬───────────────┘
           │                         ↓
           │              ┌──────────────────────────┐
           │              │ 7. 检查约束              │
           │              │ - 是否重复               │
           │              │ - 是否越过字符上限       │
           │              │ - 是否命中安全拦截       │
           │              └──────────┬───────────────┘
           │                         │
           │              ┌──────────┴──────────┐
           │              │                     │
           │              ↓                     ↓
           │   ┌──────────────────────┐   ┌──────────────────────┐
           │   │ 检查失败             │   │ 检查通过             │
           │   │ 拒绝写入             │   │ 写入 MEMORY/USER 文件│
           │   └──────────┬───────────┘   └──────────┬───────────┘
           │              │                          │
           └──────────────┴──────────────┬───────────┘
                                          ↓
┌───────────────────────────────────────────────┐
│ 8. 返回本轮回答                               │
│ 注意：当前会话里的 frozen memory 不会立刻更新 │
└───────────────┬───────────────────────────────┘
                ↓
┌───────────────────────────────┐
│ 9. 后台可选 memory review     │
│ 再次检查是否有该补记的内容    │
└───────────────┬───────────────┘
                ↓
┌───────────────────────────────┐
│ 10. 下一次新会话              │
│ 重新读取最新 MEMORY/USER      │
│ 再生成新的 frozen snapshot    │
└───────────────────────────────┘
```

## 它是不是每一轮都去“拿记忆”？

### Built-in memory

不是。

它的行为更准确地说是：

```text
会话开始时拿一次
  -> 形成 frozen snapshot
  -> 当前会话后续每轮请求都带着它
  -> 但不是每轮重新检索
```

所以效果上像“每轮都带记忆”，但实现上不是“每轮都去记忆体重新查一次”。

### External memory provider

如果 Hermes 挂的是 Mem0、Honcho、Hindsight 这类外部 provider，则不同：

```text
每个用户回合开始前 recall 一次
  -> 把命中的相关记忆注入当前回合上下文
  -> 本回合内部的多次 tool loop 复用缓存
  -> 下一回合再重新 recall
```

## 为什么不会无限 token 爆炸？

因为 built-in memory 有硬上限。

- `MEMORY.md` 默认上限约 `2200` 字符
- `USER.md` 默认上限约 `1375` 字符

超限时不是自动摘要，也不是自动淘汰，而是直接拒绝新增。

## 记忆满了以后怎么处理？

Hermes 当前 built-in memory 的方式很朴素：

```text
新增 memory
  -> 先检查重复
  -> 再检查新增后是否超上限
  -> 超限则拒绝
  -> 提示先 replace 或 remove
```

```text
replace memory
  -> 用 old_text 匹配旧条目
  -> 替换为新内容
  -> 再次检查是否超上限
  -> 如果还超限，则拒绝
```

```text
remove memory
  -> 用 old_text 匹配旧条目
  -> 删除并保存
```

也就是说：

- Hermes 不会自动决定删哪条
- Hermes 不做 LRU
- Hermes 不做自动摘要压缩
- Hermes 主要依赖模型自己调用 `add / replace / remove` 维护这块小型常驻记忆

## 方法论理解

Hermes built-in memory 的方法论可以简化成：

```text
不要把所有历史都塞进 prompt
  -> 只保留少量、稳定、长期有效的记忆
  -> 作为常驻 system prompt 的一部分
  -> 让模型自己决定要不要写入、替换、删除
  -> 用硬上限防止膨胀
```

这是一个偏工程化的折中方案，不是大型长期知识库方案。

## 适合保存什么

- 用户偏好
- 长期稳定的行为要求
- 项目约定
- 环境事实
- 值得跨会话延续的少量经验

## 不适合保存什么

- 大量项目知识
- 长聊天记录
- 原始大段数据
- 临时任务过程
- 容易重新发现的信息

## 简短对比

### Hermes built-in memory

- 小型常驻记忆
- 会话启动时注入
- 当前会话内固定
- 模型自己维护
- 成本稳定但容量小

### 外部 memory provider

- 大容量外部记忆
- 每回合 recall 相关片段
- 只注入命中的部分
- 更省 token
- 更适合知识库和长期沉淀

## 参考源码与文档

- Hermes memory 文档  
  https://hermes-agent.nousresearch.com/docs/user-guide/features/memory/
- Hermes memory providers 文档  
  https://hermes-agent.nousresearch.com/docs/user-guide/features/memory-providers
- `run_agent.py`  
  https://raw.githubusercontent.com/NousResearch/hermes-agent/main/run_agent.py
- `tools/memory_tool.py`  
  https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/memory_tool.py
- `agent/builtin_memory_provider.py`  
  https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/builtin_memory_provider.py
- `agent/memory_manager.py`  
  https://raw.githubusercontent.com/NousResearch/hermes-agent/main/agent/memory_manager.py
