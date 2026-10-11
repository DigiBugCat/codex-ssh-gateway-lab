// Stress test through the SSH front door: SSH -> gateway -> router -> executor.
//   load:  C concurrent exec sessions, each running K short commands + reads
//   churn: M moves between machines, verifying a file's hash after every move
// Usage: node stress.mjs --host IP --port 22 --user lab --key PATH --host-key PUBFILE
//          --mode load|churn [--clients 10] [--ops 20] [--moves 10] [--env proj] [--out file]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import ssh2 from 'ssh2';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc, []));
const env = args.env ?? 'proj', clients = +(args.clients ?? 10), ops = +(args.ops ?? 20), moves = +(args.moves ?? 10);
const pinned = ssh2.utils.parseKey(readFileSync(args['host-key'], 'utf8')).getPublicSSH();

function connect() {
  const conn = new ssh2.Client();
  return new Promise((res, rej) => conn.on('ready', () => res(conn)).on('error', rej).connect({
    host: args.host, port: +(args.port ?? 22), username: args.user, privateKey: readFileSync(args.key),
    hostVerifier: key => Buffer.compare(key, pinned) === 0, readyTimeout: 30000,
  }));
}
// Newline-delimited JSON-RPC over one SSH exec channel.
async function session(conn, command) {
  const stream = await new Promise((res, rej) => conn.exec(command, (e, s) => e ? rej(e) : res(s)));
  const waiting = new Map(), listeners = new Set();
  let buf = '', seq = 0;
  stream.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const v = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (v.id != null && waiting.has(v.id)) { const w = waiting.get(v.id); waiting.delete(v.id); clearTimeout(w.timer); v.error ? w.rej(Error(JSON.stringify(v.error))) : w.res(v.result); }
      for (const l of listeners) l(v);
    }
  });
  stream.stderr.resume();
  const call = (method, params, ms = 60000) => new Promise((res, rej) => {
    const id = ++seq; const timer = setTimeout(() => { waiting.delete(id); rej(Error(`timeout ${method}`)); }, ms);
    waiting.set(id, { res, rej, timer }); stream.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const notify = (method, params = {}) => stream.write(JSON.stringify({ method, params }) + '\n');
  const until = (pred, ms = 60000) => new Promise((res, rej) => {
    const timer = setTimeout(() => { listeners.delete(l); rej(Error('event timeout')); }, ms);
    const l = v => { if (pred(v)) { clearTimeout(timer); listeners.delete(l); res(v); } }; listeners.add(l);
  });
  return { call, notify, until, listeners, close: () => stream.end() };
}
async function execSession(conn, cwd) {
  const s = await session(conn, `env-connect ${env}`);
  await s.call('initialize', { clientName: 'stress', resumeSessionId: null }); s.notify('initialized');
  let n = 0;
  s.run = async argv => {
    const processId = `p${++n}-${randomBytes(3).toString('hex')}`, out = [];
    let code, exitedParams = null, sawExited = false, sawClosed = false;
    const done = new Promise((res, rej) => {
      const timer = setTimeout(() => { s.listeners.delete(l); rej(Error('process timeout')); }, 120000);
      const l = v => {
        if (v.params?.processId !== processId) return;
        if (v.method === 'process/output') out.push(Buffer.from(v.params.chunk, 'base64'));
        // exited (process ended) and closed (streams drained) arrive in either order.
        if (v.method === 'process/exited') { code = v.params.exitCode; exitedParams = v.params; sawExited = true; }
        if (v.method === 'process/closed') sawClosed = true;
        if (sawExited && sawClosed) { clearTimeout(timer); s.listeners.delete(l); res(); }
      };
      s.listeners.add(l);
    });
    await s.call('process/start', { processId, argv, cwd: pathToFileURL(cwd).href, env: {}, tty: false });
    await done;
    return { code, out: Buffer.concat(out).toString(), exitedParams };
  };
  s.read = async file => Buffer.from((await s.call('fs/readFile', { path: pathToFileURL(`${cwd}/${file}`).href })).dataBase64, 'base64').toString();
  return s;
}
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return +(s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] ?? NaN).toFixed(1); };
const stats = xs => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: +Math.max(...xs).toFixed(1) });

const admin = await connect();
const mcp = await session(admin, 'env-mcp');
await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stress', version: '0.1' } });
const tool = async (name, a = {}) => { const r = await mcp.call('tools/call', { name, arguments: a }, 600000); if (r.isError) throw Error(r.content[0].text); return JSON.parse(r.content[0].text); };
const layout = await tool('list_environments');
const target = layout.environments.find(e => e.environment === env);
const cwd = layout.workspaces.find(w => w.workspace === target.workspace).path;
const result = { mode: args.mode, startedAt: new Date().toISOString(), host: args.host, environment: env, startMachine: target.machine };

if (args.mode === 'load') {
  const conns = await Promise.all(Array.from({ length: Math.min(clients, 10) }, connect));
  const setup = [], cmd = [], read = [], errors = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: clients }, async (_, i) => {
    let s;
    try {
      const a = performance.now(); s = await execSession(conns[i % conns.length], cwd); setup.push(performance.now() - a);
      for (let k = 0; k < ops; k++) {
        const b = performance.now(); const r = await s.run(['/bin/sh', '-c', 'echo ok']); cmd.push(performance.now() - b);
        if (r.code !== 0 || r.out.trim() !== 'ok') errors.push(`bad exec code=${r.code} out=${JSON.stringify(r.out.slice(0, 40))} exited=${JSON.stringify(r.exitedParams)}`);
        const c = performance.now(); await s.read('.machine'); read.push(performance.now() - c);
      }
    } catch (e) { errors.push(e.message); } finally { s?.close(); }
  }));
  const wall = (performance.now() - t0) / 1000;
  Object.assign(result, { clients, opsPerClient: ops, wallSeconds: +wall.toFixed(2), commandsPerSecond: +(cmd.length / wall).toFixed(1),
    sessionSetupMs: stats(setup), commandMs: stats(cmd), readMs: stats(read), errors: errors.length, errorSamples: [...new Set(errors)].slice(0, 5) });
  for (const c of conns) c.end();
}

if (args.mode === 'churn') {
  const machines = layout.machines.map(m => m.machine);
  const conn = await connect();
  const s = await execSession(conn, cwd);
  const moveMs = [], syncMs = [], verified = [], errors = [];
  let at = target.machine;
  for (let i = 0; i < moves; i++) {
    const content = randomBytes(24).toString('hex');
    try {
      const w = await s.run(['/bin/sh', '-c', `printf %s ${content} > churn.txt && head -c 2000000 /dev/urandom > blob.bin && sha256sum blob.bin | cut -c1-64`]);
      if (w.code !== 0) throw Error(`write failed ${w.code}`);
      const next = machines[(machines.indexOf(at) + 1) % machines.length];
      const a = performance.now(); const m = await tool('move_environment', { environment: env, machine: next }); moveMs.push(performance.now() - a);
      syncMs.push(m.sync.syncMs); at = next;
      // The same session is rebound by the router; verify on the new machine.
      const r = await s.run(['/bin/sh', '-c', 'cat churn.txt; echo; sha256sum blob.bin | cut -c1-64; cat .machine']);
      const [got, hash, machine] = r.out.trim().split('\n');
      const ok = got === content && hash === w.out.trim();
      verified.push(ok);
      if (!ok) errors.push(`mismatch on move ${i} to ${next} (${machine})`);
    } catch (e) { errors.push(e.message); verified.push(false); }
  }
  Object.assign(result, { moves, moveWallMs: stats(moveMs), snapshotSyncMs: stats(syncMs), verified: verified.filter(Boolean).length,
    payload: '2 MB random file + marker', errors: errors.length, errorSamples: errors.slice(0, 5) });
  s.close(); conn.end();
}

result.routing = (await tool('routing_trace', { limit: 100000 })).filter(e => e.event).slice(-20).map(e => `${e.event}:${e.machine ?? e.to ?? ''}`);
mcp.close(); admin.end();
writeFileSync(args.out ?? `stress-${args.mode}.json`, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
