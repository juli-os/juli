.PHONY: dev test typecheck web web-dev setup doctor docker-build up down deploy-aliyun deploy-aws deploy-gcp

dev:        ## Run the engine locally (tsx watch)
	npm run dev
test:       ## Full test suite
	npm test
typecheck:  ## tsc, both projects
	npm run typecheck
web:        ## Build web cockpit -> web-dist (served by the engine)
	npm run web
web-dev:    ## Web dev server
	npm run web:dev
setup:      ## Guided bootstrap: tmux + Claude Code + AI key + e2e self-check
	npm run setup
doctor:     ## Read-only self-check (no installs, no writes)
	npm run doctor
docker-build: ## Build the MVP image (engine + tmux + Claude Code)
	docker build $(DOCKER_BUILD_ARGS) -t juli:latest .
	# Behind an intercepting proxy: make docker-build DOCKER_BUILD_ARGS=\
	# "--build-arg http_proxy=http://host.docker.internal:<port> --build-arg https_proxy=http://host.docker.internal:<port>"
up:         ## compose up (JULI_PASSWORD required)
	docker compose up -d --build
down:       ## compose down
	docker compose down
deploy-aliyun: ## Aliyun: ACR push + optional ECS update (see deploy/aliyun/README.md)
	bash deploy/aliyun/deploy.sh
deploy-aws:  ## AWS: terraform ECS Fargate single-instance (see deploy/aws/README.md)
	cd deploy/aws && terraform init && terraform apply
deploy-gcp:  ## GCP: Cloud Run min=max=1 (see deploy/gcp/README.md)
	cd deploy/gcp && gcloud run services replace service.yaml --region asia-east1
