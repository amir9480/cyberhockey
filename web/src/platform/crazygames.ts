import { cleanName } from '@airhockey/shared/protocol';
import type { Platform, RoomRef } from './types';

/**
 * CrazyGames: the game files are hosted on their CDN and shown in their page, through their SDK (v3, HTML5):
 * https://docs.crazygames.com/sdk/intro/
 *
 * - Players are known by their CrazyGames username (a guest gets a generated one), never asked for a name.
 * - Rooms are shared with CrazyGames invite links and reported to CrazyGames, so friends can join from the site.
 * - CrazyGames provides fullscreen itself (the game may not), and the game may not link to other sites.
 * - Our own server still runs multiplayer: the page isn't served by it, so the socket goes to APP_URL.
 *
 * Without the SDK (blocked by an ad blocker, or the page isn't on CrazyGames and not on localhost) the game still runs,
 * as a guest, with plain links to its own site for rooms.
 */

const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';
/** Give up on the SDK after this long, and play without it. */
const SDK_TIMEOUT = 8000;
const GUEST_KEY = 'airhockey.guestName';

/** What a room's invite carries (CrazyGames passes these to whoever opens the invite). */
interface InviteParams {
  room?: string;
  net?: string;
  [k: string]: string | undefined;
}

interface CgUser {
  username: string;
  profilePictureUrl: string;
}

interface CgSettings {
  disableChat: boolean;
  muteAudio: boolean;
}

/** The parts of the SDK this game uses. */
interface CrazySdk {
  init(): Promise<void>;
  environment: 'local' | 'crazygames' | 'disabled';
  game: {
    gameplayStart(): void;
    gameplayStop(): void;
    loadingStart(): void;
    loadingStop(): void;
    happytime(): void;
    settings: CgSettings;
    addSettingsChangeListener(fn: (s: CgSettings) => void): void;
    isInstantMultiplayer: boolean;
    inviteParams: InviteParams | null;
    inviteLink(params: InviteParams): string;
    addJoinRoomListener(fn: (params: InviteParams) => void): void;
    updateRoom(room: { roomId: string; isJoinable: boolean; inviteParams: InviteParams }): void;
    leftRoom(): void;
  };
  user: {
    isUserAccountAvailable: boolean;
    getUser(): Promise<CgUser | null>;
    addAuthListener(fn: (user: CgUser | null) => void): void;
  };
}

declare global {
  interface Window {
    CrazyGames?: { SDK: CrazySdk };
  }
}

/** The room an invite points to, if it is one of ours. */
function inviteRoom(p: InviteParams | null | undefined): RoomRef | null {
  if (!p?.room) return null;
  return { kind: p.net === 'p2p' ? 'p2p' : 'server', id: p.room };
}

/** Load the SDK script and initialise it; null when it can't be had (blocked, offline, not on CrazyGames). */
async function loadSdk(): Promise<CrazySdk | null> {
  try {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SDK_URL;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('CrazyGames SDK failed to load'));
      document.head.appendChild(s);
      setTimeout(() => reject(new Error('CrazyGames SDK timed out')), SDK_TIMEOUT);
    });
    const sdk = window.CrazyGames?.SDK;
    if (!sdk) return null;
    await sdk.init();
    return sdk.environment === 'disabled' ? null : sdk;
  } catch (e) {
    console.warn('Playing without the CrazyGames SDK:', e);
    return null;
  }
}

/** A guest's name: generated once, kept on this device. */
function guestName(): string {
  try {
    const saved = localStorage.getItem(GUEST_KEY);
    if (saved) return cleanName(saved);
  } catch {
    /* storage unavailable: a new name each visit */
  }
  const name = `Guest ${1000 + Math.floor(Math.random() * 9000)}`;
  try {
    localStorage.setItem(GUEST_KEY, name);
  } catch {
    /* as above */
  }
  return name;
}

export class CrazyGamesPlatform implements Platform {
  readonly id = 'crazygames';
  readonly fullscreen = false;
  readonly ownNames = false;
  name: string | null = null;
  onJoinRoom: ((room: RoomRef) => void) | null = null;
  onNameChange: ((name: string) => void) | null = null;
  onMute: ((muted: boolean) => void) | null = null;
  private sdk: CrazySdk | null = null;
  /** Gameplay is reported as started (so start/stop are only sent on a change). */
  private playing = false;

  get instantMultiplayer() {
    return !!this.sdk?.game.isInstantMultiplayer;
  }

  async init() {
    this.sdk = await loadSdk();
    const sdk = this.sdk;
    this.name = guestName();
    if (!sdk) return;
    sdk.game.loadingStart();

    if (sdk.user.isUserAccountAvailable) {
      try {
        const user = await sdk.user.getUser();
        if (user) this.name = cleanName(user.username);
      } catch {
        /* stays a guest */
      }
      sdk.user.addAuthListener((user) => {
        if (!user) return;
        this.name = cleanName(user.username);
        this.onNameChange?.(this.name);
      });
    }

    sdk.game.addJoinRoomListener((params) => {
      const room = inviteRoom(params);
      if (room) this.onJoinRoom?.(room);
    });
    // CrazyGames' mute setting overrides the game's own volumes.
    this.onMute?.(sdk.game.settings.muteAudio);
    sdk.game.addSettingsChangeListener((s) => this.onMute?.(s.muteAudio));
  }

  loaded() {
    this.sdk?.game.loadingStop();
    // Listeners may have been set after `init`: give them the current setting.
    if (this.sdk) this.onMute?.(this.sdk.game.settings.muteAudio);
  }

  serverUrl() {
    return `${import.meta.env.VITE_APP_URL.replace(/^http/, 'ws')}/ws`;
  }

  linkedRoom() {
    return inviteRoom(this.sdk?.game.inviteParams);
  }

  roomLink(room: RoomRef) {
    const params: InviteParams = { room: room.id, net: room.kind };
    if (this.sdk) return this.sdk.game.inviteLink(params);
    // No SDK: a link to the game on its own site.
    const url = new URL(`${import.meta.env.VITE_APP_URL}/`);
    url.searchParams.set(room.kind === 'p2p' ? 'p2p' : 'room', room.id);
    return url.toString();
  }

  roomChanged(room: RoomRef | null, joinable = true) {
    const game = this.sdk?.game;
    if (!game) return;
    if (room) game.updateRoom({ roomId: `${room.kind}:${room.id}`, isJoinable: joinable, inviteParams: { room: room.id, net: room.kind } });
    else game.leftRoom();
  }

  gameplayStart() {
    if (this.playing) return;
    this.playing = true;
    this.sdk?.game.gameplayStart();
  }

  gameplayStop() {
    if (!this.playing) return;
    this.playing = false;
    this.sdk?.game.gameplayStop();
  }

  celebrate() {
    this.sdk?.game.happytime();
  }
}
