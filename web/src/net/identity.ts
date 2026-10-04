import { cleanName } from '@airhockey/shared/protocol';
import { platform } from '../platform';

// Temporary identity: a display name plus a random guest token. Real authentication replaces this later;
// the server only ever sees `token` (who you are) and `name` (what others see) as separate things.
const NAME_KEY = 'airhockey.name';
const TOKEN_KEY = 'airhockey.token';

const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* identity just won't persist */
  }
};

let memToken: string | null = null;
let memName: string | null = null;

/** The display name: the platform's for this player, else the saved one (null on a first visit). */
export function getName(): string | null {
  if (platform.name) return platform.name;
  const v = memName ?? read(NAME_KEY);
  return v ? cleanName(v, '') || null : null;
}

/** Cleans and stores the name; returns it (empty if nothing usable was given). */
export function setName(raw: string): string {
  const name = cleanName(raw, '');
  if (name) {
    memName = name;
    write(NAME_KEY, name);
  }
  return name;
}

export function getToken(): string {
  const saved = memToken ?? read(TOKEN_KEY);
  if (saved && /^[0-9a-f]{32}$/.test(saved)) return (memToken = saved);
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  memToken = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  write(TOKEN_KEY, memToken);
  return memToken;
}

/** The server may mint a token if ours was missing or malformed. */
export function adoptToken(token: string) {
  if (token !== memToken) {
    memToken = token;
    write(TOKEN_KEY, token);
  }
}
