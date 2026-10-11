"""Persist a real model checkpoint, then rehydrate a fresh local Codex harness."""
import json
import subprocess
import time
import uuid
from pathlib import Path
import boto3

outputs=json.loads(subprocess.check_output(['terraform','-chdir=aws','output','-json']))
s=boto3.Session(profile_name='durable-agent-lab',region_name=outputs['region']['value'])
table=s.resource('dynamodb').Table(outputs['table_name']['value']);queue=s.client('sqs')
agent='real-codex-'+uuid.uuid4().hex[:12]

def commit(operation, checkpoint):
    event={'agentId':agent,'operationId':operation,'text':json.dumps(checkpoint)}
    queue.send_message(QueueUrl=outputs['queue_url']['value'],MessageBody=json.dumps(event),MessageGroupId=agent,MessageDeduplicationId=uuid.uuid4().hex)
    for _ in range(100):
        item=table.get_item(Key={'pk':'AGENT#'+agent,'sk':'OP#'+operation},ConsistentRead=True).get('Item')
        if item: return json.loads(item['result'])
        time.sleep(.5)
    raise RuntimeError('Cloud checkpoint did not commit')

initial=json.loads(Path('model-results.json').read_text())
assert initial['checks']==['real model completed','file side effect verified','process/start crossed SSH adapter']
saved=commit('checkpoint-one',{'lastReply':initial['reply'],'model':initial['model'],'step':1})
assert saved['revision']==1
# The next process consumes only the state read back from DynamoDB.
checkpoint=Path('.lab/cloud-checkpoint.json')
checkpoint.write_text(saved['text'])
subprocess.run(['node','model-probe.mjs','--resume',str(checkpoint)],check=True,timeout=200)
resumed=json.loads(Path('model-recovery-results.json').read_text())
assert resumed['reply']==initial['reply']+'-resumed'
final=commit('checkpoint-two',{'lastReply':resumed['reply'],'model':resumed['model'],'step':2})
assert final['revision']==2
result={'result':'PASS','agentId':agent,'initialReply':initial['reply'],'resumedReply':resumed['reply'],'cloudRevision':final['revision'],'model':resumed['model'],'scope':'Both real model turns and SSH executors ran on the Mac. Checkpoints and commit workers ran on AWS. This reconstructs an ephemeral harness from explicit application state; it is not native Codex thread/resume or in-flight model continuation.'}
Path('aws/model-recovery-results.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result,indent=2))
