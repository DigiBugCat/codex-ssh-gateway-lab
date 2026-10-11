terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws     = { source = "hashicorp/aws", version = "~> 6.0" }
    archive = { source = "hashicorp/archive", version = "~> 2.0" }
    tls     = { source = "hashicorp/tls", version = "~> 4.0" }
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
variable "name" { default = "agents-gateway-lab" }
variable "allowed_ssh_cidr" {
  type        = string
  description = "Only this CIDR may reach the SSH front door."
}
variable "user_public_keys" {
  type        = list(string)
  description = "OpenSSH public keys allowed to log in as the single test user."
}

provider "aws" {
  region              = var.region
  allowed_account_ids = [var.account_id]
  default_tags { tags = { Project = var.name, ManagedBy = "Terraform" } }
}

data "aws_vpc" "default" { default = true }
data "aws_subnets" "default" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
  filter {
    name   = "default-for-az"
    values = ["true"]
  }
}
data "aws_ssm_parameter" "al2023_arm64" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64"
}

# Artifacts and workspace snapshots. Snapshots expire; everything is disposable.
resource "aws_s3_bucket" "lab" {
  bucket_prefix = "${var.name}-"
  force_destroy = true
}
resource "aws_s3_bucket_public_access_block" "lab" {
  bucket                  = aws_s3_bucket.lab.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_lifecycle_configuration" "lab" {
  bucket = aws_s3_bucket.lab.id
  rule {
    id     = "expire-snapshots"
    status = "Enabled"
    filter { prefix = "workspaces/" }
    expiration { days = 7 }
  }
}

data "archive_file" "microvm" {
  type        = "zip"
  source_dir  = "${path.module}/microvm"
  output_path = "${path.module}/.build/microvm.zip"
}
resource "aws_s3_object" "microvm" {
  bucket = aws_s3_bucket.lab.id
  key    = "artifacts/microvm-${data.archive_file.microvm.output_md5}.zip"
  source = data.archive_file.microvm.output_path
  etag   = data.archive_file.microvm.output_md5
}

data "archive_file" "app" {
  type        = "zip"
  output_path = "${path.module}/.build/app.zip"
  dynamic "source" {
    for_each = toset(["ssh-gateway.mjs", "env-router.mjs", "env-mcp.mjs", "microvm-machine.mjs", "rpc.mjs", "presign.py", "gateway-templates.json", "package.json", "package-lock.json", "stress.mjs"])
    content {
      content  = file("${path.module}/../${source.value}")
      filename = source.value
    }
  }
}
resource "aws_s3_object" "app" {
  bucket = aws_s3_bucket.lab.id
  key    = "artifacts/app-${data.archive_file.app.output_md5}.zip"
  source = data.archive_file.app.output_path
  etag   = data.archive_file.app.output_md5
}

# The SSH host key is generated here so its public half can be pinned in
# known_hosts before first connect (the app never prompts to trust a host).
resource "tls_private_key" "host" { algorithm = "ED25519" }
resource "aws_ssm_parameter" "host_key" {
  name  = "/${var.name}/host-key"
  type  = "SecureString"
  value = tls_private_key.host.private_key_openssh
}

# Build role used by Lambda to build the MicroVM image from the S3 artifact.
resource "aws_iam_role" "microvm_build" {
  name = "${var.name}-microvm-build"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "lambda.amazonaws.com" }, Action = ["sts:AssumeRole", "sts:TagSession"],
    Condition = { StringEquals = { "aws:SourceAccount" = var.account_id } }
  }] })
}
resource "aws_iam_role_policy" "microvm_build" {
  role = aws_iam_role.microvm_build.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = "${aws_s3_bucket.lab.arn}/artifacts/*" },
    { Effect = "Allow", Action = ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource = "arn:aws:logs:${var.region}:${var.account_id}:log-group:/aws/lambda-microvms/*" }
  ] })
}

# Control-plane box: gateway, per-user harness and router. Executors hold no AWS
# credentials; this role presigns their snapshot URLs and mints MicroVM tokens.
resource "aws_iam_role" "gateway" {
  name = "${var.name}-gateway"
  assume_role_policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" }, Action = "sts:AssumeRole"
  }] })
}
resource "aws_iam_role_policy_attachment" "gateway_ssm" {
  role       = aws_iam_role.gateway.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_role_policy" "gateway" {
  role = aws_iam_role.gateway.id
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject"], Resource = "${aws_s3_bucket.lab.arn}/workspaces/*" },
    { Effect = "Allow", Action = ["s3:GetObject"], Resource = ["${aws_s3_bucket.lab.arn}/artifacts/*", "${aws_s3_bucket.lab.arn}/config/*"] },
    { Effect = "Allow", Action = ["ssm:GetParameter"], Resource = aws_ssm_parameter.host_key.arn },
    { Effect = "Allow", Action = ["lambda:CreateMicrovmAuthToken", "lambda:GetMicrovm", "lambda:ListMicrovms", "lambda:SuspendMicrovm", "lambda:ResumeMicrovm", "lambda:TerminateMicrovm"], Resource = "*" },
    # The router provisions executors itself, only from this lab's images.
    { Effect = "Allow", Action = ["lambda:RunMicrovm"], Resource = "arn:aws:lambda:${var.region}:${var.account_id}:microvm-image:agents-exec*" },
    # Launching attaches AWS's managed ingress/egress connectors; only those may be passed.
    { Effect = "Allow", Action = ["lambda:PassNetworkConnector"], Resource = "arn:aws:lambda:${var.region}:aws:network-connector:aws-network-connector:*" }
  ] })
}
resource "aws_iam_instance_profile" "gateway" {
  name = "${var.name}-gateway"
  role = aws_iam_role.gateway.name
}

resource "aws_security_group" "gateway" {
  name        = "${var.name}-gateway"
  description = "SSH front door, restricted to one CIDR"
  vpc_id      = data.aws_vpc.default.id
  ingress {
    description = "Codex app SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = [var.allowed_ssh_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_instance" "gateway" {
  ami                    = data.aws_ssm_parameter.al2023_arm64.value
  instance_type          = "t4g.small" # free-plan accounts allow only free-tier types
  subnet_id              = data.aws_subnets.default.ids[0]
  vpc_security_group_ids = [aws_security_group.gateway.id]
  iam_instance_profile   = aws_iam_instance_profile.gateway.name
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }
  user_data_replace_on_change = true
  user_data = templatefile("${path.module}/user-data.sh.tftpl", {
    region      = var.region
    bucket      = aws_s3_bucket.lab.id
    app_key     = aws_s3_object.app.key
    host_param  = aws_ssm_parameter.host_key.name
    public_keys = jsonencode(var.user_public_keys)
  })
  tags = { Name = "${var.name}-gateway" }
}
resource "aws_eip" "gateway" {
  instance = aws_instance.gateway.id
  domain   = "vpc"
}

output "gateway_ip" { value = aws_eip.gateway.public_ip }
output "host_public_key" { value = tls_private_key.host.public_key_openssh }
output "bucket" { value = aws_s3_bucket.lab.id }
output "instance_id" { value = aws_instance.gateway.id }
output "microvm_build_role_arn" { value = aws_iam_role.microvm_build.arn }
output "microvm_artifact_uri" { value = "s3://${aws_s3_bucket.lab.id}/${aws_s3_object.microvm.key}" }
output "region" { value = var.region }
