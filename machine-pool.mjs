import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Lambda MicroVM lifecycle for executors. Size is fixed per image (MicroVMs
// take their memory/vCPU from the image), TTL and idle policy at launch; a
// "longer" machine is a new launch plus a workspace restore.
export function microvmPool({ region, sizes }) {
  const aws = async (...args) => {
    const { stdout } = await run('aws', ['lambda-microvms', ...args, '--region', region, '--output', 'json']);
    return stdout.trim() ? JSON.parse(stdout) : {};
  };
  async function waitState(id, wanted, limitMs = 180000) {
    const t0 = Date.now();
    for (;;) {
      const { state } = await aws('get-microvm', '--microvm-identifier', id);
      if (wanted.includes(state)) return state;
      if (['TERMINATING', 'TERMINATED'].includes(state) || Date.now() - t0 > limitMs) throw Error(`${id} is ${state}, expected ${wanted.join('/')}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  const clamp = (v, lo, hi) => Math.min(Math.max(Math.round(v), lo), hi);
  return {
    sizes: Object.fromEntries(Object.entries(sizes).map(([k, v]) => [k, { memoryMiB: v.memoryMiB, vcpu: v.vcpu }])),
    async launch({ size = 'small', ttlMinutes = 480, idleSuspendMinutes = 60, autoResume = true } = {}) {
      const s = sizes[size];
      if (!s) throw Error(`Unknown size ${size}; choose one of ${Object.keys(sizes).join(', ')}`);
      const ttl = clamp(ttlMinutes * 60, 300, 28800), idle = clamp(idleSuspendMinutes * 60, 60, 28800);
      // Quota and rate limits are transient here (terminating VMs still count
      // against the memory quota; RunMicrovm allows ~1/s), so back off and retry.
      let started;
      for (let attempt = 0; ; attempt++) {
        try {
          started = await aws('run-microvm', '--image-identifier', s.image, '--maximum-duration-in-seconds', String(ttl),
            '--idle-policy', JSON.stringify({ autoResumeEnabled: autoResume, maxIdleDurationSeconds: idle, suspendedDurationSeconds: ttl }));
          break;
        } catch (error) {
          const detail = `${error.stderr ?? ''} ${error.message}`;
          if (!/quota|limit|throttl|toomanyrequests|capacity/i.test(detail) || attempt >= 6)
            throw Error(`Could not launch a ${size} MicroVM: ${(/\(([A-Za-z]+Exception)\)[^\n]*/.exec(detail)?.[0] ?? detail).slice(0, 300)}`);
          await new Promise(r => setTimeout(r, Math.min(2000 * 2 ** attempt, 30000)));
        }
      }
      await waitState(started.microvmId, ['RUNNING']);
      const { endpoint } = await aws('get-microvm', '--microvm-identifier', started.microvmId);
      return { microvmId: started.microvmId, endpoint, size, memoryMiB: s.memoryMiB, vcpu: s.vcpu };
    },
    async describe(id) {
      const d = await aws('get-microvm', '--microvm-identifier', id);
      const expires = Date.parse(d.startedAt) + d.maximumDurationInSeconds * 1000;
      return { state: d.state, image: d.imageArn?.split(':').pop(), startedAt: d.startedAt, expiresAt: new Date(expires).toISOString(),
        minutesLeft: Math.max(0, Math.round((expires - Date.now()) / 60000)), idlePolicy: d.idlePolicy };
    },
    async suspend(id) { await aws('suspend-microvm', '--microvm-identifier', id); return waitState(id, ['SUSPENDED']); },
    async resume(id) { await aws('resume-microvm', '--microvm-identifier', id); return waitState(id, ['RUNNING']); },
    async terminate(id) { await aws('terminate-microvm', '--microvm-identifier', id); return 'TERMINATING'; },
  };
}
