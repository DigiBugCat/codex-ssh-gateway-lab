import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdirSync, symlinkSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';

// Routes stable environment endpoints (ws://.../env/<id>) to whichever machine
// currently hosts them. A machine exposes connect(cwd) -> exec-server session
// ({send, onMessage, onClose, close}); `local` machines are child processes,
// remote ones (MicroVMs) are WebSockets. Each workspace has one stable path.
// Local machines share it via a symlink to their copy; remote machines use the
// same path natively. Moving syncs the files (rsync locally, an S3 snapshot via
// presigned URLs otherwise), then rebinds open harness connections to a fresh
// exec-server on the target. Moves are refused while anything is in flight.
export async function startRouter({ machines, workspaces, environments, snapshots }) {
  const trace = [];
  const envs = Object.fromEntries(Object.entries(environments).map(([id, e]) => [id, { id, ...e, conns: new Set() }]));
  const spaces = Object.fromEntries(Object.entries(workspaces).map(([id, w]) => [id, { id, ...w }]));
  const isLocal = name => machines[name].kind === 'local';
  for (const w of Object.values(spaces)) if (isLocal(w.machine)) pointAt(w, w.machine);

  function dirOn(workspace, machine) { return join(machines[machine].root, workspace.id); }
  function pointAt(workspace, machine) {
    const target = dirOn(workspace, machine), tmp = `${workspace.path}.next`;
    mkdirSync(target, { recursive: true }); mkdirSync(dirname(workspace.path), { recursive: true });
    symlinkSync(target, tmp); renameSync(tmp, workspace.path);
  }
  // Runs one command on a machine through its own exec-server session.
  async function runOn(machine, argv, env) {
    const s = await machines[machine].connect('/');
    const waiting = new Map(), out = [];
    let exited = null, sawExited = false, sawClosed = false, finished;
    const done = new Promise(r => { finished = r; });
    s.onMessage(line => {
      const v = JSON.parse(line);
      if (waiting.has(v.id)) { waiting.get(v.id)(v); waiting.delete(v.id); }
      if (v.method === 'process/output') out.push(Buffer.from(v.params.chunk, 'base64'));
      // exited and closed are not ordered; the command is done once both arrive.
      if (v.method === 'process/exited') { exited = v.params.exitCode; sawExited = true; }
      if (v.method === 'process/closed') sawClosed = true;
      if (sawExited && sawClosed) finished();
    });
    const call = (method, params) => new Promise((res, rej) => {
      const id = `router-${method}-${Date.now()}`;
      waiting.set(id, v => v.error ? rej(Error(`${method}: ${JSON.stringify(v.error)}`)) : res(v.result));
      s.send(JSON.stringify({ id, method, params }));
    });
    try {
      await call('initialize', { clientName: 'env-router', resumeSessionId: null });
      s.send(JSON.stringify({ method: 'initialized', params: {} }));
      await call('process/start', { processId: 'router-task', argv, cwd: pathToFileURL('/').href, env, tty: false });
      await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(Error('Router command timed out')), 300000))]);
      if (exited !== 0) throw Error(`Command on ${machine} exited ${exited}: ${Buffer.concat(out).toString().slice(-500)}`);
      return Buffer.concat(out).toString();
    } finally { s.close(); }
  }
  // Workspace snapshots: the durable copy lives in S3, never only on a machine.
  async function snapshot(workspaceId) {
    const w = spaces[workspaceId];
    if (!snapshots) throw Error('Snapshots need snapshot storage');
    if (!machines[w.machine]) throw Error(`Workspace ${w.id} has no live machine to snapshot from`);
    const key = `workspaces/${w.id}/${Date.now()}.tgz`;
    await runOn(w.machine, ['/bin/sh', '-c', 'tar -C "$W" --exclude=./.machine -czf /tmp/ws.tgz . && code=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT --upload-file /tmp/ws.tgz "$U"); rm -f /tmp/ws.tgz; [ "$code" = 200 ] || { echo "snapshot upload HTTP $code"; exit 1; }'],
      { W: w.path, U: await snapshots.presign(key, 'put') });
    w.snapshot = key;
    trace.push({ event: 'workspace-snapshot', workspace: w.id, machine: w.machine });
    return key;
  }
  async function restore(w, machine) {
    if (!w.snapshot) return runOn(machine, ['/bin/sh', '-c', 'mkdir -p "$W"'], { W: w.path });
    return runOn(machine, ['/bin/sh', '-c', 'code=$(curl -sS -o /tmp/ws.tgz -w "%{http_code}" "$U"); [ "$code" = 200 ] || { echo "snapshot download HTTP $code"; exit 1; }; mkdir -p "$W" && find "$W" -mindepth 1 -maxdepth 1 ! -name .machine -exec rm -rf {} + && tar -xzf /tmp/ws.tgz -C "$W"; s=$?; rm -f /tmp/ws.tgz; exit $s'],
      { W: w.path, U: await snapshots.presign(w.snapshot, 'get') });
  }
  async function place(workspaceId, machine) {
    const w = spaces[workspaceId];
    if (!w) throw Error(`Unknown workspace ${workspaceId}`);
    if (!machines[machine]) throw Error(`Unknown machine ${machine}`);
    if (w.machine === machine) return { workspace: w.id, machine, changed: false };
    for (const e of Object.values(envs)) if (e.workspace === w.id) assertIdle(e);
    const from = w.machine, start = performance.now();
    if (machines[from] && isLocal(from) && isLocal(machine)) {
      // .machine marks the physical copy, so it never travels with the workspace.
      // --checksum: same-size files rewritten within one second keep their mtime.
      execFileSync('/usr/bin/rsync', ['-a', '--checksum', '--delete', '--exclude', '.machine', dirOn(w, from) + '/', dirOn(w, machine) + '/']);
      pointAt(w, machine);
    } else {
      // A live source is snapshotted now; a dead one is restored from its last snapshot.
      if (machines[from]) await snapshot(w.id);
      await restore(w, machine);
    }
    w.machine = machine;
    trace.push({ event: 'workspace-placed', workspace: w.id, from, to: machine });
    return { workspace: w.id, from, to: machine, changed: true, syncMs: +(performance.now() - start).toFixed(1) };
  }
  function assertIdle(e) {
    for (const c of e.conns) if (c.running.size || c.pending.size)
      throw Error(`Environment ${e.id} is busy (${c.running.size} running, ${c.pending.size} pending); move between turns`);
  }
  async function bindBackend(c) {
    const machine = c.env.machine;
    c.machine = machine; c.backend = null;
    const s = await machines[machine].connect(spaces[c.env.workspace].path);
    c.backend = s;
    trace.push({ event: 'backend-started', environment: c.env.id, machine });
    s.onMessage(line => {
      if (c.backend !== s) return;
      const v = JSON.parse(line);
      if (c.swallow.has(v.id)) { c.swallow.get(v.id)(v); c.swallow.delete(v.id); return; }
      // A process is idle only after both exited and closed (either order).
      if (v.method === 'process/exited' || v.method === 'process/closed') {
        const id = v.params?.processId, seen = (c.ending.get(id) ?? 0) + 1;
        if (seen >= 2) { c.running.delete(id); c.ending.delete(id); } else c.ending.set(id, seen);
      }
      if (v.id != null && c.pending.has(v.id)) {
        const started = c.pending.get(v.id); c.pending.delete(v.id);
        if (v.error && started) c.running.delete(started);
      }
      if (c.ws.readyState === 1) c.ws.send(line);
    });
    s.onClose(() => { if (c.backend === s && c.ws.readyState === 1) c.ws.close(); });
    for (const line of c.queue.splice(0)) s.send(line);
  }
  async function rebind(c) {
    const old = c.backend; c.backend = null; old?.close();
    await bindBackend(c);
    if (!c.initParams) return;
    const id = `router-reinit-${Date.now()}`;
    const reply = await new Promise(resolve => { c.swallow.set(id, resolve); c.backend.send(JSON.stringify({ id, method: 'initialize', params: c.initParams })); });
    if (reply.error) throw Error(`Re-initialize failed on ${c.machine}: ${JSON.stringify(reply.error)}`);
    c.backend.send(JSON.stringify({ method: 'initialized', params: {} }));
  }
  async function move(environmentId, machine) {
    const e = envs[environmentId];
    if (!e) throw Error(`Unknown environment ${environmentId}`);
    if (!machines[machine]) throw Error(`Unknown machine ${machine}`);
    if (e.machine === machine) return { environment: e.id, machine, changed: false };
    assertIdle(e);
    const from = e.machine, placed = await place(e.workspace, machine);
    e.machine = machine;
    for (const c of e.conns) await rebind(c);
    trace.push({ event: 'environment-moved', environment: e.id, from, to: machine, rebound: e.conns.size });
    return { environment: e.id, from, to: machine, reboundConnections: e.conns.size, sync: placed };
  }

  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16 * 1024 * 1024 });
  await once(wss, 'listening');
  const base = `ws://127.0.0.1:${wss.address().port}`;
  wss.on('connection', (ws, req) => {
    const e = envs[/^\/env\/([A-Za-z0-9_-]{1,100})$/.exec(req.url ?? '')?.[1]];
    if (!e) return ws.close(1008, 'Unknown environment');
    const c = { ws, env: e, running: new Set(), pending: new Map(), swallow: new Map(), ending: new Map(), initParams: null, queue: [] };
    e.conns.add(c);
    bindBackend(c).catch(error => { trace.push({ event: 'backend-error', environment: e.id, message: error.message }); ws.close(1011, 'Executor unavailable'); });
    ws.on('error', () => {});
    ws.on('message', data => {
      let m;
      try { m = JSON.parse(data.toString()); } catch { return ws.close(1003, 'JSON required'); }
      if (m.method === 'initialize') c.initParams = m.params;
      if (m.method === 'process/start') c.running.add(m.params?.processId);
      if (m.id != null) c.pending.set(m.id, m.method === 'process/start' ? m.params?.processId : null);
      trace.push({ environment: e.id, machine: c.machine, method: m.method, id: m.id });
      const line = JSON.stringify(m);
      c.backend ? c.backend.send(line) : c.queue.push(line);
    });
    ws.on('close', () => { e.conns.delete(c); c.backend?.close(); });
  });

  const describe = () => ({
    machines: Object.entries(machines).map(([name, m]) => ({ machine: name, kind: m.kind })),
    workspaces: Object.values(spaces).map(w => ({ workspace: w.id, path: w.path, machine: w.machine, snapshot: w.snapshot ?? null })),
    environments: Object.values(envs).map(e => ({
      environment: e.id, workspace: e.workspace, machine: e.machine, url: `${base}/env/${e.id}`,
      connections: e.conns.size, running: [...e.conns].reduce((n, c) => n + c.running.size, 0),
    })),
  });
  // Runtime topology changes: machines come and go; projects appear on first use.
  function addMachine(name, machine) { machines[name] = machine; trace.push({ event: 'machine-added', machine: name }); }
  function dropMachine(name) {
    delete machines[name];
    trace.push({ event: 'machine-dropped', machine: name });
    for (const e of Object.values(envs)) if (e.machine === name) for (const c of e.conns) c.ws.close(1011, 'Executor gone');
  }
  async function addProject({ id, path, machine, snapshot: key }) {
    spaces[id] ??= { id, path, machine: null, snapshot: key ?? null };
    envs[id] ??= { id, workspace: id, machine: null, conns: new Set() };
    const w = spaces[id], e = envs[id];
    if (w.machine && w.machine !== machine && machines[w.machine]) return move(id, machine);
    if (w.machine !== machine) { await restore(w, machine); w.machine = machine; trace.push({ event: 'workspace-placed', workspace: id, to: machine }); }
    if (e.machine !== machine) { const had = e.machine; e.machine = machine; for (const c of e.conns) await rebind(c); if (had) trace.push({ event: 'environment-moved', environment: id, from: had, to: machine }); }
    return { environment: id, machine };
  }
  return { base, trace, describe, move, place, snapshot, addMachine, dropMachine, addProject,
    run: (machine, argv, env = {}) => runOn(machine, argv, env),
    workspace: id => spaces[id], environment: id => envs[id], machineNames: () => Object.keys(machines),
    async close() {
      for (const e of Object.values(envs)) for (const c of e.conns) { c.ws.terminate(); c.backend?.close(); }
      await new Promise(r => wss.close(r));
    } };
}

// Local stand-in for a machine: a fresh `codex exec-server` per session, rooted
// at the given directory.
export function localMachine(root, env = {}) {
  return { kind: 'local', root, async connect(cwd) {
    // Minimal environment: the executor must not inherit this host's credentials.
    const base = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'en_US.UTF-8' };
    const p = spawn('codex', ['exec-server', '--listen', 'stdio://'], { cwd, env: { ...base, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stderr.resume();
    return {
      send: line => p.stdin.write(line + '\n'),
      onMessage: fn => createInterface({ input: p.stdout }).on('line', fn),
      onClose: fn => p.on('exit', fn),
      close: () => p.kill('SIGKILL'),
    };
  } };
}
