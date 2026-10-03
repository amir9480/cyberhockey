import type { ServerMsg } from '@airhockey/shared/protocol';
import type { Socket } from './socket';
import { BaseTransport } from './transport';

/*
 * WebRTC plumbing for P2P rooms. Players find each other through the server (`Signaler` relays the set-up messages
 * over the websocket); after that, game traffic goes straight between browsers on a data channel (`PeerLink`).
 * Public STUN servers let browsers on different networks find a way through; there is no relay (TURN), so a network
 * that blocks direct connections (some VPNs, strict office or mobile networks) can't play P2P.
 */

const ICE: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }],
};
/** A link that hasn't opened by then never will. */
const OPEN_TIMEOUT = 10_000;
/** Both ends ping every 2 s: this long without a word, the other end is gone (closed laptop, lost Wi-Fi). */
const SILENCE = 8000;
/** A link this backed up is hopeless; drop it rather than stall. */
const MAX_BUFFERED = 1_000_000;

/** One set-up message. `l`: which link it is for. */
export type SignalData =
  | { l: string; k: 'offer' | 'answer'; sdp: string }
  | { l: string; k: 'ice'; c: RTCIceCandidateInit | null }
  | { l: string; k: 'bye' };

type SignalMsg = Extract<ServerMsg, { t: 'signal' }>;

const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');

function parseSignal(raw: unknown): SignalData | null {
  const d = raw as Partial<SignalData> | null;
  if (!d || typeof d.l !== 'string' || typeof d.k !== 'string') return null;
  if ((d.k === 'offer' || d.k === 'answer') && typeof (d as { sdp?: unknown }).sdp !== 'string') return null;
  return d as SignalData;
}

/** Routes WebRTC set-up messages between the server socket and the links they belong to. */
export class Signaler {
  /** An offer for a link nobody here knows: a player connecting to the room hosted here. */
  onOffer: (from: string, id: string, name: string, d: SignalData) => void = (from, _id, _name, d) =>
    this.send(from, { l: d.l, k: 'bye' });
  private links = new Map<string, (from: string, d: SignalData) => void>();

  constructor(private socket: Socket) {}

  send(to: string, data: SignalData) {
    this.socket.send({ t: 'signal', to, data });
  }

  register(link: string, fn: (from: string, d: SignalData) => void) {
    this.links.set(link, fn);
  }

  unregister(link: string) {
    this.links.delete(link);
  }

  receive(m: SignalMsg) {
    const d = parseSignal(m.data);
    if (!d) return;
    const fn = this.links.get(d.l);
    if (fn) fn(m.from, d);
    else if (d.k === 'offer') this.onOffer(m.from, m.id, m.name, d);
  }
}

/** One WebRTC connection with one data channel, to the connection `peer`. Either end: `offer()` or `answer()`. */
export class PeerLink {
  onOpen: () => void = () => {};
  onData: (data: string | ArrayBuffer) => void = () => {};
  /** Closed, failed, or never opened. Once. */
  onClose: () => void = () => {};
  private pc = new RTCPeerConnection(ICE);
  private dc: RTCDataChannel | null = null;
  private pendingIce: RTCIceCandidateInit[] = [];
  private closed = false;
  private lastHeard = 0;
  private openTimer: ReturnType<typeof setTimeout>;
  private watchdog: ReturnType<typeof setInterval> | null = null;

  constructor(
    private sig: Signaler,
    readonly peer: string,
    readonly id = randomId(),
  ) {
    sig.register(id, (from, d) => {
      if (from === peer) void this.signal(d);
    });
    this.pc.onicecandidate = (e) => sig.send(peer, { l: id, k: 'ice', c: e.candidate ? e.candidate.toJSON() : null });
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === 'failed' || s === 'closed') this.close();
    };
    this.openTimer = setTimeout(() => {
      if (this.dc?.readyState !== 'open') this.close();
    }, OPEN_TIMEOUT);
  }

  /** The joining end: make the channel and the offer. */
  async offer() {
    try {
      this.attach(this.pc.createDataChannel('game', { ordered: true }));
      const o = await this.pc.createOffer();
      await this.pc.setLocalDescription(o);
      this.sig.send(this.peer, { l: this.id, k: 'offer', sdp: o.sdp ?? '' });
    } catch {
      this.close();
    }
  }

  /** The hosting end: take the joiner's offer. */
  async answer(offer: SignalData) {
    this.pc.ondatachannel = (e) => this.attach(e.channel);
    await this.signal(offer);
  }

  send(data: string | Uint8Array) {
    const dc = this.dc;
    if (dc?.readyState !== 'open') return;
    if (dc.bufferedAmount > MAX_BUFFERED) {
      this.close();
      return;
    }
    if (typeof data === 'string') dc.send(data);
    else dc.send(data as Uint8Array<ArrayBuffer>);
  }

  close(bye = true) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.openTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    this.sig.unregister(this.id);
    if (bye) this.sig.send(this.peer, { l: this.id, k: 'bye' });
    this.dc?.close();
    this.pc.close();
    this.onClose();
  }

  private async signal(d: SignalData) {
    if (this.closed) return;
    try {
      if (d.k === 'offer' || d.k === 'answer') {
        await this.pc.setRemoteDescription({ type: d.k, sdp: d.sdp });
        for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c);
        if (d.k === 'offer') {
          const a = await this.pc.createAnswer();
          await this.pc.setLocalDescription(a);
          this.sig.send(this.peer, { l: this.id, k: 'answer', sdp: a.sdp ?? '' });
        }
      } else if (d.k === 'ice') {
        if (!d.c) return; // that was the last one
        if (this.pc.remoteDescription) await this.pc.addIceCandidate(d.c);
        else this.pendingIce.push(d.c);
      } else if (d.k === 'bye') this.close(false);
    } catch {
      this.close();
    }
  }

  private attach(dc: RTCDataChannel) {
    this.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      clearTimeout(this.openTimer);
      this.lastHeard = performance.now();
      this.watchdog = setInterval(() => {
        if (performance.now() - this.lastHeard > SILENCE) this.close();
      }, 1000);
      this.onOpen();
    };
    dc.onmessage = (e) => {
      this.lastHeard = performance.now();
      this.onData(e.data as string | ArrayBuffer);
    };
    dc.onclose = () => this.close(false);
  }
}

/** This player's connection to a room hosted in another player's browser. Doesn't reconnect: the host is the room. */
export class RtcTransport extends BaseTransport {
  private link: PeerLink;

  constructor(sig: Signaler, peer: string) {
    super();
    this.link = new PeerLink(sig, peer);
    this.link.onData = (d) => this.receive(d);
    this.link.onClose = () => this.lost();
    void this.link.offer();
  }

  protected write(data: string | Uint8Array) {
    this.link.send(data);
  }

  close() {
    this.link.onClose = () => {};
    this.link.close();
    this.connected = false;
    this.stopPing();
  }
}
