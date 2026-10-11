"""Run an AWS/Terraform command without inheriting unrelated R2 credentials."""
import os
import subprocess
import sys
if len(sys.argv) < 2:
    raise SystemExit('Usage: python aws/run.py COMMAND [ARGS...]')
env={k:v for k,v in os.environ.items() if not k.startswith('AWS_')}
env.update(AWS_PROFILE='durable-agent-lab', AWS_REGION='us-east-2', AWS_DEFAULT_REGION='us-east-2', AWS_PAGER='')
raise SystemExit(subprocess.call(sys.argv[1:],env=env))
