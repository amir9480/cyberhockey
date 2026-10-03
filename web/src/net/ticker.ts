import type { Every } from '@airhockey/shared/host/room';

// A page's own timers slow to once a second while its tab is hidden; a worker's don't. A P2P host runs the game for
// everyone, so its game loop is driven from a worker and keeps going if the host switches tabs.
const SRC = `const t = new Map();
onmessage = (e) => {
  const { id, ms } = e.data;
  if (ms) t.set(id, setInterval(() => postMessage(id), ms));
  else { clearInterval(t.get(id)); t.delete(id); }
};`;

let worker: Worker | null | undefined;
const fns = new Map<number, () => void>();
let nextId = 1;

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(URL.createObjectURL(new Blob([SRC], { type: 'text/javascript' })));
    worker.onmessage = (e: MessageEvent<number>) => fns.get(e.data)?.();
  } catch {
    worker = null; // no workers here: plain timers it is
  }
  return worker;
}

export const workerEvery: Every = (fn, ms) => {
  const w = getWorker();
  if (!w) {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }
  const id = nextId++;
  fns.set(id, fn);
  w.postMessage({ id, ms });
  return () => {
    fns.delete(id);
    w.postMessage({ id, ms: 0 });
  };
};
