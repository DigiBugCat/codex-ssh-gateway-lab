// Writes the gateway config for the MicroVMs in microvms.json, uploads it and
// restarts the gateway via SSM. Usage (with AWS env): node aws-agents/push-config.mjs [microvms.json | --pool]
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const out = JSON.parse(readFileSync('.lab/aws-agents-outputs.json', 'utf8'));
const bucket = out.bucket.value, instance = out.instance_id.value;
const vms = process.argv[2] && !process.argv[2].startsWith('--') ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : [];
const keys = [readFileSync(`${process.env.HOME}/.ssh/id_ed25519.pub`, 'utf8').trim(), readFileSync('.lab/keys/stress_ed25519.pub', 'utf8').trim()];
const config = {
  host: '0.0.0.0', port: 22, region: 'us-east-2', hostKey: 'host_key', templates: '/opt/agents/app/gateway-templates.json',
  codexVersion: '0.147.0', auditLog: 'audit.jsonl',
  users: { andrew: { admin: true, publicKeys: keys } }, harness: { root: 'harness', portBase: 8800 },
  snapshots: { bucket, presignScript: '/opt/agents/app/presign.py' },
};
// --pool: one MicroVM per project, provisioned on demand; otherwise the static A/B pair.
if (process.argv.includes('--pool')) {
  const image = name => `arn:aws:lambda:us-east-2:520891536882:microvm-image:${name}`;
  config.pool = { statePath: 'control-state.json', defaults: { size: 'small', ttlMinutes: 480, idleSuspendMinutes: 30 },
    sizes: { small: { image: image('agents-exec'), memoryMiB: 2048, vcpu: 1 }, medium: { image: image('agents-exec-medium'), memoryMiB: 4096, vcpu: 2 } } };
} else {
  config.router = {
    machines: Object.fromEntries(vms.map((vm, i) => ['AB'[i], { kind: 'microvm', microvmId: vm.microvmId, endpoint: vm.endpoint, port: 8080 }])),
    workspaces: { proj: { path: '/workspace/proj', machine: 'A' } }, environments: { proj: { workspace: 'proj', machine: 'A' } },
  };
  config.users.andrew.environments = ['proj'];
}
writeFileSync('.lab/aws-results/gateway-microvm.json', JSON.stringify(config, null, 2));
const aws = (...a) => execFileSync('aws', a, { encoding: 'utf8' }).trim();
aws('s3', 'cp', '.lab/aws-results/gateway-microvm.json', `s3://${bucket}/config/gateway.json`, '--only-show-errors');
const cid = aws('ssm', 'send-command', '--instance-ids', instance, '--document-name', 'AWS-RunShellScript', '--query', 'Command.CommandId', '--output', 'text',
  '--parameters', JSON.stringify({ commands: [`/usr/local/bin/aws s3 cp s3://${bucket}/config/gateway.json /opt/agents/state/gateway.json --only-show-errors`,
    'chown agents:agents /opt/agents/state/gateway.json', 'systemctl restart agents-gateway', 'sleep 3', 'systemctl is-active agents-gateway'] }));
await new Promise(r => setTimeout(r, 9000));
console.log(aws('ssm', 'get-command-invocation', '--command-id', cid, '--instance-id', instance, '--query', '[Status,StandardOutputContent]', '--output', 'text'));
