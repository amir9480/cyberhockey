import { CrazyGamesPlatform } from './crazygames';
import { ItchPlatform } from './itch';
import { SinglePlayerPlatform } from './singleplayer';
import type { Platform } from './types';
import { WebPlatform } from './web';

export type { Platform, RoomRef } from './types';

/**
 * The platform this build is for (`VITE_PLATFORM` at build time: `pnpm build` makes the web build, `pnpm
 * build:crazygames` the CrazyGames one, `pnpm build:singleplayer` the single player one, `pnpm build:itch` the itch.io one). A build-time constant, so the
 * other platforms' code is left out of the bundle.
 */
export const platform: Platform =
  import.meta.env.VITE_PLATFORM === 'crazygames'
    ? new CrazyGamesPlatform()
    : import.meta.env.VITE_PLATFORM === 'itch'
      ? new ItchPlatform()
      : import.meta.env.VITE_PLATFORM === 'singleplayer'
        ? new SinglePlayerPlatform()
        : new WebPlatform();
