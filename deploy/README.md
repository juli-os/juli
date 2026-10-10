# Cloud deployments

Single-instance only — the engine's ledger is SQLite (`/data`). Scale-out is
intentionally out of scope for the MVP.

| Cloud | Method | State | Est. minimal cost / month |
|---|---|---|---|
| Aliyun ( Alibaba Cloud ) | ACR image + ECS (cloud-init, docker compose) | **tested path** | ¥60–90 (2c4g ECS + disk + EIP) |
| AWS | Terraform: ECS Fargate (1 task) + EFS + ALB/ACM | manifests ready, not yet exercised on a live account | ~$23 (Fargate 1vCPU/2GB + ALB + EFS) |
| GCP | Cloud Run (min=1 max=1) + LB | manifests ready; **state is ephemeral between revisions** — see its README | ~$35 (Cloud Run always-on) |

Each directory is self-contained; start with its README.
