import type { PostHog, Properties } from 'posthog-js/dist/module.slim';

/**
 * Product analytics (PostHog), when the build has a project key. Kept to what the privacy policy promises: nothing
 * stored on the device (memory persistence), no session recording or autocapture, and nothing at all when the browser
 * asks not to be tracked (Do Not Track / Global Privacy Control).
 */
const KEY = import.meta.env.VITE_POSTHOG_KEY;
const HOST = import.meta.env.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com';
const optedOut = navigator.doNotTrack === '1' || (navigator as { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
const enabled = !!KEY && !optedOut;

/** Loaded on its own after the game, so it never holds up the first paint (the slim build: none of the parts we turn off). */
let client: PostHog | null = null;
/** Events from before it loaded. */
const queued: [string, Properties][] = [];

if (enabled) {
  void import('posthog-js/dist/module.slim').then(({ default: posthog }) => {
    posthog.init(KEY, {
      api_host: HOST,
      defaults: '2026-05-30',
      person_profiles: 'identified_only',
      persistence: 'memory',
      autocapture: false,
      disable_session_recording: true,
      disable_surveys: true,
      respect_dnt: true,
    });
    // Played on another site through an iframe (that site shows up as the referrer), and which build (web, crazygames).
    posthog.register({ embedded: window.top !== window.self, platform: import.meta.env.VITE_PLATFORM });
    client = posthog;
    for (const [event, props] of queued.splice(0)) posthog.capture(event, props);
  });
}

function capture(event: string, props: Properties, beacon = false) {
  if (!enabled) return;
  if (client) client.capture(event, props, beacon ? { transport: 'sendBeacon' } : undefined);
  else queued.push([event, props]);
}

export type GameMode = 'single' | 'multi';

/** The game being played, from its `game_started` until its `game_ended`. */
let current: { mode: GameMode; props: Properties; at: number } | null = null;

/**
 * A game began: `game_started`. Ignored while a game of the same mode is already going (an online player rejoining
 * their game gets its start again).
 */
export function gameStarted(mode: GameMode, props: Properties) {
  if (current?.mode === mode) return;
  if (current) gameEnded('switched');
  current = { mode, props, at: performance.now() };
  capture('game_started', { mode, ...props });
}

/**
 * The game ended: `game_ended`, with how (`finished`, `quit`, `restarted`, `kicked`, `connection_lost`, …) and how
 * long it ran (pauses included). Nothing if no game is going.
 */
export function gameEnded(how: string, extra: Properties = {}, beacon = false) {
  if (!current) return;
  const { mode, props, at } = current;
  current = null;
  capture('game_ended', { mode, ...props, ended_by: how, duration_s: Math.round((performance.now() - at) / 1000), ...extra }, beacon);
}

// Closing the tab mid-game: a beacon still gets through as the page goes away.
addEventListener('pagehide', () => gameEnded('page_closed', {}, true));
