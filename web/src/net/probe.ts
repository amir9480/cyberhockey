import { RtcTransport, type Signaler } from './rtc';

/** A room's measured ping: ms, 'testing' while measuring, or 'fail' when no direct connection could be made. */
export type ProbeResult = number | 'testing' | 'fail';

/** Probes running at once (each is a WebRTC connection). */
const PARALLEL = 4;
/** Most rooms measured. */
const MAX_ROOMS = 12;
/** A result is good for this long. */
const FRESH_MS = 30_000;
/** After the link opens, pings are collected this long (the transport sends a quick burst on open). */
const SAMPLE_MS = 900;

interface Entry {
  result: ProbeResult;
  at: number;
}

/**
 * Measures the real ping to P2P room hosts, by briefly connecting to each the way a player would. Rooms this
 * network can't reach directly come out as 'fail', so players see that before trying to join.
 */
export class Prober {
  onChange: () => void = () => {};
  private results = new Map<string, Entry>();
  private queue: string[] = [];
  private running = new Set<RtcTransport>();
  private active = false;

  constructor(private sig: Signaler) {}

  /** The measurement for host connection `peer`, or undefined when not measured yet. */
  get(peer: string): ProbeResult | undefined {
    return this.results.get(peer)?.result;
  }

  /** Measure these hosts (the listed rooms, in order) where there's no fresh result. */
  want(peers: string[]) {
    if (!this.active) return;
    const now = performance.now();
    for (const p of peers.slice(0, MAX_ROOMS)) {
      const r = this.results.get(p);
      if (r && (r.result === 'testing' || now - r.at < FRESH_MS)) continue;
      if (!this.queue.includes(p)) this.queue.push(p);
    }
    this.pump();
  }

  /** Probe only while someone is looking at the P2P list. */
  setActive(on: boolean) {
    this.active = on;
    if (on) return;
    this.queue = [];
    for (const t of this.running) t.close();
    this.running.clear();
    for (const [p, r] of this.results) if (r.result === 'testing') this.results.delete(p);
  }

  private pump() {
    while (this.active && this.running.size < PARALLEL && this.queue.length) this.probe(this.queue.shift()!);
  }

  private probe(peer: string) {
    this.set(peer, 'testing');
    const t = new RtcTransport(this.sig, peer);
    this.running.add(t);
    let done = false;
    const finish = (result: ProbeResult) => {
      if (done) return;
      done = true;
      this.running.delete(t);
      t.close();
      this.set(peer, result);
      this.pump();
    };
    t.onOpen = () => setTimeout(() => finish(t.rtt > 0 ? Math.round(t.rtt) : 'fail'), SAMPLE_MS);
    t.onClose = () => finish(t.rtt > 0 ? Math.round(t.rtt) : 'fail');
  }

  private set(peer: string, result: ProbeResult) {
    this.results.set(peer, { result, at: performance.now() });
    this.onChange();
  }
}
