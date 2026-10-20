#!/usr/bin/env bash
# Aliyun deploy: build → ACR push → (optional) ECS pull+recreate via cloud assistant.
# Env: ACR_REGISTRY (required, e.g. registry.cn-hangzhou.aliyuncs.com)
#      ACR_NAMESPACE (required, your ACR namespace)
#      IMAGE_TAG (default latest)
#      ECS_ID (optional i-xxxx — when set, remote pull+recreate via SendCommand)
#      REGION (default cn-hangzhou)
# Password: lives on the ECS host in /data/juli_password (0600, one
# JULI_PASSWORD=... line — cloud-init presets the empty file, write it once
# per README). The SendCommand payload only references the file via
# `docker run --env-file`, so the password never enters Aliyun cloud-assistant
# call history; it is still visible to `docker inspect` on the host, which is
# inherent to any env-var secret.
set -euo pipefail

ACR_REGISTRY="${ACR_REGISTRY:?ACR_REGISTRY required, e.g. registry.cn-hangzhou.aliyuncs.com}"
ACR_NAMESPACE="${ACR_NAMESPACE:?ACR_NAMESPACE required (your ACR namespace)}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
REGION="${REGION:-cn-hangzhou}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REMOTE_REF="$ACR_REGISTRY/$ACR_NAMESPACE/juli:$IMAGE_TAG"

echo "==> [1/3] build $REMOTE_REF (from $REPO_ROOT)"
docker build ${DOCKER_BUILD_ARGS:-} -t "$REMOTE_REF" "$REPO_ROOT"

echo "==> [2/3] ACR login (token via aliyun CLI — no stored passwords) + push"
USER_NAME="$(aliyun cr GetAuthorizationToken --region "$REGION" --jq .tempUserName)"
TOKEN="$(aliyun cr GetAuthorizationToken --region "$REGION" --jq .authorizationToken)"
echo "$TOKEN" | docker login --username "$USER_NAME" --password-stdin "$ACR_REGISTRY" >/dev/null
docker push "$REMOTE_REF"
docker logout "$ACR_REGISTRY" >/dev/null

echo "==> [3/3] remote update"
if [ -z "${ECS_ID:-}" ]; then
  cat <<EOF
Image pushed. To update a running ECS instance:
  ECS_ID=i-xxxx bash $0
First-time setup: see README.md (cloud-init.yaml bootstraps docker + /data and
presets /data/juli_password — write the JULI_PASSWORD line into it once, via SSH).
EOF
  exit 0
fi
# The remote script fail-closes BEFORE removing the running container if the
# host password file is missing or empty (never recreate with no password).
aliyun ecs SendCommand --region "$REGION" \
  --InstanceId.1 "$ECS_ID" \
  --Type RunShellScript \
  --Name juli-update \
  --Timeout 300 \
  --CommandContent "$(printf '#!/bin/sh\nset -e\ntest -s /data/juli_password || { echo "ERROR: /data/juli_password missing or empty; write it once on the host (see deploy/aliyun/README.md)"; exit 1; }\ndocker rm -f juli 2>/dev/null || true\ndocker pull %s\ndocker run -d --name juli --restart unless-stopped -p 7170:7070 -v /data:/data --env-file /data/juli_password -e LANG=C.UTF-8 %s' "$REMOTE_REF" "$REMOTE_REF" | base64)" \
  --jq .InvokeId
echo "Sent update command to $ECS_ID (check: aliyun ecs DescribeInvocationResults --InvokeId <id>)"
