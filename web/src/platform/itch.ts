import { SinglePlayerPlatform } from './singleplayer';

/**
 * itch.io: the single player build, uploaded as a zip and shown in itch's sandboxed iframe. The frame's address is
 * itch's, not ours, so the page never rewrites it.
 */
export class ItchPlatform extends SinglePlayerPlatform {
  override readonly id = 'itch';

  override roomChanged() {}
}
