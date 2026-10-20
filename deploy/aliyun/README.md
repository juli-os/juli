# Aliyun deployment (tested path)

Single ECS instance, image from your ACR (Aliyun Container Registry), state on
the instance disk. This is the simplest durable topology for the SQLite ledger.

## One-time setup

1. **ACR namespace** — create a personal/enterprise ACR instance in
   cn-hangzhou (or your region) and a namespace, e.g. `juli`.
2. **ECS instance** — 2 vCPU / 4 GB (arm64 or x86_64), Aliyun Linux 3 or
   Ubuntu 22.04, 40 GB disk. Attach an EIP for public access.
3. **Bootstrap docker** — pass [`cloud-init.yaml`](cloud-init.yaml) as the
   instance user-data (installs docker, prepares `/data`, presets an empty
   `/data/juli_password`, mode 0600).
4. **Provision the engine password** — SSH in once and write the password
   line into the preset file (a single `JULI_PASSWORD=...` line, raw value —
   docker `--env-file` does not strip quotes):
   `printf 'JULI_PASSWORD=your-password\n' | sudo tee /data/juli_password`
   The file never leaves the host; `deploy.sh` sends only a `--env-file`
   reference, so the password does not enter Aliyun cloud-assistant call
   history. (It remains visible to `docker inspect` on the host — inherent
   to env-var secrets.)
5. **HTTPS (recommended)** — put a SLB/ALB with a certificate in front, or
   terminate TLS with your own nginx; the engine itself speaks HTTP on 7070.

## Deploy / update

```bash
# from this directory (aliyun CLI configured, docker running locally;
# /data/juli_password already provisioned on the instance)
ACR_REGISTRY=registry.cn-hangzhou.aliyuncs.com ACR_NAMESPACE=juli \
ECS_ID=i-xxxxxxxx \
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
- The engine requires `JULI_PASSWORD` whenever it listens off-loopback; it is
  read from `/data/juli_password` on the host (`docker run --env-file`), so it
  stays out of the SendCommand payload and Aliyun call history. The update
  command fail-closes before touching the running container if that file is
  missing or empty — it never recreates the container with no password.
- tmux + Claude Code run inside the container; the ECS security group only
  needs to open 22 (ops) and the cockpit port.
