# AWS durable agent prototype

Deployed to **Side Quest Accepted**, account `520891536882`, Ohio (`us-east-2`). Infrastructure name: `durable-agent-lab`.

```
local client / SSH adapter / Codex harness
  -> IAM-authenticated SQS FIFO queue
  -> short-lived Lambda worker
  -> DynamoDB transaction: identity + event + operation result
```

No public endpoint, VM, NAT gateway, provisioned concurrency, or model credentials are deployed. The two-worker limit bounds simultaneous work. When idle, the Lambda workers incur no execution-duration charges; queue polling and stored data can still have small costs.

Pending queue messages and failed messages are retained for **14 days**. Completed state has no TTL and is protected against Terraform deletion. This is a prototype of durable deterministic events, not a complete cloud-hosted Codex harness. Arbitrary shell/API side effects and in-flight model streams are not replay-safe merely because a queue is durable.

## Use

Run from the project root. AWS CLI 2.37.5 is installed. A temporary-login profile `durable-agent-lab` was configured through the existing console session; no long-lived access keys were created. Renew it with:

```sh
python3 aws/run.py aws login --profile durable-agent-lab --region us-east-2
```

The wrapper strips inherited AWS variables that belong to Cloudflare R2. Use it for this project's AWS commands:

```sh
python3 aws/run.py .lab/aws-venv/bin/python aws/client.py submit --agent example --operation one --text 'remember this'
python3 aws/run.py .lab/aws-venv/bin/python aws/client.py status --agent example --operation one
python3 aws/run.py .lab/aws-venv/bin/python aws/client.py read --agent example
```

A `queued` reply proves durable transport acceptance, not completed execution. Read the operation result to verify completion. Reusing an operation ID with the same payload produces one committed event. A conflicting payload fails and ultimately reaches the dead-letter queue. `read` returns up to 100 events and a pagination key; it is a small diagnostic client, not a full history UI.

To recreate local Python dependencies: `python3 -m venv .lab/aws-venv`, then `.lab/aws-venv/bin/pip install -r aws/requirements-dev.txt`.

## Infrastructure and tests

`main.tf` owns the eight resources. Local Terraform state is ignored by Git and must be retained to manage them. `deployment.auto.tfvars` contains the selected account and region. The provider refuses to operate in another account.

```sh
python3 aws/run.py terraform -chdir=aws plan
python3 aws/run.py .lab/aws-venv/bin/python aws/verify_live.py
python3 aws/run.py .lab/aws-venv/bin/python aws/verify_model_recovery.py
```

The live test writes synthetic history, forces duplicate delivery through a FIFO barrier, and changes then restores the Lambda description to recycle the runtime. It verifies a changed runtime identity and preserved state. See `live-results.json` for actual results. The model test requires `model-results.json` from `node model-probe.mjs`; it stores that checkpoint in AWS and rehydrates a fresh local model/executor. See `model-recovery-results.json` for its actual result. Model authentication remains on this Mac.

Verified results on October 9, 2026 (Pacific): duplicate delivery committed one event, state survived a fresh Lambda runtime, and a fresh local `gpt-5.6-sol` harness recovered the cloud checkpoint, produced `durable-real-model-probe-resumed` through its SSH executor, and committed cloud revision 2. This is explicit application-state recovery, not native Codex thread resume or continuation of an interrupted model stream. One direct invocation measured 380 ms warm and 1.57 s after runtime recycling; these are individual round-trip samples, not latency percentiles. Queue submission to committed state measured 2.13 s.

Pause queue consumption while preserving stored state:

```sh
python3 aws/run.py terraform -chdir=aws apply -var='enabled=false'
```

Resume with `-var='enabled=true'`. Pausing does not extend the 14-day pending-message retention. Do not blindly run `terraform destroy`: state deletion is deliberately blocked. No recurring monitoring or notification automation was installed.

## Cost assumptions

For 10,000 short deterministic events/month, each using around one second at 256 MB, the rough infrastructure estimate is **under $1/month**, excluding inference and unusually heavy polling/logging. This is an estimate, not a spending cap. The console showed $200 credit and a free-plan end date of April 8, 2027; eligibility and remaining balance must be checked in AWS Billing.

Estimate basis: Lambda ARM duration around $0.0000133334/GB-second plus $0.20/million requests; DynamoDB around $0.625/million write units and $0.125/million read units, with transactional writes consuming extra units; SQS FIFO requests, retained storage and logs add small usage-based amounts. Free-tier allowances were not needed for the estimate. Refer to current regional pricing: [Lambda](https://aws.amazon.com/lambda/pricing/), [DynamoDB](https://aws.amazon.com/dynamodb/pricing/), [SQS](https://aws.amazon.com/sqs/pricing/).
