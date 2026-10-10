.PHONY: dev test typecheck web web-dev setup doctor docker-build up down

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
	docker build -t juli:latest .
up:         ## compose up (JULI_PASSWORD required)
	docker compose up -d --build
down:
	docker compose down
