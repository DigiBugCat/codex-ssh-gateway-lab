// Times MicroVM suspend/resume and auto-resume-on-traffic, then a parallel
// launch burst. Usage (with AWS env): node aws-agents/lifecycle.mjs microvms.json N out.json
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { microvmMachine } from '../microvm-machine.mjs';
const run = promisify(execFile);
const aws = async (...a) => JSON.parse((await run('aws', ['lambda-microvms', ...a, '--output', 'json'])).stdout || '{}');
const [, vm] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const burst = +(process.argv[3] ?? 8);
const ms = t => +(performance.now() - t).toFixed(0);
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
async function waitState(id, want, limitMs = 120000) {
  const t0 = performance.now(); let last;
  for (;;) {
    const s = (await aws('get-microvm', '--microvm-identifier', id)).state;
    if (s !== last) { log(id.slice(8, 16), s); last = s; }
    if (s === want) return;
    if (s === 'TERMINATED' || performance.now() - t0 > limitMs) throw Error(`${id} stuck in ${s} waiting for ${want}`);
    await new Promise(r => setTimeout(r, 250));
  }
}
async function command(m) {
  const t = performance.now(); const s = await m.connect(); const connectMs = ms(t);
  const waiting = new Map(); let ex = false, cl = false, fin; const done = new Promise(r => { fin = r; });
  s.onMessage(l => { const v = JSON.parse(l); if (waiting.has(v.id)) { waiting.get(v.id)(v); waiting.delete(v.id); } if (v.method === 'process/exited') ex = true; if (v.method === 'process/closed') cl = true; if (ex && cl) fin(); });
  const call = (id, method, params) => new Promise(r => { waiting.set(id, r); s.send(JSON.stringify({ id, method, params })); });
  await call(1, 'initialize', { clientName: 'lifecycle', resumeSessionId: null });
  s.send(JSON.stringify({ method: 'initialized', params: {} }));
  await call(2, 'process/start', { processId: 'x', argv: ['/bin/sh', '-c', 'cat /workspace/proj/.machine'], cwd: pathToFileURL('/workspace').href, env: {}, tty: false });
  await Promise.race([done, new Promise((_, rej) => setTimeout(() => rej(Error('command timed out')), 30000))]); s.close();
  return { connectMs, totalMs: ms(t) };
}
const m = microvmMachine({ ...vm, region: 'us-east-2' });
const out = { microvmId: vm.microvmId };
log('warm command'); out.warmCommand = await command(m);
let t = performance.now(); await aws('suspend-microvm', '--microvm-identifier', vm.microvmId); await waitState(vm.microvmId, 'SUSPENDED'); out.suspendMs = ms(t);
t = performance.now(); await aws('resume-microvm', '--microvm-identifier', vm.microvmId); await waitState(vm.microvmId, 'RUNNING'); out.resumeMs = ms(t);
out.afterResumeCommand = await command(m);
t = performance.now(); await aws('suspend-microvm', '--microvm-identifier', vm.microvmId); await waitState(vm.microvmId, 'SUSPENDED'); out.suspendAgainMs = ms(t);
try { out.autoResumeOnTraffic = await command(m); } catch (e) { out.autoResumeOnTraffic = { error: e.message }; }
out.stateAfterTraffic = (await aws('get-microvm', '--microvm-identifier', vm.microvmId)).state;
// Launch burst, staggered under the RunMicrovm 5 TPS limit, then terminate.
const image = 'arn:aws:lambda:us-east-2:520891536882:microvm-image:agents-exec';
const launched = await Promise.all(Array.from({ length: burst }, async (_, i) => {
  await new Promise(r => setTimeout(r, i * 250));
  const t0 = performance.now();
  try {
    const r = await aws('run-microvm', '--image-identifier', image, '--maximum-duration-in-seconds', '1800', '--idle-policy', JSON.stringify({ autoResumeEnabled: false, maxIdleDurationSeconds: 600, suspendedDurationSeconds: 60 }));
    await waitState(r.microvmId, 'RUNNING');
    const runningMs = ms(t0);
    const first = await command(microvmMachine({ microvmId: r.microvmId, endpoint: (await aws('get-microvm', '--microvm-identifier', r.microvmId)).endpoint, region: 'us-east-2' })).catch(e => ({ error: e.message }));
    await aws('terminate-microvm', '--microvm-identifier', r.microvmId);
    return { runningMs, firstCommand: first };
  } catch (e) { return { error: e.message.slice(0, 200) }; }
}));
out.burst = { n: burst, results: launched };
writeFileSync(process.argv[4] ?? 'lifecycle.json', JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
