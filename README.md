# Neon Air Hockey

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

## Multiplayer notes

- Identity is a temporary guest token kept in `localStorage` (`airhockey.token`) plus a display name; the server derives the player id from the token behind an `AuthProvider` (`server/src/auth.ts`), so real auth can replace it.
- Room links look like `/?room=<8 chars>`. Quick play (2 or 4 players) matches into hidden rooms that auto-start when full.

### How online physics works

- **The server simulates everything.** One `MatchCore` per running game (`shared/src/match.ts`) steps at 120 Hz: puck, walls, AI seats, goals, scores, serves, the idle-puck nudge. Players send where they want their mallet (`in`, up to 60/s); the server's mallet eases toward it and is clamped to the seat's zone. Pauses, the countdown and vote-kick are the server's too.
- **The server sends verified positions** every second step (60 Hz): the puck's position, the mallets that moved, and events as they happen (hits, loud wall bounces, goals, serves). No velocities go over the wire.
- **Clients draw by moving between those positions.** The puck and the other players' mallets are drawn on one shared timeline `delay` ms behind the server clock, interpolating between the two server positions around that time and never going beyond the newest. The delay follows the 95th-percentile lateness of recent server messages (40–250 ms, grows fast, shrinks slowly), so there is nearly always a newer position to move toward.
- **Your own hit is instant.** Your mallet is drawn in real time and collides with the puck as drawn, locally, so the hit shows and sounds with no delay. The touch is reported (`hit`: the time of the picture you saw, your mallet's position and velocity). The server's `rewindHit` takes the puck back to that moment (it keeps the last 0.6 s), checks the mallet really touches it, bounces it with the shared physics, and replays the steps since, so a hit counts where you saw it even on a high ping. Players' mallets hit the puck only through these claims; the server's own collisions are for AI seats. A claim is dropped if the mallet is outside its zone or too far from where the server has it, the speed is above the physics maximum, the puck wasn't within reach, or it is stale. The local bounce is shown until the picture reaches the server's result (or a `miss` says it didn't count), then the ball glides on to the server's positions.
- **Other players' hits are predicted too.** When another mallet (a player's or an AI's) touches the puck in the picture, the client bounces the puck at that moment with the mallet's drawn position and speed, instead of waiting for the server's hit message. The server's version replaces it when it arrives; the ball glides away any difference.
- **A late hit can't land a goal the defender never saw.** The server rewinds for a claim, but the new path never starts more than 150 ms (`MAX_COMPENSATION` in `shared/src/match.ts`) before now. A player on a 400 ms ping sees the puck about half a second late; rewriting all of that would drop the puck near the other player's goal with no time to react. Beyond 150 ms the puck waits at the hit point for the difference and then flies, so the shooter sees a correction and the defender gets the time back. The history stays lined up with the clock throughout, so the next claim is still judged.
- **Testing a bad connection:** open the game with `?lag=200` (every message is delayed 200 ms each way, in order, with a little jitter; the HUD ping shows about 400 ms).
- **Fast pucks don't pass through mallets.** Contact is solved, not sampled (`sweepEntry` in `shared/src/physics.ts`): between two positions both the puck and the mallet move in a straight line, so the first moment they are a radius-sum apart is the root of a quadratic. The client does it for every mallet between one frame and the next (using their relative motion); the server does it along the puck's recorded path when it judges a claim, so no recorded step needs to land on the mallet.
- **A late hit rewrites a short stretch of the puck's path.** The server's hit message carries the time it judged against (`from`) and the puck's position now; clients drop the positions after `from` and move the ball from the hit point along its new path.
- **Wire format**: mallet snapshots, puck positions, hits, wall bounces, mallet input and hit claims are small binary frames (`shared/src/binary.ts`); everything else is JSON.
- Limits: other players are drawn `delay` ms behind real time (that is what makes their movement verified and smooth). Mallets are confined to their own zones, so two hits can only collide when both mallets touch the puck at the dividing line at once; the server orders them.
