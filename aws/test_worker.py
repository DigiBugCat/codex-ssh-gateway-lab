import json
import unittest
from unittest.mock import patch
import boto3
from moto import mock_aws
from worker import apply_event

@mock_aws
class WorkerTest(unittest.TestCase):
    def setUp(self):
        self.table = boto3.resource('dynamodb', region_name='us-east-2').create_table(
            TableName='lab', KeySchema=[{'AttributeName':'pk','KeyType':'HASH'}, {'AttributeName':'sk','KeyType':'RANGE'}],
            AttributeDefinitions=[{'AttributeName':'pk','AttributeType':'S'}, {'AttributeName':'sk','AttributeType':'S'}], BillingMode='PAY_PER_REQUEST')
        self.op = {'agentId':'a','operationId':'one','text':'saved'}
    def test_replay_after_lost_response(self):
        expected = apply_event(self.table, self.op)
        self.assertEqual(apply_event(self.table, self.op), expected)
        self.assertEqual(self.table.scan()['Count'], 3)
    def test_identity_and_order(self):
        apply_event(self.table, self.op)
        self.assertEqual(apply_event(self.table, {**self.op,'operationId':'two'})['revision'],2)
        self.assertEqual(apply_event(self.table, {**self.op,'agentId':'b'})['revision'],1)
    def test_conflicting_payload(self):
        apply_event(self.table, self.op)
        with self.assertRaisesRegex(ValueError, 'conflict'):
            apply_event(self.table, {**self.op,'text':'different'})
        self.assertEqual(self.table.scan()['Count'],3)
    def test_input_boundary(self):
        with self.assertRaises(ValueError): apply_event(self.table,{**self.op,'text':'x'*4097})
        with self.assertRaises(ValueError): apply_event(self.table,{**self.op,'agentId':'../a'})
        self.assertEqual(self.table.scan()['Count'],0)
    def test_transaction_failure_does_not_partially_commit(self):
        from botocore.exceptions import ClientError
        error = ClientError({'Error':{'Code':'AccessDeniedException','Message':'test'}},'TransactWriteItems')
        with patch.object(self.table.meta.client,'transact_write_items',side_effect=error):
            with self.assertRaises(ClientError): apply_event(self.table,self.op)
        self.assertEqual(self.table.scan()['Count'],0)

if __name__=='__main__': unittest.main()
