import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import WebSocket from 'ws';

const run = promisify(execFile);

// A Lambda MicroVM running `codex exec-server --listen ws://0.0.0.0:<port>`.
// Each session is a WebSocket to the MicroVM's public endpoint, authenticated
// with a short-lived token scoped to that one port (presented as WebSocket
// subprotocols, which Lambda strips before forwarding).
export function microvmMachine({ microvmId, endpoint, port = 8080, region }) {
  let token = null, expiresAt = 0, inflight = null;
  // Concurrent connects share one token request (a burst would otherwise fork
  // one CLI process per connection).
  function authToken() {
    if (token && Date.now() < expiresAt - 5 * 60_000) return Promise.resolve(token);
    inflight ??= run('aws', ['lambda-microvms', 'create-microvm-auth-token', '--microvm-identifier', microvmId,
      '--expiration-in-minutes', '60', '--allowed-ports', JSON.stringify([{ port }]), '--region', region, '--output', 'json'])
      .then(({ stdout }) => { token = JSON.parse(stdout).authToken['X-aws-proxy-auth']; expiresAt = Date.now() + 60 * 60_000; return token; })
      .finally(() => { inflight = null; });
    return inflight;
  }
  return { kind: 'microvm', microvmId, async connect() {
    const ws = new WebSocket(`wss://${endpoint}/`, ['lambda-microvms', `lambda-microvms.authentication.${await authToken()}`, `lambda-microvms.port.${port}`]);
    await new Promise((res, rej) => {
      const timer = setTimeout(() => { ws.terminate(); rej(Error(`MicroVM ${microvmId} connect timed out`)); }, 15000);
      ws.once('open', () => { clearTimeout(timer); res(); }).once('error', e => { clearTimeout(timer); rej(e); });
      ws.once('unexpected-response', (req, r) => rej(Error(`MicroVM ${microvmId} refused WebSocket: HTTP ${r.statusCode}`)));
    });
    ws.on('error', () => {});
    return {
      send: line => ws.send(line),
      onMessage: fn => ws.on('message', d => fn(d.toString())),
      onClose: fn => ws.on('close', fn),
      close: () => ws.terminate(),
    };
  } };
}
