import { View, DEFAULT_PITCH, QUALITIES, type Quality } from './game/view';
import { Input } from './game/input';
import type { PlayerCount } from '@airhockey/shared/layout';
import { DEFAULT_ROOM, clampMalletScale, clampWinScore } from '@airhockey/shared/room';
import { DIFFICULTIES, type Difficulty } from '@airhockey/shared/ai';
import { PALETTE_HEX, assignSeatColors, seatColor } from './game/colors';
import { getName, setName } from './net/identity';
import { Multiplayer, savedRoom, type Standing } from './net/mp';
import { Countdown } from './game/countdown';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const buttons = [...document.querySelectorAll<HTMLButtonElement>('#modes button')];
const view = new View(canvas);
/**
 * Debug: `?debug` plays without fullscreen (the mouse follows the cursor, no pointer lock needed), Esc doesn't pause,
 * and the game objects are exposed as `window.airhockey`, for driving and measuring the game from DevTools.
 */
const DEBUG = new URLSearchParams(location.search).has('debug');
const input = new Input(view, canvas);

const parse = (v: string | null): PlayerCount => (v === '3' ? 3 : v === '4' ? 4 : 2);
const byId = (id: string) => document.getElementById(id) as HTMLElement;
/** Seconds of 3, 2, 1 before the puck moves: at the start and after every pause. */
const COUNTDOWN = 3;

let players: PlayerCount = 2;
let myColor = 0;

// --- screens -----------------------------------------------------------------
// One overlay at a time ('none' while playing). Fresh start: name, then the room you were in or the main menu.
type Screen = 'name' | 'home' | 'spSetup' | 'settings' | 'pause' | 'lobby' | 'room' | 'none';
const SCREENS: Record<Exclude<Screen, 'none'>, HTMLElement> = {
  name: byId('nameScreen'),
  home: byId('home'),
  spSetup: byId('spSetup'),
  settings: byId('settings'),
  pause: byId('pause'),
  lobby: byId('lobby'),
  room: byId('room'),
};
let screen: Screen = 'name';
/** Where BACK on the settings screen goes: the main menu or the pause menu. */
let settingsFrom: Screen = 'home';

function show(s: Screen) {
  screen = s;
  for (const [k, el] of Object.entries(SCREENS)) el.hidden = k !== s;
  if (s !== 'none') SCREENS[s].querySelector<HTMLElement>('.primary')?.focus({ preventScroll: true });
}

// menu: no game. sp: a single player game (its setup, play and pause). mp: multiplayer, which drives its own screens.
type Mode = 'menu' | 'sp' | 'mp';
let mode: Mode = 'menu';
const countdown = new Countdown(byId('countdown'), view.sound);
view.onCountdown = (secs) => countdown.set(secs);

function setPlayers(n: PlayerCount) {
  players = n;
  assignSeatColors(myColor); // rivals re-roll their colours whenever the table is rebuilt
  view.setPlayers(n);
  for (const b of buttons) b.setAttribute('aria-pressed', String(Number(b.dataset.n) === n));
  if (mode === 'sp') syncPlayersUrl();
}

function syncPlayersUrl() {
  const url = new URL(location.href);
  url.searchParams.set('players', String(players));
  url.searchParams.delete('room');
  history.replaceState(null, '', url);
}

for (const b of buttons) b.addEventListener('click', () => setPlayers(parse(b.dataset.n ?? null)));
addEventListener('keydown', (e) => {
  if (screen === 'spSetup' && (e.key === '2' || e.key === '3' || e.key === '4')) setPlayers(parse(e.key));
});

// --- sensitivity (persisted) ------------------------------------------------
const SENS_KEY = 'airhockey.sens';
const sensInput = document.getElementById('sensInput') as HTMLInputElement;
const sensOut = document.getElementById('sensOut') as HTMLOutputElement;

function setSens(v: number) {
  const min = Number(sensInput.min);
  const max = Number(sensInput.max);
  input.sensitivity = Math.min(max, Math.max(min, v));
  sensInput.value = String(input.sensitivity);
  sensOut.value = input.sensitivity.toFixed(2);
}

try {
  const saved = Number(localStorage.getItem(SENS_KEY));
  setSens(saved > 0 ? saved : 1);
} catch {
  setSens(1);
}
sensInput.addEventListener('input', () => {
  setSens(Number(sensInput.value));
  try {
    localStorage.setItem(SENS_KEY, String(input.sensitivity));
  } catch {
    /* storage unavailable: setting just won't persist */
  }
});

// --- camera angle (persisted) ------------------------------------------------
const PITCH_KEY = 'airhockey.pitch';
const pitchInput = document.getElementById('pitchInput') as HTMLInputElement;
const pitchOut = document.getElementById('pitchOut') as HTMLOutputElement;

function setPitch(deg: number) {
  const v = Math.min(Number(pitchInput.max), Math.max(Number(pitchInput.min), deg));
  view.setPitch(v);
  pitchInput.value = String(v);
  pitchOut.value = `${Math.round(v)}°`;
  return v;
}

try {
  const saved = Number(localStorage.getItem(PITCH_KEY));
  setPitch(saved > 0 ? saved : DEFAULT_PITCH);
} catch {
  setPitch(DEFAULT_PITCH);
}
pitchInput.addEventListener('input', () => {
  const v = setPitch(Number(pitchInput.value));
  try {
    localStorage.setItem(PITCH_KEY, String(v));
  } catch {
    /* setting just won't persist */
  }
});

// --- mallet size: a room rule (persisted locally for now) ------------------------
const MALLET_KEY = 'airhockey.malletScale';
const malletInput = document.getElementById('malletInput') as HTMLInputElement;
const malletOut = document.getElementById('malletOut') as HTMLOutputElement;

function setMalletScale(v: number) {
  const scale = clampMalletScale(v);
  view.setRoom({ malletScale: scale });
  malletInput.value = String(scale);
  malletOut.value = `${Math.round(scale * 100)}%`;
  return scale;
}

try {
  const saved = Number(localStorage.getItem(MALLET_KEY));
  setMalletScale(saved > 0 ? saved : DEFAULT_ROOM.malletScale);
} catch {
  setMalletScale(DEFAULT_ROOM.malletScale);
}
malletInput.addEventListener('input', () => {
  const v = setMalletScale(Number(malletInput.value));
  try {
    localStorage.setItem(MALLET_KEY, String(v));
  } catch {
    /* setting just won't persist */
  }
});

// --- points to win: a room rule (persisted locally for now) ------------------------
const WIN_KEY = 'airhockey.winScore';
const winInput = document.getElementById('winInput') as HTMLInputElement;
const winOut = document.getElementById('winOut') as HTMLOutputElement;

function setWinScore(v: number) {
  const n = clampWinScore(v);
  view.setRoom({ winScore: n });
  winInput.value = String(n);
  winOut.value = String(n);
  return n;
}

try {
  const saved = Number(localStorage.getItem(WIN_KEY));
  setWinScore(saved > 0 ? saved : DEFAULT_ROOM.winScore);
} catch {
  setWinScore(DEFAULT_ROOM.winScore);
}
winInput.addEventListener('input', () => {
  const n = setWinScore(Number(winInput.value));
  try {
    localStorage.setItem(WIN_KEY, String(n));
  } catch {
    /* setting just won't persist */
  }
});

// While the camera angle or mallet size is being changed the menu fades, so the table behind it shows.
let peekTimer: ReturnType<typeof setTimeout> | null = null;
function peek(on: boolean) {
  if (peekTimer) clearTimeout(peekTimer);
  peekTimer = null;
  document.body.classList.toggle('peek', on);
}
for (const el of [pitchInput, malletInput]) {
  el.addEventListener('pointerdown', () => peek(true));
  for (const ev of ['pointerup', 'pointercancel', 'blur'] as const) el.addEventListener(ev, () => peek(false));
  el.addEventListener('keydown', () => {
    // Keyboard changes have no release: fade back a moment after the last key.
    peek(true);
    peekTimer = setTimeout(() => peek(false), 800);
  });
}

// --- audio (persisted, both on by default) -----------------------------------
const audioKeys = { music: 'airhockey.music', sfx: 'airhockey.sfx' } as const;
const audioButtons = [...document.querySelectorAll<HTMLButtonElement>('#audio button')];

function setAudio(kind: 'music' | 'sfx', on: boolean) {
  if (kind === 'music') view.sound.setMusic(on);
  else view.sound.setSfx(on);
  const b = audioButtons.find((x) => x.dataset.k === kind);
  if (b) {
    b.setAttribute('aria-pressed', String(on));
    b.textContent = `${kind === 'music' ? 'MUSIC' : 'SOUND FX'} ${on ? 'ON' : 'OFF'}`;
  }
}

for (const kind of ['music', 'sfx'] as const) {
  let on = true;
  try {
    on = localStorage.getItem(audioKeys[kind]) !== '0';
  } catch {
    /* storage unavailable: default on */
  }
  setAudio(kind, on);
}
for (const b of audioButtons) {
  b.addEventListener('click', () => {
    const kind = b.dataset.k as 'music' | 'sfx';
    const on = b.getAttribute('aria-pressed') !== 'true';
    setAudio(kind, on);
    try {
      localStorage.setItem(audioKeys[kind], on ? '1' : '0');
    } catch {
      /* setting just won't persist */
    }
  });
}
// --- FPS / ping display (persisted, on by default) -------------------------------
const HUD_KEY = 'airhockey.hud';
const hudToggle = byId('hudToggle');

function setHud(on: boolean) {
  document.body.classList.toggle('nohud', !on);
  hudToggle.setAttribute('aria-pressed', String(on));
  hudToggle.textContent = `SHOW FPS / PING ${on ? 'ON' : 'OFF'}`;
}

try {
  setHud(localStorage.getItem(HUD_KEY) !== '0');
} catch {
  setHud(true);
}
hudToggle.addEventListener('click', () => {
  const on = hudToggle.getAttribute('aria-pressed') !== 'true';
  setHud(on);
  try {
    localStorage.setItem(HUD_KEY, on ? '1' : '0');
  } catch {
    /* setting just won't persist */
  }
});

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
const qualitySelect = document.getElementById('quality') as HTMLSelectElement;
const TARGET_FPS = 56; // a 60 Hz display averages a little under 60

function setQuality(q: Quality) {
  view.setQuality(q);
  qualitySelect.value = q;
}

function saveQuality(q: Quality) {
  try {
    localStorage.setItem(QUALITY_KEY, q);
  } catch {
    /* setting just won't persist */
  }
}

qualitySelect.addEventListener('change', () => {
  const q = qualitySelect.value as Quality;
  setQuality(q);
  saveQuality(q);
});

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
const diffButtons = [...document.querySelectorAll<HTMLButtonElement>('#difficulty button')];

function setDifficulty(d: Difficulty) {
  view.setDifficulty(d);
  for (const b of diffButtons) b.setAttribute('aria-pressed', String(b.dataset.d === d));
}

let savedDiff: Difficulty = 'medium';
try {
  const v = localStorage.getItem(DIFF_KEY) as Difficulty | null;
  if (v && DIFFICULTIES.includes(v)) savedDiff = v;
} catch {
  /* storage unavailable */
}
setDifficulty(savedDiff);
for (const b of diffButtons) {
  b.addEventListener('click', () => {
    const d = b.dataset.d as Difficulty;
    setDifficulty(d);
    try {
      localStorage.setItem(DIFF_KEY, d);
    } catch {
      /* setting just won't persist */
    }
  });
}

// --- player colour (persisted) -------------------------------------------------
const COLOR_KEY = 'airhockey.color';
const colorBox = document.getElementById('colors') as HTMLElement;
const swatches = PALETTE_HEX.map((hex, i) => {
  const b = document.createElement('button');
  const css = `#${hex.toString(16).padStart(6, '0')}`;
  b.style.setProperty('--c', css);
  b.setAttribute('aria-label', `Colour ${i + 1}`);
  b.addEventListener('click', () => {
    if (i === myColor) return;
    setColor(i);
    try {
      localStorage.setItem(COLOR_KEY, String(i));
    } catch {
      /* setting just won't persist */
    }
    setPlayers(players); // rebuild so every mallet, light and score takes its new colour
  });
  colorBox.appendChild(b);
  return b;
});

function setColor(i: number) {
  myColor = i;
  swatches.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
}

try {
  const saved = Number(localStorage.getItem(COLOR_KEY));
  if (Number.isInteger(saved) && saved >= 0 && saved < PALETTE_HEX.length) myColor = saved;
} catch {
  /* storage unavailable */
}
setColor(myColor);

// --- single player: play / pause ---------------------------------------------
// Playing = fullscreen, hidden cursor. Leaving fullscreen (Esc) or the pause button pauses.
let playing = false;
const canFullscreen = !DEBUG && !!document.documentElement.requestFullscreen;
const spStart = byId('spStart') as HTMLButtonElement;

const result = byId('result');
const resultTitle = byId('resultTitle');
const resultScore = byId('resultScore');

/** Game over: freeze play, give the cursor back and show who won. */
function showResult(winner: number, scores: number[]) {
  const won = winner === 0;
  resultTitle.textContent = won ? 'YOU WIN' : 'DEFEATED';
  resultScore.textContent = scores.join('  –  ');
  byId('resultNames').hidden = true;
  byId('resultNote').hidden = true;
  byId('resultWait').hidden = true;
  byId('again').hidden = false;
  byId('again').textContent = 'PLAY AGAIN';
  byId('toMenu').textContent = 'QUIT';
  result.className = won ? 'win' : 'lose';
  result.hidden = false;
  setPlaying(false);
  byId('again').focus({ preventScroll: true });
}

view.onGameOver = (w, s) => {
  if (mode === 'sp') showResult(w, s);
};

function setPlaying(on: boolean) {
  playing = on;
  document.body.classList.toggle('playing', on);
  input.enabled = on;
  input.mouseActive = on;
  view.running = on;
  if (on) {
    view.countdown = COUNTDOWN;
    show('none');
  } else {
    input.release();
    view.countdown = 0;
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
  result.hidden = true;
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
  if (mode !== 'sp' || !playing) return;
  setPlaying(false);
  show('pause');
}

/** Single player game thrown away: back to the main menu. */
function quitSingle() {
  setPlaying(false);
  result.hidden = true;
  mode = 'menu';
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

byId('again').addEventListener('click', () => {
  if (mode === 'sp') restartSingle();
});
byId('toMenu').addEventListener('click', () => {
  if (mode === 'sp') quitSingle();
});
addEventListener('keydown', (e) => {
  if (mode === 'sp' && (e.key === 'r' || e.key === 'R') && playing) {
    view.restart();
    view.countdown = COUNTDOWN;
  }
});

document.addEventListener('fullscreenchange', () => {
  if (mode === 'mp') mp.onFullscreenChange();
  else if (!document.fullscreenElement) pauseSingle();
});

addEventListener('keydown', (e) => {
  // Debug: Esc does nothing, so a test run isn't paused by stray keys.
  if (e.key !== 'Escape' || document.fullscreenElement || DEBUG) return;
  if (mode === 'sp') pauseSingle();
  else if (mode === 'mp') mp.selfPause();
});

// Clicking while playing re-grabs the pointer (e.g. after alt-tab).
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.screen, #result, #banner, #pauseBtn')) return;
  if (mode === 'sp' && playing) lockPointer();
  else if (mode === 'mp') mp.grab();
});

// --- in-game pause button and pause menu ---------------------------------------------
byId('pauseBtn').addEventListener('click', () => {
  if (mode === 'sp') pauseSingle();
  else if (mode === 'mp') mp.selfPause();
});
byId('resume').addEventListener('click', () => {
  if (mode === 'mp') void mp.resumeClick();
  else if (mode === 'sp') void start();
});
byId('restart').addEventListener('click', () => {
  if (mode === 'sp') restartSingle();
});
byId('pauseSettings').addEventListener('click', () => openSettings('pause'));
byId('quit').addEventListener('click', () => {
  if (mode === 'mp') mp.exit();
  else quitSingle();
});

// --- multiplayer ---------------------------------------------------------------
const mp: Multiplayer = new Multiplayer({
  view,
  input,
  setScreen(s) {
    show(s === 'menu' ? 'pause' : s === 'game' ? 'none' : s);
  },
  engage() {
    document.body.classList.add('playing');
    input.enabled = true;
    input.mouseActive = true;
    view.running = true;
  },
  disengage() {
    document.body.classList.remove('playing');
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
  exit() {
    mode = 'menu';
    if (document.fullscreenElement) void document.exitFullscreen();
    show('home');
  },
  countdown,
});

// --- name, main menu, single player setup, settings ------------------------------
const nameInput = byId('nameInput') as HTMLInputElement;
const settingsName = byId('settingsName') as HTMLInputElement;

function enterMulti(room: string | null, auto = false) {
  mode = 'mp';
  mp.enter(room, auto);
}

/** After the name: straight back into the room you were in, else the main menu. */
function afterName() {
  const room = new URLSearchParams(location.search).get('room') ?? savedRoom();
  if (room) enterMulti(room, true);
  else show('home');
}

// First visit: ask for a name (saved in localStorage, so later visits skip this).
byId('nameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = setName(nameInput.value);
  const note = byId('nameNote');
  if (!name) {
    note.textContent = 'Pick a name first';
    note.classList.add('warn');
    nameInput.focus();
    return;
  }
  nameInput.value = name;
  afterName();
});

byId('goSingle').addEventListener('click', () => {
  mode = 'sp';
  setPlayers(players); // a fresh game, and the table an online game may have replaced
  syncPlayersUrl();
  show('spSetup');
});
spStart.addEventListener('click', () => {
  view.restart();
  void start();
});
byId('spBack').addEventListener('click', () => quitSingle());
byId('goMulti').addEventListener('click', () => enterMulti(null));
byId('goSettings').addEventListener('click', () => openSettings('home'));

function openSettings(from: Screen) {
  settingsFrom = from;
  settingsName.value = getName() ?? '';
  byId('settingsNote').textContent = '';
  show('settings');
}

byId('settingsBack').addEventListener('click', () => show(settingsFrom));
byId('settingsNameForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const note = byId('settingsNote');
  const name = setName(settingsName.value);
  note.classList.toggle('warn', !name);
  note.textContent = name ? 'Name saved' : 'Pick a name first';
  if (!name) return;
  settingsName.value = nameInput.value = name;
  mp.rename(name);
});

// --- HUD: FPS (and ping online), then every seat by score -----------------------------
const hudStats = byId('hudStats');
const hudScores = byId('hudScores');
let hudKey = '';

/** Single player: you and the AIs. */
function spStandings(): Standing[] | null {
  const scores = view.match?.scores;
  if (!scores) return null;
  return scores.map((score, seat) => ({
    seat,
    name: seat === 0 ? (getName() ?? 'YOU') : players > 2 ? `AI ${seat}` : 'AI',
    color: -1,
    score,
    ai: seat > 0,
    ping: 0,
    me: seat === 0,
  }));
}

function renderHud() {
  const ping = mode === 'mp' && mp.ping > 0 ? ` · ${Math.round(mp.ping)} ms` : '';
  hudStats.textContent = `${view.fps} FPS${ping}`;
  renderScores();
}

function renderScores() {
  const rows = (mode === 'mp' ? mp.standings() : mode === 'sp' ? spStandings() : null) ?? [];
  // Highest score on top; ties keep seat order.
  rows.sort((a, b) => b.score - a.score || a.seat - b.seat);
  const key = rows.map((r) => `${r.seat}|${r.name}|${r.color}|${r.score}|${r.ai}|${Math.round(r.ping)}`).join(';');
  if (key === hudKey) return;
  hudKey = key;
  hudScores.replaceChildren(
    ...rows.flatMap((r) => {
      const who = document.createElement('div');
      who.className = r.me ? 'who me' : 'who';
      const dot = document.createElement('span');
      dot.className = 'dot';
      const hex = r.color >= 0 ? (PALETTE_HEX[r.color] ?? 0xffffff) : seatColor(r.seat).getHex();
      dot.style.setProperty('--c', `#${hex.toString(16).padStart(6, '0')}`);
      who.append(dot, r.name);
      const pts = document.createElement('div');
      pts.className = 'pts';
      pts.textContent = String(r.score);
      const ms = document.createElement('div');
      ms.className = 'ms';
      ms.textContent = !r.ai && mode === 'mp' && r.ping > 0 ? `${Math.round(r.ping)} ms` : '';
      return [who, pts, ms];
    }),
  );
}

view.onFps = renderHud;
setInterval(renderHud, 500);
setInterval(renderScores, 150);

input.enabled = false;
if (DEBUG) Object.assign(window, { airhockey: { view, mp } });
setPlayers(parse(new URLSearchParams(location.search).get('players')));
nameInput.value = getName() ?? '';
if (getName()) afterName();
else show('name');

// First run: pick the quality from a short live FPS test. The menu waits for it (no blur, which would skew it).
let savedQuality: Quality | null = null;
try {
  const v = localStorage.getItem(QUALITY_KEY) as Quality | null;
  if (v && QUALITIES.includes(v)) savedQuality = v;
} catch {
  /* storage unavailable: detect every load */
}
if (savedQuality) {
  setQuality(savedQuality);
} else {
  document.body.classList.add('benchmarking');
  spStart.disabled = true;
  spStart.textContent = 'DETECTING GRAPHICS…';
  void detectQuality().then((q) => {
    setQuality(q);
    saveQuality(q);
    document.body.classList.remove('benchmarking');
    spStart.disabled = false;
    spStart.textContent = 'START';
  });
}
