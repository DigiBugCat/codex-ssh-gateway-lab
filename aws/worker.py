"""Deterministic durable events; no model calls or external side effects."""
import hashlib
import json
import os
import re
import time
import uuid

RUNTIME_INSTANCE_ID = uuid.uuid4().hex
import boto3
from botocore.exceptions import ClientError


def validate(value):
    if not isinstance(value, dict) or set(value) != {"agentId", "operationId", "text"}:
        raise ValueError("Expected exactly agentId, operationId and text")
    for key in ("agentId", "operationId"):
        if not isinstance(value[key], str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,100}", value[key]):
            raise ValueError("Invalid identity")
    if not isinstance(value["text"], str) or len(value["text"].encode()) > 4096:
        raise ValueError("Text exceeds 4096 bytes")
    return value


def apply_event(table, value):
    value = validate(value)
    pk = "AGENT#" + value["agentId"]
    op_key = {"pk": pk, "sk": "OP#" + value["operationId"]}
    payload_hash = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    for attempt in range(6):
        old = table.get_item(Key=op_key, ConsistentRead=True).get("Item")
        if old:
            if old["payloadHash"] != payload_hash:
                raise ValueError("Operation ID conflict")
            return json.loads(old["result"])
        meta = table.get_item(Key={"pk": pk, "sk": "META"}, ConsistentRead=True).get("Item", {})
        revision = int(meta.get("revision", 0))
        result = {**value, "revision": revision + 1}
        # Resource client uses the document serializer for transaction values.
        try:
            table.meta.client.transact_write_items(TransactItems=[
                {"Update": {"TableName": table.name, "Key": {"pk": pk, "sk": "META"},
                    "UpdateExpression": "SET revision = :next",
                    "ConditionExpression": "attribute_not_exists(revision)" if revision == 0 else "revision = :previous",
                    "ExpressionAttributeValues": {":next": revision + 1, **({":previous": revision} if revision else {})}}},
                {"Put": {"TableName": table.name,
                    "Item": {**op_key, "payloadHash": payload_hash, "result": json.dumps(result)},
                    "ConditionExpression": "attribute_not_exists(pk)"}},
                {"Put": {"TableName": table.name,
                    "Item": {"pk": pk, "sk": f"EVENT#{revision + 1:020d}", "text": value["text"], "operationId": value["operationId"]},
                    "ConditionExpression": "attribute_not_exists(pk)"}},
            ])
            return result
        except ClientError as error:
            if error.response["Error"]["Code"] != "TransactionCanceledException":
                raise
            if attempt == 5:
                raise
            time.sleep(0.01 * (2 ** attempt))


def handler(event, context):
    table = boto3.resource("dynamodb").Table(os.environ["TABLE_NAME"])
    # FIFO mapping uses batch_size=1. Raising retries the item; permanent
    # failures move to the configured dead-letter queue after three receives.
    for record in event["Records"]:
        apply_event(table, json.loads(record["body"]))
    return {"ok": True, "runtimeInstanceId": RUNTIME_INSTANCE_ID}
