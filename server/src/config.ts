import { DEFAULT_ROOM_CONFIG, type RoomConfig } from '@airhockey/shared/host/config';

export interface ServerConfig extends RoomConfig {
  /** Server pings every this many ms; a connection silent for 3x is dropped. */
  heartbeat: number;
  /** A connection that sends nothing but keep-alive pings for this many ms is closed (checked every heartbeat). */
  idleTimeout: number;
  /** Directory with the built frontend, if any. */
  webDir?: string;
  /** Open websockets allowed from one address. */
  maxConnsPerIp: number;
  /** Open websockets allowed in all. */
  maxConns: number;
  /** Reverse proxies in front of the server whose X-Forwarded-For is trusted (0: none, use the socket's address). */
  trustProxy: number;
  /** The public site URL: the only other origin whose pages may open the game socket. */
  appUrl: string;
}

export const DEFAULT_CONFIG: ServerConfig = {
  ...DEFAULT_ROOM_CONFIG,
  heartbeat: 10_000,
  idleTimeout: 15 * 60_000,
  maxConnsPerIp: 16,
  maxConns: 5000,
  trustProxy: 0,
  appUrl: 'http://localhost:3000',
};
