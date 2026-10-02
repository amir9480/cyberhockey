import type { PlayerCount } from '@airhockey/shared/layout';
import { MatchCore, type MatchEvent } from '@airhockey/shared/match';
import {
  type ClientMsg,
  type LobbyRoom,
  type MemberInfo,
  type PauseEntry,
  type SeatInfo,
  type ServerMsg,
} from '@airhockey/shared/protocol';
import { DEFAULT_ROOM, PALETTE_SIZE, clampMalletScale, clampWinScore, type RoomSettings } from '@airhockey/shared/room';
import type { Client } from './client';
import type { ServerConfig } from './config';
import type { Hub } from './hub';
import { encodeHit, encodeState, encodeWall, type StateFrame } from '@airhockey/shared/binary';
import { FREEZE_HELD, TICK, TICK_RATE } from '@airhockey/shared/net';
import { MAX_MALLET_SPEED } from '@airhockey/shared/physics';

const DT = TICK;
const STATE_EVERY = 2; // ticks between state broadcasts (60 a second)
const MAX_CATCHUP = 0.1; // seconds of real time the loop simulates at most after a stall
const MAX_AHEAD = TICK_RATE * 2; // ticks: inputs further ahead than this are a broken clock, not a fast one
const SLACK_WINDOW = TICK_RATE / 2; // ticks over which each seat's input slack is the minimum seen
/** A driven mallet may move this far per tick (the speed cap, plus wire rounding). */
const MAX_DRIVE_STEP = MAX_MALLET_SPEED * DT + 0.005;

interface Member {
  id: string;
  name: string;
  color: number;
  ready: boolean;
  online: boolean;
  /** Seat in the running game, or -1. */
  seat: number;
  conn: Client | null;
  /** Timer that removes a dropped member who was not in the game. */
  grace: ReturnType<typeof setTimeout> | null;
}

interface Seat {
  /** Player who owns the seat (kept while the seat is AI-driven, so they can reclaim it). */
  id: string | null;
  name: string;
  color: number;
  ai: boolean;
}

/** Something that happened in the simulation, with the tick it happened in and the puck right after. */
interface Happened {
  e: MatchEvent;
  tick: number;
  p: [number, number];
}

/** A human seat's incoming mallet positions, by the tick they are for. */
interface SeatInput {
  pending: Map<number, [number, number]>;
  /** Fewest ticks early an input arrived, this window and the last (negative: late). */
  slack: number;
  slackPrev: number;
}

const newInput = (): SeatInput => ({ pending: new Map(), slack: Infinity, slackPrev: Infinity });

interface Game {
  match: MatchCore;
  seats: Seat[];
  /** The last simulated tick. Keeps counting through pauses and countdowns, so it stays in step with the clock. */
  tick: number;
  acc: number;
  last: number;
  countdown: number;
  events: Happened[];
  inputs: SeatInput[];
  timer: ReturnType<typeof setInterval>;
  /** Players currently holding the game paused, in order. */
  paused: Set<string>;
  budgets: Map<string, number>;
  votes: Map<string, Set<string>>;
  /** Players kicked in this game: they can't take a seat again. */
  seatBanned: Set<string>;
}

export interface RoomOptions {
  public: boolean;
  quick: boolean;
  cap: number;
  settings: RoomSettings;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

export class Room {
  readonly members = new Map<string, Member>();
  readonly banned = new Set<string>();
  readonly created = Date.now();
  public: boolean;
  readonly quick: boolean;
  readonly cap: number;
  settings: RoomSettings;
  hostId = '';
  status: 'lobby' | 'playing' = 'lobby';
  /** Quick rooms start by themselves once, when full. */
  autoStarted = false;
  game: Game | null = null;
  private closed = false;

  constructor(
    readonly id: string,
    private hub: Hub,
    private cfg: ServerConfig,
    opts: RoomOptions,
  ) {
    this.public = opts.public;
    this.quick = opts.quick;
    this.cap = opts.cap;
    this.settings = opts.settings;
  }

  // --- membership -----------------------------------------------------------

  /** Error code if `id` can't join, else null. */
  canJoin(id: string): 'kicked' | 'full' | null {
    if (this.banned.has(id)) return 'kicked';
    if (!this.members.has(id) && this.members.size >= this.cap) return 'full';
    return null;
  }

  get playersOnline() {
    let n = 0;
    for (const m of this.members.values()) if (m.online) n++;
    return n;
  }

  join(client: Client) {
    let m = this.members.get(client.id);
    if (m) {
      if (m.conn && m.conn !== client) {
        m.conn.room = null;
        m.conn.send({ t: 'left', reason: 'replaced' });
      }
      if (m.grace) clearTimeout(m.grace);
      m.grace = null;
      m.conn = client;
      m.online = true;
      m.name = client.name;
    } else {
      m = {
        id: client.id,
        name: client.name,
        color: this.randomFreeColor(),
        ready: false,
        online: true,
        seat: -1,
        conn: client,
        grace: null,
      };
      this.members.set(m.id, m);
      if (!this.hostId) this.hostId = m.id;
    }
    client.room = this;

    const g = this.game;
    let seated = false;
    if (g) {
      if (m.seat >= 0 && g.seats[m.seat]?.id === m.id && !g.seatBanned.has(m.id)) {
        // Reclaim (or re-attach after a second tab replaced the connection).
        const seat = g.seats[m.seat];
        seat.ai = false;
        seat.name = m.name;
        seated = true;
      } else {
        m.seat = -1;
        seated = this.fillSeats(false);
      }
    }
    this.changed();
    if (g && m.seat >= 0) {
      this.sendStart(m);
      this.broadcastSeats();
    } else if (seated) this.broadcastSeats();

    if (this.quick && !this.autoStarted && this.status === 'lobby' && this.playersOnline === this.cap) {
      this.startGame();
    }
  }

  /** Explicit leave, kick or the like: the member is gone from the room. */
  removeMember(id: string, reason: 'left' | 'kicked', ban = false) {
    const m = this.members.get(id);
    if (!m) return;
    if (m.grace) clearTimeout(m.grace);
    this.members.delete(id);
    if (ban) this.banned.add(id);
    if (m.conn) {
      if (m.conn.room === this) m.conn.room = null;
      m.conn.send({ t: 'left', reason });
      m.conn = null;
    }
    if (this.members.size === 0) {
      this.close();
      return;
    }
    if (this.hostId === id) this.transferHost();
    if (this.game && m.seat >= 0) {
      this.game.seats[m.seat].ai = true;
      if (reason === 'kicked') this.game.seatBanned.add(id);
      this.afterSeatLoss();
    } else this.changed();
  }

  leave(client: Client) {
    if (this.members.get(client.id)?.conn !== client) return;
    this.removeMember(client.id, 'left');
  }

  /** The websocket closed. */
  drop(client: Client) {
    const m = this.members.get(client.id);
    if (!m || m.conn !== client) return; // a stale connection
    client.room = null;
    m.conn = null;
    m.online = false;
    m.ready = false;
    if (this.game && m.seat >= 0) {
      // Seated players stay members until the game ends, so they can come back to their seat.
      this.game.seats[m.seat].ai = true;
      this.afterSeatLoss();
      return;
    }
    m.grace = setTimeout(() => {
      m.grace = null;
      if (!m.online) this.removeMember(m.id, 'left');
    }, this.cfg.grace);
    this.changed();
  }

  rename(client: Client) {
    const m = this.members.get(client.id);
    if (!m || m.conn !== client) return;
    m.name = client.name;
    const seat = this.game?.seats[m.seat];
    if (seat && seat.id === m.id) {
      seat.name = m.name;
      this.broadcastSeats();
    }
    this.changed();
  }

  private transferHost() {
    let next: Member | undefined;
    for (const m of this.members.values()) {
      if (m.online) {
        next = m;
        break;
      }
      next ??= m;
    }
    if (next) this.hostId = next.id;
  }

  // --- commands --------------------------------------------------------------

  handle(client: Client, msg: ClientMsg) {
    const m = this.members.get(client.id);
    if (!m || m.conn !== client) return; // stale connection
    const isHost = m.id === this.hostId;
    switch (msg.t) {
      case 'color': {
        const c = msg.color;
        if (!Number.isInteger(c) || c < 0 || c >= PALETTE_SIZE) return client.error('bad_request', 'bad colour');
        if (this.quick && !this.autoStarted) return client.error('color_locked', 'Colours are random in quick play');
        if (this.game && m.seat >= 0) return client.error('color_locked', 'Colours are locked during a game');
        if (this.takenColors(m.id).has(c)) return client.error('color_taken', 'That colour is taken');
        m.color = c;
        return this.changed();
      }
      case 'ready':
        if (this.status !== 'lobby' || isHost) return;
        m.ready = !!msg.on;
        return this.changed();
      case 'settings': {
        if (!isHost || this.status !== 'lobby') return;
        if (this.quick && !this.autoStarted) return client.error('quick_room', 'Quick play rooms use default settings');
        if (typeof msg.public === 'boolean') this.public = msg.public;
        if (msg.winScore !== undefined) this.settings.winScore = clampWinScore(Number(msg.winScore));
        if (msg.malletScale !== undefined) this.settings.malletScale = clampMalletScale(Number(msg.malletScale));
        return this.changed();
      }
      case 'kick': {
        if (!isHost || this.status !== 'lobby' || typeof msg.id !== 'string' || msg.id === m.id) return;
        return this.removeMember(msg.id, 'kicked', true);
      }
      case 'start': {
        if (!isHost) return;
        const why = this.cannotStart();
        if (why) return client.error('cannot_start', why);
        return this.startGame();
      }
      case 'in':
        return this.onInput(m, msg);
      case 'pause':
        return this.pause(m);
      case 'resume':
        return this.resume(m);
      case 'vote':
        return this.vote(m, msg.id);
      default:
        return;
    }
  }

  private cannotStart(): string | null {
    if (this.status !== 'lobby') return 'A game is already running';
    if (this.playersOnline < 2) return 'Need at least 2 players online';
    for (const m of this.members.values()) {
      if (m.online && m.id !== this.hostId && !m.ready) return `${m.name} is not ready`;
    }
    return null;
  }

  // --- colours ---------------------------------------------------------------

  private takenColors(except: string | null) {
    const taken = new Set<number>();
    for (const m of this.members.values()) if (m.id !== except) taken.add(m.color);
    // Seats keep their colour while an AI plays them, so a newcomer can't look identical to one.
    if (this.game) for (const s of this.game.seats) if (s.id !== except) taken.add(s.color);
    return taken;
  }

  private randomFreeColor() {
    const taken = this.takenColors(null);
    const free: number[] = [];
    for (let i = 0; i < PALETTE_SIZE; i++) if (!taken.has(i)) free.push(i);
    const pool = free.length ? free : Array.from({ length: PALETTE_SIZE }, (_, i) => i);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // --- game ------------------------------------------------------------------

  private startGame() {
    if (this.game || this.status !== 'lobby') return;
    const seated = [...this.members.values()].filter((m) => m.online).slice(0, 4);
    if (seated.length < 2) return;
    if (this.quick) this.autoStarted = true;
    const match = new MatchCore(seated.length as PlayerCount, this.settings.malletScale, this.settings.winScore);
    const events: Happened[] = [];
    match.onEvent = (e) => events.push({ e, tick: g.tick, p: [match.physics.pos.x, match.physics.pos.y] });
    for (const m of this.members.values()) m.seat = -1;
    seated.forEach((m, i) => {
      m.seat = i;
      match.setDriven(i, true);
    });
    const g: Game = {
      match,
      seats: seated.map((m) => ({ id: m.id, name: m.name, color: m.color, ai: false })),
      tick: 0,
      acc: 0,
      last: performance.now(),
      countdown: this.cfg.countdown,
      events,
      inputs: seated.map(newInput),
      timer: setInterval(() => this.loop(), 1000 / TICK_RATE),
      paused: new Set(),
      budgets: new Map(),
      votes: new Map(),
      seatBanned: new Set(),
    };
    this.game = g;
    this.status = 'playing';
    for (const m of seated) this.sendStart(m);
    this.changed();
  }

  private seatInfos(): SeatInfo[] {
    return this.game!.seats.map((s) => ({ id: s.id, name: s.name, color: s.color, ai: s.ai }));
  }

  /** The whole game after the last tick. */
  private state(g: Game): StateFrame {
    const { match } = g;
    const { pos, vel } = match.physics;
    const held = g.paused.size > 0 || !match.visible || match.done;
    return {
      tick: g.tick,
      at: Date.now(),
      freeze: held ? FREEZE_HELD : g.countdown > 0 ? Math.ceil(g.countdown / DT - 1e-6) : 0,
      vis: match.visible,
      p: [pos.x, pos.y],
      v: [vel.x, vel.y],
      m: match.mallets.flatMap((mal) => [mal.pos.x, mal.pos.y]),
      slack: g.inputs.map((s) => Math.min(s.slack, s.slackPrev)),
    };
  }

  private sendStart(m: Member) {
    const g = this.game;
    if (!g || m.seat < 0) return;
    const cd = g.paused.size ? 0 : g.countdown;
    m.conn?.send({
      t: 'start',
      players: g.seats.length as PlayerCount,
      seat: m.seat,
      seats: this.seatInfos(),
      settings: { ...this.settings },
      scores: [...g.match.scores],
      state: this.state(g),
      cd,
    });
  }

  private sendSeated(msg: ServerMsg | string | Uint8Array, except?: string) {
    for (const m of this.members.values()) if (m.online && m.seat >= 0 && m.id !== except) m.conn?.send(msg);
  }

  private broadcastSeats() {
    const g = this.game;
    if (!g) return;
    this.sendSeated({ t: 'seats', seats: this.seatInfos() });
    // The server plays every seat without a human; a human's mallet goes where their positions say.
    g.seats.forEach((seat, i) => {
      g.match.setAI(i, seat.ai);
      if (seat.ai !== !g.match.isDriven(i)) return;
      g.match.setDriven(i, !seat.ai);
      g.inputs[i] = newInput();
    });
  }

  /** A player's mallet positions for upcoming ticks: kept until the tick they are for is simulated. */
  private onInput(m: Member, msg: Extract<ClientMsg, { t: 'in' }>) {
    const g = this.game;
    if (!g || m.seat < 0 || g.seats[m.seat].ai) return;
    const { tick, m: pos } = msg;
    if (!Number.isInteger(tick) || !Array.isArray(pos) || pos.length < 2 || pos.length % 2) return;
    const inp = g.inputs[m.seat];
    // The first of these is needed soonest: how early it came is what the client tunes its clock by.
    inp.slack = Math.min(inp.slack, tick - (g.tick + 1));
    for (let i = 0; i + 1 < pos.length; i += 2) {
      const t = tick + i / 2;
      const x = pos[i];
      const y = pos[i + 1];
      if (t <= g.tick || t > g.tick + MAX_AHEAD || !Number.isFinite(x) || !Number.isFinite(y)) continue;
      inp.pending.set(t, [x, y]);
    }
    // Late: those ticks are gone, but the newest position still tells where the mallet is now.
    const last = tick + pos.length / 2 - 1;
    if (last <= g.tick) inp.pending.set(g.tick + 1, [pos[pos.length - 2], pos[pos.length - 1]]);
  }

  /** Each human mallet's position for this tick: inside its zone and no faster than any mallet can move. */
  private feedInputs(g: Game) {
    g.inputs.forEach((inp, seat) => {
      if (!g.match.isDriven(seat)) return;
      const p = inp.pending.get(g.tick);
      for (const t of inp.pending.keys()) if (t <= g.tick) inp.pending.delete(t);
      if (g.tick % SLACK_WINDOW === 0) {
        inp.slackPrev = inp.slack;
        inp.slack = Infinity;
      }
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return; // no news: it stands still
      const mallet = g.match.mallets[seat];
      let x = p[0];
      let y = p[1];
      const c = mallet.clamp({ x, y });
      if (Math.hypot(c.x - x, c.y - y) > 0.01) ({ x, y } = c);
      const dx = x - mallet.pos.x;
      const dy = y - mallet.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > MAX_DRIVE_STEP) {
        x = mallet.pos.x + (dx / d) * MAX_DRIVE_STEP;
        y = mallet.pos.y + (dy / d) * MAX_DRIVE_STEP;
      }
      g.match.drive(seat, { x, y });
    });
  }

  private loop() {
    const g = this.game;
    if (!g) return;
    const now = performance.now();
    const elapsed = (now - g.last) / 1000;
    g.last = now;
    if (g.paused.size > 0) this.drainBudgets(g, elapsed);
    g.acc = Math.min(g.acc + elapsed, MAX_CATCHUP);
    while (g.acc >= DT) {
      g.acc -= DT;
      g.tick++;
      this.feedInputs(g);
      // Paused or counting down: mallets move, the puck stands still.
      if (g.paused.size > 0) g.match.moveMallets(DT);
      else if (g.countdown > 0) {
        g.countdown = Math.max(0, g.countdown - DT);
        g.match.moveMallets(DT);
      } else g.match.step(DT);
      // Events first: a client takes a predicted hit the state comes without as one that didn't happen.
      this.flush(g);
      if (g.tick % STATE_EVERY === 0) this.sendSeated(encodeState(this.state(g)));
      if (g.match.done) {
        this.flush(g);
        this.endGame('score', g.match.winner);
        return;
      }
    }
    this.flush(g);
  }

  /** What happened since the last flush: hits, loud wall bounces, goals, serves. */
  private flush(g: Game) {
    for (const h of g.events.splice(0)) {
      const e = h.e;
      if (e.t === 'hit') this.sendSeated(encodeHit(e.s, h.tick, e.i));
      else if (e.t === 'wall') this.sendSeated(encodeWall(h.tick, e.i));
      else if (e.t === 'goal') this.sendSeated({ t: 'goal', s: e.s, c: e.c, sc: e.sc, tick: h.tick });
      else if (e.t === 'serve') this.sendSeated({ t: 'serve', s: e.s, p: h.p, tick: h.tick });
    }
  }

  /** Back to the room lobby. `winner` is a seat index, or -1. */
  private endGame(reason: 'score' | 'forfeit', winner: number) {
    const g = this.game;
    if (!g) return;
    clearInterval(g.timer);
    this.game = null;
    this.status = 'lobby';
    const over: ServerMsg = {
      t: 'over',
      winner,
      scores: [...g.match.scores],
      seats: g.seats.map((s) => ({ id: s.id, name: s.name, color: s.color, ai: s.ai })),
      reason,
    };
    for (const m of this.members.values()) if (m.online) m.conn?.send(over);
    for (const m of [...this.members.values()]) {
      m.ready = false;
      m.seat = -1;
      if (!m.online) {
        if (m.grace) clearTimeout(m.grace);
        this.members.delete(m.id);
      }
    }
    if (this.members.size === 0) {
      this.close();
      return;
    }
    if (!this.members.has(this.hostId)) this.transferHost();
    this.changed();
  }

  /** A seat just turned into AI: end the game if too few humans remain, else carry on. */
  private afterSeatLoss() {
    const g = this.game;
    if (!g) return;
    const humans = g.seats.map((s, i) => (s.ai ? -1 : i)).filter((i) => i >= 0);
    if (humans.length <= 1) {
      this.endGame('forfeit', humans.length === 1 ? humans[0] : -1);
      return;
    }
    this.prunePause(g);
    this.fillSeats(false);
    this.broadcastSeats();
    this.changed();
  }

  /**
   * Waiting members take AI seats: first those whose owner is gone for good, then those whose
   * owner is offline. Returns whether any seat changed hands.
   */
  private fillSeats(announce = true): boolean {
    const g = this.game;
    if (!g) return false;
    let changed = false;
    for (const m of this.members.values()) {
      if (!m.online || m.seat >= 0 || g.seatBanned.has(m.id)) continue;
      const open = g.seats.map((s, i) => ({ s, i })).filter((x) => x.s.ai);
      const owner = (x: { s: Seat }) => (x.s.id ? this.members.get(x.s.id) : undefined);
      const pick = open.find((x) => !owner(x)) ?? open.find((x) => owner(x) && !owner(x)!.online);
      if (!pick) break;
      const prev = owner(pick);
      if (prev) prev.seat = -1;
      pick.s.id = m.id;
      pick.s.name = m.name;
      pick.s.color = m.color;
      pick.s.ai = false;
      m.seat = pick.i;
      changed = true;
      this.sendStart(m);
    }
    if (changed && announce) {
      this.broadcastSeats();
      this.changed();
    }
    return changed;
  }

  // --- pause and kick ----------------------------------------------------------

  private isSeatedHuman(g: Game, id: string) {
    const m = this.members.get(id);
    return !!m && m.online && m.seat >= 0 && g.seats[m.seat]?.id === id && !g.seats[m.seat].ai;
  }

  private eligibleVoters(g: Game, target: string) {
    return [...this.members.keys()].filter((id) => id !== target && !g.paused.has(id) && this.isSeatedHuman(g, id));
  }

  private pause(m: Member) {
    const g = this.game;
    if (!g || !this.isSeatedHuman(g, m.id) || g.paused.has(m.id)) return;
    g.paused.add(m.id);
    if (!g.budgets.has(m.id)) g.budgets.set(m.id, this.cfg.pauseBudget);
    this.pauseChanged(g);
  }

  private resume(m: Member) {
    const g = this.game;
    if (!g || !g.paused.has(m.id)) return;
    g.paused.delete(m.id);
    g.votes.delete(m.id);
    this.pauseChanged(g, g.paused.size === 0 ? this.restartClock(g) : 0);
  }

  /** After the last pause ends: countdown before the puck moves again. Returns its length in seconds. */
  private restartClock(g: Game) {
    g.countdown = this.cfg.countdown;
    return this.cfg.countdown;
  }

  /** Drop paused players who are gone, and start the countdown if nobody is paused any more. */
  private prunePause(g: Game) {
    const before = g.paused.size;
    for (const id of [...g.paused]) {
      if (!this.isSeatedHuman(g, id)) {
        g.paused.delete(id);
        g.votes.delete(id);
      }
    }
    for (const v of g.votes.values()) for (const id of [...v]) if (!this.isSeatedHuman(g, id)) v.delete(id);
    this.pauseChanged(g, before > 0 && g.paused.size === 0 ? this.restartClock(g) : 0);
  }

  private drainBudgets(g: Game, elapsed: number) {
    let spent = false;
    for (const id of g.paused) {
      const left = g.budgets.get(id) ?? 0;
      if (left <= 0) continue;
      const next = Math.max(0, left - elapsed);
      g.budgets.set(id, next);
      if (next === 0) spent = true;
    }
    if (spent) this.pauseChanged(g);
  }

  private pauseEntries(g: Game): PauseEntry[] {
    return [...g.paused].map((id) => {
      const left = g.budgets.get(id) ?? 0;
      const voters = new Set(this.eligibleVoters(g, id));
      return {
        id,
        name: this.members.get(id)?.name ?? '',
        left: round1(left),
        kickable: left <= 0,
        votes: [...(g.votes.get(id) ?? [])].filter((v) => voters.has(v)),
        need: Math.floor(voters.size / 2) + 1,
      };
    });
  }

  private pauseChanged(g: Game, cd = 0) {
    this.sendSeated({ t: 'pause', paused: this.pauseEntries(g), cd });
    this.evaluateKicks(g);
  }

  private vote(voter: Member, target: unknown) {
    const g = this.game;
    if (!g || typeof target !== 'string' || !g.paused.has(target)) return;
    if ((g.budgets.get(target) ?? 0) > 0) return;
    if (!this.eligibleVoters(g, target).includes(voter.id)) return;
    let v = g.votes.get(target);
    if (!v) g.votes.set(target, (v = new Set()));
    v.add(voter.id);
    this.pauseChanged(g);
  }

  private evaluateKicks(g: Game) {
    for (const e of this.pauseEntries(g)) {
      if (e.kickable && e.votes.length >= e.need) {
        this.removeMember(e.id, 'kicked');
        return;
      }
    }
  }

  // --- broadcast ---------------------------------------------------------------

  private memberInfos(): MemberInfo[] {
    return [...this.members.values()].map((m) => ({
      id: m.id,
      name: m.name,
      color: m.color,
      ready: m.ready,
      online: m.online,
      seat: m.seat,
    }));
  }

  roomMsg(): ServerMsg {
    return {
      t: 'room',
      id: this.id,
      public: this.public,
      quick: this.quick,
      fresh: this.quick && !this.autoStarted,
      cap: this.cap,
      host: this.hostId,
      status: this.status,
      settings: { ...this.settings },
      members: this.memberInfos(),
    };
  }

  /** Something about the room changed: tell members and the lobby list. */
  changed() {
    if (this.closed) return;
    const json = JSON.stringify(this.roomMsg());
    for (const m of this.members.values()) m.conn?.send(json);
    this.hub.roomChanged(this);
  }

  /** Public-list entry, or null when the room isn't listed. */
  summary(): LobbyRoom | null {
    if (!this.public || this.quick || this.members.size === 0) return null;
    return {
      id: this.id,
      host: this.members.get(this.hostId)?.name ?? '',
      players: this.members.size,
      cap: this.cap,
      status: this.status,
      winScore: this.settings.winScore,
      malletScale: this.settings.malletScale,
    };
  }

  /** Stop everything; remaining members are told the room closed. */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.game) clearInterval(this.game.timer);
    this.game = null;
    for (const m of this.members.values()) {
      if (m.grace) clearTimeout(m.grace);
      if (m.conn) {
        if (m.conn.room === this) m.conn.room = null;
        m.conn.send({ t: 'left', reason: 'closed' });
      }
    }
    this.members.clear();
    this.hub.roomClosed(this);
  }
}

export const defaultSettings = (): RoomSettings => ({ ...DEFAULT_ROOM });
