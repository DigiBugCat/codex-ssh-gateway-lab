// Launches N executor MicroVMs from the agents-exec image and times each state
// transition. Usage (with AWS env): node aws-agents/launch-microvms.mjs N out.json
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';
const run = promisify(execFile);
const aws = async (...a) => JSON.parse((await run('aws', ['lambda-microvms', ...a, '--output', 'json'])).stdout);
const image = 'arn:aws:lambda:us-east-2:520891536882:microvm-image:agents-exec';
const n = +(process.argv[2] ?? 2);
const results = await Promise.all(Array.from({ length: n }, async (_, i) => {
  await new Promise(r => setTimeout(r, i * 250)); // stay under RunMicrovm 5 TPS
  const t0 = performance.now();
  const started = await aws('run-microvm', '--image-identifier', image, '--maximum-duration-in-seconds', '28800',
    '--idle-policy', JSON.stringify({ autoResumeEnabled: true, maxIdleDurationSeconds: 3600, suspendedDurationSeconds: 3600 }));
  const accepted = performance.now() - t0;
  let state = started.state, info = started;
  while (state !== 'RUNNING') {
    if (['TERMINATING', 'TERMINATED'].includes(state)) throw Error(`${started.microvmId} ${state}: ${JSON.stringify(info.stateReason ?? '')}`);
    await new Promise(r => setTimeout(r, 500));
    info = await aws('get-microvm', '--microvm-identifier', started.microvmId); state = info.state;
  }
  return { microvmId: started.microvmId, endpoint: info.endpoint ?? started.endpoint, runAcceptedMs: +accepted.toFixed(0), runningAfterMs: +(performance.now() - t0).toFixed(0) };
}));
writeFileSync(process.argv[3] ?? 'microvms.json', JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
