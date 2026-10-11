import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';
import { DurableStore } from './durable-store.mjs';
import { startLab } from './boundary-lab.mjs';
import { Rpc } from './rpc.mjs';
mkdirSync('.lab', { recursive: true });
const db = join(mkdtempSync(resolve('.lab/bridge-')), 'state.sqlite');
const killed = spawnSync(process.execPath, [resolve('durable-worker.mjs'), db, 'accepted'], { input: JSON.stringify({ agentId: 'sleeper', operationId: 'one', text: 'I survived sleep.' }) });
assert.equal(killed.signal, 'SIGKILL');
const timings = [];
for (let i = 0; i < 2; i++) {
  const start = performance.now();
  const store = new DurableStore(db);
  const lab = await startLab({ durableStore: store });
  let ws;
  try {
    ws = new WebSocket(lab.url); await once(ws, 'open');
    const rpc = new Rpc(s => ws.send(s));
    ws.on('message', b => rpc.receive(b.toString()));
    await rpc.call('initialize', { clientName: 'durable-bridge-test', resumeSessionId: null });
    rpc.notify('initialized');
    const reply = await rpc.call('fs/readFile', { path: 'file:///durable/sleeper/history.txt' });
    assert.equal(Buffer.from(reply.dataBase64, 'base64').toString(), 'I survived sleep.');
    assert.equal(store.read('sleeper').revision, 1);
    assert.equal(store.pending().length, 0);
    timings.push(+(performance.now() - start).toFixed(2));
  } finally {
    ws?.terminate(); assert.equal(await lab.close(), 0); store.close();
  }
}
const result = { checkedAt: new Date().toISOString(), result: 'PASS', checks: ['Gateway startup recovers an accepted operation after worker SIGKILL', 'Durable history returned through executor file-read interception', 'Fresh gateway, SSH transport, executor and database connection preserve the same identity and one event'], fullLocalLabStartupThroughFirstReadMs: timings, timingScope: 'Two illustrative samples, includes SSH key generation and handshake; not a percentile benchmark.' };
writeFileSync('durable-bridge-results.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
