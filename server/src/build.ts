import { randomBytes } from 'node:crypto';

/**
 * New on every server start. Stamped into the served page and sent in `hello`: a client whose page came from an
 * earlier run (a deploy since) sees a different one and reloads to pick up the new frontend.
 */
export const BUILD_ID = randomBytes(6).toString('hex');
