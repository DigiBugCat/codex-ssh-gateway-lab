// Opt-in live test: one Codex thread whose executor moves from machine A to B
// between turns, driven through the env-router MCP server.
//   transparent: same environment ID, router rebinds it to B (move_environment)
//   native:      thread switches environment IDs via turn/start environments
// Both keep one thread and one workspace path; turn 2 must run on B and see turn 1's file.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, existsSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { Rpc } from './rpc.mjs';

mkdirSync('.lab', { recursive: true });
const root = mkdtempSync(resolve('.lab/move-'));
const machineRoot = name => join(root, 'machines', name);
for (const name of ['A', 'B']) for (const ws of ['proj', 'proj2']) {
  mkdirSync(join(machineRoot(name), ws), { recursive: true });
  writeFileSync(join(machineRoot(name), ws, '.machine'), `machine-${name}\n`);
}
const config = {
  machines: { A: { root: machineRoot('A') }, B: { root: machineRoot('B') } },
  workspaces: { proj: { path: join(root, 'workspace/proj'), machine: 'A' }, proj2: { path: join(root, 'workspace/proj2'), machine: 'A' } },
  environments: { proj: { workspace: 'proj', machine: 'A' }, 'proj2-a': { workspace: 'proj2', machine: 'A' }, 'proj2-b': { workspace: 'proj2', machine: 'B' } },
};
writeFileSync(join(root, 'config.json'), JSON.stringify(config, null, 2));

const children = [];
function start(command, args, env) {
  const p = spawn(command, args, { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'] });
  children.push(p); p.stderr.resume(); return p;
}
const lineRpc = p => { const rpc = new Rpc(s => p.stdin.write(s + '\n')); return rpc; };

const mcpProc = start(process.execPath, [resolve('env-mcp.mjs'), join(root, 'config.json')], { PATH: process.env.PATH, HOME: process.env.HOME });
const mcp = lineRpc(mcpProc);
createInterface({ input: mcpProc.stdout }).on('line', l => mcp.receive(l));
async function tool(name, args = {}) {
  const r = await mcp.call('tools/call', { name, arguments: args });
  const text = r.content[0].text;
  if (r.isError) throw Error(`${name}: ${text}`);
  return JSON.parse(text);
}

const appHome = join(root, 'app-home'); mkdirSync(appHome);
const authLink = join(appHome, 'auth.json');
// Uses the existing login through the normal credential reader; nothing is copied.
symlinkSync(resolve(homedir(), '.codex/auth.json'), authLink);
const results = { checkedAt: new Date().toISOString(), scenarios: {} };
let timer;
try {
  await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-move', version: '0.1' } });
  mcp.notify('notifications/initialized');
  const toolNames = (await mcp.call('tools/list', {})).tools.map(t => t.name);
  assert.deepEqual(toolNames.sort(), ['list_environments', 'move_environment', 'place_workspace', 'routing_trace']);
  const urls = Object.fromEntries((await tool('list_environments')).environments.map(e => [e.environment, e.url]));

  const app = start('codex', ['app-server'], { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: appHome, LANG: 'en_US.UTF-8' });
  const rpc = lineRpc(app);
  const waiters = [];
  const items = [];
  createInterface({ input: app.stdout }).on('line', line => {
    const v = JSON.parse(line); rpc.receive(line);
    if (v.method === 'item/completed' && v.params.item.type === 'agentMessage') items.push(v.params.item.text);
    if (v.method === 'turn/completed') waiters.shift()?.(v.params);
    if (v.method === 'error') console.error('MODEL ERROR', JSON.stringify(v.params));
  });
  await rpc.call('initialize', { clientInfo: { name: 'test-move', version: '0.1' }, capabilities: { experimentalApi: true } });
  rpc.notify('initialized');
  for (const id of ['proj', 'proj2-a', 'proj2-b']) await rpc.call('environment/add', { environmentId: id, execServerUrl: urls[id] });

  async function turn(threadId, text, environments) {
    items.length = 0;
    const done = new Promise((res, rej) => { waiters.push(res); timer = setTimeout(() => rej(Error('Turn timed out')), 240000); });
    await rpc.call('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], ...(environments ? { environments } : {}) });
    const outcome = await done; clearTimeout(timer);
    assert.equal(outcome.turn.status, 'completed', JSON.stringify(outcome));
    return items.join('\n');
  }
  const ask1 = 'Using a tool, create notes.txt in the workspace containing the line "turn one", then run `cat .machine`. Reply with only the machine name it printed.';
  const ask2 = 'Using tools, append the line "turn two" to notes.txt, then run `cat .machine` and `cat notes.txt`. Reply with only the machine name, then the notes on the next lines.';
  const startThread = (env, workspace) => rpc.call('thread/start', {
    ephemeral: true, cwd: root, approvalPolicy: 'never', sandbox: 'workspace-write',
    environments: [{ environmentId: env, cwd: config.workspaces[workspace].path }],
    baseInstructions: 'You are a bounded integration-test agent. Use the provided execution tools only inside the assigned workspace. Do not access unrelated files, credentials or network services. Do not spawn agents.',
  });
  const traceLength = async () => (await tool('routing_trace', { limit: 100000 })).length;
  const execMachines = async (from, to) => [...new Set((await tool('routing_trace', { limit: 100000 })).slice(from, to)
    .filter(e => e.method === 'process/start').map(e => `${e.environment}@${e.machine}`))];

  // Scenario 1: transparent move behind a stable environment ID.
  {
    const thread = await startThread('proj', 'proj');
    const t0 = await traceLength();
    const r1 = await turn(thread.thread.id, ask1);
    const t1 = await traceLength();
    const moved = await tool('move_environment', { environment: 'proj', machine: 'B' });
    const t2 = await traceLength();
    const r2 = await turn(thread.thread.id, ask2);
    const notesB = readFileSync(join(machineRoot('B'), 'proj', 'notes.txt'), 'utf8');
    const turn1Exec = await execMachines(t0, t1), turn2Exec = await execMachines(t2);
    results.scenarios.transparent = { reply1: r1, reply2: r2, turn1Exec, turn2Exec, move: moved, notesOnB: notesB };
    assert.match(r1, /machine-A/); assert.match(r2, /machine-B/);
    assert.match(notesB, /turn one[\s\S]*turn two/);
    assert.deepEqual(turn1Exec, ['proj@A']); assert.deepEqual(turn2Exec, ['proj@B']);
  }

  // Scenario 2: native per-turn switch between two pinned environments.
  {
    const thread = await startThread('proj2-a', 'proj2');
    const r1 = await turn(thread.thread.id, ask1);
    const placed = await tool('place_workspace', { workspace: 'proj2', machine: 'B' });
    const t1 = await traceLength();
    let r2, error;
    try { r2 = await turn(thread.thread.id, ask2, [{ environmentId: 'proj2-b', cwd: config.workspaces.proj2.path }]); }
    catch (e) { error = e.message; }
    const notes = join(machineRoot('B'), 'proj2', 'notes.txt');
    results.scenarios.native = { reply1: r1, reply2: r2 ?? null, error: error ?? null, place: placed,
      turn2Exec: await execMachines(t1), notesOnB: existsSync(notes) ? readFileSync(notes, 'utf8') : null };
    assert.equal(error, undefined); assert.match(r1, /machine-A/); assert.match(r2, /machine-B/);
    assert.match(results.scenarios.native.notesOnB, /turn one[\s\S]*turn two/);
    assert.deepEqual(results.scenarios.native.turn2Exec, ['proj2-b@B']);
  }
  results.result = 'PASS';
} catch (error) {
  results.result = 'FAIL'; results.error = error.message; throw error;
} finally {
  clearTimeout(timer);
  unlinkSync(authLink);
  writeFileSync('move-results.json', JSON.stringify(results, null, 2) + '\n');
  mcpProc.stdin.end();
  for (const p of children) p.kill('SIGKILL');
  console.log(JSON.stringify(results, null, 2));
}
