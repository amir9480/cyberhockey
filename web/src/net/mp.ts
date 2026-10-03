import type { LeftReason, LobbyRoom, PauseEntry, SeatInfo, ServerMsg } from '@airhockey/shared/protocol';
import { PALETTE_SIZE, clampMalletScale, clampWinScore } from '@airhockey/shared/room';
import type { PlayerCount } from '@airhockey/shared/layout';
import { PALETTE_HEX } from '../game/colors';
import { Alpine, css, focusIn, setNote, ui } from '../ui';
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
  /** What the room preview table was last built for (rebuilt only when it changes). */
  private previewKey = '';

  constructor(private deps: MpDeps) {
    const { socket } = this;
    socket.onMessage = (m) => this.onMessage(m);
    socket.onOpen = () => {
      setNote(ui.lobby.note, '');
      if (this.wantedRoom) socket.send({ t: 'join', room: this.wantedRoom });
      socket.send({ t: 'lobby' });
    };
    socket.onClose = () => {
      if (!this.open) return;
      const msg = 'Connection lost, reconnecting…';
      if (this.active) this.toast(msg);
      else setNote(ui.lobby.note, msg, true);
    };
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
    this.previewKey = ''; // single player may have rebuilt the table since
    setNote(ui.lobby.note, room ? 'Joining room…' : '');
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
    ui.result.open = false;
    this.setUrl(null);
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
    ui.toast = text;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (ui.toast = ''), ms);
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
    this.previewKey = '';
    this.showingResult = false;
    ui.result.open = false;
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
    const winner = m.seats[m.winner] ?? this.seats[m.winner];
    const won = m.winner >= 0 && m.winner === mine;
    const r = ui.result;
    r.title = m.winner < 0 ? 'GAME OVER' : won ? 'YOU WIN' : `${(winner?.name ?? 'PLAYER').toUpperCase()} WINS`;
    r.won = won;
    r.score = '';
    r.rows = m.seats.map((s, i) => ({ name: s.name, color: css(PALETTE_HEX[s.color] ?? 0xffffff), score: m.scores[i] ?? 0 }));
    r.note = m.reason === 'forfeit' ? 'Opponents left' : '';
    r.open = true;
    this.deps.setScreen('game');
    this.renderResultActions();
    const isHost = this.room?.host === this.myId;
    void Alpine.nextTick(() => focusIn(isHost ? '#again' : '#toMenu'));
  }

  /** After a game the host restarts or leaves (which ends the room); everyone else waits for them or leaves. */
  private renderResultActions() {
    const isHost = !!this.room && this.room.host === this.myId;
    const r = ui.result;
    r.showAgain = isHost;
    r.againText = 'RESTART';
    r.quitText = 'LEAVE';
    r.wait = isHost ? '' : 'WAITING FOR THE HOST…';
  }

  private onLeft(reason: LeftReason) {
    if (!this.open) return;
    this.endGameUi();
    this.game?.stop();
    this.game = null;
    this.room = null;
    this.wantedRoom = null;
    this.showingResult = false;
    ui.result.open = false;
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
      setNote(ui.lobby.note, msg, true);
      this.deps.setScreen('lobby');
      return;
    }
    if (code === 'cannot_start' && !this.showingResult) setNote(ui.room.note, msg, true);
    else this.toast(msg);
  }

  /** Common cleanup when the game stops for this client. */
  private endGameUi() {
    this.active = false;
    this.selfPaused = false;
    this.pauses = [];
    this.deps.countdown.clear();
    ui.banner.open = false;
    ui.hint = false;
    ui.waiting = false;
    this.deps.disengage();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }

  // --- lobby -------------------------------------------------------------------

  createRoom() {
    this.socket.send({ t: 'create', public: ui.lobby.createPublic });
  }

  quickPlay(size: 2 | 4) {
    this.socket.send({ t: 'quick', size });
  }

  joinRoom(id: string) {
    this.socket.send({ t: 'join', room: id });
  }

  private renderRoomList(rooms: LobbyRoom[]) {
    ui.lobby.rooms = rooms.map((r) => ({
      id: r.id,
      host: r.host || 'Room',
      sub: `${r.status === 'playing' ? 'PLAYING' : 'LOBBY'} · ${r.winScore} PTS · MALLET ${Math.round(r.malletScale * 100)}%`,
      count: `${r.players}/${r.cap}`,
      full: r.players >= r.cap,
    }));
  }

  // --- room --------------------------------------------------------------------

  pickColor(color: number) {
    this.socket.send({ t: 'color', color });
  }

  setVisibility(pub: boolean) {
    this.socket.send({ t: 'settings', public: pub });
  }

  /** Dragging the points slider: show the value; the room takes it on release. */
  previewWinScore(v: number) {
    ui.room.winScore = clampWinScore(v);
  }

  setWinScore(v: number) {
    this.socket.send({ t: 'settings', winScore: v });
  }

  /** Dragging the mallet slider: resize the preview at once; the room follows on release. */
  previewMalletScale(v: number) {
    const scale = clampMalletScale(v);
    ui.room.malletScale = scale;
    this.deps.view.setRoom({ malletScale: scale });
  }

  setMalletScale(v: number) {
    this.socket.send({ t: 'settings', malletScale: v });
  }

  toggleReady() {
    const me = this.room?.members.find((x) => x.id === this.myId);
    this.socket.send({ t: 'ready', on: !me?.ready });
  }

  startGame() {
    setNote(ui.room.note, '');
    this.socket.send({ t: 'start' });
  }

  leaveRoom() {
    this.socket.send({ t: 'leave' });
  }

  kick(id: string) {
    this.socket.send({ t: 'kick', id });
  }

  copyLink() {
    const url = new URL(location.href);
    url.searchParams.delete('players');
    if (this.room) url.searchParams.set('room', this.room.id);
    void navigator.clipboard?.writeText(url.toString()).then(
      () => {
        ui.room.copyText = 'COPIED';
        setTimeout(() => (ui.room.copyText = 'COPY LINK'), 1500);
      },
      () => this.toast('Copy failed: copy the address bar instead'),
    );
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
    const v = ui.room;
    v.id = r.id;
    v.members = r.members.map((m) => ({
      id: m.id,
      name: `${m.id === r.host ? '♛ ' : ''}${m.name}`,
      color: css(PALETTE_HEX[m.color] ?? 0xffffff),
      you: m.id === this.myId,
      offline: !m.online,
      ready: m.online && m.id !== r.host && m.ready,
      kickable: isHost && m.id !== this.myId && r.status === 'lobby',
    }));

    // Colours: taken ones (held by someone else) are disabled; quick rooms assign them at random.
    v.showColors = !r.quick;
    v.taken = r.members.filter((m) => m.id !== this.myId).map((m) => m.color);
    v.colorsLocked = r.status === 'playing' && !!me && me.seat >= 0;
    v.myColor = me?.color ?? -1;

    // Settings: editable by the host in a lobby, read-only otherwise.
    const fresh = r.quick && r.fresh;
    v.canEdit = isHost && r.status === 'lobby' && !fresh;
    v.showVis = !r.quick;
    v.isPublic = r.public;
    v.winScore = r.settings.winScore;
    v.malletScale = r.settings.malletScale;
    this.preview(r);

    // Status line and action buttons.
    const online = r.members.filter((m) => m.online).length;
    const waitingSeat = r.status === 'playing' && !!me && me.seat < 0;
    if (waitingSeat) setNote(v.status, "Game in progress, you'll join when a seat opens");
    else if (fresh) setNote(v.status, `Waiting for players ${online}/${r.cap}`);
    else setNote(v.status, '');
    v.showReady = !isHost && !fresh && r.status === 'lobby';
    v.readyText = me?.ready ? 'NOT READY' : 'READY';
    v.showStart = isHost && !fresh && r.status === 'lobby';
    const block = this.startBlock(r);
    v.startBlocked = !!block;
    if (v.showStart) setNote(v.note, block ?? 'Everyone is ready');
    else setNote(v.note, '');
  }

  /**
   * Behind the room screen: the table the game would start on now, seats in join order (the server seats players
   * that way), this player at the bottom, the room's mallet size.
   */
  private preview(r: RoomMsg) {
    if (this.active || this.showingResult) return;
    const online = r.members.filter((m) => m.online).slice(0, 4);
    const n = Math.min(4, Math.max(2, online.length)) as PlayerCount;
    const colors = online.map((m) => m.color);
    for (let c = 0; colors.length < n && c < PALETTE_SIZE; c++) if (!colors.includes(c)) colors.push(c); // empty seats
    const local = Math.max(0, online.findIndex((m) => m.id === this.myId));
    const key = `${n}|${local}|${colors.join(',')}`;
    const view = this.deps.view;
    if (key !== this.previewKey) {
      this.previewKey = key;
      view.setupNet(n, local, colors, r.settings);
    } else view.setRoom(r.settings);
  }

  // --- game: pause, countdown, results --------------------------------------------

  /** The result screen's RESTART (host only). */
  again() {
    if (this.open && this.showingResult) this.socket.send({ t: 'restart' });
  }

  /** PAUSE TOO: hold the game too, so a resume by the others doesn't catch us off guard. */
  joinPause() {
    this.selfPause();
  }

  voteKick() {
    const target = this.pauses.find((p) => p.id !== this.myId && this.isKickable(p));
    if (target) this.socket.send({ t: 'vote', id: target.id });
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
    ui.hint = !!(
      this.active &&
      !this.selfPaused &&
      !document.fullscreenElement &&
      this.deps.canFullscreen &&
      document.fullscreenEnabled &&
      !touch
    );
  }

  /** Each frame of a countdown (0 once it ends): the numbers and the camera cinematic. Paused: both stop at once. */
  private showCountdown(cd: number) {
    if (this.active && !this.pauses.length && !this.selfPaused) {
      this.deps.countdown.set(cd);
      this.deps.view.cinematic(cd);
    } else {
      this.deps.countdown.clear();
      this.deps.view.stopCinematic();
    }
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
      ui.pauseLeft = `PAUSE TIME LEFT ${clock(mine.left - elapsed)}`;
    } else {
      // Budget left isn't known to a player who isn't paused; show the full-game rule.
      ui.pauseLeft = this.selfPaused ? 'PAUSING…' : '';
    }
    const show = this.active && !this.selfPaused && others.length > 0;
    ui.waiting = show;
    const b = ui.banner;
    b.open = show;
    if (!show) return;
    const first = others[0];
    b.text = `PAUSED BY ${others.map((p) => p.name.toUpperCase()).join(', ')} · ${clock(first.left - elapsed)}`;
    const kickable = others.find((p) => this.isKickable(p));
    b.vote.show = !!kickable;
    if (kickable) {
      b.vote.text = `VOTE KICK (${kickable.votes.length}/${kickable.need})`;
      b.vote.disabled = kickable.votes.includes(this.myId);
    }
  }
}
