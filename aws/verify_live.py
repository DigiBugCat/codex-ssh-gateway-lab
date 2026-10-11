"""Live synthetic checks; leaves a small, named test history in DynamoDB."""
import json
import time
import uuid
import base64
import subprocess
from pathlib import Path
import boto3
from boto3.dynamodb.conditions import Key

outputs=json.loads(subprocess.check_output(['terraform','-chdir=aws','output','-json']))
s=boto3.Session(profile_name='durable-agent-lab',region_name=outputs['region']['value'])
lam=s.client('lambda'); sqs=s.client('sqs'); table=s.resource('dynamodb').Table(outputs['table_name']['value'])
queue=outputs['queue_url']['value']; function=outputs['function_name']['value']
agent='verify-'+uuid.uuid4().hex[:12]
checks=[]
def put(operation,text):
    value={'agentId':agent,'operationId':operation,'text':text}
    sqs.send_message(QueueUrl=queue,MessageBody=json.dumps(value),MessageGroupId=agent,MessageDeduplicationId=uuid.uuid4().hex)
    return value

def completed(operation):
    row=table.get_item(Key={'pk':'AGENT#'+agent,'sk':'OP#'+operation},ConsistentRead=True).get('Item')
    return json.loads(row['result']) if row else None

def wait_operation(operation):
    deadline=time.monotonic()+50
    while time.monotonic()<deadline:
        result=completed(operation)
        if result: return result
        time.sleep(.5)
    raise RuntimeError('Completion timeout: '+operation)

def pass_check(name):
    checks.append(name);print('PASS',name,flush=True)

begin=time.monotonic();first=put('one','saved through the AWS queue');result=wait_operation('one')
queue_seconds=time.monotonic()-begin
assert result['revision']==1
pass_check('FIFO queue -> real Lambda -> durable DynamoDB transaction')
put('one','saved through the AWS queue');put('barrier','after duplicate')
assert wait_operation('barrier')['revision']==2
assert completed('one')==result
pass_check('Forced duplicate delivery followed by FIFO barrier produces no duplicate event')

# Direct invocations measure the function separately from queue polling.
def invoke(operation):
    event={'Records':[{'body':json.dumps({'agentId':agent,'operationId':operation,'text':operation})}]}
    started=time.monotonic()
    response=lam.invoke(FunctionName=function,LogType='Tail',Payload=json.dumps(event).encode())
    payload=json.loads(response['Payload'].read())
    assert not response.get('FunctionError'),payload
    return {'response':payload,'elapsedMs':round((time.monotonic()-started)*1000,2),'logs':base64.b64decode(response['LogResult']).decode()}

before=invoke('before-recycle')
original=lam.get_function_configuration(FunctionName=function).get('Description','')
try:
    lam.update_function_configuration(FunctionName=function,Description='temporary runtime recycle probe '+agent)
    lam.get_waiter('function_updated_v2').wait(FunctionName=function,WaiterConfig={'Delay':2,'MaxAttempts':30})
    after=invoke('after-recycle')
    assert before['response']['runtimeInstanceId']!=after['response']['runtimeInstanceId']
    assert completed('one')==result
    pass_check('Fresh Lambda runtime preserves prior committed identity and state')
finally:
    lam.update_function_configuration(FunctionName=function,Description=original)
    lam.get_waiter('function_updated_v2').wait(FunctionName=function,WaiterConfig={'Delay':2,'MaxAttempts':30})

rows=table.query(KeyConditionExpression=Key('pk').eq('AGENT#'+agent)&Key('sk').begins_with('EVENT#'),ConsistentRead=True)['Items']
assert len(rows)==4
report={'agentId':agent,'checks':checks,'queueToCommitSeconds':round(queue_seconds,3),'beforeRecycle':before,'afterRecycle':after,'events':rows,'scope':'Synthetic deterministic events. No model call or arbitrary shell execution.'}
Path('aws/live-results.json').write_text(json.dumps(report,indent=2,default=str)+'\n')
print(json.dumps({k:v for k,v in report.items() if k not in ('events','beforeRecycle','afterRecycle')},indent=2))
