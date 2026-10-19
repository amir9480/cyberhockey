/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project key (POSTHOG_KEY at build time); analytics are off without it. */
  readonly VITE_POSTHOG_KEY?: string;
  /** PostHog API host (POSTHOG_HOST at build time), e.g. https://eu.i.posthog.com. */
  readonly VITE_POSTHOG_HOST?: string;
  /** The public site URL, no trailing slash (APP_URL at build time). */
  readonly VITE_APP_URL: string;
  /** Where this build is published: 'web' (the game's own site), 'crazygames' or 'singleplayer' (no multiplayer). See src/platform. */
  readonly VITE_PLATFORM: 'web' | 'crazygames' | 'singleplayer';
}
