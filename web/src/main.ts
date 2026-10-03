import { View, DEFAULT_PITCH, MIN_PITCH, MAX_PITCH, DEFAULT_ZOOM, MIN_ZOOM, MAX_ZOOM, QUALITIES, type Quality } from './game/view';
import { Input } from './game/input';
import type { PlayerCount } from '@airhockey/shared/layout';
import { DEFAULT_ROOM, clampMalletScale, clampWinScore } from '@airhockey/shared/room';
import { DIFFICULTIES, type Difficulty } from '@airhockey/shared/ai';
import { PALETTE_HEX, assignSeatColors, seatColor } from './game/colors';
import { getName, setName } from './net/identity';
import { Multiplayer, savedRoom, type RoomRef, type Standing } from './net/mp';
import { Countdown } from './game/countdown';
import { SeatNames } from './game/seatnames';
import { Alpine, css, focusIn, setNote, show, ui, type Screen } from './ui';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const view = new View(canvas);
/**
 * Debug: `?debug` plays without fullscreen (the mouse follows the cursor, no pointer lock needed), Esc doesn't pause,
 * and the game objects are exposed as `window.airhockey`, for driving and measuring the game from DevTools.
 */
const DEBUG = new URLSearchParams(location.search).has('debug');
const input = new Input(view, canvas);

const parse = (v: string | number | null): PlayerCount => (String(v) === '3' ? 3 : String(v) === '4' ? 4 : 2);
/** Seconds of 3, 2, 1 before the puck moves: at the start and after every pause. */
const COUNTDOWN = 3;
const SENS_MIN = 0.25;
const SENS_MAX = 5;

const countdown = new Countdown(document.getElementById('countdown') as HTMLElement, view.sound);
view.onCountdown = (secs) => countdown.set(secs);

/** A number from localStorage, or `fallback` when missing, invalid or storage is unavailable. */
function loadNumber(key: string, fallback: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage unavailable
  }
}

function save(key: string, value: string | number) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage unavailable: setting just won't persist */
  }
}

// --- players ---------------------------------------------------------------------
function setPlayers(n: PlayerCount) {
  ui.sp.players = n;
  assignSeatColors(ui.sp.color); // rivals re-roll their colours whenever the table is rebuilt
  view.setPlayers(n);
  if (ui.mode === 'sp') syncPlayersUrl();
}

function syncPlayersUrl() {
  const url = new URL(location.href);
  url.searchParams.set('players', String(ui.sp.players));
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

addEventListener('keydown', (e) => {
  if (ui.screen === 'spSetup' && (e.key === '2' || e.key === '3' || e.key === '4')) setPlayers(parse(e.key));
});

// --- sensitivity (persisted) ------------------------------------------------
const SENS_KEY = 'airhockey.sens';

function setSens(v: number) {
  input.sensitivity = Math.min(SENS_MAX, Math.max(SENS_MIN, v));
  ui.settings.sens = input.sensitivity;
}
setSens(loadNumber(SENS_KEY, 1));

// --- camera angle (persisted) ------------------------------------------------
const PITCH_KEY = 'airhockey.pitch';

function setPitch(deg: number) {
  const v = Math.min(MAX_PITCH, Math.max(MIN_PITCH, deg));
  view.setPitch(v);
  ui.settings.pitch = v;
  return v;
}
setPitch(loadNumber(PITCH_KEY, DEFAULT_PITCH));

// --- camera zoom (persisted) ------------------------------------------------
const ZOOM_KEY = 'airhockey.zoom';

function setZoom(percent: number) {
  const v = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, percent));
  view.setZoom(v);
  ui.settings.zoom = v;
  return v;
}
setZoom(loadNumber(ZOOM_KEY, DEFAULT_ZOOM));

// --- mallet size and points to win: room rules (persisted locally for single player) ------
const MALLET_KEY = 'airhockey.malletScale';
const WIN_KEY = 'airhockey.winScore';

function setMalletScale(v: number) {
  const scale = clampMalletScale(v);
  view.setRoom({ malletScale: scale });
  ui.sp.malletScale = scale;
  return scale;
}
setMalletScale(loadNumber(MALLET_KEY, DEFAULT_ROOM.malletScale));

function setWinScore(v: number) {
  const n = clampWinScore(v);
  view.setRoom({ winScore: n });
  ui.sp.winScore = n;
  return n;
}
setWinScore(loadNumber(WIN_KEY, DEFAULT_ROOM.winScore));

// While the camera angle, zoom or mallet size is being changed the menu fades, so the table behind it shows.
let peekTimer: ReturnType<typeof setTimeout> | null = null;
/** The slider the fade belongs to: only it can end the fade by losing focus. */
let peekEl: EventTarget | null = null;
function peek(on: boolean, el: EventTarget | null = null) {
  if (peekTimer) clearTimeout(peekTimer);
  peekTimer = null;
  peekEl = on ? el : null;
  ui.peek = on;
}

// --- audio (persisted, both on by default) -----------------------------------
const audioKeys = { music: 'airhockey.music', sfx: 'airhockey.sfx' } as const;

function setAudio(kind: 'music' | 'sfx', on: boolean) {
  if (kind === 'music') view.sound.setMusic(on);
  else view.sound.setSfx(on);
  ui.settings[kind] = on;
}
for (const kind of ['music', 'sfx'] as const) setAudio(kind, load(audioKeys[kind]) !== '0');

// --- FPS / ping display (persisted, on by default) -------------------------------
const HUD_KEY = 'airhockey.hud';
ui.settings.hud = load(HUD_KEY) !== '0';

// UI feedback: every button click, and a tick while dragging a slider.
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('button')) view.sound.ui();
});
document.addEventListener('input', (e) => {
  if ((e.target as HTMLElement).matches('input[type="range"]')) view.sound.tick();
});
// Browsers only allow audio after a user gesture.
const unlockAudio = () => view.sound.unlock();
addEventListener('pointerdown', unlockAudio, { once: true });
addEventListener('keydown', unlockAudio, { once: true });

// --- graphics quality (persisted; auto-detected on first run) ------------------
const QUALITY_KEY = 'airhockey.quality';
const TARGET_FPS = 56; // a 60 Hz display averages a little under 60

function setQuality(q: Quality) {
  view.setQuality(q);
  ui.settings.quality = q;
}

/** Try High, then Medium; keep the best level that holds ~60 FPS, else Low. */
async function detectQuality(): Promise<Quality> {
  for (const q of ['high', 'medium'] as const) {
    setQuality(q);
    if ((await view.measureFps()) >= TARGET_FPS) return q;
  }
  return 'low';
}

// --- difficulty (persisted) --------------------------------------------------
const DIFF_KEY = 'airhockey.difficulty';

function setDifficulty(d: Difficulty) {
  view.setDifficulty(d);
  ui.sp.difficulty = d;
}
const savedDiff = load(DIFF_KEY) as Difficulty | null;
setDifficulty(savedDiff && DIFFICULTIES.includes(savedDiff) ? savedDiff : 'medium');

// --- player colour (persisted) -------------------------------------------------
const COLOR_KEY = 'airhockey.color';
{
  const saved = Number(load(COLOR_KEY));
  if (Number.isInteger(saved) && saved >= 0 && saved < PALETTE_HEX.length) ui.sp.color = saved;
}

// --- single player: play / pause ---------------------------------------------
// Playing = fullscreen, hidden cursor. Leaving fullscreen (Esc) or the pause button pauses.
let playing = false;
const canFullscreen = !DEBUG && !!document.documentElement.requestFullscreen;

/** Game over: freeze play, give the cursor back and show who won. */
function showResult(winner: number, scores: number[]) {
  const won = winner === 0;
  Object.assign(ui.result, {
    open: true,
    won,
    title: won ? 'YOU WIN' : 'DEFEATED',
    score: scores.join('  –  '),
    rows: [],
    note: '',
    wait: '',
    showAgain: true,
    againText: 'PLAY AGAIN',
    quitText: 'QUIT',
  });
  setPlaying(false);
  void Alpine.nextTick(() => focusIn('#again'));
}

view.onGameOver = (w, s) => {
  if (ui.mode === 'sp') showResult(w, s);
};

function setPlaying(on: boolean) {
  playing = on;
  ui.playing = on;
  input.enabled = on;
  input.mouseActive = on;
  view.running = on;
  if (on) {
    view.countdown = COUNTDOWN;
    show('none');
  } else {
    input.release();
    view.countdown = 0;
    view.stopCinematic();
    countdown.clear();
    if (document.pointerLockElement) document.exitPointerLock();
  }
}

function lockPointer() {
  if (document.pointerLockElement === canvas) return;
  const plain = () => {
    try {
      (canvas.requestPointerLock() as unknown as Promise<void> | undefined)?.catch(() => {});
    } catch {
      /* cursor stays unlocked: input falls back to absolute tracking */
    }
  };
  try {
    // Raw (unaccelerated) deltas where supported; fall back to a plain lock.
    const opts = { unadjustedMovement: true } as unknown as undefined;
    (canvas.requestPointerLock(opts) as unknown as Promise<void> | undefined)?.catch(plain);
  } catch {
    plain();
  }
}

/** Play (or resume) the single player game. Called from a click: fullscreen needs the user gesture. */
async function start() {
  view.sound.unlock();
  ui.result.open = false;
  if (canFullscreen && !document.fullscreenElement) {
    // Both requests need the click's user activation, so issue them together.
    const fs = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    lockPointer();
    try {
      await fs;
    } catch {
      /* play anyway */
    }
  }
  setPlaying(true);
  lockPointer(); // retry in case the first one raced fullscreen
}

function pauseSingle() {
  if (ui.mode !== 'sp' || !playing) return;
  setPlaying(false);
  show('pause');
}

/**
 * Any game thrown away (single player or online): back to the main menu, with everything as on a fresh start, so
 * nothing of the last game leaks into the next.
 */
function toMenu() {
  setPlaying(false);
  ui.mode = 'menu';
  peek(false);
  ui.hint = false;
  ui.waiting = false;
  ui.result.open = false;
  ui.banner.open = false;
  view.onFrame = null; // only an online game sets it; mp stops its own, this makes sure
  // This player's own rules and table again: an online room may have replaced them.
  setMalletScale(ui.sp.malletScale);
  setWinScore(ui.sp.winScore);
  setPlayers(ui.sp.players);
  const url = new URL(location.href);
  url.searchParams.delete('players');
  history.replaceState(null, '', url);
  if (document.fullscreenElement) void document.exitFullscreen();
  show('home');
}

function restartSingle() {
  view.restart();
  void start();
}

addEventListener('keydown', (e) => {
  if (ui.mode === 'sp' && (e.key === 'r' || e.key === 'R') && playing) {
    view.restart();
    view.countdown = COUNTDOWN;
  }
});

document.addEventListener('fullscreenchange', () => {
  if (ui.mode === 'mp') mp.onFullscreenChange();
  else if (!document.fullscreenElement) pauseSingle();
});

addEventListener('keydown', (e) => {
  // Debug: Esc does nothing, so a test run isn't paused by stray keys.
  if (e.key !== 'Escape' || document.fullscreenElement || DEBUG) return;
  if (ui.mode === 'sp') pauseSingle();
  else if (ui.mode === 'mp') mp.selfPause();
});

// Alt-tab (the window loses focus) or switching tabs pauses, like leaving fullscreen. Debug: no, as with Esc.
function pauseAway() {
  if (DEBUG) return;
  if (ui.mode === 'sp') pauseSingle();
  else if (ui.mode === 'mp') mp.selfPause();
}
addEventListener('blur', pauseAway);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseAway();
});

// Clicking while playing re-grabs the pointer (e.g. after alt-tab).
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.screen, #result, #banner, #pauseBtn')) return;
  if (ui.mode === 'sp' && playing) lockPointer();
  else if (ui.mode === 'mp') mp.grab();
});

// --- multiplayer ---------------------------------------------------------------
const mp: Multiplayer = new Multiplayer({
  view,
  input,
  setScreen(s) {
    show(s === 'menu' ? 'pause' : s === 'game' ? 'none' : s);
  },
  engage() {
    ui.playing = true;
    input.enabled = true;
    input.mouseActive = true;
    view.running = true;
  },
  disengage() {
    ui.playing = false;
    input.enabled = false;
    input.mouseActive = false;
    input.release();
    view.running = false;
    if (document.pointerLockElement) document.exitPointerLock();
  },
  lockPointer,
  canFullscreen,
  goFullscreen: () => {
    if (document.fullscreenElement) return Promise.resolve();
    if (!canFullscreen) return Promise.reject(new Error('no fullscreen'));
    return document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  },
  exit: toMenu,
  countdown,
});

// --- name, main menu, settings ----------------------------------------------------
function enterMulti(room: RoomRef | null, auto = false) {
  ui.mode = 'mp';
  mp.enter(room, auto);
}

/** After the name: straight back into the room you were in, else the main menu. */
function afterName() {
  const room = savedRoom();
  if (room) enterMulti(room, true);
  else show('home');
}

function openSettings(from: Screen) {
  ui.settings.from = from;
  ui.settings.name = getName() ?? '';
  setNote(ui.settings.note, '');
  show('settings');
}

// --- HUD: FPS (and ping online), then every seat by score -----------------------------
let hudKey = '';

/** Single player: you and the AIs. */
function spStandings(): Standing[] | null {
  const scores = view.match?.scores;
  if (!scores) return null;
  return scores.map((score, seat) => ({
    seat,
    name: seat === 0 ? (getName() ?? 'YOU') : ui.sp.players > 2 ? `AI ${seat}` : 'AI',
    color: -1,
    score,
    ai: seat > 0,
    ping: 0,
    me: seat === 0,
  }));
}

function standings(): Standing[] {
  return (ui.mode === 'mp' ? mp.standings() : ui.mode === 'sp' ? spStandings() : null) ?? [];
}

view.names = new SeatNames((seat) => standings().find((r) => r.seat === seat)?.name ?? '');

function renderHud() {
  const ping = ui.mode === 'mp' && mp.ping > 0 ? ` · ${Math.round(mp.ping)} ms` : '';
  ui.hud.stats = `${view.fps} FPS${ping}`;
  renderScores();
}

/** Each seat's score last shown, to spot a goal (its number pops). */
const shownScores = new Map<number, number>();
/** Seats whose score is popping right now. */
const popping = new Map<number, ReturnType<typeof setTimeout>>();
const POP_MS = 650; // the pop animation's length (index.html)

function renderScores() {
  const list = standings();
  if (!list.length) shownScores.clear(); // between games: a new game's first goal still pops
  const target = view.winScore;
  const key = `${target};` + list.map((r) => `${r.seat}|${r.name}|${r.color}|${r.score}|${r.ai}|${Math.round(r.ping)}`).join(';');
  if (key === hudKey) return;
  hudKey = key;
  for (const r of list) {
    const before = shownScores.get(r.seat);
    shownScores.set(r.seat, r.score);
    if (before === undefined || r.score <= before) continue;
    const old = popping.get(r.seat);
    if (old) clearTimeout(old);
    popping.set(
      r.seat,
      setTimeout(() => {
        popping.delete(r.seat);
        const row = ui.hud.rows.find((x) => x.seat === r.seat);
        if (row) row.pop = false;
      }, POP_MS),
    );
  }
  // Highest score first; ties keep seat order. Rows stay in seat order (stable elements), placed by rank.
  const order = [...list].sort((a, b) => b.score - a.score || a.seat - b.seat);
  ui.hud.target = target;
  ui.hud.rows = list.map((r) => ({
    seat: r.seat,
    rank: order.indexOf(r) + 1,
    name: r.name,
    color: css(r.color >= 0 ? (PALETTE_HEX[r.color] ?? 0xffffff) : seatColor(r.seat).getHex()),
    score: r.score,
    progress: Math.min(1, r.score / Math.max(1, target)),
    ms: !r.ai && ui.mode === 'mp' && r.ping > 0 ? `${Math.round(r.ping)} ms` : '',
    me: r.me,
    pop: popping.has(r.seat),
  }));
}

view.onFps = renderHud;
setInterval(renderHud, 500);
setInterval(renderScores, 150);

// --- what the page's buttons, sliders and forms do (index.html binds to these) ----------
Alpine.data('app', () => ({
  ui,

  /** Sliders that change the table: fade the menu while they're dragged (or keyed). */
  peeking: {
    '@pointerdown'(e: Event) {
      peek(true, e.currentTarget);
    },
    '@pointerup'() {
      peek(false);
    },
    '@pointercancel'() {
      peek(false);
    },
    '@blur'(e: Event) {
      // Pressing another slider fires its pointerdown before this one's blur: leave its fade alone.
      if (e.currentTarget === peekEl) peek(false);
    },
    '@keydown'(e: Event) {
      // Keyboard changes have no release: fade back a moment after the last key.
      peek(true, e.currentTarget);
      peekTimer = setTimeout(() => peek(false), 800);
    },
  },

  // First visit: ask for a name (saved in localStorage, so later visits skip this).
  saveName() {
    const name = setName(ui.nameScreen.name);
    if (!name) {
      setNote(ui.nameScreen.note, 'Pick a name first', true);
      document.getElementById('nameInput')?.focus();
      return;
    }
    ui.nameScreen.name = name;
    afterName();
  },

  goSingle() {
    ui.mode = 'sp';
    // This game's own rules again: an online room may have replaced them.
    setMalletScale(ui.sp.malletScale);
    setWinScore(ui.sp.winScore);
    setPlayers(ui.sp.players); // a fresh game, and the table an online game may have replaced
    syncPlayersUrl();
    show('spSetup');
  },
  goMulti() {
    enterMulti(null);
  },
  openSettings,

  // Single player setup.
  setPlayers(n: number) {
    setPlayers(parse(n));
  },
  pickColor(i: number) {
    if (i === ui.sp.color) return;
    ui.sp.color = i;
    save(COLOR_KEY, i);
    setPlayers(ui.sp.players); // rebuild so every mallet, light and score takes its new colour
  },
  setDifficulty(d: Difficulty) {
    setDifficulty(d);
    save(DIFF_KEY, d);
  },
  setWinScore(v: string) {
    save(WIN_KEY, setWinScore(Number(v)));
  },
  setMalletScale(v: string) {
    save(MALLET_KEY, setMalletScale(Number(v)));
  },
  spStart() {
    view.restart();
    void start();
  },
  spBack() {
    toMenu();
  },

  // Settings.
  settingsBack() {
    show(ui.settings.from);
  },
  saveSettingsName() {
    const name = setName(ui.settings.name);
    setNote(ui.settings.note, name ? 'Name saved' : 'Pick a name first', !name);
    if (!name) return;
    ui.settings.name = ui.nameScreen.name = name;
    mp.rename(name);
  },
  toggleAudio(kind: 'music' | 'sfx') {
    const on = !ui.settings[kind];
    setAudio(kind, on);
    save(audioKeys[kind], on ? '1' : '0');
  },
  toggleHud() {
    ui.settings.hud = !ui.settings.hud;
    save(HUD_KEY, ui.settings.hud ? '1' : '0');
  },
  setQuality(q: Quality) {
    setQuality(q);
    save(QUALITY_KEY, q);
  },
  setPitch(v: string) {
    save(PITCH_KEY, setPitch(Number(v)));
  },
  setZoom(v: string) {
    save(ZOOM_KEY, setZoom(Number(v)));
  },
  setSens(v: string) {
    setSens(Number(v));
    save(SENS_KEY, input.sensitivity);
  },

  // In game: pause button, pause menu and result screen.
  pause() {
    if (ui.mode === 'sp') pauseSingle();
    else if (ui.mode === 'mp') mp.selfPause();
  },
  resume() {
    if (ui.mode === 'mp') void mp.resumeClick();
    else if (ui.mode === 'sp') void start();
  },
  restart() {
    if (ui.mode === 'sp') restartSingle();
  },
  again() {
    if (ui.mode === 'sp') restartSingle();
    else if (ui.mode === 'mp') mp.again();
  },
  /** QUIT / LEAVE / BACK out of the current mode, to the main menu. */
  quit() {
    if (ui.mode === 'mp') mp.exit();
    else toMenu();
  },

  // Multiplayer: lobby, room, pause banner.
  createRoom: () => mp.createRoom(),
  quickPlay: (size: 2 | 4) => mp.quickPlay(size),
  joinRoom: (id: string) => mp.joinRoom(id),
  setNetKind: (kind: 'server' | 'p2p') => mp.setKind(kind),
  copyLink: () => mp.copyLink(),
  roomColor: (i: number) => mp.pickColor(i),
  roomVisibility: (pub: boolean) => mp.setVisibility(pub),
  roomWinInput: (v: string) => mp.previewWinScore(Number(v)),
  roomWinChange: (v: string) => mp.setWinScore(Number(v)),
  roomMalletInput: (v: string) => mp.previewMalletScale(Number(v)),
  roomMalletChange: (v: string) => mp.setMalletScale(Number(v)),
  toggleReady: () => mp.toggleReady(),
  startGame: () => mp.startGame(),
  leaveRoom: () => mp.leaveRoom(),
  kick: (id: string) => mp.kick(id),
  voteKick: () => mp.voteKick(),
  joinPause: () => mp.joinPause(),
}));

input.enabled = false;
if (DEBUG) Object.assign(window, { airhockey: { view, mp, ui } });
setPlayers(parse(new URLSearchParams(location.search).get('players')));
ui.nameScreen.name = getName() ?? '';
Alpine.start();
if (getName()) afterName();
else show('name');

// First run: pick the quality from a short live FPS test. The menu waits for it (no blur, which would skew it).
const savedQuality = load(QUALITY_KEY) as Quality | null;
if (savedQuality && QUALITIES.includes(savedQuality)) {
  setQuality(savedQuality);
} else {
  ui.benchmarking = true;
  ui.sp.detecting = true;
  void detectQuality().then((q) => {
    setQuality(q);
    save(QUALITY_KEY, q);
    ui.benchmarking = false;
    ui.sp.detecting = false;
  });
}
