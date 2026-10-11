# Codex executor interception lab

A working experiment with a [deployed AWS durable-state layer](aws/README.md), separating the Codex app-server from its executor and placing an adapter at that boundary. Tested with Codex CLI 0.147.0, Node 26.3.1, macOS 26.5.1.

```text
separate real Codex app-server
  → environment/add (execServerUrl)
  → local WebSocket adapter
  → real OpenSSH client, pinned host key, dedicated test key
  → local SSH server
  → real codex exec-server --listen stdio://
```

The adapter can answer selected calls itself. The test intercepts `fs/readFile` for `file:///virtual/boundary-marker.txt` and returns virtual content. Other requests pass through SSH to the real executor. No primary app installation, SSH configuration, account credentials, or global Codex configuration is changed.

## Run

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
```

Requires `codex`, `node`, `/usr/bin/ssh`, and `/usr/bin/ssh-keygen`. The test creates loopback-only listeners on random ports, an isolated Codex home, temporary SSH keys, and an empty workspace under ignored `.lab/run-*`. It closes its listeners and stops owned server/transport processes on completion. `results.json` records method names and outcomes, never key contents. The `.lab` directory contains only generated experiment state and can be removed after tests finish.

This is a trusted local lab, **not a security sandbox**. Local clients that reach the WebSocket port can request execution with this user's permissions. SSH host-key checking and public-key authentication are enabled. The default `npm test` suite uses no external host or paid API. The separate model and AWS tests use authenticated external services.

## What passed

- A real app-server registers the adapter as an environment, negotiates exec-server initialization, and retrieves the correct executor working directory and shell through SSH.
- A protocol test client reads a virtual file supplied by the adapter, with no corresponding host file.
- The same client reads a real file through the executor.
- A real shell command writes a file and emits separately verified stdout and stderr; completion is observed.
- An active process is interrupted, reports a nonzero exit, and closes.
- Unsupported operations return explicit protocol errors.
- A fresh SSH connection and fresh executor read the file created by the earlier connection.
- All tracked server/transport child processes stop after the test.

**Evidence boundary:** only initialization and environment information are driven by the real app-server. File/process/interception/cancellation tests use a direct exec-protocol client. The original boundary suite does not cover a model turn. The separate `model-probe.mjs` now verifies a real Codex model turn and shell side effect through this SSH path; see `model-results.json`. Desktop UI, celld, approval UI, and in-flight model recovery remain untested. Reconnect proves completed host filesystem persistence, not durable harness recovery. A separate executor is launched per connection in this proof, so it does not demonstrate zero processes per agent.

## Protocol details observed in this build

App-server and exec-server expose different RPC shapes. Do not forward one blindly into the other.

| Operation | Observed exec-server request |
|---|---|
| Initialize | `initialize` with `clientName`, `resumeSessionId`, then `initialized` |
| Environment | `environment/info` |
| Read | `fs/readFile`, `{path: "file:///..."}`; result has `dataBase64` |
| Start | `process/start`, `{processId, argv, cwd: "file:///...", env, tty: false}` |
| Output | `process/output` notification with `processId`, `seq`, `stream`, base64 `chunk` |
| Completion | `process/exited`, then `process/closed` |
| Interrupt | `process/signal`, `{processId, signal: "interrupt"}` |

The app-server's `environment/add` accepts `{environmentId, execServerUrl}`. Its `environment/info` accepts `{environmentId}`. Its standalone `command/exec` and `process/spawn` operate on the app-server host; they are not proof of remote environment execution.

## Why this helps the original idea

Recovered chats: “Claude Celld SSH Setup” and “Research Claude SSH Agent Adapter” (October 5). They describe a durable harness owning agent state while execution environments are attached resources. The prior Claude prototype lives at `/Users/andrew.sulistio/Documents/Codex/2026-10-05/research-whether-claude-desktop-s-ssh`; its report demonstrates helper-to-celld fixed replies, but leaves Desktop UI acceptance unverified.

This experiment proves that the installed Codex build has a usable executor interception boundary. A real harness turn has now passed through the environment, including process execution. Selected reads expose durable local storage, and a separate recovery test reconstructs a fresh harness from an AWS checkpoint. Routing execution to leased cloud runtimes remains future work. Keep the distinction between replacing the executor and replacing the agent harness: the adapter changes the execution boundary.

References: [official app-server documentation](https://learn.chatgpt.com/docs/app-server), [official self-hosted executor architecture](https://developers.openai.com/api/docs/guides/agents-api/environments/self-hosted). Exact experimental RPC fields above were checked against generated bindings and live responses from the installed executable; they may change between versions.

## Durable identity and fast activation

`durable-store.mjs` adds a SQLite-backed deterministic state machine. Agent identities, operation IDs, accepted work, results, and ordered events survive worker exit. `durable-worker.mjs` is disposable: it opens the store, does one activation, and exits. Gateway startup replays accepted operations; file reads at `file:///durable/<agent-id>/history.txt` expose persisted events through the interception boundary.

`npm run test:durable` tests full worker exit, SIGKILL after acceptance/before commit/after commit, conflicting IDs, eight concurrent duplicate submissions, 100 stored identities, and full gateway restarts. See `durability-results.json` and `durable-bridge-results.json` for measured timing and scope. The latest run measured about 50 ms median for an entire fresh Node process, transaction and exit; 0.18 ms median for a small transaction in a running host. These are this Mac's local measurements, not cloud/model/VM startup promises.

Only deterministic local event mutations are replay-safe here. Database updates and results commit atomically. This is not recovery of a running model stream or an arbitrary shell/API side effect. Those require checkpoints, operation-specific idempotency and reconciliation; a killed process is not a saved continuation. SQLite is local durable storage, not replicated cloud storage or a backup. The durable state machine is deterministic; separate real Codex harness tests are documented in `aws/README.md`.

## Hosted on AWS (experimental)

[`aws-agents/`](aws-agents/README.md) runs this design for the real Codex desktop app: a static SSH host whose gateway emulates the app's four recorded commands (`ssh-gateway.mjs`), a harness per user, and a router (`env-router.mjs`, `control-plane.mjs`, `machine-pool.mjs`) that gives each project its own Lambda MicroVM running `codex exec-server`, with S3 snapshots and MCP tools for size, TTL, pause, info and moves. `test-move.mjs` moves a live thread between executors; `stress.mjs` load- and churn-tests the path through the front door.
