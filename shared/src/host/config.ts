export interface RoomConfig {
  /** Pause time each player gets per game, seconds. */
  pauseBudget: number;
  /** Countdown before the puck moves (game start and after a pause), seconds. */
  countdown: number;
  /** How long a member who dropped keeps their place in a room lobby, ms. */
  grace: number;
}

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  pauseBudget: 60,
  countdown: 3,
  grace: 5000,
};
