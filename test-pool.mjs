// Pool-mode test without a model: acts like the Codex app opening threads in two
// projects, then checks each got its own MicroVM, and exercises the machine tools.
// Usage: node test-pool.mjs <host> <port> <user> <identity> <host-pubkey> <harness-home>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Duplex } from 'node:stream';
import ssh2 from 'ssh2';
import WebSocket from 'ws';
import { Rpc } from './rpc.mjs';

const [host, port, username, identity, hostPub, harnessHome] = process.argv.slice(2);
const pinned = ssh2.utils.parseKey(readFileSync(hostPub, 'utf8')).getPublicSSH();
const proxyCommand = JSON.parse(readFileSync('fixtures/codex-app-ssh-commands.json', 'utf8')).commands.proxy;
const conn = new ssh2.Client();
await new Promise((res, rej) => conn.on('ready', res).on('error', rej).connect({ host, port: +port, username, privateKey: readFileSync(identity), hostVerifier: k => Buffer.compare(k, pinned) === 0 }));
const exec = command => new Promise((res, rej) => conn.exec(command, (e, s) => e ? rej(e) : res(s)));

// MCP over SSH (admin).
const mcpStream = await exec('env-mcp');
const mcp = new Rpc(s => mcpStream.write(s + '\n'));
let buf = '';
mcpStream.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { mcp.receive(buf.slice(0, i)); buf = buf.slice(i + 1); } });
await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test-pool', version: '0.1' } });
const tool = async (name, args = {}) => {
  const r = await new Promise((res, rej) => { const t = setTimeout(() => rej(Error(`timeout ${name}`)), 300000); mcp.call('tools/call', { name, arguments: args }).then(v => { clearTimeout(t); res(v); }, rej); });
  if (r.isError) throw Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
for (const name of ['alpha', 'beta']) await tool('create_project', { name });

// App-like client through the proxy: one thread per project.
const stream = await exec(proxyCommand);
let skip = 8;
const socket = new Duplex({ read() {}, write(c, e, cb) { stream.write(c, cb); }, final(cb) { stream.end(); cb(); } });
stream.on('data', d => { if (skip) { const n = Math.min(skip, d.length); skip -= n; d = d.subarray(n); } if (d.length) socket.push(d); });
stream.on('close', () => socket.push(null));
Object.assign(socket, { setNoDelay() {}, setTimeout() {}, setKeepAlive() {} });
const ws = new WebSocket('ws://codex-app-server/rpc', { createConnection: () => socket });
await new Promise((res, rej) => ws.once('open', res).once('error', rej));
const rpc = new Rpc(s => ws.send(s)); ws.on('message', b => rpc.receive(b.toString()));
const slow = (method, params) => new Promise((res, rej) => { const t = setTimeout(() => rej(Error(`timeout ${method}`)), 300000); rpc.call(method, params).then(v => { clearTimeout(t); res(v); }, rej); });
await rpc.call('initialize', { clientInfo: { name: 'test-pool', version: '0.1' }, capabilities: {} });
rpc.notify('initialized');
const results = {};
for (const name of ['alpha', 'beta']) {
  const t0 = performance.now();
  const thread = await slow('thread/start', { cwd: `${harnessHome}/projects/${name}`, ephemeral: false });
  results[name] = { threadId: thread.thread.id, threadStartMs: Math.round(performance.now() - t0) };
}
const projects = await tool('list_projects');
const machines = await tool('list_machines');
const byProject = Object.fromEntries(projects.map(p => [p.project.replace(/^.*?-/, ''), p.machine]));
assert.ok(byProject.alpha && byProject.beta, 'both projects routed');
assert.notEqual(byProject.alpha, byProject.beta, 'projects must not share a machine');
results.projects = projects.map(p => ({ project: p.project, machine: p.machine, path: p.path, threads: p.threads }));
results.machines = machines.map(m => ({ machine: m.machine, size: m.size, state: m.state, minutesLeft: m.minutesLeft, projects: m.projects }));
results.info = await tool('machine_info', { machine: byProject.alpha });
results.pause = await tool('pause_machine', { machine: byProject.beta });
results.afterPause = (await tool('list_machines')).find(m => m.machine === byProject.beta).state;
// A turn/start on the paused project's thread must route by thread and wake it.
// (An empty thread has no rollout to resume; the gateway routes before forwarding.)
results.resumeReply = await slow('thread/resume', { threadId: results.beta.threadId }).then(() => 'ok', e => e.message.slice(0, 80));
results.afterResumeRouting = (await tool('list_machines')).find(m => m.machine === byProject.beta).state;
ws.close(); mcpStream.end(); conn.end();
console.log(JSON.stringify(results, null, 2));
