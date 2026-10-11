// Replays the Codex app's four recorded SSH commands against the gateway with a
// real SSH client, then speaks app-server JSON-RPC through the proxy and drives
// the router over `env-mcp`. Usage: node test-gateway.mjs <host> <port> <user> <identity>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Duplex } from 'node:stream';
import ssh2 from 'ssh2';
import WebSocket from 'ws';
import { Rpc } from './rpc.mjs';

const [host, port, username, identity] = process.argv.slice(2);
const { commands } = JSON.parse(readFileSync('fixtures/codex-app-ssh-commands.json', 'utf8'));
const marker = c => Buffer.from(/(?:\\[0-7]{3}){8}/.exec(c)[0].slice(1).split('\\').map(o => parseInt(o, 8)));

const conn = new ssh2.Client();
await new Promise((res, rej) => conn.on('ready', res).on('error', rej).connect({ host, port: +port, username, privateKey: readFileSync(identity) }));
const exec = command => new Promise((res, rej) => conn.exec(command, (err, stream) => err ? rej(err) : res(stream)));
async function run(command) {
  const s = await exec(command); let out = Buffer.alloc(0), code;
  s.on('data', d => { out = Buffer.concat([out, d]); }); s.stderr.resume();
  await new Promise(r => s.on('exit', c => { code = c; }).on('close', r));
  return { code, out };
}
const results = {};
for (const kind of ['probe', 'version', 'boot']) {
  const r = await run(commands[kind]);
  assert.ok(r.out.subarray(0, 8).equals(marker(commands[kind])), `${kind}: marker mismatch`);
  results[kind] = { exit: r.code, output: r.out.subarray(8).toString().trim() };
}
assert.equal(results.probe.exit, 0); assert.match(results.version.output, /^codex-cli /); assert.equal(results.boot.exit, 0);
results.rejected = await exec('echo pwned').then(() => 'accepted', () => 'rejected');
assert.equal(results.rejected, 'rejected');

// Proxy: strip the 8-byte marker, then let ws speak HTTP upgrade over the channel.
const stream = await exec(commands.proxy);
let skip = 8;
const socket = new Duplex({
  read() {}, write(chunk, enc, cb) { stream.write(chunk, cb); }, final(cb) { stream.end(); cb(); },
});
stream.on('data', d => { if (skip) { const n = Math.min(skip, d.length); skip -= n; d = d.subarray(n); } if (d.length) socket.push(d); });
stream.on('close', () => socket.push(null));
Object.assign(socket, { setNoDelay() {}, setTimeout() {}, setKeepAlive() {} });
const ws = new WebSocket('ws://codex-app-server/rpc', { createConnection: () => socket });
await new Promise((res, rej) => ws.once('open', res).once('error', rej));
const rpc = new Rpc(s => ws.send(s)); ws.on('message', b => rpc.receive(b.toString()));
const init = await rpc.call('initialize', { clientInfo: { name: 'gateway-test', version: '0.1' }, capabilities: {} });
rpc.notify('initialized');
const threads = await rpc.call('thread/list', {});
results.proxy = { initializeKeys: Object.keys(init), threadListKeys: Object.keys(threads) };
ws.close();

// Admin MCP over SSH.
const mcpStream = await exec('env-mcp');
const mcp = new Rpc(s => mcpStream.write(s + '\n'));
let buf = '';
mcpStream.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { mcp.receive(buf.slice(0, i)); buf = buf.slice(i + 1); } });
await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gateway-test', version: '0.1' } });
const tools = (await mcp.call('tools/list', {})).tools.map(t => t.name).sort();
const envs = JSON.parse((await mcp.call('tools/call', { name: 'list_environments', arguments: {} })).content[0].text);
results.mcp = { tools, environments: envs.environments.map(e => `${e.environment}@${e.machine}`) };
mcpStream.end(); conn.end();
console.log(JSON.stringify(results, null, 2));
