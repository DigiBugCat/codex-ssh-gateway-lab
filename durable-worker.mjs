import { readFileSync } from 'node:fs';
import { DurableStore } from './durable-store.mjs';
const request = JSON.parse(readFileSync(0, 'utf8'));
const store = new DurableStore(process.argv[2]);
// These crash points are only enabled by the local test runner.
const crash = phase => { if (process.argv[3] === phase) process.kill(process.pid, 'SIGKILL'); };
try {
  let result;
  if (request.action === 'read') result = store.read(request.agentId);
  else if (request.action === 'recover') result = store.recover();
  else {
    result = store.submit(request, crash);
    crash('afterCommit');
  }
  process.stdout.write(JSON.stringify(result) + '\n');
} finally { store.close(); }
