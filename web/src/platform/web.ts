import type { NetKind } from '../net/modes';
import type { Platform, RoomRef } from './types';

/** URL parameter holding the room id, per kind of room. */
const URL_PARAM: Record<NetKind, string> = { server: 'room', p2p: 'p2p' };

/**
 * The game's own site: players name themselves, rooms are shared as links to this page (`?room=` / `?p2p=`, kept in
 * the address bar), and the server is the one that served the page.
 */
export class WebPlatform implements Platform {
  readonly id = 'web';
  readonly fullscreen = true;
  readonly ownNames = true;
  readonly name = null;
  readonly instantMultiplayer = false;
  onJoinRoom: ((room: RoomRef) => void) | null = null;
  onNameChange: ((name: string) => void) | null = null;
  onMute: ((muted: boolean) => void) | null = null;

  init() {
    return Promise.resolve();
  }

  loaded() {}

  serverUrl() {
    return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
  }

  linkedRoom(): RoomRef | null {
    const q = new URLSearchParams(location.search);
    for (const kind of ['server', 'p2p'] as const) {
      const id = q.get(URL_PARAM[kind]);
      if (id) return { kind, id };
    }
    return null;
  }

  roomLink(room: RoomRef) {
    return this.url(room).toString();
  }

  roomChanged(room: RoomRef | null) {
    history.replaceState(null, '', this.url(room));
  }

  gameplayStart() {}
  gameplayStop() {}
  celebrate() {}

  /** This page's address for `room`: `?room=` for one on the server, `?p2p=` for a P2P one (none: neither). */
  private url(room: RoomRef | null) {
    const url = new URL(location.href);
    url.searchParams.delete('players');
    for (const p of Object.values(URL_PARAM)) url.searchParams.delete(p);
    if (room) url.searchParams.set(URL_PARAM[room.kind], room.id);
    return url;
  }
}
