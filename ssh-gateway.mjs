// SSH front door for the Codex desktop app's "SSH connection" mode.
// The app runs four fixed shell scripts; this server never runs a shell. It
// matches each exec request against recorded templates (gateway-templates.json),
// answers probe/version/boot itself, and for `proxy` speaks the WebSocket
// upgrade and bridges to this user's own harness (`codex app-server` on
// loopback). On the way it injects environment/add and pins every thread/turn
// to the user's routed environment, so tools execute on router-managed machines.
// Admin keys may also run `env-mcp` to drive the router's MCP tools over SSH.
// Usage: node ssh-gateway.mjs <gateway.json>
import { spawn, execFile } from 'node:child_process';
import { connect as tcpConnect } from 'node:net';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import ssh2 from 'ssh2';
import WebSocket, { WebSocketServer } from 'ws';
import { startRouter, localMachine } from './env-router.mjs';
import { microvmMachine } from './microvm-machine.mjs';
import { microvmPool } from './machine-pool.mjs';
import { startControlPlane } from './control-plane.mjs';
import { serveMcp } from './env-mcp.mjs';

const configPath = resolve(process.argv[2]);
const config = JSON.parse(readFileSync(configPath, 'utf8'));
const fromConfig = p => resolve(dirname(configPath), p);
const templates = new Map(Object.entries(JSON.parse(readFileSync(fromConfig(config.templates), 'utf8')).templates).map(([kind, hash]) => [hash, kind]));
const users = Object.entries(config.users).map(([name, u], index) => ({ name, index, ...u, keys: u.publicKeys.map(k => ssh2.utils.parseKey(k)) }));
const auditFile = fromConfig(config.auditLog);
mkdirSync(dirname(auditFile), { recursive: true });
// Shapes only (method, id, error code): protocol payloads can carry credentials.
const audit = entry => appendFileSync(auditFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');

const routerConfig = config.router ?? { machines: {}, workspaces: {}, environments: {} };
const machines = Object.fromEntries(Object.entries(routerConfig.machines).map(([name, m]) => {
  if (m.kind === 'local') return [name, localMachine(fromConfig(m.root))];
  if (m.kind === 'microvm') return [name, microvmMachine({ ...m, region: config.region })];
  throw Error(`Unsupported machine kind ${m.kind}`);
}));
const resolvePaths = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.path && !v.path.startsWith('/') ? { ...v, path: fromConfig(v.path) } : v]));
// Workspace snapshots move through S3 via presigned URLs, so sandboxes never hold AWS credentials.
const presignRun = promisify(execFile);
const snapshots = config.snapshots && { presign: async (key, method) => (await presignRun('python3', [fromConfig(config.snapshots.presignScript), config.snapshots.bucket, key, method])).stdout.trim() };
const router = await startRouter({ machines, workspaces: resolvePaths(routerConfig.workspaces), environments: routerConfig.environments, snapshots });
// Pool mode: one MicroVM per project, provisioned on demand (see control-plane.mjs).
const control = config.pool && startControlPlane({ router, region: config.region, statePath: fromConfig(config.pool.statePath ?? 'control-state.json'),
  defaults: config.pool.defaults, pool: microvmPool({ region: config.region, sizes: config.pool.sizes }) });
const harnessHome = user => join(fromConfig(config.harness.root), user.name);
// A thread's project is the folder under <harness home>/projects/ it was opened in.
function projectFromCwd(user, cwd) {
  const prefix = join(harnessHome(user), 'projects') + '/';
  return typeof cwd === 'string' && cwd.startsWith(prefix) ? cwd.slice(prefix.length).split('/')[0] : 'default';
}
const gatewayTools = control ? {
  ...control.tools,
  create_project: { description: 'Create a project folder that appears in the Codex app\'s folder picker on this host (under projects/). Threads opened there get their own MicroVM.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, user: { type: 'string' } }, required: ['name'], additionalProperties: false },
    run: ({ name, user: who }) => {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw Error('Project names: letters, digits, . _ -');
      const u = users.find(x => x.name === (who ?? users[0].name)); if (!u) throw Error(`Unknown user ${who}`);
      const dir = join(harnessHome(u), 'projects', name); mkdirSync(dir, { recursive: true });
      return { project: name, folder: dir, note: 'In the Codex app, create a project on this host and choose this folder.' };
    } },
} : {};

const normalize = command => command.replace(/(?:\\[0-7]{3}){8}/, '<MARKER>');
const classify = command => templates.get(createHash('sha256').update(normalize(command)).digest('hex'));
const marker = command => Buffer.from(/(?:\\[0-7]{3}){8}/.exec(command)[0].slice(1).split('\\').map(o => parseInt(o, 8)));

// One harness per user: a real app-server on loopback with its own CODEX_HOME.
const harnesses = new Map();
function ensureHarness(user) {
  const existing = harnesses.get(user.name);
  if (existing && existing.proc.exitCode === null) return existing.ready;
  const home = join(fromConfig(config.harness.root), user.name), port = config.harness.portBase + user.index;
  mkdirSync(join(home, 'codex-home'), { recursive: true });
  const proc = spawn(config.harness.codex ?? 'codex', ['app-server', '--listen', `ws://127.0.0.1:${port}`], {
    cwd: home, stdio: ['ignore', 'ignore', 'pipe'],
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, 'codex-home'), LANG: 'en_US.UTF-8' },
  });
  proc.stderr.resume();
  audit({ user: user.name, event: 'harness-start', port });
  const ready = (async () => {
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/readyz`)).ok) return port; } catch {}
      await new Promise(r => setTimeout(r, 200));
    }
    throw Error('Harness did not become ready');
  })();
  harnesses.set(user.name, { proc, ready, added: new Set() });
  return ready;
}

function environmentsFor(user) {
  const known = Object.fromEntries(router.describe().environments.map(e => [e.environment, e]));
  const spaces = Object.fromEntries(router.describe().workspaces.map(w => [w.workspace, w]));
  return user.environments.map(id => ({ environmentId: id, url: known[id].url, cwd: spaces[known[id].workspace].path }));
}

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
function readUpgrade(channel) {
  return new Promise((resolveUpgrade, rejectUpgrade) => {
    let buf = Buffer.alloc(0);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) { if (buf.length > 16384) rejectUpgrade(Error('Upgrade request too large')); return; }
      channel.off('data', onData); channel.pause();
      const [requestLine, ...lines] = buf.subarray(0, end).toString('latin1').split('\r\n');
      const [method, url] = requestLine.split(' ');
      const headers = Object.fromEntries(lines.map(l => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      resolveUpgrade({ req: { method, url, headers, httpVersion: '1.1' }, head: buf.subarray(end + 4) });
    };
    channel.on('data', onData);
  });
}

async function bridge(channel, user) {
  const port = await ensureHarness(user);
  const { req, head } = await readUpgrade(channel);
  // ws expects a net.Socket; an SSH channel is a duplex stream without these.
  channel.setTimeout ??= () => channel; channel.setNoDelay ??= () => channel; channel.setKeepAlive ??= () => channel;
  wss.handleUpgrade(req, channel, head, client => {
    channel.resume();
    const up = new WebSocket(`ws://127.0.0.1:${port}`);
    const queue = [], swallow = new Map(), initIds = new Set();
    let seq = 0;
    const sendUp = m => up.readyState === 1 ? up.send(JSON.stringify(m)) : queue.push(m);
    const request = (method, params) => new Promise(r => { const id = `gw-${++seq}`; swallow.set(id, r); sendUp({ id, method, params }); });
    up.on('open', () => { for (const m of queue.splice(0)) up.send(JSON.stringify(m)); });
    const pendingThreads = new Map(); // request id -> environment, to learn thread ids
    // Pool mode: the project's MicroVM must exist and be registered with this harness.
    async function routeProject(project) {
      const env = await control.ensureProject(user.name, project);
      const h = harnesses.get(user.name);
      if (!h.added.has(env.environmentId)) {
        const r = await request('environment/add', { environmentId: env.environmentId, execServerUrl: env.url });
        audit({ user: user.name, event: 'environment-add', environment: env.environmentId, error: r.error?.code });
        h.added.add(env.environmentId);
      }
      return env;
    }
    async function handle(m) {
      if (m.method === 'initialize') {
        m.params = { ...m.params, capabilities: { ...m.params?.capabilities, experimentalApi: true } };
        initIds.add(m.id);
      }
      // Policy: tools always run on the routed executor, never on the harness host.
      if (control && ['thread/start', 'thread/resume', 'turn/start'].includes(m.method)) {
        const known = m.params?.threadId && control.threadEnvironment(m.params.threadId);
        const project = known ? control.state.projects[known]?.project : projectFromCwd(user, m.params?.cwd);
        const env = await routeProject(project ?? 'default');
        audit({ user: user.name, event: 'routed', method: m.method, environment: env.environmentId });
        if (m.method !== 'thread/resume') m.params = { ...m.params, environments: [{ environmentId: env.environmentId, cwd: env.cwd }] };
        if (m.method !== 'turn/start') pendingThreads.set(m.id, env.environmentId);
      } else if (m.method === 'thread/start' || m.method === 'turn/start') {
        const pinned = environmentsFor(user).map(({ environmentId, cwd }) => ({ environmentId, cwd }));
        if (m.params?.environments && JSON.stringify(m.params.environments) !== JSON.stringify(pinned)) audit({ user: user.name, event: 'environments-overridden', method: m.method });
        m.params = { ...m.params, environments: pinned };
      }
      audit({ user: user.name, dir: 'in', method: m.method, id: m.id });
      sendUp(m);
    }
    let chain = Promise.resolve();
    client.on('message', data => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return client.close(1003, 'JSON required'); }
      // Ordered, but routing may need to provision a machine first.
      chain = chain.then(() => handle(m)).catch(error => {
        audit({ user: user.name, event: 'route-error', method: m.method, message: error.message.slice(0, 300) });
        if (m.id != null && client.readyState === 1) client.send(JSON.stringify({ id: m.id, error: { code: -32000, message: `gateway: ${error.message}` } }));
      });
    });
    up.on('message', async data => {
      const v = JSON.parse(data.toString());
      if (swallow.has(v.id)) { swallow.get(v.id)(v); swallow.delete(v.id); return; }
      audit({ user: user.name, dir: 'out', method: v.method, id: v.id, error: v.error?.code });
      if (pendingThreads.has(v.id)) {
        const env = pendingThreads.get(v.id); pendingThreads.delete(v.id);
        if (v.result?.thread?.id) control.rememberThread(v.result.thread.id, env);
      }
      // Durability: snapshot the project after every completed turn.
      if (control && v.method === 'turn/completed') {
        const env = control.threadEnvironment(v.params?.threadId ?? v.params?.turn?.threadId);
        if (env) control.checkpoint(env).then(key => audit({ user: user.name, event: 'checkpoint', environment: env, ok: !!key }),
          e => audit({ user: user.name, event: 'checkpoint-error', environment: env, message: e.message.slice(0, 200) }));
      }
      if (initIds.has(v.id) && !v.error && !control) {
        initIds.delete(v.id);
        // Register environments before the client can start a thread.
        for (const env of environmentsFor(user)) {
          const r = await request('environment/add', { environmentId: env.environmentId, execServerUrl: env.url });
          audit({ user: user.name, event: 'environment-add', environment: env.environmentId, error: r.error?.code });
        }
      }
      if (client.readyState === 1) client.send(data.toString());
    });
    const closeBoth = () => { client.terminate(); up.terminate(); };
    client.on('close', closeBoth); up.on('close', closeBoth);
    client.on('error', () => {}); up.on('error', () => {});
  });
}

new ssh2.Server({ hostKeys: [readFileSync(fromConfig(config.hostKey))] }, conn => {
  let user = null;
  conn.on('error', () => {});
  conn.on('authentication', ctx => {
    if (ctx.method !== 'publickey') return ctx.reject(['publickey']);
    const match = users.find(u => u.keys.some(k => ctx.key.algo === k.type && ctx.key.data.equals(k.getPublicSSH())));
    if (!match) return ctx.reject(['publickey']);
    if (!ctx.signature) return ctx.accept(); // key probe; the signed attempt follows
    const key = match.keys.find(k => ctx.key.data.equals(k.getPublicSSH()));
    if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) !== true) return ctx.reject(['publickey']);
    user = match; audit({ user: user.name, event: 'login' }); ctx.accept();
  });
  conn.on('request', (accept, reject) => reject?.()); // no tcpip-forward
  // The only forward allowed: the app's ChatGPT sign-in callback (localhost:1455)
  // to this user's harness login server. Everything else is refused.
  conn.on('tcpip', (accept, reject, info) => {
    const allowed = user && ['127.0.0.1', 'localhost'].includes(info.destIP) && info.destPort === 1455;
    audit({ user: user?.name, event: 'forward', destPort: info.destPort, allowed });
    if (!allowed) return reject();
    const socket = tcpConnect(1455, '127.0.0.1');
    socket.once('connect', () => { const channel = accept(); channel.pipe(socket).pipe(channel); channel.on('error', () => socket.destroy()); });
    socket.once('error', () => reject());
  });
  conn.on('ready', () => conn.on('session', acceptSession => {
    const session = acceptSession();
    for (const event of ['pty', 'shell', 'subsystem', 'x11', 'auth-agent', 'window-change', 'signal']) session.on(event, (accept, reject) => reject?.());
    session.on('env', (accept, reject, info) => info.key === 'LANG' ? accept?.() : reject?.());
    session.on('exec', async (acceptExec, rejectExec, info) => {
      if (info.command === 'env-mcp' && user.admin) {
        audit({ user: user.name, event: 'mcp-session' });
        const channel = acceptExec();
        const session = serveMcp(router, channel, channel, gatewayTools);
        // Close once the client has finished sending and every reply has been written.
        channel.on('end', async () => { await new Promise(r => setTimeout(r, 100)); await session.drained(); channel.exit(0); channel.end(); });
        return;
      }
      // Admin/test only: a raw exec-protocol session on a routed environment,
      // newline-delimited JSON over the channel (used by the stress test).
      const direct = /^env-connect ([A-Za-z0-9_-]{1,100})$/.exec(info.command);
      if (direct && user.admin) {
        audit({ user: user.name, event: 'env-connect', environment: direct[1] });
        const channel = acceptExec();
        const ws = new WebSocket(`${router.base}/env/${direct[1]}`);
        const pending = [];
        ws.on('open', () => { for (const l of pending.splice(0)) ws.send(l); });
        ws.on('message', d => channel.write(d.toString() + '\n'));
        ws.on('close', () => { channel.exit(0); channel.end(); });
        ws.on('error', () => {});
        let buf = '';
        channel.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); ws.readyState === 1 ? ws.send(l) : pending.push(l); } });
        channel.on('close', () => ws.terminate());
        return;
      }
      const kind = classify(info.command);
      audit({ user: user.name, event: 'exec', kind: kind ?? 'rejected', sha256: createHash('sha256').update(normalize(info.command)).digest('hex') });
      if (!kind) return rejectExec();
      const channel = acceptExec();
      channel.write(marker(info.command));
      try {
        if (kind === 'probe') { channel.exit(0); return channel.end(); }
        if (kind === 'version') { channel.write(`codex-cli ${config.codexVersion}\n`); channel.exit(0); return channel.end(); }
        if (kind === 'boot') { await ensureHarness(user); channel.exit(0); return channel.end(); }
        if (kind === 'proxy') return await bridge(channel, user);
      } catch (error) {
        audit({ user: user.name, event: 'exec-error', kind, message: error.message });
        channel.stderr.write(`gateway: ${error.message}\n`); channel.exit(1); channel.end();
      }
    });
  }));
}).listen(config.port, config.host ?? '127.0.0.1', function () {
  console.log(`gateway listening on ${config.host ?? '127.0.0.1'}:${this.address().port}`);
});
