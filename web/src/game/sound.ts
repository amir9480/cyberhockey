/**
 * All audio is plain <audio> elements: no Web Audio, so nothing runs on a real-time audio thread between sounds (on
 * phones that thread competed with the game for the CPU). Effects are short MP3s in /sfx (rendered from the synth
 * recipes this file used to hold, see git history), each preloaded into a few elements so they can overlap; music is
 * one looping element. Volumes are the elements' own; iOS ignores those, so there effects play at their rendered level
 * and the sliders only mute at 0.
 */

const MUSIC_URL = `${import.meta.env.BASE_URL}musics/octosound-chill-synthwave.mp3`;
const SFX_URL = (name: string) => `${import.meta.env.BASE_URL}sfx/${name}.mp3`;

/** Each effect, and how many copies of it may play at once. */
const EFFECTS = { hit: 4, wall: 4, win: 1, lose: 1, other: 2, count: 2, go: 1, ui: 3, tick: 3 } as const;
type Effect = keyof typeof EFFECTS;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

const HIT_GAP = 0.12; // s: a softer hit this soon after the last one is not played
const HIT_HARDER = 1.5; // ...unless it is this many times harder
const HIT_RUN = 0.4; // s: hits closer together than this form a run
const HIT_RUN_FADE = 0.6; // each hit in a run is quieter: gain / (1 + run * this)

const now = () => performance.now() / 1000;

export class Sound {
  /** 0..1 */
  musicVolume = 0.2;
  /** 0..1 */
  sfxVolume = 1;

  private pools = new Map<Effect, HTMLAudioElement[]>();
  private music: HTMLAudioElement | null = null;
  /** A user gesture has called `unlock`: media may start. */
  private gestured = false;
  /** Everything silent, whatever the volumes (the platform asked: CrazyGames' mute setting). */
  private muted = false;
  /**
   * Every effect element started once inside a gesture (iOS only lets such elements play later): 'no', 'pending'
   * while their play() calls settle, 'yes' once all of them were allowed.
   */
  private primed: 'no' | 'pending' | 'yes' = 'no';
  /** The browser confirmed the music is playing (play() resolved), not just asked to. */
  private musicOk = false;
  private last = new Map<Effect, number>();
  private hitAt = -1;
  private hitPower = 0;
  /** Hits in the current quick run, after the first. */
  private hitRun = 0;

  constructor() {
    for (const [name, copies] of Object.entries(EFFECTS) as [Effect, number][]) {
      const pool: HTMLAudioElement[] = [];
      for (let i = 0; i < copies; i++) {
        const el = new Audio(SFX_URL(name));
        el.preload = 'auto';
        el.preservesPitch = false; // a faster hit sounds higher, as it did
        pool.push(el);
      }
      this.pools.set(name, pool);
    }
  }

  /**
   * Must be called from a user gesture (browser autoplay policy); cheap, so call it on every one until `unlocked`:
   * browsers differ in which events count (Safari and touch don't take pointerdown), and a refused start is retried.
   */
  unlock() {
    this.gestured = true;
    if (this.primed === 'no') this.prime();
    this.applyMusic();
  }

  /**
   * The browser has confirmed effects may play and the music is running (unless it's at 0): no more gestures needed.
   * Confirmed, not just requested: a gesture the browser doesn't count is refused a moment later, and must not stop
   * the retries.
   */
  get unlocked(): boolean {
    return this.primed === 'yes' && (this.muted || this.musicVolume <= 0 || this.musicOk);
  }

  /** Music volume, 0..1 (0 stops the track). */
  setMusicVolume(v: number) {
    this.musicVolume = clamp(v, 0, 1);
    this.applyMusic();
  }

  /** Silence everything (true), or let the volumes apply again. */
  setMuted(on: boolean) {
    this.muted = on;
    this.applyMusic();
  }

  /** Sound effects volume, 0..1. */
  setSfxVolume(v: number) {
    this.sfxVolume = clamp(v, 0, 1);
  }

  // --- effects ---------------------------------------------------------------

  /** Mallet touches the puck. `power` 0..1 from the impact speed. */
  hit(power: number) {
    const p = clamp(power, 0.15, 1);
    const t = now();
    const since = t - this.hitAt;
    // A burst of touches (dribbling, pinning, a puck rattling against a mallet) is one sound: a hit this soon after
    // another is skipped unless it is clearly harder, and each one in a quick run is quieter than the last.
    if (since < HIT_GAP && p < this.hitPower * HIT_HARDER) return;
    this.hitRun = since < HIT_RUN ? this.hitRun + 1 : 0;
    this.hitAt = t;
    this.hitPower = p;
    this.play('hit', (0.4 + 0.6 * p) / (1 + this.hitRun * HIT_RUN_FADE), 0.9 + p * 0.3);
  }

  /** Puck bounces off the table edge / corner. */
  wall(power: number) {
    const p = clamp(power, 0.1, 1);
    this.play('wall', 0.35 + 0.65 * p, 1, 0.05);
  }

  win() {
    this.play('win');
  }

  lose() {
    this.play('lose');
  }

  other() {
    this.play('other');
  }

  /** A countdown number (3, 2, 1). */
  count() {
    this.play('count', 1, 1, 0.2);
  }

  /** The countdown ends: play starts. */
  go() {
    this.play('go', 1, 1, 0.2);
  }

  /** UI button press. */
  ui() {
    this.play('ui', 1, 1, 0.04);
  }

  /** Slider step. */
  tick() {
    this.play('tick', 1, 1, 0.06);
  }

  // --- internals -------------------------------------------------------------

  /** Start every effect element once, muted, inside the gesture: iOS lets an element play later only after that. */
  private prime() {
    this.primed = 'pending';
    const all = [...this.pools.values()].flat();
    let refused = false;
    void Promise.all(
      all.map((el) => {
        el.muted = true;
        return el
          .play()
          .then(() => {
            el.pause();
            el.currentTime = 0;
          })
          .catch(() => {
            refused = true;
          })
          .finally(() => {
            el.muted = false;
          });
      }),
    ).then(() => {
      // Refused: not a gesture this browser counts; the next one tries again.
      this.primed = refused ? 'no' : 'yes';
    });
  }

  private play(name: Effect, gain = 1, rate = 1, minGap = 0) {
    if (!this.gestured || this.muted || this.sfxVolume <= 0) return;
    const t = now();
    if (t - (this.last.get(name) ?? -1) < minGap) return;
    this.last.set(name, t);
    const pool = this.pools.get(name)!;
    // A free copy, else the one furthest along (its tail is the least missed).
    const el = pool.find((a) => a.paused || a.ended) ?? pool.reduce((a, b) => (b.currentTime > a.currentTime ? b : a));
    el.volume = clamp(gain * this.sfxVolume, 0, 1);
    el.playbackRate = rate;
    el.currentTime = 0;
    void el.play().catch(() => {});
  }

  /**
   * Set the music's volume; start the track (fetched only now, on first use) or pause it at 0. Before the first
   * gesture (`unlock`) only the volume is kept.
   */
  private applyMusic() {
    const v = this.muted ? 0 : this.musicVolume;
    if (this.music) this.music.volume = v;
    if (!this.gestured) return;
    if (v > 0 && !this.music) {
      this.music = new Audio(MUSIC_URL);
      this.music.loop = true;
      this.music.preload = 'auto';
      this.music.volume = v;
    }
    const el = this.music;
    if (!el) return;
    if (v > 0 && el.paused) {
      void el.play().then(
        () => (this.musicOk = true),
        () => (this.musicOk = false),
      );
    } else if (v <= 0 && !el.paused) el.pause();
  }
}
