# Neon Air Hockey

Three.js air hockey for 2–4 players: single player against AI, or online multiplayer with an authoritative Express + WebSocket server.

## Layout

- `web/` – Vite + TypeScript + Three.js client
- `server/` – Express + `ws` server (rooms, lobby, simulation loop)
- `shared/` – pure TypeScript used by both: table layout, physics, AI, `MatchCore` rules, wire protocol

Single `package.json` at the repo root (one install covers client, server and shared); Node 20+. `@airhockey/shared/*` resolves to `shared/src/*` through tsconfig paths and a Vite alias.

## Development

```sh
pnpm install
pnpm dev        # rebuilds web/dist on change (vite build --watch) and runs the server on :3000 with restart-on-change; refresh the page to see client changes; open http://localhost:3000
```

`make dev` does the same. Tests and type checks:

```sh
pnpm test       # shared sim + server integration tests (vitest)
pnpm typecheck
```

## Production

```sh
pnpm build      # web/dist + server/dist/index.js
pnpm start      # one process: serves web/dist, /api and /ws on :3000 (PORT overrides, WEB_DIR overrides the frontend dir). Same single port as dev
```

Rooms live in memory on a single instance; a restart drops running games.

## Multiplayer notes

- Identity is a temporary guest token kept in `localStorage` (`airhockey.token`) plus a display name; the server derives the player id from the token behind an `AuthProvider` (`server/src/auth.ts`), so real auth can replace it.
- Room links look like `/?room=<8 chars>`. Quick play (2 or 4 players) matches into hidden rooms that auto-start when full.
