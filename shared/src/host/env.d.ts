// The timers and clocks both Node and browsers have. Room code runs in either (the server, or a P2P host's browser),
// so it may use only these.
declare function setTimeout(fn: () => void, ms?: number): unknown;
declare function clearTimeout(id: unknown): void;
declare function setInterval(fn: () => void, ms?: number): unknown;
declare function clearInterval(id: unknown): void;
declare const performance: { now(): number };
declare const crypto: { getRandomValues<T extends Uint8Array>(array: T): T };
