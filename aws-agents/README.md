# Codex over SSH, hosted on AWS (experimental)

The Codex desktop app's "SSH connection" mode, pointed at a static host that is
not a real shell. One address per person; each project gets its own sandbox.

```text
Codex app ──SSH──▶ gateway (EC2)                  ssh-gateway.mjs
                    ├─ 4 recorded commands emulated, nothing else runs
                    ├─ harness per user: codex app-server on loopback
                    └─ router + MCP tools          env-router.mjs, control-plane.mjs
                          └─ one Lambda MicroVM per project: codex exec-server
                                └─ workspace snapshots in S3 (presigned URLs)
```

## How it works

- **Front door.** The app runs four fixed shell scripts over SSH (probe, version,
  boot, `exec codex app-server proxy`). `gateway-templates.json` holds their
  hashes with the per-connection marker normalised out; anything else is
  rejected. `proxy` is answered by bridging the WebSocket upgrade to the user's
  own harness. Port forwarding is refused except `localhost:1455`, the ChatGPT
  sign-in callback. Agent forwarding, PTYs, shells and SFTP are refused.
- **Harness.** A real `codex app-server` per user with its own `CODEX_HOME`, so
  each person signs in from the app ("Sign in to Codex") and nothing is copied.
  The desktop app's code mode also needs `codex-code-mode-host` next to `codex`.
- **Routing.** A thread opened in `<harness home>/projects/<name>` belongs to
  project `<name>`; anything else is `default`. The gateway provisions that
  project's MicroVM on first use, registers it with `environment/add`, and pins
  every `thread/start` / `turn/start` to it. Thread → project routing is
  persisted, so `thread/resume` follows the thread.
- **Durability.** Runtimes are disposable. Workspaces are snapshotted to S3
  after every completed turn and before pause/terminate; a machine that expired
  or died is replaced on next use and restored. Sandboxes never hold AWS
  credentials, only one presigned URL per object.

## MCP tools

Admin keys reach them with `ssh <gateway> env-mcp` (newline-delimited MCP).

| Tool | Does |
|---|---|
| `create_project` | Makes the folder the app's picker should use |
| `list_projects`, `list_machines`, `sizes` | Topology, state, size, minutes left |
| `create_machine` | `size` (`small` 2 GB, `medium` 4 GB), `ttl_minutes` ≤ 480, `idle_suspend_minutes` |
| `pause_machine`, `resume_machine`, `terminate_machine` | Lifecycle; pause/terminate snapshot first |
| `machine_info` | Lifecycle plus OS/CPU/memory/disk from inside the VM |
| `set_project_machine`, `set_project_defaults`, `snapshot_project` | Move or tune a project |
| `list_environments`, `move_environment`, `routing_trace` | Router internals |

## Deploy

```sh
python3 aws/run.py terraform -chdir=aws-agents apply        # needs terraform.tfvars
# build images agents-exec (2048 MiB) and agents-exec-medium (4096 MiB) from aws-agents/microvm
python3 aws/run.py node aws-agents/push-config.mjs --pool   # pool mode config + restart
python3 aws/run.py bash aws-agents/deploy-code.sh           # hot-deploy code changes
```

`terraform.tfvars` needs `account_id`, `allowed_ssh_cidr` and `user_public_keys`.
The app never prompts to trust a host key, so add the `host_public_key` output
to `~/.ssh/known_hosts` before connecting.

## Measured (us-east-2, from a Mac on the US west coast)

| | |
|---|---|
| Commands through SSH → gateway → MicroVM, 30 sessions | 166 ms p50, 206 ms p95, 0 errors |
| Project move via S3 (2 MB + marker, hash checked) | 1.37 s p50, 2.3 s p95 |
| MicroVM launch to RUNNING | ~2.4 s; first command on a new VM ~8 s |
| Suspend / resume | ~0.95 s / ~0.93 s; traffic auto-resumes |

## Limits found

- Concurrent connections per MicroVM: 8 per vCPU, not adjustable (HTTP 429 beyond).
- This account: 8 GB total MicroVM memory (running + suspended), 1 launch/s.
  Terminating VMs still count briefly; launches retry with backoff.
- Size is per image; TTL (≤ 8 h) and idle policy are fixed at launch.
- Launching needs `lambda:PassNetworkConnector` on AWS's managed connectors.
- Codex's own sandbox is unavailable inside the MicroVM, so it asks approval for
  each command; the MicroVM is the isolation boundary.
- The app's folder picker browses the harness host, not the executor.

Not production: one EC2 box hosts every harness, the gateway trusts its config,
and model credentials live on that box.
