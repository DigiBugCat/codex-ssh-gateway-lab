// MCP server exposing tools to inspect and move execution environments between
// machines. serveMcp works over any line stream (stdio, an SSH channel).
// CLI usage: node env-mcp.mjs <config.json>
// Config: { machines: {name: {root}}, workspaces: {id: {path, machine}},
//           environments: {id: {workspace, machine}} }
import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startRouter, localMachine } from './env-router.mjs';

export function serveMcp(router, input, output, extraTools = {}) {
  const tools = {
    list_environments: {
      description: 'List machines, workspaces and environments, with each environment\'s stable URL, current machine, open connections and running processes.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      run: () => router.describe(),
    },
    move_environment: {
      description: 'Move an environment to another machine between turns: syncs its workspace, repoints the path and rebinds open harness connections. Refused while processes are running.',
      inputSchema: { type: 'object', properties: { environment: { type: 'string' }, machine: { type: 'string' } }, required: ['environment', 'machine'], additionalProperties: false },
      run: ({ environment, machine }) => router.move(environment, machine),
    },
    place_workspace: {
      description: 'Sync a workspace to another machine and make that copy active, without rebinding environments. Use before pointing a thread at an environment pinned to that machine.',
      inputSchema: { type: 'object', properties: { workspace: { type: 'string' }, machine: { type: 'string' } }, required: ['workspace', 'machine'], additionalProperties: false },
      run: ({ workspace, machine }) => router.place(workspace, machine),
    },
    routing_trace: {
      description: 'Recent routing events: which machine handled each exec request, backend starts, moves.',
      inputSchema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false },
      run: ({ limit = 200 } = {}) => router.trace.slice(-limit),
    },
  };

  Object.assign(tools, extraTools);
  let inflight = 0, drainedWaiters = [];
  const settle = () => { if (inflight === 0) for (const r of drainedWaiters.splice(0)) r(); };
  const send = message => output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  createInterface({ input }).on('line', async line => {
    inflight++;
    try { await handleLine(line); } finally { inflight--; settle(); }
  });
  async function handleLine(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (m.id == null) return; // notifications (e.g. notifications/initialized)
    try {
      if (m.method === 'initialize') {
        send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'env-router', version: '0.1.0' } } });
      } else if (m.method === 'tools/list') {
        send({ id: m.id, result: { tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } });
      } else if (m.method === 'tools/call') {
        const tool = tools[m.params?.name];
        if (!tool) return send({ id: m.id, error: { code: -32602, message: `Unknown tool ${m.params?.name}` } });
        try {
          const result = await tool.run(m.params.arguments ?? {});
          send({ id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
        } catch (error) {
          send({ id: m.id, result: { content: [{ type: 'text', text: error.message }], isError: true } });
        }
      } else if (m.method === 'ping') {
        send({ id: m.id, result: {} });
      } else {
        send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
      }
    } catch (error) {
      send({ id: m.id, error: { code: -32603, message: error.message } });
    }
  }
  // Resolves once no tool call is in flight (callers close the transport then).
  return { drained: () => new Promise(r => { drainedWaiters.push(r); settle(); }) };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  const machines = Object.fromEntries(Object.entries(config.machines).map(([name, m]) => [name, localMachine(m.root)]));
  const router = await startRouter({ machines, workspaces: config.workspaces, environments: config.environments });
  serveMcp(router, process.stdin, process.stdout);
  process.stdin.on('end', async () => { await router.close(); process.exit(0); });
}
