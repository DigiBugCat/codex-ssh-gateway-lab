import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import ssh2 from 'ssh2';

// This is a local transport experiment, not a security sandbox.
export async function startLab({ durableStore } = {}) {
  durableStore?.recover();
  mkdirSync('.lab', { recursive: true });
  const root = mkdtempSync(resolve('.lab/run-'));
  const home = join(root, 'codex-home');
  mkdirSync(home); mkdirSync(join(root, 'workspace'));
  for (const name of ['host', 'client']) execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)]);
  const key = ssh2.utils.parseKey(readFileSync(join(root, 'client.pub')));
  let closing = false;
  const children = new Set(), connections = new Set(), trace = [];
  const childEnv = { PATH: process.env.PATH, HOME: process.env.HOME, CODEX_HOME: home, LANG: 'en_US.UTF-8' };
  function launch(command, args, environmentOverrides = {}) {
    const p = spawn(command, args, { cwd: join(root, 'workspace'), env: { ...childEnv, ...environmentOverrides }, stdio: ['pipe', 'pipe', 'pipe'] });
    children.add(p); p.once('exit', () => children.delete(p));
    p.stderr.resume(); return p;
  }
  const server = new ssh2.Server({ hostKeys: [readFileSync(join(root, 'host'))] }, client => {
    connections.add(client); client.on('error', () => {}); client.on('close', () => connections.delete(client));
    client.on('authentication', ctx => {
      const matches = ctx.username === 'lab' && ctx.method === 'publickey' && ctx.key.data.equals(key.getPublicSSH());
      if (matches && (!ctx.signature || key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true)) ctx.accept();
      else ctx.reject();
    });
    client.on('ready', () => client.on('session', accept => {
      const session = accept();
      session.on('exec', (acceptExec, reject, info) => {
        if (closing || info.command !== 'codex-executor-lab') return reject();
        const channel = acceptExec();
        const p = launch('codex', ['exec-server', '--listen', 'stdio://']);
        trace.push({ event: 'ssh-executor-started' });
        channel.pipe(p.stdin); p.stdout.pipe(channel);
        p.once('exit', code => { channel.exit(code ?? 1); channel.end(); });
        channel.on('close', () => p.kill('SIGKILL'));
      });
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sshPort = server.address().port;
  writeFileSync(join(root, 'known_hosts'), `[127.0.0.1]:${sshPort} ${readFileSync(join(root, 'host.pub'), 'utf8')}`);
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 1024 * 1024 });
  await once(wss, 'listening');
  const virtualPath = 'file:///virtual/boundary-marker.txt';
  wss.on('connection', ws => {
    const p = launch('/usr/bin/ssh', ['-F', '/dev/null', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${join(root, 'known_hosts')}`, '-i', join(root, 'client'), '-p', String(sshPort), 'lab@127.0.0.1', 'codex-executor-lab']);
    ws.on('error', () => {});
    ws.on('message', data => {
      let message;
      try { message = JSON.parse(data.toString()); } catch { ws.close(1003, 'JSON required'); return; }
      trace.push({ direction: 'request', method: message.method, id: message.id });
      const durableMatch = message.method === 'fs/readFile' && /^file:\/\/\/durable\/([a-zA-Z0-9_-]{1,100})\/history.txt$/.exec(message.params?.path ?? '');
      if (durableMatch && durableStore) {
        const state = durableStore.read(durableMatch[1]);
        trace.push({ event: 'durable-file-intercept' });
        ws.send(JSON.stringify({ id: message.id, result: { dataBase64: Buffer.from(state.events.map(event => event.text).join('\n')).toString('base64') } }));
      } else if (message.method === 'fs/readFile' && message.params?.path === virtualPath) {
        trace.push({ event: 'virtual-file-intercept' });
        ws.send(JSON.stringify({ id: message.id, result: { dataBase64: Buffer.from('hello from the virtual workspace\n').toString('base64') } }));
      } else p.stdin.write(JSON.stringify(message) + '\n');
    });
    createInterface({ input: p.stdout }).on('line', line => {
      if (ws.readyState === 1) ws.send(line);
      const v = JSON.parse(line); trace.push({ direction: 'response', id: v.id, method: v.method, error: v.error?.code });
    });
    ws.on('close', () => p.kill('SIGKILL'));
    p.on('exit', () => { if (ws.readyState === 1) ws.close(); });
  });
  return { root, home, trace, virtualPath, url: `ws://127.0.0.1:${wss.address().port}`, launch,
    async close() {
      closing = true;
      for (const ws of wss.clients) ws.terminate();
      for (const c of connections) c.end();
      const waits = [...children].map(p => { const done = once(p, 'exit').catch(() => {}); p.kill('SIGKILL'); return done; });
      await Promise.all(waits);
      await Promise.all([new Promise(r => wss.close(r)), new Promise(r => server.close(r))]);
      for (const p of [...children]) {
        const done = once(p, 'exit').catch(() => {}); p.kill('SIGKILL'); await done;
      }
      return children.size;
    }
  };
}
