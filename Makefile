.PHONY: install web server run dev dev-go dev-web build

install:
	cd web && pnpm install

web:
	cd web && pnpm build

server: web
	go run ./cmd/server

# Production: build frontend, embed it, run single binary.
run: server

build: web
	go build -o bin/airhockey ./cmd/server

# Dev: Go API (:3000) + Vite (:5173, proxies /api,/ws) in parallel. Open http://localhost:5173. Ctrl+C stops both.
dev:
	./scripts/dev.sh

dev-go:
	WEB_DIR=web/dist go run ./cmd/server

dev-web:
	cd web && pnpm dev
