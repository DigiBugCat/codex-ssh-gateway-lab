// Opt-in live model experiment: separate ephemeral app-server + SSH executor.
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { symlinkSync, writeFileSync, readFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startLab } from './boundary-lab.mjs';
import { Rpc } from './rpc.mjs';
const recovered = process.argv[2] === '--resume' ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : null;
const expected = recovered ? recovered.lastReply + '-resumed' : process.argv[2] || 'durable-real-model-probe';
if (!/^[a-z0-9_-]{1,120}$/.test(expected)) throw Error('Invalid probe marker');
const lab = await startLab();
const appHome = resolve(lab.root, 'app-home');
mkdirSync(appHome);
symlinkSync(resolve(homedir(), '.codex/auth.json'), resolve(appHome, 'auth.json'));
// Use the existing login via the normal Codex credential reader. No secret is
// copied. This uses the same trusted host; it is not credential isolation.
const events = [];
let timer;
try {
  const app = lab.launch('codex', ['app-server'], { CODEX_HOME: appHome });
  const rpc = new Rpc(line => app.stdin.write(line+'\n'));
  let finish;
  const completed = new Promise((resolve, reject) => {
    finish = resolve;
    timer = setTimeout(() => reject(Error('Model turn timed out')), 180000);
  });
  createInterface({ input: app.stdout }).on('line', line => {
    const value = JSON.parse(line);
    rpc.receive(line);
    if (value.method) events.push(value);
    if (value.method === 'turn/completed') finish(value.params);
    if (value.method === 'error') console.error('MODEL ERROR',JSON.stringify(value.params));
  });
  await rpc.call('initialize', { clientInfo: { name:'durable-model-probe',version:'0.1' },capabilities:{experimentalApi:true} });
  rpc.notify('initialized');
  await rpc.call('environment/add', {environmentId:'leased-executor',execServerUrl:lab.url});
  const info=await rpc.call('environment/info',{environmentId:'leased-executor'});
  const thread=await rpc.call('thread/start', {
    ephemeral:true, cwd:lab.root+'/workspace', approvalPolicy:'never', sandbox:'workspace-write',
    environments:[{environmentId:'leased-executor',cwd:fileURLToPath(info.cwd)}],
    baseInstructions:'You are a bounded integration-test agent. Use the provided execution tools to perform only the user-requested operation in the assigned workspace. Do not access any unrelated files, credentials or network services. Do not spawn agents.',
  });
  console.log('Model:',thread.model);
  await rpc.call('turn/start', {threadId:thread.thread.id, input:[{type:'text',text: recovered ? `Your previous harness and execution environment have stopped. This checkpoint was recovered from AWS durable storage: ${JSON.stringify(recovered)}. In this fresh workspace, reconstruct checkpoint.txt using the checkpoint's lastReply followed by -resumed, with no newline. Read it back using a tool. Reply only with the new contents.` : `This is a real execution test. In the assigned workspace create exactly one file named checkpoint.txt containing exactly ${expected}, with no newline. Read it back using a tool, then reply only with its contents.`,text_elements:[]} ]});
  const outcome=await completed;
  assert.equal(outcome.turn.status,'completed',JSON.stringify(outcome));
  assert.equal(readFileSync(lab.root+'/workspace/checkpoint.txt','utf8'),expected);
  assert.ok(lab.trace.some(e=>e.direction==='request' && e.method==='process/start'),'No remote process/start observed');
  const reply=events.filter(e=>e.method==='item/completed'&&e.params.item.type==='agentMessage').map(e=>e.params.item.text).join('\n');
  assert.ok(reply.includes(expected));
  const report={model:thread.model,runtimeWorkspace:lab.root,expected,reply,checks:['real model completed','file side effect verified','process/start crossed SSH adapter'],trace:lab.trace};
  writeFileSync(recovered ? 'model-recovery-results.json' : 'model-results.json',JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({model:report.model,reply:report.reply,checks:report.checks}));
} finally {clearTimeout(timer);assert.equal(await lab.close(),0);unlinkSync(resolve(appHome, 'auth.json'));}
