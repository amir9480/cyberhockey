.PHONY: install dev build start test typecheck

install:
	pnpm install

# Dev: one server on :3000 with Vite running inside it (hot reload). Open http://localhost:3000.
dev:
	pnpm dev

# Production build: frontend (web/dist) and server bundle (server/dist).
build:
	pnpm build

# Production: one process serves the built frontend, /api and /ws on :3000 (PORT overrides).
start: build
	pnpm start

test:
	pnpm test

typecheck:
	pnpm typecheck
