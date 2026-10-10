#!/usr/bin/env bash
# Aliyun deploy: build → ACR push → (optional) ECS pull+recreate via cloud assistant.
# Env: ACR_REGISTRY (required, e.g. registry.cn-hangzhou.aliyuncs.com)
#      ACR_NAMESPACE (required, your ACR namespace)
#      IMAGE_TAG (default latest)
#      ECS_ID (optional i-xxxx — when set, remote pull+recreate via SendCommand)
#      JULI_PASSWORD (required only when ECS_ID set — becomes the container env)
#      REGION (default cn-hangzhou)
set -euo pipefail

ACR_REGISTRY="${ACR_REGISTRY:?ACR_REGISTRY required, e.g. registry.cn-hangzhou.aliyuncs.com}"
ACR_NAMESPACE="${ACR_NAMESPACE:?ACR_NAMESPACE required (your ACR namespace)}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
REGION="${REGION:-cn-hangzhou}"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REMOTE_REF="$ACR_REGISTRY/$ACR_NAMESPACE/juli:$IMAGE_TAG"

echo "==> [1/3] build $REMOTE_REF (from $REPO_ROOT)"
docker build $DOCKER_BUILD_ARGS -t "$REMOTE_REF" "$REPO_ROOT"

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
  ECS_ID=i-xxxx JULI_PASSWORD=... bash $0
First-time setup: see README.md (cloud-init.yaml bootstraps docker + /data).
EOF
  exit 0
fi
JULI_PASSWORD="${JULI_PASSWORD:?JULI_PASSWORD required for ECS update}"
aliyun ecs SendCommand --region "$REGION" \
  --InstanceId.1 "$ECS_ID" \
  --Type RunShellScript \
  --Name juli-update \
  --Timeout 300 \
  --CommandContent "$(printf '#!/bin/sh\nset -e\ndocker rm -f juli 2>/dev/null || true\ndocker pull %s\ndocker run -d --name juli --restart unless-stopped -p 7170:7070 -v /data:/data -e JULI_PASSWORD="$JULI_PASSWORD" -e LANG=C.UTF-8 %s' "$REMOTE_REF" "$REMOTE_REF" | base64)" \
  --jq .InvokeId
echo "Sent update command to $ECS_ID (check: aliyun ecs DescribeInvocationResults --InvokeId <id>)"
