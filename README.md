# Cyber Hockey

Three.js air hockey for 2–4 players: single player against AI, or online multiplayer with an authoritative Express + WebSocket server.

## Layout

- `web/` – Vite + TypeScript + Three.js client
- `server/` – Express + `ws` server (rooms, lobby, pause/kick, the game simulation)
- `shared/` – pure TypeScript used by both: table layout, physics, AI, `MatchCore` rules, binary wire format, protocol

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

Limits (environment variables):

- `MAX_CONNS_PER_IP` (16): open websockets per address (per /64 block for IPv6); more get `429`.
- `MAX_CONNS` (5000): open websockets in all.
- `IDLE_TIMEOUT` (900, seconds): a connection that sends nothing but keep-alive pings for this long is closed (code `4000`). Dead connections (no pong) go after 30 s. The page doesn't reconnect after an idle close until the player clicks, presses a key or comes back to the tab.
- `TRUST_PROXY` (0): how many reverse proxies sit in front of the server. Set it (usually `1`) behind nginx, Caddy or a load balancer, or every player shares the proxy's address and the per-address limit applies to all of them together. Leave it at `0` when nothing is in front: otherwise clients can fake their address with `X-Forwarded-For`.
- `POSTHOG_KEY`, `POSTHOG_HOST` (build time; host defaults to `https://eu.i.posthog.com`): PostHog analytics. No key, no analytics. Events: `game_started` and `game_ended` (`mode` single/multi, `players`, `ended_by`, `duration_s`, …); nothing is stored on the device, and Do Not Track / Global Privacy Control turn it off.
- `APP_URL` (`http://localhost:3000`): the public site URL, e.g. `https://cyberhockey.fetchrover.app`. Needed at build time too (the page's canonical, Open Graph and Twitter tags; `VITE_APP_URL` overrides it there) and at run time: browsers may open the game socket only from pages on this origin or on the host they connected to (else `403`). With Docker: `APP_URL=https://… docker compose up --build`.

Every response carries security headers (helmet: CSP, HSTS over HTTPS, nosniff, Referrer-Policy, Permissions-Policy, …). Other sites may embed the game in an iframe (`frame-ancestors *`, no `X-Frame-Options`); they can't read into it, and the guest token sits in localStorage, not a cookie. An embedder grants fullscreen with `<iframe allow="fullscreen">`.

Each connection may send up to 30 JSON messages a second (bursts of 120) and 500 binary input frames a second; extra messages are dropped and a connection that keeps flooding is closed. A player (one browser's guest token) is in one game at a time: joining a different game from another tab is refused with `busy`.

## Multiplayer notes

- Identity is a temporary guest token kept in `localStorage` (`airhockey.token`) plus a display name; the server derives the player id from the token behind an `AuthProvider` (`server/src/auth.ts`), so real auth can replace it.
- Room links look like `/?room=<8 chars>`. Quick play (2 or 4 players) matches into hidden rooms that auto-start when full.

### How online physics works

Server-authoritative simulation, clients that run ahead with tick-stamped input, client-side prediction with rollback, and a distance-based display timeline for the puck. The same `Physics` code runs on both ends.

- **One shared tick clock.** The server steps its `MatchCore` (`shared/src/match.ts`) at 120 Hz (`shared/src/net.ts`) and counts ticks without stopping, through countdowns and pauses too, so tick and clock stay in step.
- **Clients run ahead of the server.** A client's present is about half a round trip plus a few ticks ahead of the server (`NetClock`, `shared/src/netclock.ts`). Every tick it moves its own mallet and sends that exact position stamped with the tick (`in`, binary, one frame per render frame). The input reaches the server *before* the server simulates that tick, so the server's puck meets exactly the mallet you moved: nothing needs claiming, rewinding or judging afterwards. Each state reports per seat how many ticks early that seat's inputs arrive (`slack`); the client raises its lead quickly when inputs are late and lowers it slowly when they are early. The server clamps each position to the seat's zone and to the mallet speed cap.
- **The server sends full state** every second tick (60 Hz): tick, puck position and velocity, every mallet, how long the puck stays frozen (countdown, pause, between rounds), and the slack. Hits and loud wall bounces (binary) and goals and serves (JSON) carry their tick and are sent before the state that follows them.
- **Clients predict with rollback** (`Predictor`, `shared/src/predict.ts`). Each new state is the truth up to its tick. From there the game is re-run tick by tick up to the present with your own recorded inputs (exactly what the server uses) and the other mallets carried on at their last speed for up to 100 ms. The result is bit-for-bit what the server computes unless another player changed something you couldn't know about yet.
- **The puck is drawn on a distance-based timeline** (a local perception filter, `lagWeight`). Near your goal it is drawn in the present, so your mallet meets the puck you see and your hits are instant and real. Near the other players it is drawn `depth` ticks in the past, where the server has already confirmed it, so their hits show exactly as they happened instead of as predictions that get corrected. In between, the puck's time slides from one to the other, so it looks a little faster coming toward you and a little slower going away. `DisplayTime` changes that rate smoothly, so the drawn speed never jumps while nothing touches the puck. An opponent's mallet close to the puck is drawn at the puck's moment, so their touch is drawn as a touch. When a new state changes what was predicted, the puck and mallets glide to the corrected path over about 100 ms instead of jumping. The puck's drawn time runs between 0.8× and 1.25× real time, so the puck is never drawn far from its true speed, and its target moment is averaged along the puck's already-known path (`pathWeight`), so a bounce off a wall doesn't kick the drawn speed. Drawing the far side less in the past instead was measured to cause many more corrections, which look worse. Other mallets are drawn the same way. Sounds, goals and serves play when the drawn puck reaches their tick. Any leftover correction glides away over about 100 ms.
- **A stuck puck is served again.** If the puck stays within 1.5 units of one spot for 5 s (pinned in a corner by a mallet, or wedged on its own), it is put back, standing still, on the serve spot of the side it was stuck on (`freeStuckPuck` in `shared/src/match.ts`).
- **Debugging:** `?debug` plays without fullscreen (the mouse follows the cursor), Esc doesn't pause, and the game objects are on `window.airhockey`.
- **Nothing passes through a mallet.** Mallet-puck contact is swept within each physics substep (`sweepEntry` in `shared/src/physics.ts`): both move in straight lines, so the first touching moment is the root of a quadratic. Mallets also can't move faster than `MAX_MALLET_SPEED`, the speed the physics counts for momentum.
- **What latency still costs:** news of another player's move reaches you after a round trip. If they touch the puck close to the moment you do (a scrum at the center line), your predicted hit can be overturned, and the puck glides to the server's path.
- **Testing a bad connection:** open the game with `?lag=100` (every message is delayed 100 ms each way, in order, with a little jitter, so the HUD ping shows about 200 ms). `server/test/netplay.test.ts` plays two headless clients against the real server at a 200 ms ping and checks that every hit a player saw is a hit on the server.
- **Wire format**: state, hits, wall bounces and mallet input are small binary frames (`shared/src/binary.ts`); everything else is JSON.

## Docker

```sh
docker compose up --build   # http://localhost:3000 (PORT=8080 docker compose up changes the host port)
```

`docker build -t airhockey .` builds the image alone. Run a single instance: rooms live in memory.
