# Aliyun deployment (tested path)

Single ECS instance, image from your ACR (Aliyun Container Registry), state on
the instance disk. This is the simplest durable topology for the SQLite ledger.

## One-time setup

1. **ACR namespace** — create a personal/enterprise ACR instance in
   cn-hangzhou (or your region) and a namespace, e.g. `juli`.
2. **ECS instance** — 2 vCPU / 4 GB (arm64 or x86_64), Aliyun Linux 3 or
   Ubuntu 22.04, 40 GB disk. Attach an EIP for public access.
3. **Bootstrap docker** — pass [`cloud-init.yaml`](cloud-init.yaml) as the
   instance user-data (installs docker + compose, prepares `/data`).
4. **HTTPS (recommended)** — put a SLB/ALB with a certificate in front, or
   terminate TLS with your own nginx; the engine itself speaks HTTP on 7070.

## Deploy / update

```bash
# from this directory (aliyun CLI configured, docker running locally)
ACR_REGISTRY=registry.cn-hangzhou.aliyuncs.com ACR_NAMESPACE=juli \
ECS_ID=i-xxxxxxxx JULI_PASSWORD=xxxx \
bash deploy.sh
```

`deploy.sh` will:

1. build the image from the repo root,
2. push it to `$ACR_REGISTRY/$ACR_NAMESPACE/juli:latest` (ACR auth token
   obtained via `aliyun cr GetAuthorizationToken` — no stored passwords),
3. if `ECS_ID` is set, trigger a pull+recreate on the instance via cloud
   assistant (`aliyun ecs SendCommand`).

Then open `http://<EIP>:7170` (or your SLB HTTPS endpoint) and configure AI
via Settings.

## Notes

- State lives in `/data` on the ECS disk — snapshot the disk for backup.
- The engine requires `JULI_PASSWORD` whenever it listens off-loopback; the
  script refuses to run without it.
- tmux + Claude Code run inside the container; the ECS security group only
  needs to open 22 (ops) and the cockpit port.
