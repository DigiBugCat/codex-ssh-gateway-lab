// Connects to each MicroVM's exec-server through its authenticated endpoint,
// writes a .machine marker and times connect + first command.
// Usage (with AWS env): node aws-agents/microvm-probe.mjs microvms.json
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { microvmMachine } from '../microvm-machine.mjs';
const vms = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const names = ['A', 'B', 'C', 'D', 'E', 'F'];
for (const [i, vm] of vms.entries()) {
  const m = microvmMachine({ ...vm, region: 'us-east-2' });
  const t0 = performance.now();
  const s = await m.connect();
  const connected = performance.now() - t0;
  const waiting = new Map(); let exit, closed;
  const done = new Promise(r => { closed = r; });
  s.onMessage(line => { const v = JSON.parse(line); if (waiting.has(v.id)) { waiting.get(v.id)(v); waiting.delete(v.id); } if (v.method === 'process/exited') exit = v.params.exitCode; if (v.method === 'process/closed') closed(); });
  const call = (id, method, params) => new Promise(r => { waiting.set(id, r); s.send(JSON.stringify({ id, method, params })); });
  const init = await call(1, 'initialize', { clientName: 'probe', resumeSessionId: null });
  s.send(JSON.stringify({ method: 'initialized', params: {} }));
  const t1 = performance.now();
  await call(2, 'process/start', { processId: 'mark', argv: ['/bin/sh', '-c', `echo machine-${names[i]} > /workspace/proj/.machine && uname -m`], cwd: pathToFileURL('/workspace/proj').href, env: {}, tty: false });
  await done;
  const info = await call(3, 'environment/info', {});
  console.log(JSON.stringify({ machine: names[i], microvmId: vm.microvmId, initOk: !init.error, connectMs: +connected.toFixed(0), firstCommandMs: +(performance.now() - t1).toFixed(0), exit, envInfo: info.result ?? info.error }));
  s.close();
}
