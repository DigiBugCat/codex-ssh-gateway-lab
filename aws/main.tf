terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
  }
}
variable "account_id" {
  type = string
  validation {
    condition     = can(regex("^[0-9]{12}$", var.account_id))
    error_message = "Supply the intended 12-digit AWS account ID."
  }
}
variable "region" { default = "us-east-2" }
variable "name" { default = "durable-agent-lab" }
variable "enabled" {
  type    = bool
  default = true
}
provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags { tags = { Project = var.name, ManagedBy = "Terraform" } }
}
resource "aws_dynamodb_table" "state" {
  name         = var.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"
  attribute {
    name = "pk"
    type = "S"
  }
  attribute {
    name = "sk"
    type = "S"
  }
  on_demand_throughput {
    max_read_request_units  = 10
    max_write_request_units = 10
  }
  lifecycle { prevent_destroy = true }
}
resource "aws_sqs_queue" "dead" {
  name                      = "${var.name}-dead.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_sqs_queue" "work" {
  name                       = "${var.name}.fifo"
  fifo_queue                 = true
  visibility_timeout_seconds = 60
  message_retention_seconds  = 1209600
  sqs_managed_sse_enabled    = true
  redrive_policy             = jsonencode({ deadLetterTargetArn = aws_sqs_queue.dead.arn, maxReceiveCount = 3 })
}
resource "aws_iam_role" "worker" {
  name               = "${var.name}-worker"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{ Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = "sts:AssumeRole" }] })
}
resource "aws_cloudwatch_log_group" "worker" {
  name              = "/aws/lambda/${var.name}"
  retention_in_days = 7
}
resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.worker.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"], Resource = aws_dynamodb_table.state.arn },
    { Effect = "Allow", Action = ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"], Resource = aws_sqs_queue.work.arn },
    { Effect = "Allow", Action = ["logs:CreateLogStream", "logs:PutLogEvents"], Resource = "${aws_cloudwatch_log_group.worker.arn}:*" }
  ] })
}
data "archive_file" "worker" {
  type        = "zip"
  source_file = "${path.module}/worker.py"
  output_path = "${path.module}/worker.zip"
}
resource "aws_lambda_function" "worker" {
  function_name                  = var.name
  role                           = aws_iam_role.worker.arn
  filename                       = data.archive_file.worker.output_path
  source_code_hash               = data.archive_file.worker.output_base64sha256
  handler                        = "worker.handler"
  description                    = "Durable agent state prototype"
  runtime                        = "python3.12"
  architectures                  = ["arm64"]
  memory_size                    = 256
  timeout                        = 10
  reserved_concurrent_executions = 2
  environment { variables = { TABLE_NAME = aws_dynamodb_table.state.name } }
  depends_on = [aws_iam_role_policy.worker]
}
resource "aws_lambda_event_source_mapping" "work" {
  enabled          = var.enabled
  event_source_arn = aws_sqs_queue.work.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 1
  scaling_config { maximum_concurrency = 2 }
}
output "queue_url" { value = aws_sqs_queue.work.url }
output "dead_letter_queue_url" { value = aws_sqs_queue.dead.url }
output "table_name" { value = aws_dynamodb_table.state.name }
output "function_name" { value = aws_lambda_function.worker.function_name }
output "region" { value = var.region }
