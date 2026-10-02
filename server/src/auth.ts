import { createHash, randomBytes } from 'node:crypto';

export interface Identity {
  id: string;
}

/**
 * Turns whatever credential the client sent into a stable identity. Guest auth is a stand-in:
 * real authentication swaps this provider and nothing else changes.
 */
export interface AuthProvider {
  identify(token: string | undefined): { identity: Identity; token: string };
}

const TOKEN_RE = /^[0-9a-f]{32}$/;

/** Anyone is a guest: the token is a random secret the client keeps, the id is derived from it. */
export class GuestAuth implements AuthProvider {
  identify(token: string | undefined) {
    const t = token && TOKEN_RE.test(token) ? token : randomBytes(16).toString('hex');
    const id = createHash('sha256').update(`airhockey-guest:${t}`).digest('hex').slice(0, 16);
    return { identity: { id }, token: t };
  }
}
