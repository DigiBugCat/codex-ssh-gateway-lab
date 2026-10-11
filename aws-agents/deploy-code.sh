#!/bin/bash
# Hot-deploys gateway code to the running instance via S3 + SSM (no instance
# replacement). Usage: python3 aws/run.py bash aws-agents/deploy-code.sh
set -euo pipefail
cd "$(dirname "$0")/.."
B=$(python3 -c "import json;print(json.load(open('.lab/aws-agents-outputs.json'))['bucket']['value'])")
I=$(python3 -c "import json;print(json.load(open('.lab/aws-agents-outputs.json'))['instance_id']['value'])")
FILES="ssh-gateway.mjs env-router.mjs env-mcp.mjs microvm-machine.mjs machine-pool.mjs control-plane.mjs rpc.mjs presign.py gateway-templates.json"
for f in $FILES; do aws s3 cp "$f" "s3://$B/config/app/$f" --only-show-errors; done
CMDS=$(python3 -c "
import json,sys; b,files=sys.argv[1],sys.argv[2].split()
c=[f'/usr/local/bin/aws s3 cp s3://{b}/config/app/{f} /opt/agents/app/{f} --only-show-errors' for f in files]
c+=['chown -R agents:agents /opt/agents/app','systemctl restart agents-gateway','sleep 3','systemctl is-active agents-gateway']
print(json.dumps({'commands':c}))" "$B" "$FILES")
CID=$(aws ssm send-command --instance-ids "$I" --document-name AWS-RunShellScript --parameters "$CMDS" --query Command.CommandId --output text)
sleep 8
aws ssm get-command-invocation --command-id "$CID" --instance-id "$I" --query '[Status,StandardOutputContent,StandardErrorContent]' --output text
