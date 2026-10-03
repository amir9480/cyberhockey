import { DEFAULT_ROOM_CONFIG, type RoomConfig } from '@airhockey/shared/host/config';

export interface ServerConfig extends RoomConfig {
  /** Server pings every this many ms; a connection silent for 3x is dropped. */
  heartbeat: number;
  /** Directory with the built frontend, if any. */
  webDir?: string;
}

export const DEFAULT_CONFIG: ServerConfig = {
  ...DEFAULT_ROOM_CONFIG,
  heartbeat: 10_000,
};
