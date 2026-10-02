/**
 * All audio is synthesised with Web Audio: no asset files. Music is a slow generative
 * pad/arpeggio loop. Effects are rendered once into AudioBuffers at startup (preloaded, so
 * playing one is just starting a buffer) and played back with per-hit gain / pitch.
 */

const BEAT = 60 / 72;
const CHORD_BEATS = 8;
const LOOKAHEAD = 1.5; // seconds of music scheduled ahead
// Am7 - Fmaj7 - Cmaj7 - Gmaj7 (MIDI notes)
const CHORDS = [
  [57, 60, 64, 67],
  [53, 57, 60, 64],
  [48, 55, 60, 64],
  [55, 59, 62, 66],
];
const ARP = [0, 2, 1, 3, 2, 3, 1, 2];

const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

interface ToneOpts {
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  /** Frequency to glide to over the note's length. */
  slideTo?: number;
}

function tone(c: BaseAudioContext, dest: AudioNode, start: number, dur: number, freq: number, o: ToneOpts = {}) {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, start);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(o.slideTo, 20), start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.linearRampToValueAtTime(o.gain ?? 0.2, start + (o.attack ?? 0.003));
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  osc.connect(g);
  g.connect(dest);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}

function click(c: BaseAudioContext, dest: AudioNode, noise: AudioBuffer, start: number, dur: number, highpass: number, gain: number) {
  const src = c.createBufferSource();
  src.buffer = noise;
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = highpass;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, start);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(hp);
  hp.connect(g);
  g.connect(dest);
  src.start(start);
  src.stop(start + dur + 0.02);
}

type Build = (c: BaseAudioContext, out: AudioNode, noise: AudioBuffer) => void;

/** Effect recipes, rendered to buffers once. Each starts at t = 0. */
const EFFECTS: Record<string, { dur: number; build: Build }> = {
  // Mallet touches the puck.
  hit: {
    dur: 0.2,
    build: (c, out, noise) => {
      tone(c, out, 0, 0.12, 220, { gain: 0.8, slideTo: 70 });
      click(c, out, noise, 0, 0.04, 2500, 0.18);
    },
  },
  // Puck bounces off the table edge / corner.
  wall: {
    dur: 0.15,
    build: (c, out) => tone(c, out, 0, 0.07, 640, { type: 'triangle', gain: 0.32, slideTo: 380 }),
  },
  // The local player wins a round.
  win: {
    dur: 0.9,
    build: (c, out) =>
      [72, 76, 79, 84].forEach((m, i) =>
        tone(c, out, i * 0.08, i === 3 ? 0.45 : 0.14, hz(m), { type: 'triangle', gain: 0.25, attack: 0.005 }),
      ),
  },
  // The local player loses a round.
  lose: {
    dur: 1.1,
    build: (c, out) => {
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 800;
      lp.connect(out);
      [64, 60, 57, 52].forEach((m, i) =>
        tone(c, lp, i * 0.16, i === 3 ? 0.5 : 0.2, hz(m), { type: 'sawtooth', gain: 0.2, slideTo: hz(m - 1) }),
      );
    },
  },
  // One AI player beats another. Quiet, so it doesn't compete with the local player's sounds.
  other: {
    dur: 0.5,
    build: (c, out) => {
      tone(c, out, 0, 0.18, hz(69), { gain: 0.1 });
      tone(c, out, 0.1, 0.25, hz(74), { gain: 0.1 });
    },
  },
  // UI button press.
  ui: {
    dur: 0.12,
    build: (c, out) => {
      tone(c, out, 0, 0.06, 900, { type: 'triangle', gain: 0.22, slideTo: 1400 });
      tone(c, out, 0.035, 0.07, 1800, { gain: 0.07 });
    },
  },
  // Slider step.
  tick: {
    dur: 0.05,
    build: (c, out) => tone(c, out, 0, 0.03, 1500, { gain: 0.1 }),
  },
};

export class Sound {
  musicOn = true;
  sfxOn = true;

  private ctx: AudioContext | null = null;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private musicIn!: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private timer: number | null = null;
  private nextChord = 0;
  private chordIdx = 0;
  private last = new Map<string, number>();

  constructor() {
    this.preload();
  }

  /** Must be called from a user gesture the first time (browser autoplay policy). */
  unlock() {
    if (!this.ctx) this.build();
    void this.ctx?.resume();
    this.applyMusic();
  }

  setMusic(on: boolean) {
    this.musicOn = on;
    this.applyMusic();
  }

  setSfx(on: boolean) {
    this.sfxOn = on;
  }

  // --- effects ---------------------------------------------------------------

  /** Mallet touches the puck. `power` 0..1 from the impact speed. */
  hit(power: number) {
    const p = clamp(power, 0.15, 1);
    this.play('hit', 0.4 + 0.6 * p, 0.9 + p * 0.3, 0.03);
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

  /** UI button press. */
  ui() {
    this.play('ui', 1, 1, 0.04);
  }

  /** Slider step. */
  tick() {
    this.play('tick', 1, 1, 0.06);
  }

  // --- internals -------------------------------------------------------------

  /** Render every effect once, up front. No user gesture is needed for offline rendering. */
  private preload() {
    const OAC = window.OfflineAudioContext;
    if (!OAC) return;
    const rate = 44100;
    for (const [name, fx] of Object.entries(EFFECTS)) {
      try {
        const c = new OAC(1, Math.ceil(rate * fx.dur), rate);
        const noise = c.createBuffer(1, rate * 0.2, rate);
        const d = noise.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
        fx.build(c, c.destination, noise);
        void c
          .startRendering()
          .then((buf) => this.buffers.set(name, buf))
          .catch(() => {});
      } catch {
        /* effect just stays silent */
      }
    }
  }

  private play(name: string, gain = 1, rate = 1, minGap = 0) {
    const c = this.ctx;
    const buf = this.buffers.get(name);
    if (!c || !buf || !this.sfxOn) return;
    const run = () => {
      const t = c.currentTime;
      if (t - (this.last.get(name) ?? -1) < minGap) return;
      this.last.set(name, t);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = c.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(this.sfxBus);
      src.start();
    };
    // Right after the first click the context may still be resuming.
    if (c.state === 'running') run();
    else void c.resume().then(run);
  }

  private build() {
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    const c = new AC();
    this.ctx = c;

    const comp = c.createDynamicsCompressor();
    comp.connect(c.destination);

    this.sfxBus = c.createGain();
    this.sfxBus.gain.value = 0.9;
    this.sfxBus.connect(comp);

    this.musicBus = c.createGain();
    this.musicBus.gain.value = 0;
    this.musicBus.connect(comp);

    // Everything melodic goes through `musicIn`: dry, plus an echo for space.
    this.musicIn = c.createGain();
    this.musicIn.connect(this.musicBus);
    const delay = c.createDelay(1);
    delay.delayTime.value = BEAT * 0.75;
    const fb = c.createGain();
    fb.gain.value = 0.38;
    const echoTone = c.createBiquadFilter();
    echoTone.type = 'lowpass';
    echoTone.frequency.value = 1800;
    const wet = c.createGain();
    wet.gain.value = 0.45;
    this.musicIn.connect(delay);
    delay.connect(echoTone);
    echoTone.connect(fb);
    fb.connect(delay);
    echoTone.connect(wet);
    wet.connect(this.musicBus);
  }

  private applyMusic() {
    const c = this.ctx;
    if (!c) return;
    this.musicBus.gain.setTargetAtTime(this.musicOn ? 0.5 : 0, c.currentTime, 0.4);
    if (this.musicOn && this.timer === null) {
      this.nextChord = c.currentTime + 0.1;
      this.timer = window.setInterval(this.schedule, 300);
      this.schedule();
    } else if (!this.musicOn && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private schedule = () => {
    const c = this.ctx!;
    while (this.nextChord < c.currentTime + LOOKAHEAD) {
      this.chord(this.nextChord, CHORDS[this.chordIdx % CHORDS.length]);
      this.nextChord += CHORD_BEATS * BEAT;
      this.chordIdx++;
    }
  };

  private chord(t: number, notes: number[]) {
    const c = this.ctx!;
    const len = CHORD_BEATS * BEAT;

    // Pad: two slightly detuned triangles per note, slow swell, soft lowpass.
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1000;
    lp.Q.value = 0.3;
    lp.connect(this.musicIn);
    for (const m of notes) {
      for (const det of [-6, 6]) {
        const osc = c.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = hz(m);
        osc.detune.value = det;
        const g = c.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.045, t + 2.2);
        g.gain.setValueAtTime(0.045, t + len - 0.2);
        g.gain.linearRampToValueAtTime(0.0001, t + len + 2.5);
        osc.connect(g);
        g.connect(lp);
        osc.start(t);
        osc.stop(t + len + 2.6);
      }
    }

    // Bass: root two octaves down.
    const bass = c.createOscillator();
    bass.type = 'sine';
    bass.frequency.value = hz(notes[0] - 24);
    const bg = c.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.linearRampToValueAtTime(0.16, t + 0.8);
    bg.gain.linearRampToValueAtTime(0.0001, t + len + 1.2);
    bass.connect(bg);
    bg.connect(this.musicIn);
    bass.start(t);
    bass.stop(t + len + 1.3);

    // Arpeggio: gentle plucks on eighth notes, a few left out so it breathes.
    const eighth = BEAT / 2;
    for (let k = 0; k < CHORD_BEATS * 2; k++) {
      if (Math.random() < 0.3) continue;
      const m = notes[ARP[k % ARP.length]] + 12;
      tone(c, this.musicIn, t + k * eighth, 1.1, hz(m), { type: 'triangle', gain: 0.035, attack: 0.01 });
    }
  }
}
