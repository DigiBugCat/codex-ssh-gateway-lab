// Opens N concurrent exec-server sessions straight to one MicroVM (no gateway)
// and counts how many initialize. Usage: node aws-agents/microvm-conns.mjs microvms.json N
import { readFileSync } from 'node:fs';
import { microvmMachine } from '../microvm-machine.mjs';
const [vm] = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const n = +process.argv[3], m = microvmMachine({ ...vm, region: 'us-east-2' });
const outcomes = await Promise.all(Array.from({ length: n }, async (_, i) => {
  try {
    const s = await m.connect();
    const ok = await new Promise(res => {
      const t = setTimeout(() => res('init-timeout'), 20000);
      s.onMessage(l => { if (JSON.parse(l).id === 1) { clearTimeout(t); res('ok'); } });
      s.onClose(() => res('closed'));
      s.send(JSON.stringify({ id: 1, method: 'initialize', params: { clientName: `c${i}`, resumeSessionId: null } }));
    });
    return { ok, s };
  } catch (e) { return { ok: `connect-error: ${e.message.slice(0, 80)}` }; }
}));
const tally = {}; for (const o of outcomes) tally[o.ok] = (tally[o.ok] ?? 0) + 1;
console.log(JSON.stringify({ requested: n, tally }));
for (const o of outcomes) o.s?.close();
