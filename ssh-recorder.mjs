// Recording SSH server: logs what the Codex desktop app runs over "SSH remote".
// Loopback only. Accepts user "lab" with no auth, runs each exec request with
// /bin/sh under an isolated HOME (.lab/recorder/home) and tees both directions.
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import ssh2 from 'ssh2';

const port = Number(process.argv[2] || 2222);
const root = resolve('.lab/recorder');
const home = process.env.RECORDER_HOME || join(root, 'home'); // keep short: unix socket paths max ~104 chars
mkdirSync(home, { recursive: true });
const hostKey = join(root, 'host');
if (!existsSync(hostKey)) execFileSync('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
const logFile = join(root, 'log.jsonl');
let seq = 0;
// Decodes WebSocket frames after the HTTP upgrade so masked client messages are readable.
function wsDecoder(onMessage) {
  let buf = Buffer.alloc(0), upgraded = false;
  return chunk => {
    buf = Buffer.concat([buf, chunk]);
    if (!upgraded) {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      upgraded = true; buf = buf.subarray(end + 4);
    }
    while (buf.length >= 2) {
      const opcode = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const keyLen = masked ? 4 : 0;
      if (buf.length < off + keyLen + len) return;
      const payload = Buffer.from(buf.subarray(off + keyLen, off + keyLen + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[off + (i & 3)];
      buf = buf.subarray(off + keyLen + len);
      if (opcode === 1 || opcode === 0) onMessage(payload.toString('utf8'));
    }
  };
}
const log = entry => appendFileSync(logFile, JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n');
// Protocol messages may carry credentials, so record only their shape: id, method,
// error code and key names. Values are never written.
const shape = text => {
  try {
    const m = JSON.parse(text), keys = v => v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : undefined;
    return { id: typeof m.id === 'string' ? m.id.split(':')[0] : m.id, method: m.method, paramKeys: keys(m.params), resultKeys: keys(m.result), error: m.error?.code };
  } catch { return { nonJsonBytes: Buffer.byteLength(text) }; }
};
const preview = buf => buf.length > 4000 ? buf.subarray(0, 4000).toString('utf8') + `…(+${buf.length - 4000} bytes)` : buf.toString('utf8');

new ssh2.Server({ hostKeys: [readFileSync(hostKey)] }, client => {
  const conn = ++seq;
  log({ conn, event: 'connect' });
  client.on('error', e => log({ conn, event: 'error', message: e.message }));
  client.on('close', () => log({ conn, event: 'close' }));
  client.on('authentication', ctx => {
    log({ conn, event: 'auth', user: ctx.username, method: ctx.method });
    if (ctx.username === 'lab' && ['none', 'publickey'].includes(ctx.method)) {
      if (ctx.method === 'publickey' && ctx.signature === undefined) return ctx.accept();
      return ctx.accept();
    }
    ctx.reject(['none', 'publickey']);
  });
  client.on('ready', () => client.on('session', accept => {
    const session = accept();
    const env = {};
    session.on('env', (acc, _rej, info) => { env[info.key] = info.val; log({ conn, event: 'env', key: info.key }); acc?.(); });
    session.on('pty', (acc, _rej, info) => { log({ conn, event: 'pty', info }); acc?.(); });
    session.on('auth-agent', acc => { log({ conn, event: 'auth-agent' }); acc?.(); });
    session.on('shell', (acc) => { log({ conn, event: 'shell-request' }); const ch = acc(); ch.exit(1); ch.end(); });
    session.on('subsystem', (acc, rej, info) => { log({ conn, event: 'subsystem', name: info.name }); rej(); });
    session.on('exec', (acceptExec, _reject, info) => {
      const id = `${conn}.${Date.now()}`;
      log({ conn, id, event: 'exec', command: info.command });
      const channel = acceptExec();
      const p = spawn('/bin/sh', ['-c', info.command], {
        cwd: home,
        env: { HOME: home, USER: 'lab', LOGNAME: 'lab', SHELL: '/bin/zsh', LANG: 'en_US.UTF-8', TERM: 'dumb',
          PATH: '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const isProxy = info.command.includes('app-server proxy');
      const decodeIn = wsDecoder(m => log({ conn, id, dir: 'in-msg', ...shape(m) }));
      // Server output starts with the 8-byte marker, then the HTTP 101 response, then frames.
      let skip = 8;
      const decodeOut = wsDecoder(m => log({ conn, id, dir: 'out-msg', ...shape(m) }));
      channel.on('data', d => { if (isProxy) decodeIn(d); else log({ conn, id, dir: 'in', data: preview(d) }); p.stdin.write(d); });
      channel.on('end', () => p.stdin.end());
      p.stdout.on('data', d => {
        if (isProxy) { const rest = skip ? d.subarray(skip) : d; skip = Math.max(0, skip - d.length); decodeOut(rest); }
        else log({ conn, id, dir: 'out', data: preview(d) });
        channel.write(d);
      });
      p.stderr.on('data', d => { log({ conn, id, dir: 'err', data: preview(d) }); channel.stderr.write(d); });
      p.on('exit', (code, signal) => { log({ conn, id, event: 'exit', code, signal }); channel.exit(code ?? 1); channel.end(); });
      channel.on('close', () => { if (p.exitCode === null) p.kill('SIGTERM'); });
    });
  }));
}).listen(port, '127.0.0.1', () => {
  log({ event: 'listening', port });
  console.log(`recorder listening on 127.0.0.1:${port}; log ${logFile}`);
  console.log(`host key: ${readFileSync(hostKey + '.pub', 'utf8').trim()}`);
});
