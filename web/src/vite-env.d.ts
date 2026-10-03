/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project key (POSTHOG_KEY at build time); analytics are off without it. */
  readonly VITE_POSTHOG_KEY?: string;
  /** PostHog API host (POSTHOG_HOST at build time), e.g. https://eu.i.posthog.com. */
  readonly VITE_POSTHOG_HOST?: string;
}
