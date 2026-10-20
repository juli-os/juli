# juli on AWS ECS Fargate — single instance (SQLite), EFS state, ALB+ACM TLS.
# Manifests-ready status: shapes follow current ECS/EFS/ALB practice but have
# not been applied on a live account yet (see ../README.md).

variable "region" {
  type    = string
  default = "us-east-1"
}
variable "cert_arn" {
  type        = string
  description = "ACM certificate ARN for HTTPS"
}
variable "juli_password" {
  type      = string
  sensitive = true
}
variable "hostname" {
  type        = string
  description = "DNS name you will point at the ALB"
}
variable "image" {
  type    = string
  default = "ghcr.io/juli-os/juli:latest"
}

provider "aws" { region = var.region }

data "aws_vpc" "default" { default = true }
data "aws_subnets" "public" {
  filter {
    name   = "vpc-id"
    values = [data.aws_vpc.default.id]
  }
}

resource "aws_security_group" "alb" {
  name_prefix = "juli-alb-"
  vpc_id      = data.aws_vpc.default.id
  ingress {
    description = "HTTPS from anywhere"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTP for the 80->443 redirect listener"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "task" {
  name_prefix = "juli-task-"
  vpc_id      = data.aws_vpc.default.id
  ingress {
    description     = "app port from the ALB only"
    from_port       = 7070
    to_port         = 7070
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  ingress {
    # EFS mount targets share this SG; NFS from the task (same SG) needs an
    # explicit self-reference — same-SG traffic is not implicitly allowed.
    description     = "NFS from the task itself for the EFS volume"
    from_port       = 2049
    to_port         = 2049
    protocol        = "tcp"
    security_groups = [aws_security_group.task.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_efs_file_system" "data" { tags = { Name = "juli-data" } }
resource "aws_efs_mount_target" "data" {
  count           = length(data.aws_subnets.public.ids)
  file_system_id  = aws_efs_file_system.data.id
  subnet_id       = data.aws_subnets.public.ids[count.index]
  security_groups = [aws_security_group.task.id]
}

resource "aws_secretsmanager_secret" "password" { name = "juli/password" }
resource "aws_secretsmanager_secret_version" "password" {
  secret_id     = aws_secretsmanager_secret.password.id
  secret_string = var.juli_password
}

resource "aws_iam_role" "execution" {
  name_prefix = "juli-exec-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ecs-tasks.amazonaws.com" } }]
  })
}
resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "exec_pull_secret" {
  name = "pull-image-and-secret"
  role = aws_iam_role.execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      { Effect = "Allow", Action = ["secretsmanager:GetSecretValue"], Resource = [aws_secretsmanager_secret.password.arn] },
    ]
  })
}

resource "aws_ecs_cluster" "juli" { name = "juli" }

resource "aws_ecs_task_definition" "juli" {
  family                   = "juli"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution.arn
  container_definitions = jsonencode([{
    name         = "juli"
    image        = var.image
    portMappings = [{ containerPort = 7070, protocol = "tcp" }]
    environment = [
      { name = "JULI_DATA_DIR", value = "/data" },
      { name = "JULI_LISTEN_HOST", value = "0.0.0.0" },
      { name = "LANG", value = "C.UTF-8" },
    ]
    secrets     = [{ name = "JULI_PASSWORD", valueFrom = aws_secretsmanager_secret.password.arn }]
    mountPoints = [{ sourceVolume = "data", containerPath = "/data" }]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:7070/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 15
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.juli.name
        awslogs-region        = var.region
        awslogs-stream-prefix = "juli"
      }
    }
  }])
  volume {
    name = "data"
    efs_volume_configuration { file_system_id = aws_efs_file_system.data.id }
  }
}

resource "aws_cloudwatch_log_group" "juli" {
  name              = "/ecs/juli"
  retention_in_days = 14
}

resource "aws_lb" "juli" {
  name               = "juli"
  load_balancer_type = "application"
  subnets            = data.aws_subnets.public.ids
  security_groups    = [aws_security_group.alb.id]
}
resource "aws_lb_target_group" "juli" {
  name_prefix = "juli-"
  port        = 7070
  protocol    = "HTTP"
  vpc_id      = data.aws_vpc.default.id
  target_type = "ip"
  health_check {
    path    = "/healthz"
    matcher = "200"
  }
}
resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.juli.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.cert_arn
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.juli.arn
  }
}
resource "aws_lb_listener" "http_redirect" {
  load_balancer_arn = aws_lb.juli.arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}
resource "aws_ecs_service" "juli" {
  name            = "juli"
  cluster         = aws_ecs_cluster.juli.id
  task_definition = aws_ecs_task_definition.juli.arn
  desired_count   = 1 # SQLite: hard single instance — do not scale
  launch_type     = "FARGATE"
  network_configuration {
    subnets          = data.aws_subnets.public.ids
    security_groups  = [aws_security_group.task.id]
    assign_public_ip = true
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.juli.arn
    container_name   = "juli"
    container_port   = 7070
  }
  # Tasks must not be scheduled before EFS mount targets exist in their AZ.
  depends_on = [aws_efs_mount_target.data]
}

output "alb_dns" { value = aws_lb.juli.dns_name }
output "note" { value = "Point ${var.hostname} CNAME at alb_dns" }
