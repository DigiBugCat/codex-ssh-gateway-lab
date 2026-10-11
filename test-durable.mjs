import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { DurableStore } from './durable-store.mjs';
mkdirSync('.lab', { recursive: true });
const root = mkdtempSync(resolve('.lab/durable-'));
const db = join(root, 'state.sqlite');
const worker = resolve('durable-worker.mjs');
const checks = [];
function pass(name) { checks.push(name); console.log('PASS', name); }
function cold(request, crash) {
  const start = performance.now();
  const p = spawnSync(process.execPath, [worker, db, ...(crash ? [crash] : [])], { input: JSON.stringify(request), encoding: 'utf8', timeout: 10000 });
  const ms = performance.now() - start;
  if (crash) { assert.equal(p.signal, 'SIGKILL'); return { ms }; }
  assert.equal(p.status, 0, p.stderr);
  return { result: JSON.parse(p.stdout), ms };
}
const op = (agentId, operationId, text = 'hello') => ({ agentId, operationId, text });
const first = cold(op('agent1', 'first', 'saved before sleep')).result;
assert.deepEqual(cold(op('agent1', 'first', 'saved before sleep')).result, first);
assert.equal(cold({ action: 'read', agentId: 'agent1' }).result.revision, 1);
pass('Identity and completed operation survive full worker exit; retry deduplicates');
for (const phase of ['accepted', 'beforeCommit', 'afterCommit']) {
  cold(op(phase, 'crash', phase), phase);
  cold({ action: 'recover' });
  const state = cold({ action: 'read', agentId: phase }).result;
  assert.equal(state.revision, 1); assert.equal(state.events.length, 1);
  assert.equal(cold(op(phase, 'crash', phase)).result.revision, 1);
  pass(`SIGKILL at ${phase}: recover with exactly one committed local event`);
}
const conflicting = spawnSync(process.execPath, [worker, db], { input: JSON.stringify(op('agent1', 'first', 'different')), encoding: 'utf8' });
assert.notEqual(conflicting.status, 0); assert.match(conflicting.stderr, /Operation ID conflict/);
pass('Conflicting operation ID is rejected');
async function concurrent(request) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [worker, db], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), 10000);
    p.stdout.on('data', b => output += b); p.stderr.on('data', b => error += b);
    p.on('error', reject); p.on('close', code => { clearTimeout(timer); code === 0 ? resolve(JSON.parse(output)) : reject(Error(error)); });
    p.stdin.end(JSON.stringify(request));
  });
}
const replies = await Promise.all(Array.from({ length: 8 }, () => concurrent(op('race', 'same'))));
assert.ok(replies.every(r => r.revision === 1));
assert.equal(cold({ action: 'read', agentId: 'race' }).result.events.length, 1);
pass('Eight concurrent activations commit one event for the same operation');
const store = new DurableStore(db);
const warm = [];
for (let i = 0; i < 100; i++) {
  const start = performance.now(); store.submit(op(`warm${i}`, 'first')); warm.push(performance.now() - start);
}
store.close();
assert.equal(cold({ action: 'read', agentId: 'warm99' }).result.revision, 1);
pass('100 dormant identities are durable rows, with no per-agent worker retained');
const coldTimes = [];
for (let i = 0; i < 25; i++) coldTimes.push(cold(op(`cold${i}`, 'first')).ms);
const stats = values => { const v = [...values].sort((a, b) => a - b); return { n: v.length, medianMs: +v[Math.floor(v.length / 2)].toFixed(2), p95Ms: +v[Math.ceil(v.length * .95) - 1].toFixed(2), maxMs: +v.at(-1).toFixed(2) }; };
const result = { checkedAt: new Date().toISOString(), node: process.version, checks, warmLocalTransaction: stats(warm), coldProcessStartCommitAndExit: stats(coldTimes), scope: 'Local deterministic SQLite events; no model, network, VM, celld or external side-effect recovery.' };
writeFileSync('durability-results.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
