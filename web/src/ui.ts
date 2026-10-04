import Alpine from 'alpinejs';
import type { PlayerCount } from '@airhockey/shared/layout';
import type { Difficulty } from '@airhockey/shared/ai';
import { PALETTE_HEX } from './game/colors';
import type { InputMode } from './game/input';

/**
 * All menu, HUD and overlay state, rendered by Alpine from the bindings in index.html. Game code writes here and
 * never touches that DOM itself. Plain data only: game objects (View, Input, sockets) stay out of the proxy.
 */

// One overlay at a time ('none' while playing).
export type Screen = 'name' | 'home' | 'spSetup' | 'settings' | 'pause' | 'lobby' | 'room' | 'none';
// menu: no game. sp: a single player game (its setup, play and pause). mp: multiplayer, which drives its own screens.
export type Mode = 'menu' | 'sp' | 'mp';

export interface Note {
  text: string;
  warn: boolean;
}

/** One seat in the in-game scoreboard. Rows stay in seat order; `rank` places them. */
export interface HudRow {
  seat: number;
  /** 1 = leading. */
  rank: number;
  name: string;
  color: string;
  score: number;
  /** Share of the points to win, 0..1. */
  progress: number;
  /** Ping label ('' when none). */
  ms: string;
  me: boolean;
  /** Score just went up: the number pops. */
  pop: boolean;
}

/** A name/colour/score row on the game over screen. */
export interface ResultRow {
  name: string;
  color: string;
  score: number;
}

export interface LobbyRow {
  id: string;
  host: string;
  sub: string;
  count: string;
  full: boolean;
  /** P2P: measured ping label ('' for none). */
  text: string;
  level: PingLevel;
  /** P2P: measured ping, ms. */
  ms: number;
}

/** How a ping label is coloured. */
export type PingLevel = 'none' | 'good' | 'ok' | 'bad' | 'testing' | 'fail';

export interface MemberRow {
  id: string;
  name: string;
  color: string;
  you: boolean;
  offline: boolean;
  ready: boolean;
  kickable: boolean;
}

/** An opponent's name floating over their mallet during the countdown cinematic. */
export interface SeatLabel {
  seat: number;
  name: string;
  color: string;
  x: number;
  y: number;
  on: boolean;
}

export const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
const note = (): Note => ({ text: '', warn: false });

export const ui = Alpine.reactive({
  screen: 'name' as Screen,
  mode: 'menu' as Mode,
  /** Palette colours as CSS, for every swatch row. */
  palette: PALETTE_HEX.map(css),

  // Page-wide states (classes on <body>).
  playing: false,
  /** Online game held by another player's pause: the banner shows and the cursor comes back. */
  waiting: false,
  /** Dragging a slider that changes the table: the menu fades so the table shows through. */
  peek: false,
  /** First-run graphics test running. */
  benchmarking: false,

  nameScreen: { name: '', note: note() },

  sp: {
    players: 2 as PlayerCount,
    color: 0,
    difficulty: 'medium' as Difficulty,
    winScore: 10,
    malletScale: 1,
    /** START is waiting for the graphics test. */
    detecting: false,
  },

  settings: {
    /** Where BACK goes: the main menu or the pause menu. */
    from: 'home' as Screen,
    name: '',
    note: note(),
    /** Volumes, percent. */
    music: 20,
    sfx: 100,
    hud: true,
    quality: 'high',
    pitch: 50,
    zoom: 100,
    sens: 1,
    inputMode: 'drag' as InputMode,
  },

  hud: { stats: '', target: 10, rows: [] as HudRow[] },
  seatNames: [] as SeatLabel[],
  /** Online: pause time left, shown in the pause menu. */
  pauseLeft: '',

  result: {
    open: false,
    won: false,
    title: '',
    score: '',
    rows: [] as ResultRow[],
    note: '',
    /** Shown instead of the again button ('' = none). */
    wait: '',
    showAgain: true,
    againText: 'PLAY AGAIN',
    quitText: 'QUIT',
  },

  banner: { open: false, text: '', vote: { show: false, text: '', disabled: false } },
  hint: false,
  toast: '',

  lobby: {
    /** Which rooms: on the Finland server, or P2P (hosted by a player's browser). */
    tab: 'server' as 'server' | 'p2p',
    rooms: [] as LobbyRow[],
    p2pRooms: [] as LobbyRow[],
    /** Ping to the server, as a label. */
    serverPing: '',
    serverLevel: 'none' as PingLevel,
    note: note(),
    createPublic: true,
  },

  room: {
    id: '',
    status: note(),
    note: note(),
    members: [] as MemberRow[],
    showColors: true,
    myColor: -1,
    /** Palette indices held by someone else. */
    taken: [] as number[],
    colorsLocked: false,
    showVis: true,
    isPublic: true,
    canEdit: false,
    winScore: 10,
    malletScale: 1,
    showReady: false,
    readyText: 'READY',
    showStart: false,
    startBlocked: false,
    copyText: 'COPY LINK',
    /** How this room is connected, for P2P rooms ('' on the server). */
    net: '',
  },
});

export function setNote(n: Note, text: string, warn = false) {
  n.text = text;
  n.warn = warn;
}

/** Show one screen (or none) and focus its main button once it's on screen. */
export function show(s: Screen) {
  ui.screen = s;
  if (s !== 'none') void Alpine.nextTick(() => focusIn(`[data-screen="${s}"]`));
}

/** Focus the first visible primary button inside `sel` (or `sel` itself when it's a button). */
export function focusIn(sel: string) {
  const root = document.querySelector<HTMLElement>(sel);
  if (!root) return;
  const btn = root.matches('button') ? root : [...root.querySelectorAll<HTMLElement>('.primary')].find((b) => b.offsetParent);
  btn?.focus({ preventScroll: true });
}

export { Alpine };
