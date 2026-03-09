.PHONY: help dev dev-down dev-scratch prod prod-down

COMPOSE ?= docker compose

GIT_COMMIT := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
GIT_TAG    := $(shell git describe --tags --exact-match 2>/dev/null || echo unknown)
BUILD_DATE := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

export GIT_COMMIT GIT_TAG BUILD_DATE

help: ## Show this help
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F ':.*## ' '{printf "  make %-14s %s\n", $$1, $$2}'

dev: ## Start dev environment
	$(COMPOSE) up

dev-down: ## Stop dev environment
	$(COMPOSE) down

dev-scratch: ## Rebuild dev from scratch (removes volumes)
	$(COMPOSE) down -v
	$(COMPOSE) up --build

prod: ## Start production environment
	$(COMPOSE) -f compose.yaml -f compose.prod.yaml up -d --build

prod-down: ## Stop production environment
	$(COMPOSE) -f compose.yaml -f compose.prod.yaml down
