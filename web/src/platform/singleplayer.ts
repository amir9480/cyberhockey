import { WebPlatform } from './web';

/**
 * The single player build (static hosting, e.g. GitHub Pages): the game's own site without online multiplayer. There
 * is no server to talk to, so no room is ever linked to or joined.
 */
export class SinglePlayerPlatform extends WebPlatform {
  override readonly id = 'singleplayer';
  override readonly multiplayer = false;

  override linkedRoom() {
    return null;
  }
}
