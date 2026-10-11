# calendar-agent — operator commands. `make help` lists them.
SHELL := /bin/bash
.DEFAULT_GOAL := help

ENV_FILE := .env
, := ,
# Publish addresses derived from APP_BIND_ADDRESSES (comma separated, max two).
# Values read from .env strip trailing comments and quotes (comments belong on their own line).
envval = $(shell grep -E '^$(1)=' $(ENV_FILE) 2>/dev/null | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$$//' | tr -d '"' | tr -d "'" | xargs)
BIND_ADDRS := $(call envval,APP_BIND_ADDRESSES)
APP_PORT_VAL := $(or $(call envval,APP_PORT),8400)
PUBLISH_1 := $(word 1,$(subst $(,), ,$(BIND_ADDRS)))
PUBLISH_2 := $(word 2,$(subst $(,), ,$(BIND_ADDRS)))
PUBLISH_3 := $(word 3,$(subst $(,), ,$(BIND_ADDRS)))
COMPOSE := APP_PUBLISH_1=$(if $(PUBLISH_1),$(PUBLISH_1),127.0.0.1) APP_PUBLISH_2=$(PUBLISH_2) docker compose -f docker-compose.yml $(if $(PUBLISH_2),-f compose.publish-2.yml,)

.PHONY: help
help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

# ---- setup -------------------------------------------------------------------
.PHONY: env
env: ## Create .env from .env.example if it does not exist
	@test -f $(ENV_FILE) && echo ".env exists" || (cp .env.example $(ENV_FILE) && chmod 600 $(ENV_FILE) && echo "created .env — fill it in")

.PHONY: key-generate
key-generate: ## Print a fresh MASTER_KEY and SLACK_STATE_SECRET
	@echo "MASTER_KEY=$$(openssl rand -base64 32)"
	@echo "SLACK_STATE_SECRET=$$(openssl rand -hex 32)"

.PHONY: install
install: ## Install dependencies on the host (tests, lint, CLI)
	npm ci

.PHONY: setup
setup: env install ## First-time setup: .env + dependencies
	@echo "Now fill .env, then: make manifest, make build, make up"

.PHONY: manifest
manifest: compile ## Render the Slack app manifest from .env → manifest.json
	node --env-file=$(ENV_FILE) dist/cli/manifest.js

# ---- run ---------------------------------------------------------------------
.PHONY: build
build: $(if $(SKIP_CHECK),,check) ## Build the application image (runs `make check` first; SKIP_CHECK=1 to bypass)
	$(COMPOSE) build

.PHONY: up
up: ports-check ## Start the stack in the background and wait for health
	@test -z "$(PUBLISH_3)" || { echo "APP_BIND_ADDRESSES lists more than two addresses; one or two are supported."; exit 1; }
	$(COMPOSE) up -d
	@for i in $$(seq 1 30); do s=$$($(COMPOSE) ps --format '{{.Health}}' app 2>/dev/null); [ "$$s" = "healthy" ] && echo "healthy" && exit 0; sleep 2; done; echo "not healthy yet — check: make logs"; exit 1

.PHONY: down
down: ## Stop the stack (data volume preserved)
	$(COMPOSE) down

.PHONY: restart
restart: ## Restart the stack, picking up .env changes
	$(COMPOSE) up -d --force-recreate

.PHONY: rebuild
rebuild: build ## Rebuild the image and restart (after code changes)
	$(COMPOSE) up -d --force-recreate

.PHONY: logs
logs: ## Follow the application logs (never contain question or answer text)
	$(COMPOSE) logs -f --tail=200 app

.PHONY: ps
ps: ## Show service state and published ports
	$(COMPOSE) ps

.PHONY: shell
shell: ## Open a shell in the running container
	$(COMPOSE) exec app sh

.PHONY: status
status: ## Health and Socket Mode status from the running app
	@curl -sf http://127.0.0.1:$(APP_PORT_VAL)/health | sed 's/,/,\n /g'

# ---- data --------------------------------------------------------------------
.PHONY: db-backup
db-backup: ## Snapshot the SQLite database to ./backups/ (gitignored, mode 600); works while the app runs
	@mkdir -p backups && chmod 700 backups
	@name=calendar-agent-$$(date +%Y%m%d-%H%M%S).db; \
	$(COMPOSE) exec -T app sh -c "mkdir -p /data/backups && node dist/cli/backup.js /data/backups/$$name" && \
	$(COMPOSE) cp app:/data/backups/$$name backups/$$name && \
	chmod 600 backups/$$name && \
	$(COMPOSE) exec -T app rm -f /data/backups/$$name && \
	ls -la backups/$$name

.PHONY: db-restore
db-restore: ## Restore a backup — usage: make db-restore f=backups/<file>.db (stops the app, replaces the database and its WAL files, restarts)
	@test -f "$(f)" || { echo "usage: make db-restore f=backups/<file>.db"; exit 1; }
	$(COMPOSE) stop app
	$(COMPOSE) run --rm --no-deps -v "$(abspath $(f))":/restore.db:ro --entrypoint sh app -c 'rm -f /data/calendar-agent.db-wal /data/calendar-agent.db-shm && cp /restore.db /data/calendar-agent.db && echo restored'
	$(COMPOSE) up -d app

.PHONY: db-shell
db-shell: sqlite3-check db-backup ## Open a fresh backup copy with the host's sqlite3 (install: apt install sqlite3)
	sqlite3 $$(ls -t backups/*.db | head -1)

.PHONY: sqlite3-check
sqlite3-check:
	@command -v sqlite3 >/dev/null || { echo "sqlite3 is not installed on the host (apt install sqlite3)"; exit 1; }

# ---- checks ------------------------------------------------------------------
.PHONY: ask
ask: ## Ask the engine inside the running container (its keys, its query log) — usage: make ask q="is the owner free Monday 4pm?" [tz=Europe/Paris] [lang=fr] [now=2026-10-09T12:00 (local time in tz, UTC if tz omitted)]
	$(COMPOSE) exec -T app node dist/cli/ask.js --q "$(q)" $(if $(tz),--tz $(tz),) $(if $(lang),--lang $(lang),) $(if $(now),--now $(now),)

.PHONY: ask-host
ask-host: compile ## Developer: the engine on the host with ./data and the keys of .env (not the instance's); same usage as ask
	node --env-file=$(ENV_FILE) dist/cli/ask.js --q "$(q)" $(if $(tz),--tz $(tz),) $(if $(lang),--lang $(lang),) $(if $(now),--now $(now),)

.PHONY: calcom-check
calcom-check: ## Live check of the Cal.com key the instance uses (admin Settings, else .env): /v2/me, selected calendars, schedule (ids and emails only)
	$(COMPOSE) exec -T app node dist/cli/calcom-check.js

.PHONY: deepseek-check
deepseek-check: ## Live check of the DeepSeek key the instance uses, with one tiny completion
	$(COMPOSE) exec -T app node dist/cli/deepseek-check.js

.PHONY: test
test: ## Run the hermetic unit, integration and repository suites
	npm test

.PHONY: test-live
test-live: ## Run the live suites against Cal.com, DeepSeek and the running container (needs .env)
	@set -a; . ./$(ENV_FILE); set +a; LIVE=1 npx vitest run $(if $(f),$(f),)

.PHONY: lint
lint: ## Lint
	npm run lint

.PHONY: typecheck
typecheck: ## Type-check
	npm run typecheck

.PHONY: compile
compile: ## Compile TypeScript to dist/ on the host (needed by manifest and ask-host)
	npm run build

.PHONY: ports-check
ports-check: ## Verify the configured port is free on every publish address
	@node scripts/check-ports.mjs

.PHONY: secrets-scan
secrets-scan: ## Fail if anything that looks like a secret is committed
	@node scripts/scan-secrets.mjs

.PHONY: private-words-check
private-words-check: ## Fail if a term from the local .private-words list is in the tree or an unpushed commit message
	@node scripts/check-private-words.mjs

.PHONY: hooks
hooks: ## Install the repository's git hooks (pre-push runs private-words-check)
	git config core.hooksPath .githooks

.PHONY: audit
audit: ## Fail on known high/critical dependency vulnerabilities
	npm audit --audit-level=high

.PHONY: security-check
security-check: secrets-scan private-words-check audit ## Run every security gate
	@echo "Security checks passed."

.PHONY: docs-check
docs-check: ## Verify the documentation: every doc indexed, every link, path and make target resolves
	@node scripts/docs-check.mjs

.PHONY: check
check: lint typecheck test security-check docs-check ## Everything a commit must pass
	@echo "All checks passed."
