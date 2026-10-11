"""Authenticated CLI for the experiment; uses a named AWS login profile."""
import argparse
import hashlib
import json
import subprocess
import time
import uuid
import boto3
from boto3.dynamodb.conditions import Key
from worker import validate

p = argparse.ArgumentParser()
p.add_argument('action', choices=['submit','read','status','smoke'])
p.add_argument('--profile', default='durable-agent-lab')
p.add_argument('--region', default='us-east-2')
p.add_argument('--agent', default='cloud-probe')
p.add_argument('--operation', default=None)
p.add_argument('--text', default='hello from the durable AWS worker')
a = p.parse_args()
outputs = json.loads(subprocess.check_output(['terraform','-chdir=aws','output','-json']))
session = boto3.Session(profile_name=a.profile, region_name=a.region)
queue = session.client('sqs')
table = session.resource('dynamodb').Table(outputs['table_name']['value'])
op_id = a.operation or str(uuid.uuid4())
value = validate({'agentId':a.agent,'operationId':op_id,'text':a.text})
def status():
    item = table.get_item(Key={'pk':'AGENT#'+a.agent,'sk':'OP#'+op_id},ConsistentRead=True).get('Item')
    return json.loads(item['result']) if item else None

def submit():
    body = json.dumps(value,sort_keys=True)
    queue.send_message(QueueUrl=outputs['queue_url']['value'],MessageBody=body,MessageGroupId=a.agent,MessageDeduplicationId=hashlib.sha256(body.encode()).hexdigest())
    return {'state':'queued','agentId':a.agent,'operationId':op_id}

if a.action=='submit': print(json.dumps(submit()))
elif a.action=='status':
    if not a.operation: p.error('--operation is required for status')
    print(json.dumps(status() or {'state':'pending-or-not-found'}))
elif a.action=='read':
    rows=table.query(KeyConditionExpression=Key('pk').eq('AGENT#'+a.agent)&Key('sk').begins_with('EVENT#'),ConsistentRead=True,Limit=100)
    print(json.dumps({'events':rows['Items'],'nextKey':rows.get('LastEvaluatedKey')},default=str))
else:
    begin=time.monotonic(); submit()
    for _ in range(60):
        result=status()
        if result: break
        time.sleep(.5)
    else: raise RuntimeError('No completion after 30 seconds; inspect queue and worker logs')
    assert result['text']==a.text
    # Use a distinct transport deduplication key to force a second delivery.
    queue.send_message(QueueUrl=outputs['queue_url']['value'],MessageBody=json.dumps(value,sort_keys=True),MessageGroupId=a.agent,MessageDeduplicationId=str(uuid.uuid4()))
    print(json.dumps({'result':result,'observedCompletionSeconds':round(time.monotonic()-begin,3),'duplicateEnqueued':True,'note':'Duplicate delivery requires later state/queue verification.'}))
