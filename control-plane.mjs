import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { microvmMachine } from './microvm-machine.mjs';

// Projects -> machines. Every project gets its own MicroVM (the isolation
// unit), created on first use and replaced when it expires or dies; its
// workspace survives in S3 snapshots. State is persisted so a gateway restart
// keeps projects, machines and thread routing.
export function startControlPlane({ router, pool, region, statePath, defaults = {} }) {
  const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { machines: {}, projects: {}, threads: {}, seq: 0 };
  const save = () => { writeFileSync(`${statePath}.tmp`, JSON.stringify(state, null, 2)); renameSync(`${statePath}.tmp`, statePath); };
  for (const [name, m] of Object.entries(state.machines)) router.addMachine(name, microvmMachine({ ...m, region }));
  const checked = new Map(); // machine -> last liveness check time

  async function launch(options) {
    const vm = await pool.launch(options);
    const name = `vm-${++state.seq}`;
    state.machines[name] = { ...vm, ttlMinutes: options.ttlMinutes, idleSuspendMinutes: options.idleSuspendMinutes, launchedAt: new Date().toISOString() };
    router.addMachine(name, microvmMachine({ ...vm, region }));
    save();
    return name;
  }
  // A machine is usable if RUNNING (or resumable); expired/terminated ones are dropped.
  async function alive(name) {
    const m = state.machines[name];
    if (!m) return false;
    if (Date.now() - (checked.get(name) ?? 0) < 30000) return true;
    let d;
    try { d = await pool.describe(m.microvmId); } catch { d = { state: 'MISSING' }; }
    if (['SUSPENDED', 'SUSPENDING'].includes(d.state)) { await pool.resume(m.microvmId); d.state = 'RUNNING'; }
    if (!['RUNNING', 'PENDING'].includes(d.state)) {
      delete state.machines[name]; router.dropMachine(name); checked.delete(name); save();
      return false;
    }
    checked.set(name, Date.now());
    return true;
  }
  const projectId = (user, project) => `${user}-${project}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100);

  // Called by the gateway before a thread or turn runs.
  async function ensureProject(user, project) {
    const id = projectId(user, project);
    const p = state.projects[id] ??= { user, project, path: `/workspace/${project.replace(/[^A-Za-z0-9_.-]/g, '-')}`, machine: null, snapshot: null,
      size: defaults.size ?? 'small', ttlMinutes: defaults.ttlMinutes ?? 480, idleSuspendMinutes: defaults.idleSuspendMinutes ?? 60 };
    if (!p.machine || !(await alive(p.machine))) p.machine = await launch({ size: p.size, ttlMinutes: p.ttlMinutes, idleSuspendMinutes: p.idleSuspendMinutes });
    p.snapshot = router.workspace(id)?.snapshot ?? p.snapshot;
    await router.addProject({ id, path: p.path, machine: p.machine, snapshot: p.snapshot });
    save();
    const env = router.describe().environments.find(e => e.environment === id);
    return { environmentId: id, cwd: p.path, url: env.url };
  }
  async function checkpoint(environmentId) {
    const p = state.projects[environmentId];
    if (!p || !(await alive(p.machine))) return null;
    p.snapshot = await router.snapshot(environmentId);
    save();
    return p.snapshot;
  }
  const rememberThread = (threadId, environmentId) => { state.threads[threadId] = environmentId; save(); };
  const threadEnvironment = threadId => state.threads[threadId];

  const projectOf = name => Object.entries(state.projects).filter(([, p]) => p.machine === name).map(([id]) => id);
  const tool = (description, properties, required, run) => ({ description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, run });
  const str = d => ({ type: 'string', description: d }), num = d => ({ type: 'number', description: d });
  const tools = {
    list_machines: tool('List executor MicroVMs: size, project, state, minutes left before TTL, idle policy.', {}, [], async () =>
      Promise.all(Object.entries(state.machines).map(async ([name, m]) => ({ machine: name, size: m.size, memoryMiB: m.memoryMiB, projects: projectOf(name),
        ...(await pool.describe(m.microvmId).catch(e => ({ state: `unknown: ${e.message.slice(0, 80)}` }))) })))),
    create_machine: tool('Launch an executor MicroVM. Sizes are image variants; TTL max 480 minutes; it auto-suspends after the idle period and auto-resumes on traffic.',
      { size: str(`One of: ${Object.keys(pool.sizes).join(', ')}`), ttl_minutes: num('Lifetime, 5-480'), idle_suspend_minutes: num('Idle minutes before suspend, 1-480') }, [],
      async a => { const name = await launch({ size: a.size ?? 'small', ttlMinutes: a.ttl_minutes ?? 480, idleSuspendMinutes: a.idle_suspend_minutes ?? 60 }); return { machine: name, ...state.machines[name] }; }),
    pause_machine: tool('Suspend a MicroVM (memory and disk kept; billed as snapshot storage). Traffic or resume_machine wakes it.', { machine: str('Machine name') }, ['machine'],
      async ({ machine }) => { await checkpointAll(machine); checked.delete(machine); return { machine, state: await pool.suspend(need(machine).microvmId) }; }),
    resume_machine: tool('Resume a suspended MicroVM.', { machine: str('Machine name') }, ['machine'],
      async ({ machine }) => ({ machine, state: await pool.resume(need(machine).microvmId) })),
    terminate_machine: tool('Snapshot every project on a MicroVM to S3, then terminate it. Its projects get a fresh machine on next use.', { machine: str('Machine name') }, ['machine'],
      async ({ machine }) => { const saved = await checkpointAll(machine); await pool.terminate(need(machine).microvmId); delete state.machines[machine]; router.dropMachine(machine); save(); return { machine, terminated: true, snapshots: saved }; }),
    machine_info: tool('Details for one machine: lifecycle (state, TTL left, idle policy) plus OS, CPU, memory, disk and workspace sizes from inside the VM. Does not wake a suspended VM unless wake is true.',
      { machine: str('Machine name'), wake: { type: 'boolean' } }, ['machine'], async ({ machine, wake }) => {
        const m = need(machine), life = await pool.describe(m.microvmId);
        const info = { machine, size: m.size, memoryMiB: m.memoryMiB, vcpu: m.vcpu, projects: projectOf(machine), ...life };
        if (life.state !== 'RUNNING' && !wake) return info;
        info.inside = await router.run(machine, ['/bin/sh', '-c', 'echo "os: $(. /etc/os-release; echo $PRETTY_NAME) $(uname -m) kernel $(uname -r)"; echo "cpus: $(nproc)"; free -m | awk \'/Mem:/{print "memory_mb: total " $2 ", used " $3}\'; df -h /workspace | awk \'NR==2{print "disk: " $2 " total, " $3 " used, " $4 " free"}\'; echo "uptime: $(cut -d" " -f1 /proc/uptime)s"; du -sh /workspace/* 2>/dev/null | sed "s/^/workspace: /"']);
        return info;
      }),
    list_projects: tool('List projects with their machine, workspace path, last snapshot and thread count.', {}, [], () =>
      Object.entries(state.projects).map(([id, p]) => ({ project: id, ...p, threads: Object.values(state.threads).filter(t => t === id).length }))),
    set_project_machine: tool('Move a project to another machine between turns (snapshot, restore, rebind open sessions).', { project: str('Project id'), machine: str('Machine name') }, ['project', 'machine'],
      async ({ project, machine }) => { need(machine); const p = state.projects[project]; if (!p) throw Error(`Unknown project ${project}`); const r = await router.addProject({ id: project, path: p.path, machine }); p.machine = machine; save(); return r; }),
    set_project_defaults: tool('Set the size, TTL and idle suspend used when a project next needs a machine.', { project: str('Project id'), size: str('Size'), ttl_minutes: num('TTL'), idle_suspend_minutes: num('Idle suspend') }, ['project'],
      ({ project, size, ttl_minutes, idle_suspend_minutes }) => { const p = state.projects[project]; if (!p) throw Error(`Unknown project ${project}`); if (size && !pool.sizes[size]) throw Error(`Unknown size ${size}`); Object.assign(p, size && { size }, ttl_minutes && { ttlMinutes: ttl_minutes }, idle_suspend_minutes && { idleSuspendMinutes: idle_suspend_minutes }); save(); return p; }),
    snapshot_project: tool('Snapshot a project workspace to S3 now.', { project: str('Project id') }, ['project'], async ({ project }) => ({ project, snapshot: await checkpoint(project) })),
    sizes: tool('List available machine sizes.', {}, [], () => pool.sizes),
  };
  function need(machine) { const m = state.machines[machine]; if (!m) throw Error(`Unknown machine ${machine}`); return m; }
  async function checkpointAll(machine) { const out = {}; for (const id of projectOf(machine)) out[id] = await checkpoint(id).catch(e => `failed: ${e.message.slice(0, 120)}`); return out; }

  return { ensureProject, checkpoint, rememberThread, threadEnvironment, tools, state };
}
