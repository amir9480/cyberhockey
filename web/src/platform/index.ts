import { CrazyGamesPlatform } from './crazygames';
import type { Platform } from './types';
import { WebPlatform } from './web';

export type { Platform, RoomRef } from './types';

/**
 * The platform this build is for (`VITE_PLATFORM` at build time: `pnpm build` makes the web build, `pnpm
 * build:crazygames` the CrazyGames one). A build-time constant, so the other platform's code is left out of the bundle.
 */
export const platform: Platform = import.meta.env.VITE_PLATFORM === 'crazygames' ? new CrazyGamesPlatform() : new WebPlatform();
