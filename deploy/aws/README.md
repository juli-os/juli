# AWS deployment (manifests ready — not yet exercised on a live account)

ECS Fargate, single task (SQLite pins us to replicas=1), EFS for `/data`,
ALB with ACM TLS in front. ~$23/month at the minimal shape.

## Prereqs

- AWS credentials + default region set (`aws configure`)
- A certificate in ACM for your domain (`cert_arn` variable)
- A VPC with public subnets (defaults use the account default VPC)

## Deploy

```bash
terraform init
terraform apply \
  -var="cert_arn=arn:aws:acm:...:certificate/..." \
  -var="juli_password=..." \
  -var="hostname=juli.example.com"
```

Outputs the ALB DNS name; point your domain's CNAME at it.

## Notes

- The image is pulled from public GHCR (`ghcr.io/juli-os/juli:latest`) — no ECR
  replication needed.
- SQLite on EFS is fine at one writer; do not raise `desired_count`.
- `juli_password` goes through AWS Secrets Manager (created by this stack) and
  is injected into the task definition; it never lands in tf state in plaintext
  after first apply if you use the `ephemeral` pattern — for the MVP keep state
  in a private bucket (`backend.tf` is left to you).
