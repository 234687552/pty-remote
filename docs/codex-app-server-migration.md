# Codex App Server Migration

## Goal

Replace the current Codex `PTY + TUI + JSONL watcher` integration with an `app-server`-first runtime.

Target behavior:

- `codex app-server` is the single source of truth for Codex conversations.
- The primary conversation UI uses app-server thread/turn/item events, not PTY screen scraping.
- Codex terminal is no longer always-on.
- A Codex PTY is started only when the terminal pane is visible.
- The PTY is a remote TUI client attached to the same app-server thread:
  - `codex --remote <local-app-server-ws> resume <threadId> --no-alt-screen`
- When the terminal pane is hidden, the PTY is closed.
- The PTY never owns the session. The app-server `threadId` is the only Codex session identifier.

## Why Change

The current Codex runtime is tightly coupled to:

- interactive shell startup
- PTY lifecycle
- TUI prompt detection
- `~/.codex/history.jsonl`
- `~/.codex/sessions/**/*.jsonl`
- terminal frame side-channel parsing for approval/interruption

That coupling existed in the removed legacy Codex runtime files:

- `packages/cli/src/providers/codex-pty.ts`
- `packages/cli/src/providers/codex-manager.ts`
- `packages/cli/src/providers/codex-history.ts`
- `packages/cli/src/providers/codex-resume-session.ts`

The migration removes file and screen heuristics from the main path and makes PTY optional.

## Non-Goals For The First Slice

The first implementation slice does not try to complete every final-state behavior.

Explicit non-goals for slice 1:

- full app-server approval request UI
- structured attachment delivery with `UserInput[]` images/mentions
- replacing the terminal pane UX
- complete parity for every Codex item type in chat rendering
- removing the legacy PTY runtime immediately

Slice 1 is successful if:

- Codex history/session listing is app-server backed
- Codex message dispatch is app-server backed
- Codex runtime state is app-server backed
- Codex interruptions use app-server
- Codex terminal PTY can still be attached separately later without changing the app-server thread identity

## Target Architecture

### Runtime Ownership

`cli`

- owns one long-lived local Codex app-server process
- owns one long-lived websocket client connection to that app-server
- owns zero or one short-lived Codex remote-TUI PTY per active terminal view

`relay`

- remains the browser/websocket multiplexer
- remains unaware of the internal Codex app-server wire protocol
- continues to expose the existing `runtime-meta`, `messages-upsert`, and `terminal-frame-patch` channels

`web`

- keeps using the current relay protocol
- gradually stops inferring Codex state from terminal frames

### Identity Model

For Codex app-server:

- `threadId` is the canonical session ID
- `conversationKey` must equal `threadId`
- `sessionId` in the shared runtime protocol must also equal `threadId`

This keeps current workspace storage compatible with minimal frontend churn.

## Phase Plan

### Phase 1

App-server becomes the source of truth for Codex history, conversation state, and message dispatch.

Changes:

- add a local Codex app-server process manager
- add a websocket protocol client for app-server
- add a new `CodexAppServerManager`
- add a new `CodexAppServerProviderRuntime`
- switch Codex provider selection to choose `app-server` backend via config
- map app-server thread history to the existing `ChatMessage[]` model
- remove `codex-history.ts`, `codex-resume-session.ts`, and JSONL refresh from the active Codex runtime path

Temporary constraints:

- use `approvalPolicy: "never"` for the app-server path
- keep attachments as prompt text only in slice 1
- terminal PTY remains optional and can be disabled while the app-server path is stabilized

### Phase 2

Add on-demand remote TUI PTY attached to the same app-server thread.

Changes:

- add terminal visibility signalling from web to cli
- spawn remote TUI PTY only while terminal is visible
- close PTY when terminal is hidden or conversation changes
- continue using existing terminal-frame sync and rendering

PTY launch shape:

```bash
codex --remote ws://127.0.0.1:<port> resume <threadId> --no-alt-screen
```

### Phase 3

Replace terminal side-channel approval parsing with explicit app-server server-request handling.

Changes:

- forward app-server approval requests through relay
- render approval UI from explicit events
- remove Codex-only terminal inference logic from chat pane

### Phase 4

Upgrade attachments from path injection to structured app-server `UserInput[]`.

## First Slice Implementation Details

### Backend Selection

Codex now runs in app-server mode only.

The old Codex `PTY + JSONL` main runtime has been removed from the active code path.

### New Modules

Add:

- `packages/cli/src/providers/codex-app-server-protocol.ts`
- `packages/cli/src/providers/codex-app-server-process.ts`
- `packages/cli/src/providers/codex-app-server-client.ts`
- `packages/cli/src/providers/codex-app-server-runtime.ts`

Responsibilities:

- `protocol`: local TS types and narrow wire helpers used by the app
- `process`: spawn/stop app-server and expose its websocket endpoint
- `client`: websocket request/response multiplexer plus notification dispatch
- `runtime`: implement the existing `ProviderRuntime` contract using app-server

### Message Mapping

The shared runtime model is narrower than app-server `ThreadItem`.

Slice 1 mapping:

- `userMessage` -> user text message
- `agentMessage` -> assistant text message
- `reasoning` -> assistant text message with `meta.phase = "reasoning"`
- `plan` -> assistant text message with `meta.phase = "plan"`
- `commandExecution` -> assistant tool-use + tool-result pair
- `mcpToolCall` -> assistant tool-use + tool-result pair
- `dynamicToolCall` -> assistant tool-use + tool-result pair
- `webSearch` -> assistant tool-use message
- `fileChange` -> assistant tool-result message

Items not represented cleanly can be summarized into text blocks rather than dropped.

### Refresh Strategy

To keep slice 1 manageable:

- do not reconstruct streaming messages from raw deltas
- instead debounce `thread/read(includeTurns=true)` after relevant notifications

Refresh triggers:

- `thread/started`
- `turn/started`
- `turn/completed`
- `item/started`
- `item/completed`
- `item/agentMessage/delta`
- `item/plan/delta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`
- `thread/status/changed`

This is less efficient than a full delta reducer, but it is stable and simple.

### Draft Conversation Model

Current draft behavior is PTY/JSONL based.

Slice 1 draft behavior:

- a draft conversation starts with a local temporary `conversationKey`
- the first `dispatchMessage` calls `thread/start`
- once `threadId` is returned, the runtime promotes:
  - `conversationKey = threadId`
  - `sessionId = threadId`
- frontend receives the promoted identity through normal runtime metadata and select result

### Interrupt Model

Track the most recent active `turnId` per thread.

- `dispatchMessage`
  - `thread/start` for draft
  - `turn/start` for existing thread
- `stopActiveRun`
  - `turn/interrupt(threadId, turnId)`

### Terminal Compatibility

Slice 1 keeps the current terminal protocol untouched.

That means:

- `terminal-frame-patch` still comes from PTY only
- app-server itself does not emit terminal frames
- Codex terminal PTY can be added later without changing the main runtime identity

## Concrete Step Order

1. Add backend selection and app-server manager modules.
2. Implement app-server request/notification plumbing.
3. Implement app-server-backed history listing.
4. Implement app-server-backed conversation activation and message dispatch.
5. Implement app-server-backed interrupt and runtime refresh.
6. Wire Codex provider selection to the new backend.
7. Verify `list history -> select conversation -> send message -> stop message`.
8. Add on-demand PTY attach in a follow-up slice.

## Acceptance Criteria For This Repo Round

This migration round is complete when:

- Codex runs in app-server mode by default
- history list no longer depends on `~/.codex/history.jsonl` in that mode
- Codex messages no longer depend on JSONL parsing in that mode
- `select conversation`, `send message`, and `stop message` work in that mode
- existing relay/web protocol remains backward compatible

## Known Tradeoffs

- Slice 1 chooses correctness and integration speed over perfect streaming fidelity.
- Approval UI is intentionally deferred instead of re-creating another implicit side-channel.
- Terminal behavior remains transitional until phase 2 lands.
