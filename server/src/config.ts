export interface ServerConfig {
  /** Pause time each player gets per game, seconds. */
  pauseBudget: number;
  /** Countdown before the puck moves (game start and after a pause), seconds. */
  countdown: number;
  /** How long a member who dropped keeps their place in a room lobby, ms. */
  grace: number;
  /** Server pings every this many ms; a connection silent for 3x is dropped. */
  heartbeat: number;
  /** Directory with the built frontend, if any. */
  webDir?: string;
}

export const DEFAULT_CONFIG: ServerConfig = {
  pauseBudget: 60,
  countdown: 3,
  grace: 5000,
  heartbeat: 10_000,
};
