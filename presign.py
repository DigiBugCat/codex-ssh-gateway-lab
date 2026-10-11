"""Print a presigned S3 URL for one workspace snapshot object (10 minutes).

Signs against the regional endpoint: on the global endpoint a new bucket
answers with 307 redirects, which an upload would silently not follow.
"""
import os
import sys
import boto3
from botocore.config import Config

bucket, key, method = sys.argv[1:4]
if method not in ('get', 'put') or not key.startswith('workspaces/'):
    raise SystemExit('usage: presign.py BUCKET workspaces/KEY get|put')
region = os.environ.get('AWS_DEFAULT_REGION', 'us-east-2')
s3 = boto3.client('s3', region_name=region, endpoint_url=f'https://s3.{region}.amazonaws.com',
                  config=Config(signature_version='s3v4', s3={'addressing_style': 'virtual'}))
print(s3.generate_presigned_url(f'{method}_object', Params={'Bucket': bucket, 'Key': key}, ExpiresIn=600))
