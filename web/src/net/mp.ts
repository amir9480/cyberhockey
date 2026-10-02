import type { LeftReason, LobbyRoom, PauseEntry, SeatInfo, ServerMsg } from '@airhockey/shared/protocol';
import { clampMalletScale, clampWinScore } from '@airhockey/shared/room';
import { PALETTE_HEX } from '../game/colors';
import type { Countdown } from '../game/countdown';
import type { Input } from '../game/input';
import type { View } from '../game/view';
import { NetGame } from './netgame';
import { Socket } from './socket';

type RoomMsg = Extract<ServerMsg, { t: 'room' }>;
type StartMsg = Extract<ServerMsg, { t: 'start' }>;
type OverMsg = Extract<ServerMsg, { t: 'over' }>;

export type MpScreen = 'lobby' | 'room' | 'menu' | 'game';

/** One seat in the in-game scoreboard. */
export interface Standing {
  seat: number;
  name: string;
  /** Palette index. */
  color: number;
  score: number;
  ai: boolean;
  /** Round trip in ms; 0 for an AI or when not known. */
  ping: number;
  me: boolean;
}

export interface MpDeps {
  view: View;
  input: Input;
  /** Which overlay shows. 'game' hides them all; 'menu' is the in-game pause menu. */
  setScreen(s: MpScreen): void;
  /** Starts input and the local simulation for a running online game. */
  engage(): void;
  disengage(): void;
  lockPointer(): void;
  /** Needs a user gesture; rejects when the browser refuses. */
  /** False where fullscreen isn't available (or is switched off for debugging): play happens without it. */
  canFullscreen: boolean;
  goFullscreen(): Promise<void>;
  /** Back to the start screen. */
  exit(): void;
  countdown: Countdown;
}

const ROOM_KEY = 'airhockey.room';

/** The room this player was last in (to go straight back to on a fresh start), or null. */
export function savedRoom(): string | null {
  try {
    return localStorage.getItem(ROOM_KEY);
  } catch {
    return null;
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
const clock = (secs: number) => {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The multiplayer client: lobby and room screens, the socket, the online game and its pause/result UI. */
export class Multiplayer {
  readonly socket = new Socket();
  private myId = '';
  private room: RoomMsg | null = null;
  private wantedRoom: string | null = null;
  /** Rejoining the saved room on a fresh start: if it's gone, back to the start screen rather than the lobby. */
  private autoJoin = false;
  private game: NetGame | null = null;
  private seats: SeatInfo[] = [];
  /** Each seat's player round trip, ms, from the server. */
  private pings: number[] = [];
  private open = false;
  /** An online game is running and this client holds a seat. */
  private active = false;
  private selfPaused = false;
  private showingResult = false;
  private pauses: PauseEntry[] = [];
  private pausesAt = 0;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private createPublic = true;

  private roomList = $('roomList');
  private lobbyNote = $('lobbyNote');
  private members = $('members');
  private roomNote = $('roomNote');
  private roomStatus = $('roomStatus');
  private swatches: HTMLButtonElement[] = [];
  private result = $('result');
  private banner = $('banner');
  private bannerText = $('bannerText');
  private voteBtn = $('voteBtn') as HTMLButtonElement;
  private hint = $('hint');
  private toastEl = $('toast');
  private pauseLeft = $('pauseLeft');

  constructor(private deps: MpDeps) {
    const { socket } = this;
    socket.onMessage = (m) => this.onMessage(m);
    socket.onOpen = () => {
      this.setNote(this.lobbyNote, '');
      if (this.wantedRoom) socket.send({ t: 'join', room: this.wantedRoom });
      socket.send({ t: 'lobby' });
    };
    socket.onClose = () => {
      if (!this.open) return;
      const msg = 'Connection lost, reconnecting…';
      if (this.active) this.toast(msg);
      else this.setNote(this.lobbyNote, msg, true);
    };
    this.bindLobby();
    this.bindRoom();
    this.bindGame();
  }

  /** Round-trip time in ms, or 0 when unknown. */
  get ping() {
    return this.socket.rtt;
  }

  /** The running game's seats with scores and pings, or null when there is none. */
  standings(): Standing[] | null {
    const g = this.game;
    const scores = this.deps.view.match?.scores;
    if (!g || !this.active || !scores) return null;
    return this.seats.map((s, i) => {
      const me = i === g.localSeat;
      return {
        seat: i,
        name: s.ai ? 'AI' : s.name,
        color: s.color,
        score: scores[i] ?? 0,
        ai: s.ai,
        ping: s.ai ? 0 : me ? this.socket.rtt : (this.pings[i] ?? 0),
        me,
      };
    });
  }

  get isOpen() {
    return this.open;
  }

  /** True when a click on the canvas should grab the pointer (or fullscreen) for the game. */
  get wantsGrab() {
    return this.active && !this.selfPaused && !this.showingResult;
  }

  // --- lifecycle -------------------------------------------------------------

  /** Enter multiplayer; `room` joins that room straight away (`auto`: on a fresh start, not by the player's choice). */
  enter(room: string | null, auto = false) {
    this.open = true;
    this.wantedRoom = room;
    this.autoJoin = auto && !!room;
    this.room = null;
    document.body.classList.add('mp');
    this.setNote(this.lobbyNote, room ? 'Joining room…' : '');
    this.deps.setScreen('lobby');
    this.socket.connect();
  }

  /** Leave multiplayer completely (back to the start screen). */
  exit() {
    if (!this.open) return;
    this.open = false;
    this.endGameUi();
    this.socket.send({ t: 'leave' });
    this.socket.close();
    this.room = null;
    this.wantedRoom = null;
    this.showingResult = false;
    this.result.hidden = true;
    this.setUrl(null);
    document.body.classList.remove('mp');
    this.deps.exit();
  }

  /** The player saved a new name. */
  rename(name: string) {
    if (this.open) this.socket.send({ t: 'name', name });
  }

  private setUrl(room: string | null) {
    const url = new URL(location.href);
    url.searchParams.delete('players');
    if (room) url.searchParams.set('room', room);
    else url.searchParams.delete('room');
    history.replaceState(null, '', url);
    try {
      if (room) localStorage.setItem(ROOM_KEY, room);
      else localStorage.removeItem(ROOM_KEY);
    } catch {
      /* storage unavailable: a fresh start just won't rejoin */
    }
  }

  private toast(text: string, ms = 3500) {
    this.toastEl.textContent = text;
    this.toastEl.hidden = false;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toastEl.hidden = true), ms);
  }

  private setNote(node: HTMLElement, text: string, warn = false) {
    node.textContent = text;
    node.classList.toggle('warn', warn);
  }

  // --- server messages -------------------------------------------------------

  private onMessage(m: ServerMsg) {
    switch (m.t) {
      case 'hello':
        this.myId = m.id;
        break;
      case 'st':
        this.game?.state(m);
        break;
      case 'lobby':
        this.renderRoomList(m.rooms);
        break;
      case 'room':
        this.onRoom(m);
        break;
      case 'start':
        this.onStart(m);
        break;
      case 'seats':
        this.seats = m.seats;
        this.game?.setSeats(m.seats);
        break;
      case 'pings':
        this.pings = m.p;
        break;
      case 'pause':
        this.game?.pauseChanged(m);
        this.onPause(m.paused);
        break;
      case 'hit':
        this.game?.hit(m);
        break;
      case 'goal':
        this.game?.goal(m);
        break;
      case 'serve':
        this.game?.serve(m);
        break;
      case 'wall':
        this.game?.wall(m);
        break;
      case 'over':
        this.onOver(m);
        break;
      case 'left':
        this.onLeft(m.reason);
        break;
      case 'error':
        this.onError(m.code, m.msg);
        break;
    }
  }

  private onRoom(m: RoomMsg) {
    this.room = m;
    this.wantedRoom = m.id;
    this.autoJoin = false;
    this.setUrl(m.id);
    this.renderRoom();
    if (this.showingResult) this.renderResultActions();
    if (this.active || this.showingResult) return;
    this.deps.setScreen('room');
  }

  private onStart(m: StartMsg) {
    this.seats = m.seats;
    this.pings = [];
    this.showingResult = false;
    this.result.hidden = true;
    if (this.game) this.game.restart(m);
    else {
      this.game = new NetGame(this.deps.view, this.socket, m);
      this.game.onCountdown = (cd) => this.showCountdown(cd);
    }
    this.active = true;
    this.selfPaused = false;
    this.pauses = [];
    this.deps.engage();
    this.deps.setScreen('game');
    this.renderPause();
    // Browsers only allow fullscreen from a click; this works when the player clicked recently, else the hint shows.
    this.deps.goFullscreen().then(
      () => this.deps.lockPointer(),
      () => {},
    );
    this.updateHint();
    this.ensureTicker();
  }

  private onPause(list: PauseEntry[]) {
    this.pauses = list;
    this.pausesAt = performance.now();
    if (list.length) this.deps.countdown.clear();
    if (list.some((p) => p.id !== this.myId) && document.pointerLockElement) document.exitPointerLock();
    this.renderPause();
  }

  private onOver(m: OverMsg) {
    this.endGameUi();
    this.showingResult = true;
    const mine = this.game?.localSeat ?? -1;
    this.game?.stop();
    this.game = null;
    const title = $('resultTitle');
    const winner = m.seats[m.winner] ?? this.seats[m.winner];
    const won = m.winner >= 0 && m.winner === mine;
    title.textContent = m.winner < 0 ? 'GAME OVER' : won ? 'YOU WIN' : `${(winner?.name ?? 'PLAYER').toUpperCase()} WINS`;
    this.result.className = won ? 'win' : 'lose';
    $('resultScore').textContent = '';
    const names = $('resultNames');
    names.replaceChildren(
      ...m.seats.map((s, i) => {
        const row = el('div', 'row');
        const dot = el('span', 'dot');
        dot.style.setProperty('--c', css(PALETTE_HEX[s.color] ?? 0xffffff));
        row.append(dot, el('span', 'grow', s.name), el('b', '', String(m.scores[i] ?? 0)));
        return row;
      }),
    );
    names.hidden = false;
    const note = $('resultNote');
    note.textContent = m.reason === 'forfeit' ? 'Opponents left' : '';
    note.hidden = m.reason !== 'forfeit';
    this.result.hidden = false;
    this.deps.setScreen('game');
    this.renderResultActions();
    const isHost = this.room?.host === this.myId;
    $(isHost ? 'again' : 'toMenu').focus({ preventScroll: true });
  }

  /** After a game the host restarts or leaves (which ends the room); everyone else waits for them or leaves. */
  private renderResultActions() {
    const isHost = !!this.room && this.room.host === this.myId;
    const again = $<HTMLButtonElement>('again');
    again.hidden = !isHost;
    again.textContent = 'RESTART';
    $('toMenu').textContent = 'LEAVE';
    const wait = $('resultWait');
    wait.hidden = isHost;
    wait.textContent = 'WAITING FOR THE HOST…';
  }

  private onLeft(reason: LeftReason) {
    if (!this.open) return;
    this.endGameUi();
    this.game?.stop();
    this.game = null;
    this.room = null;
    this.wantedRoom = null;
    this.showingResult = false;
    this.result.hidden = true;
    this.setUrl(null);
    if (reason === 'replaced' || reason === 'hostLeft' || reason === 'closed') {
      this.toast(
        reason === 'replaced' ? 'This room was opened in another tab' : reason === 'hostLeft' ? 'The host left the room' : 'The room was closed',
      );
      this.exit();
      return;
    }
    if (reason === 'kicked') this.toast('You were removed from the room');
    this.deps.setScreen('lobby');
  }

  private onError(code: string, msg: string) {
    if ((code === 'not_found' || code === 'full' || code === 'kicked') && !this.room) {
      this.wantedRoom = null;
      this.setUrl(null);
      if (this.autoJoin) {
        this.toast(msg);
        this.exit();
        return;
      }
      this.setNote(this.lobbyNote, msg, true);
      this.deps.setScreen('lobby');
      return;
    }
    if (code === 'cannot_start' && !this.showingResult) this.setNote(this.roomNote, msg, true);
    else this.toast(msg);
  }

  /** Common cleanup when the game stops for this client. */
  private endGameUi() {
    this.active = false;
    this.selfPaused = false;
    this.pauses = [];
    this.deps.countdown.clear();
    this.banner.hidden = true;
    this.hint.hidden = true;
    document.body.classList.remove('waiting');
    this.deps.disengage();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  // --- lobby -------------------------------------------------------------------

  private bindLobby() {
    const vis = [...document.querySelectorAll<HTMLButtonElement>('#createVis button')];
    for (const b of vis) {
      b.addEventListener('click', () => {
        this.createPublic = b.dataset.v === 'public';
        for (const x of vis) x.setAttribute('aria-pressed', String(x === b));
      });
    }
    $('createRoom').addEventListener('click', () => this.socket.send({ t: 'create', public: this.createPublic }));
    $('quick2').addEventListener('click', () => this.socket.send({ t: 'quick', size: 2 }));
    $('quick4').addEventListener('click', () => this.socket.send({ t: 'quick', size: 4 }));
    $('lobbyBack').addEventListener('click', () => this.exit());
  }

  private renderRoomList(rooms: LobbyRoom[]) {
    if (!rooms.length) {
      this.roomList.replaceChildren(el('div', 'empty', 'No public rooms yet. Create one!'));
      return;
    }
    this.roomList.replaceChildren(
      ...rooms.map((r) => {
        const row = el('div', 'row');
        const info = el('div', 'grow', r.host || 'Room');
        const sub = el('div', 'dim', `${r.status === 'playing' ? 'PLAYING' : 'LOBBY'} · ${r.winScore} PTS · MALLET ${Math.round(r.malletScale * 100)}%`);
        info.append(sub);
        const count = el('span', 'dim', `${r.players}/${r.cap}`);
        const join = el('button', '', 'JOIN');
        join.type = 'button';
        join.disabled = r.players >= r.cap;
        join.addEventListener('click', () => this.socket.send({ t: 'join', room: r.id }));
        row.append(info, count, join);
        return row;
      }),
    );
  }

  // --- room --------------------------------------------------------------------

  private bindRoom() {
    PALETTE_HEX.forEach((hex, i) => {
      const b = el('button');
      b.type = 'button';
      b.style.setProperty('--c', css(hex));
      b.setAttribute('aria-label', `Colour ${i + 1}`);
      b.addEventListener('click', () => this.socket.send({ t: 'color', color: i }));
      $('roomSwatches').appendChild(b);
      this.swatches.push(b);
    });
    const vis = [...document.querySelectorAll<HTMLButtonElement>('#roomVis button')];
    for (const b of vis) b.addEventListener('click', () => this.socket.send({ t: 'settings', public: b.dataset.v === 'public' }));
    const win = $<HTMLInputElement>('roomWin');
    const mallet = $<HTMLInputElement>('roomMallet');
    win.addEventListener('input', () => {
      const v = clampWinScore(Number(win.value));
      $<HTMLOutputElement>('roomWinOut').value = String(v);
    });
    win.addEventListener('change', () => this.socket.send({ t: 'settings', winScore: Number(win.value) }));
    mallet.addEventListener('input', () => {
      $<HTMLOutputElement>('roomMalletOut').value = `${Math.round(clampMalletScale(Number(mallet.value)) * 100)}%`;
    });
    mallet.addEventListener('change', () => this.socket.send({ t: 'settings', malletScale: Number(mallet.value) }));
    $('readyBtn').addEventListener('click', () => {
      const me = this.room?.members.find((x) => x.id === this.myId);
      this.socket.send({ t: 'ready', on: !me?.ready });
    });
    $('startBtn').addEventListener('click', () => {
      this.setNote(this.roomNote, '');
      this.socket.send({ t: 'start' });
    });
    $('leaveRoom').addEventListener('click', () => this.socket.send({ t: 'leave' }));
    const copy = $('copyLink') as HTMLButtonElement;
    copy.addEventListener('click', () => {
      const url = new URL(location.href);
      url.searchParams.delete('players');
      if (this.room) url.searchParams.set('room', this.room.id);
      void navigator.clipboard?.writeText(url.toString()).then(
        () => {
          copy.textContent = 'COPIED';
          setTimeout(() => (copy.textContent = 'COPY LINK'), 1500);
        },
        () => this.toast('Copy failed: copy the address bar instead'),
      );
    });
  }

  /** Why the host can't start yet, or null when they can. */
  private startBlock(r: RoomMsg): string | null {
    const online = r.members.filter((m) => m.online);
    if (r.status !== 'lobby') return 'A game is running';
    if (online.length < 2) return 'Waiting for another player…';
    const waiting = online.find((m) => m.id !== r.host && !m.ready);
    return waiting ? `Waiting for ${waiting.name} to get ready` : null;
  }

  private renderRoom() {
    const r = this.room;
    if (!r) return;
    const me = r.members.find((m) => m.id === this.myId);
    const isHost = r.host === this.myId;
    $('roomId').textContent = r.id;

    this.members.replaceChildren(
      ...r.members.map((m) => {
        const row = el('div', 'row');
        const dot = el('span', 'dot');
        dot.style.setProperty('--c', css(PALETTE_HEX[m.color] ?? 0xffffff));
        row.append(dot, el('span', 'grow', `${m.id === r.host ? '♛ ' : ''}${m.name}`));
        if (m.id === this.myId) row.append(el('span', 'badge you', 'YOU'));
        if (!m.online) row.append(el('span', 'badge off', 'OFFLINE'));
        else if (m.id !== r.host && m.ready) row.append(el('span', 'badge ready', 'READY'));
        if (isHost && m.id !== this.myId && r.status === 'lobby') {
          const kick = el('button', '', 'KICK');
          kick.type = 'button';
          kick.addEventListener('click', () => this.socket.send({ t: 'kick', id: m.id }));
          row.append(kick);
        }
        return row;
      }),
    );

    // Colours: taken ones (held by someone else) are disabled; quick rooms assign them at random.
    $('roomColorsBox').hidden = r.quick;
    const taken = new Set(r.members.filter((m) => m.id !== this.myId).map((m) => m.color));
    const locked = r.status === 'playing' && !!me && me.seat >= 0;
    this.swatches.forEach((b, i) => {
      b.setAttribute('aria-pressed', String(me?.color === i));
      b.disabled = taken.has(i) || locked;
    });

    // Settings: editable by the host in a lobby, read-only otherwise.
    const fresh = r.quick && r.fresh;
    const canEdit = isHost && r.status === 'lobby' && !fresh;
    $('roomVisBox').hidden = r.quick;
    for (const b of document.querySelectorAll<HTMLButtonElement>('#roomVis button')) {
      b.setAttribute('aria-pressed', String((b.dataset.v === 'public') === r.public));
      b.disabled = !canEdit;
    }
    const win = $<HTMLInputElement>('roomWin');
    const mallet = $<HTMLInputElement>('roomMallet');
    win.value = String(r.settings.winScore);
    mallet.value = String(r.settings.malletScale);
    win.disabled = mallet.disabled = !canEdit;
    $('roomWinBox').setAttribute('aria-disabled', String(!canEdit));
    $('roomMalletBox').setAttribute('aria-disabled', String(!canEdit));
    $<HTMLOutputElement>('roomWinOut').value = String(r.settings.winScore);
    $<HTMLOutputElement>('roomMalletOut').value = `${Math.round(r.settings.malletScale * 100)}%`;

    // Status line and action buttons.
    const ready = $('readyBtn') as HTMLButtonElement;
    const start = $('startBtn') as HTMLButtonElement;
    const online = r.members.filter((m) => m.online).length;
    const waitingSeat = r.status === 'playing' && !!me && me.seat < 0;
    if (waitingSeat) this.setNote(this.roomStatus, "Game in progress, you'll join when a seat opens");
    else if (fresh) this.setNote(this.roomStatus, `Waiting for players ${online}/${r.cap}`);
    else this.setNote(this.roomStatus, '');
    ready.hidden = isHost || fresh || r.status !== 'lobby';
    ready.textContent = me?.ready ? 'NOT READY' : 'READY';
    start.hidden = !isHost || fresh || r.status !== 'lobby';
    const block = this.startBlock(r);
    start.disabled = !!block;
    if (isHost && !fresh && r.status === 'lobby') this.setNote(this.roomNote, block ?? 'Everyone is ready');
    else this.setNote(this.roomNote, '');
  }

  // --- game: pause, countdown, results --------------------------------------------

  private bindGame() {
    $('again').addEventListener('click', () => {
      if (this.open && this.showingResult) this.socket.send({ t: 'restart' });
    });
    $('toMenu').addEventListener('click', () => {
      if (this.open) this.exit();
    });
    $('joinPause').addEventListener('click', () => this.selfPause()); // hold the game too, so a resume by the others doesn't catch us off guard
    this.voteBtn.addEventListener('click', () => {
      const target = this.pauses.find((p) => p.id !== this.myId && this.isKickable(p));
      if (target) this.socket.send({ t: 'vote', id: target.id });
    });
  }

  /** The player pressed Esc or left fullscreen: pause for everyone. */
  selfPause() {
    if (!this.active || this.selfPaused || this.showingResult) return;
    this.selfPaused = true;
    this.socket.send({ t: 'pause' });
    this.deps.input.enabled = false;
    this.deps.input.release();
    if (document.pointerLockElement) document.exitPointerLock();
    this.deps.setScreen('menu');
    this.renderPause();
  }

  /** The RESUME button (a click, so fullscreen is allowed). */
  async resumeClick() {
    if (!this.active) return;
    this.deps.view.sound.unlock();
    try {
      await this.deps.goFullscreen();
    } catch {
      /* play anyway */
    }
    this.selfPaused = false;
    this.socket.send({ t: 'resume' });
    this.deps.input.enabled = true;
    this.deps.setScreen('game');
    this.deps.lockPointer();
    this.renderPause();
    this.updateHint();
  }

  /** A click on the canvas during a game: go fullscreen if we aren't, and grab the pointer. */
  grab() {
    if (!this.wantsGrab) return;
    if (!document.fullscreenElement && this.deps.canFullscreen && document.fullscreenEnabled) {
      void this.deps.goFullscreen().then(
        () => this.deps.lockPointer(),
        () => this.deps.lockPointer(),
      );
    } else this.deps.lockPointer();
    this.updateHint();
  }

  onFullscreenChange() {
    if (!document.fullscreenElement && this.deps.canFullscreen) this.selfPause();
    this.updateHint();
  }

  private updateHint() {
    const touch = matchMedia('(pointer: coarse)').matches;
    this.hint.hidden = !(
      this.active &&
      !this.selfPaused &&
      !document.fullscreenElement &&
      this.deps.canFullscreen &&
      document.fullscreenEnabled &&
      !touch
    );
  }

  private showCountdown(cd: number) {
    if (this.active && !this.pauses.length) this.deps.countdown.set(cd);
    else this.deps.countdown.clear();
  }

  private isKickable(p: PauseEntry) {
    return p.kickable || p.left - (performance.now() - this.pausesAt) / 1000 <= 0;
  }

  private ensureTicker() {
    if (!this.ticker) this.ticker = setInterval(() => this.renderPause(), 250);
  }

  private renderPause() {
    const elapsed = (performance.now() - this.pausesAt) / 1000;
    const others = this.pauses.filter((p) => p.id !== this.myId);
    const mine = this.pauses.find((p) => p.id === this.myId);
    if (mine) {
      this.setNote(this.pauseLeft, `PAUSE TIME LEFT ${clock(mine.left - elapsed)}`);
    } else {
      // Budget left isn't known to a player who isn't paused; show the full-game rule.
      this.setNote(this.pauseLeft, this.selfPaused ? 'PAUSING…' : '');
    }
    const show = this.active && !this.selfPaused && others.length > 0;
    document.body.classList.toggle('waiting', show);
    this.banner.hidden = !show;
    if (!show) return;
    const first = others[0];
    this.bannerText.textContent = `PAUSED BY ${others.map((p) => p.name.toUpperCase()).join(', ')} · ${clock(first.left - elapsed)}`;
    const kickable = others.find((p) => this.isKickable(p));
    this.voteBtn.hidden = !kickable;
    if (kickable) {
      this.voteBtn.textContent = `VOTE KICK (${kickable.votes.length}/${kickable.need})`;
      this.voteBtn.disabled = kickable.votes.includes(this.myId);
    }
  }
}
