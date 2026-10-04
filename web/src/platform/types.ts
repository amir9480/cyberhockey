import type { NetKind } from '../net/modes';

/** A room and how it is reached. */
export interface RoomRef {
  kind: NetKind;
  id: string;
}

/**
 * Where the game is published, and everything that differs between those places at run time: who the player is, how
 * rooms are shared and joined, which server to talk to, and what the page may do (fullscreen). The rest of the game
 * only talks to the platform through this. Markup that differs (links to other sites) is cut at build time instead:
 * `<!-- only:web -->` regions in index.html, see vite.config.ts.
 *
 * One is chosen at build time (`VITE_PLATFORM`, see `index.ts`): `WebPlatform` for the game's own site,
 * `CrazyGamesPlatform` for the CrazyGames build.
 */
export interface Platform {
  readonly id: 'web' | 'crazygames';
  /** The game may switch to fullscreen itself (the platform may forbid it and offer its own). */
  readonly fullscreen: boolean;
  /** Players pick their own display name; otherwise `name` (the platform account's) is used. */
  readonly ownNames: boolean;
  /** The player's name from the platform, or null when they pick their own. Valid after `init`. */
  readonly name: string | null;
  /** Start multiplayer straight away, in a new private room (the platform launched the game for that). */
  readonly instantMultiplayer: boolean;

  /** Set up (load an SDK, find out who the player is). The game starts once it resolves; it never rejects. */
  init(): Promise<void>;
  /** The game has finished loading and shows its first screen. */
  loaded(): void;

  /** The game server's websocket endpoint. */
  serverUrl(): string;
  /** The room this page was opened to join (a shared link, an invite), if any. */
  linkedRoom(): RoomRef | null;
  /** A link others can open to join `room`. */
  roomLink(room: RoomRef): string;
  /** The player is now in `room` (`joinable`: others may still join it), or in none. */
  roomChanged(room: RoomRef | null, joinable?: boolean): void;

  /** Play started or resumed. */
  gameplayStart(): void;
  /** Play stopped: a menu, a pause, the end of a game. */
  gameplayStop(): void;
  /** The local player won. */
  celebrate(): void;

  /** The player chose a room from outside the game (e.g. a friend's "join" on the platform). */
  onJoinRoom: ((room: RoomRef) => void) | null;
  /** The platform's name for the player changed (they signed in). */
  onNameChange: ((name: string) => void) | null;
  /** The platform wants all audio muted (true) or allows it again. */
  onMute: ((muted: boolean) => void) | null;
}
