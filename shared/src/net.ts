/** Fixed simulation rate of an online game. Server and clients count the same ticks. */
export const TICK_RATE = 120;
export const TICK = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;
/** A state's `freeze` meaning the puck stays where it is until a later state says otherwise (pause, between rounds). */
export const FREEZE_HELD = 0xffff;
