import { View, DEFAULT_PITCH, QUALITIES, type Quality } from './game/view';
import { Input } from './game/input';
import type { PlayerCount } from './game/layout';
import { DEFAULT_ROOM, clampMalletScale, clampWinScore } from './game/room';
import { DIFFICULTIES, type Difficulty } from './game/ai';
import { PALETTE_HEX, assignSeatColors } from './game/colors';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const pauseMenu = document.getElementById('pause') as HTMLElement;
const resumeBtn = document.getElementById('resume') as HTMLButtonElement;
const buttons = [...document.querySelectorAll<HTMLButtonElement>('#modes button')];
const view = new View(canvas);
const input = new Input(view, canvas);

const parse = (v: string | null): PlayerCount => (v === '3' ? 3 : v === '4' ? 4 : 2);

let players: PlayerCount = 2;
let myColor = 0;

function setPlayers(n: PlayerCount) {
  players = n;
  assignSeatColors(myColor); // rivals re-roll their colours whenever the table is rebuilt
  view.setPlayers(n);
  for (const b of buttons) b.setAttribute('aria-pressed', String(Number(b.dataset.n) === n));
  const url = new URL(location.href);
  url.searchParams.set('players', String(n));
  history.replaceState(null, '', url);
}

for (const b of buttons) b.addEventListener('click', () => setPlayers(parse(b.dataset.n ?? null)));
addEventListener('keydown', (e) => {
  if (paused && (e.key === '2' || e.key === '3' || e.key === '4')) setPlayers(parse(e.key));
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

// --- play / pause -----------------------------------------------------------
// Playing = fullscreen, hidden cursor. Leaving fullscreen (Esc) pauses.
let playing = false;
let paused = true; // the page opens on the pause menu
const canFullscreen = !!document.documentElement.requestFullscreen;

const result = document.getElementById('result') as HTMLElement;
const resultTitle = document.getElementById('resultTitle') as HTMLElement;
const resultScore = document.getElementById('resultScore') as HTMLElement;

/** Game over: freeze play, give the cursor back and show who won. */
function showResult(winner: number, scores: number[]) {
  const won = winner === 0;
  resultTitle.textContent = won ? 'YOU WIN' : 'DEFEATED';
  resultScore.textContent = scores.join('  –  ');
  result.className = won ? 'win' : 'lose';
  result.hidden = false;
  view.running = false;
  input.enabled = false;
  input.mouseActive = false;
  input.release();
  document.body.classList.remove('playing');
  if (document.pointerLockElement) document.exitPointerLock();
  document.getElementById('again')?.focus({ preventScroll: true });
}

function hideResult() {
  result.hidden = true;
}

/** Start a fresh game right now (menu button, R key, play again). */
function restartGame() {
  hideResult();
  view.restart();
  if (playing) {
    view.running = true;
    input.enabled = true;
    input.mouseActive = true;
    document.body.classList.add('playing');
    lockPointer();
  }
}

view.onGameOver = showResult;
document.getElementById('again')?.addEventListener('click', restartGame);
document.getElementById('toMenu')?.addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else setPlaying(false);
});
document.getElementById('restart')?.addEventListener('click', () => {
  view.restart();
  resumeBtn.focus({ preventScroll: true });
});
addEventListener('keydown', (e) => {
  if ((e.key === 'r' || e.key === 'R') && playing && result.hidden) restartGame();
});

function setPlaying(on: boolean) {
  if (on === playing) return;
  playing = on;
  paused = !on;
  document.body.classList.toggle('playing', on);
  pauseMenu.hidden = on;
  input.enabled = on;
  view.running = on;
  input.mouseActive = on;
  if (!on) {
    input.release();
    if (!result.hidden) {
      // Left from the game-over screen: the next PLAY starts fresh.
      hideResult();
      view.restart();
    }
  }
  if (on) resumeBtn.textContent = 'RESUME';
  else resumeBtn.focus({ preventScroll: true });
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

async function start() {
  view.sound.unlock();
  if (!canFullscreen) {
    setPlaying(true); // e.g. iPhone Safari: no fullscreen API, Esc pauses instead
    return;
  }
  // Both requests need the click's user activation, so issue them together.
  const fs = document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  lockPointer();
  try {
    await fs;
  } catch {
    /* play anyway */
  }
  setPlaying(true);
  lockPointer(); // retry in case the first one raced fullscreen
}

document.addEventListener('fullscreenchange', () => {
  if (document.fullscreenElement) setPlaying(true);
  else setPlaying(false);
});

addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && playing && !document.fullscreenElement) setPlaying(false);
});

// Clicking while playing re-grabs the pointer (e.g. after alt-tab).
document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('#modes') || t.closest('#pause') || t.closest('#result')) return;
  if (playing) lockPointer();
});
resumeBtn.addEventListener('click', () => void start());

input.enabled = false;
resumeBtn.focus({ preventScroll: true });
setPlayers(parse(new URLSearchParams(location.search).get('players')));

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
  resumeBtn.disabled = true;
  resumeBtn.textContent = 'DETECTING GRAPHICS…';
  void detectQuality().then((q) => {
    setQuality(q);
    saveQuality(q);
    document.body.classList.remove('benchmarking');
    resumeBtn.disabled = false;
    resumeBtn.textContent = playing ? 'RESUME' : 'PLAY';
  });
}
