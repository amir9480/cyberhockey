import type { LeftReason, LobbyRoom, P2pLobbyRoom, PauseEntry, SeatInfo, ServerMsg } from '@airhockey/shared/protocol';
import { PALETTE_SIZE, clampMalletScale, clampWinScore } from '@airhockey/shared/room';
import type { PlayerCount } from '@airhockey/shared/layout';
import { PALETTE_HEX } from '../game/colors';
import { gameEnded, gameStarted } from '../analytics';
import { platform, type RoomRef } from '../platform';
import { Alpine, css, focusIn, setNote, ui, type LobbyRow } from '../ui';
import type { Countdown } from '../game/countdown';
import type { Input } from '../game/input';
import type { View } from '../game/view';
import { P2pMode, ServerMode, type LostReason, type NetKind, type NetMode } from './modes';
import { NetGame } from './netgame';
import { Prober } from './probe';
import { Signaler } from './rtc';
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
const NET_KEY = 'airhockey.net';

export type { RoomRef };

/** The room this page was opened for (a link, an invite), or the one this player was last in (to go straight back to). */
export function savedRoom(): RoomRef | null {
  const linked = platform.linkedRoom();
  if (linked) return linked;
  try {
    const raw = localStorage.getItem(ROOM_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as Partial<RoomRef>;
    return (r.kind === 'server' || r.kind === 'p2p') && typeof r.id === 'string' ? { kind: r.kind, id: r.id } : null;
  } catch {
    return null;
  }
}

/** The lobby tab the player last used. */
function savedKind(): NetKind {
  try {
    return localStorage.getItem(NET_KEY) === 'p2p' ? 'p2p' : 'server';
  } catch {
    return 'server';
  }
}

/** A ping label and how good it is. */
function pingLabel(ms: number): { text: string; level: LobbyRow['level'] } {
  return { text: `${ms} ms`, level: ms < 80 ? 'good' : ms < 160 ? 'ok' : 'bad' };
}

const clock = (secs: number) => {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * The multiplayer client: lobby and room screens, the online game and its pause/result UI. Rooms are reached through
 * a `NetMode` (the server, or P2P); the server socket stays open either way, for the lobby list and P2P introductions.
 */
export class Multiplayer {
  readonly socket = new Socket();
  private sig = new Signaler(this.socket);
  private prober = new Prober(this.sig);
  private mode: NetMode;
  private myId = '';
  private screen: MpScreen = 'lobby';
  private lobbyTicker: ReturnType<typeof setInterval> | null = null;
  private p2pRooms: P2pLobbyRoom[] = [];
  private room: RoomMsg | null = null;
  private wantedRoom: string | null = null;
  /** Rejoining the saved room on a fresh start: if it's gone, back to the start screen rather than the lobby. */
  private autoJoin = false;
  /** Make a private room as soon as the server connection is up. */
  private createOnOpen = false;
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
    this.mode = this.makeMode(savedKind());
    ui.lobby.tab = this.mode.kind;
    socket.onMessage = (m) => {
      if (m.t === 'lobby') return this.onLobby(m.rooms, m.p2p ?? []);
      if (m.t === 'signal') return this.sig.receive(m);
      if (m.t === 'hello') this.myId = m.id;
      this.mode.fromServer(m);
    };
    socket.onOpen = () => {
      setNote(ui.lobby.note, '');
      this.mode.serverOpened(this.wantedRoom);
      if (this.createOnOpen) {
        this.createOnOpen = false;
        this.mode.create(false);
      }
      socket.send({ t: 'lobby' });
    };
    socket.onClose = () => {
      if (!this.open) return;
      // A P2P room doesn't need the server once everyone is connected.
      if (this.mode.kind === 'p2p' && this.room) return;
      const msg = socket.idle ? 'Disconnected for inactivity. Click anywhere to reconnect.' : 'Connection lost, reconnecting…';
      if (this.active) this.toast(msg);
      else setNote(ui.lobby.note, msg, true);
    };
    this.prober.onChange = () => this.renderP2pList();
  }

  private makeMode(kind: NetKind): NetMode {
    const mode = kind === 'p2p' ? new P2pMode(this.socket, this.sig) : new ServerMode(this.socket);
    mode.onMessage = (m) => this.onMessage(m);
    mode.onLost = (why) => this.onLost(why);
    return mode;
  }

  /** The lobby's tab: rooms on the server, or P2P rooms. Only from the lobby (not while in a room). */
  setKind(kind: NetKind) {
    ui.lobby.tab = kind;
    try {
      localStorage.setItem(NET_KEY, kind);
    } catch {
      /* the tab just won't be remembered */
    }
    if (kind === this.mode.kind) return;
    this.mode.dispose();
    this.mode = this.makeMode(kind);
    setNote(ui.lobby.note, '');
    this.updateProbing();
  }

  /** Round-trip time to whatever runs the game, in ms, or 0 when unknown (or when this player hosts it). */
  get ping() {
    return this.mode.link.rtt;
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
        ping: s.ai ? 0 : me ? this.mode.link.rtt : (this.pings[i] ?? 0),
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

  /**
   * Enter multiplayer; `room` joins that room straight away (`auto`: on a fresh start, not by the player's choice).
   * `create`: no room given, make a new private one at once (the platform launched the game straight into multiplayer).
   */
  enter(room: RoomRef | null, auto = false, create = false) {
    this.open = true;
    this.reset();
    if (room) this.setKind(room.kind);
    this.wantedRoom = room?.id ?? null;
    this.autoJoin = auto && !!room;
    this.createOnOpen = create && !room;
    setNote(ui.lobby.note, room ? 'Joining room…' : this.createOnOpen ? 'Setting up your room…' : '');
    this.setScreen('lobby');
    this.socket.connect();
    this.renderServerPing();
    if (!this.lobbyTicker) this.lobbyTicker = setInterval(() => this.renderServerPing(), 1000);
  }

  /** Leave multiplayer completely (back to the start screen). */
  exit() {
    if (!this.open) return;
    this.open = false;
    this.mode.leave();
    this.prober.setActive(false);
    if (this.lobbyTicker) clearInterval(this.lobbyTicker);
    this.lobbyTicker = null;
    this.socket.close();
    this.reset();
    this.setRoom(null);
    this.deps.exit();
  }

  /** Go to `room`, chosen from outside the game (a platform's join): from wherever multiplayer is, or isn't, now. */
  switchRoom(room: RoomRef) {
    if (!this.open) return this.enter(room);
    this.mode.leave();
    this.reset();
    this.setKind(room.kind);
    this.wantedRoom = room.id;
    setNote(ui.lobby.note, 'Joining room…');
    this.setScreen('lobby');
    if (this.socket.connected) this.mode.join(room.id);
  }

  /** Forget every room and game: nothing of the last one may drive the view (`NetGame` owns its `onFrame`). */
  private reset() {
    gameEnded('quit');
    this.endGameUi();
    this.game?.stop();
    this.game = null;
    this.room = null;
    this.wantedRoom = null;
    this.autoJoin = false;
    this.createOnOpen = false;
    this.seats = [];
    this.pings = [];
    this.showingResult = false;
    this.previewKey = ''; // single player may have rebuilt the table since
    ui.result.open = false;
  }

  /** The player saved a new name. */
  rename(name: string) {
    if (!this.open) return;
    this.socket.send({ t: 'name', name });
    if (this.mode.link !== this.socket) this.mode.link.send({ t: 'name', name });
  }

  /** Which overlay shows; measuring P2P pings only while their list is on screen. */
  private setScreen(s: MpScreen) {
    this.screen = s;
    this.deps.setScreen(s);
    this.updateProbing();
  }

  private updateProbing() {
    const on = this.open && this.screen === 'lobby' && this.mode.kind === 'p2p';
    this.prober.setActive(on);
    if (on) this.prober.want(this.p2pRooms.map((r) => r.peer));
  }

  /**
   * This player is now in room `m` (or none): remembered for a fresh start, and told to the platform (the address bar
   * on the web, the room's status on CrazyGames).
   */
  private setRoom(m: RoomMsg | null) {
    const ref: RoomRef | null = m ? { kind: this.mode.kind, id: m.id } : null;
    platform.roomChanged(ref, !!m && m.members.filter((x) => x.online).length < m.cap);
    try {
      if (ref) localStorage.setItem(ROOM_KEY, JSON.stringify(ref));
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
    this.setRoom(m);
    this.renderRoom();
    if (this.showingResult) this.renderResultActions();
    if (this.active || this.showingResult) return;
    this.setScreen('room');
  }

  private onStart(m: StartMsg) {
    this.seats = m.seats;
    this.pings = [];
    this.previewKey = '';
    this.showingResult = false;
    ui.result.open = false;
    if (this.game) this.game.restart(m);
    else {
      this.game = new NetGame(this.deps.view, this.mode.link, m);
      this.game.onCountdown = (cd) => this.showCountdown(cd);
    }
    this.active = true;
    this.selfPaused = false;
    this.pauses = [];
    gameStarted('multi', {
      players: m.players,
      humans: m.seats.filter((s) => !s.ai).length,
      net: this.mode.kind,
      quick: !!this.room?.quick,
      win_score: m.settings.winScore,
    });
    this.deps.engage();
    this.setScreen('game');
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
    gameEnded(m.reason === 'forfeit' ? 'forfeit' : 'finished', { won: m.winner >= 0 && m.winner === mine, scores: m.scores.join('-') });
    this.game?.stop();
    this.game = null;
    const winner = m.seats[m.winner] ?? this.seats[m.winner];
    const won = m.winner >= 0 && m.winner === mine;
    if (won) platform.celebrate();
    const r = ui.result;
    r.title = m.winner < 0 ? 'GAME OVER' : won ? 'YOU WIN' : `${(winner?.name ?? 'PLAYER').toUpperCase()} WINS`;
    r.won = won;
    r.score = '';
    r.rows = m.seats.map((s, i) => ({ name: s.name, color: css(PALETTE_HEX[s.color] ?? 0xffffff), score: m.scores[i] ?? 0 }));
    r.note = m.reason === 'forfeit' ? 'Opponents left' : '';
    r.open = true;
    this.setScreen('game');
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
    // The match is over and its results are up: the host leaving ends the room, not this player's view of the
    // results. They stay, saying so (nothing to restart now), until the player leaves.
    if (reason === 'hostLeft' && this.showingResult) {
      this.mode.leave(); // P2P: hang up on the host
      this.room = null;
      this.wantedRoom = null;
      this.setRoom(null);
      const r = ui.result;
      r.showAgain = false;
      r.wait = 'THE HOST LEFT';
      r.quitText = 'LEAVE';
      return;
    }
    gameEnded(reason === 'hostLeft' ? 'host_left' : reason);
    this.mode.leave(); // P2P: hang up on the host
    this.endGameUi();
    this.game?.stop();
    this.game = null;
    this.room = null;
    this.wantedRoom = null;
    this.showingResult = false;
    ui.result.open = false;
    this.setRoom(null);
    if (reason === 'replaced' || reason === 'hostLeft' || reason === 'closed') {
      this.toast(
        reason === 'replaced' ? 'This room was opened in another tab' : reason === 'hostLeft' ? 'The host left the room' : 'The room was closed',
      );
      this.exit();
      return;
    }
    if (reason === 'kicked') this.toast('You were removed from the room');
    this.setScreen('lobby');
  }

  /** P2P: the connection to the host failed or broke. */
  private onLost(why: LostReason) {
    if (!this.open) return;
    gameEnded('connection_lost');
    const inRoom = !!this.room;
    this.endGameUi();
    this.game?.stop();
    this.game = null;
    this.room = null;
    this.wantedRoom = null;
    this.showingResult = false;
    ui.result.open = false;
    this.setRoom(null);
    if (why === 'unreachable') {
      setNote(
        ui.lobby.note,
        "Couldn't connect to this room directly. Turn off your VPN. On a phone hotspot direct play can't work: use a Wi-Fi router or the Finland server.",
        true,
      );
    } else this.toast(inRoom ? 'Lost connection to the host' : "Couldn't reach the host");
    this.setScreen('lobby');
  }

  private onError(code: string, msg: string) {
    if ((code === 'not_found' || code === 'full' || code === 'kicked' || code === 'busy') && !this.room) {
      this.wantedRoom = null;
      this.setRoom(null);
      if (this.autoJoin) {
        this.toast(msg);
        this.exit();
        return;
      }
      setNote(ui.lobby.note, msg, true);
      this.setScreen('lobby');
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
    setNote(ui.lobby.note, this.mode.kind === 'p2p' ? 'Setting up your room…' : '');
    this.mode.create(ui.lobby.createPublic);
  }

  quickPlay(size: 2 | 4) {
    setNote(ui.lobby.note, this.mode.kind === 'p2p' ? 'Looking for players…' : '');
    this.mode.quick(size);
  }

  joinRoom(id: string) {
    setNote(ui.lobby.note, this.mode.kind === 'p2p' ? 'Connecting to the host…' : '');
    this.mode.join(id);
  }

  private onLobby(rooms: LobbyRoom[], p2p: P2pLobbyRoom[]) {
    ui.lobby.rooms = rooms.map((r) => lobbyRow(r));
    this.p2pRooms = p2p;
    this.renderP2pList();
    if (this.mode.kind === 'p2p' && this.screen === 'lobby') this.prober.want(p2p.map((r) => r.peer));
  }

  /** P2P rooms with their measured ping, quickest first; unreachable ones last. */
  private renderP2pList() {
    const rank = (r: LobbyRow) => (r.level === 'fail' ? 2e9 : r.level === 'testing' ? 1e9 : r.ms);
    ui.lobby.p2pRooms = this.p2pRooms
      .map((r) => {
        const row = lobbyRow(r);
        const p = this.prober.get(r.peer);
        if (typeof p === 'number') Object.assign(row, pingLabel(p), { ms: p });
        else if (p === 'fail') Object.assign(row, { text: "CAN'T CONNECT", level: 'fail' });
        else Object.assign(row, { text: 'TESTING…', level: 'testing' });
        return row;
      })
      .sort((a, b) => rank(a) - rank(b));
  }

  private renderServerPing() {
    const s = this.socket;
    const l = ui.lobby;
    if (s.connected && s.rtt > 0) {
      const { text, level } = pingLabel(Math.round(s.rtt));
      l.serverPing = text;
      l.serverLevel = level;
    } else {
      l.serverPing = 'CONNECTING…';
      l.serverLevel = 'testing';
    }
  }

  // --- room --------------------------------------------------------------------

  pickColor(color: number) {
    this.mode.link.send({ t: 'color', color });
  }

  setVisibility(pub: boolean) {
    this.mode.link.send({ t: 'settings', public: pub });
  }

  /** Dragging the points slider: show the value; the room takes it on release. */
  previewWinScore(v: number) {
    ui.room.winScore = clampWinScore(v);
  }

  setWinScore(v: number) {
    this.mode.link.send({ t: 'settings', winScore: v });
  }

  /** Dragging the mallet slider: resize the preview at once; the room follows on release. */
  previewMalletScale(v: number) {
    const scale = clampMalletScale(v);
    ui.room.malletScale = scale;
    this.deps.view.setRoom({ malletScale: scale });
  }

  setMalletScale(v: number) {
    this.mode.link.send({ t: 'settings', malletScale: v });
  }

  toggleReady() {
    const me = this.room?.members.find((x) => x.id === this.myId);
    this.mode.link.send({ t: 'ready', on: !me?.ready });
  }

  startGame() {
    setNote(ui.room.note, '');
    this.mode.link.send({ t: 'start' });
  }

  leaveRoom() {
    this.mode.leave();
  }

  kick(id: string) {
    this.mode.link.send({ t: 'kick', id });
  }

  copyLink() {
    if (!this.room) return;
    const link = platform.roomLink({ kind: this.mode.kind, id: this.room.id });
    void navigator.clipboard?.writeText(link).then(
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
    v.net =
      this.mode.kind !== 'p2p'
        ? ''
        : this.mode.hosting
          ? "P2P · You're the host: your device runs this game, so keep it open on screen"
          : 'P2P · Connected straight to the host';
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
    if (this.open && this.showingResult) this.mode.link.send({ t: 'restart' });
  }

  /** PAUSE TOO: hold the game too, so a resume by the others doesn't catch us off guard. */
  joinPause() {
    this.selfPause();
  }

  voteKick() {
    const target = this.pauses.find((p) => p.id !== this.myId && this.isKickable(p));
    if (target) this.mode.link.send({ t: 'vote', id: target.id });
  }

  /** The player pressed Esc or left fullscreen: pause for everyone. */
  selfPause() {
    if (!this.active || this.selfPaused || this.showingResult) return;
    this.selfPaused = true;
    this.mode.link.send({ t: 'pause' });
    this.deps.input.enabled = false;
    this.deps.input.release();
    if (document.pointerLockElement) document.exitPointerLock();
    this.setScreen('menu');
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
    this.mode.link.send({ t: 'resume' });
    this.deps.input.enabled = true;
    this.setScreen('game');
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

function lobbyRow(r: LobbyRoom): LobbyRow {
  return {
    id: r.id,
    host: r.host || 'Room',
    sub: `${r.status === 'playing' ? 'PLAYING' : 'LOBBY'} · ${r.winScore} PTS · MALLET ${Math.round(r.malletScale * 100)}%`,
    count: `${r.players}/${r.cap}`,
    full: r.players >= r.cap,
    text: '',
    level: 'none',
    ms: 0,
  };
}
