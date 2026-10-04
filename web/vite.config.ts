import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';

// Which platform the build is for (src/platform): 'web' (`pnpm build`) or 'crazygames' (`pnpm build:crazygames`).
process.env.VITE_PLATFORM ||= 'web';
const crazyGames = process.env.VITE_PLATFORM === 'crazygames';
// The CrazyGames build runs from CrazyGames' CDN and reaches the game server at APP_URL: it defaults to the live site,
// never to localhost (set APP_URL to test it against a local server).
const CRAZYGAMES_APP_URL = 'https://cyberhockey.fetchrover.app';
if (crazyGames && !process.env.VITE_APP_URL && !process.env.APP_URL) process.env.APP_URL = CRAZYGAMES_APP_URL;
// index.html builds absolute OG/canonical URLs from %VITE_APP_URL% (APP_URL, the same setting the server reads, unless
// overridden); drop a trailing slash and fall back to local dev.
process.env.VITE_APP_URL = (process.env.VITE_APP_URL || process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
// PostHog analytics (src/analytics.ts): off unless the build has a project key. Never in the CrazyGames build: it
// collects no data of its own there (CrazyGames reports the game's numbers), so PostHog is left out of the bundle.
process.env.VITE_POSTHOG_KEY = crazyGames ? '' : process.env.VITE_POSTHOG_KEY || process.env.POSTHOG_KEY || '';
process.env.VITE_POSTHOG_HOST ||= process.env.POSTHOG_HOST ?? '';

/**
 * Markup for one platform only: `<!-- only:web -->…<!-- /only:web -->` (or `only:crazygames`) regions in the HTML are
 * kept in that platform's build and cut from every other one.
 */
function platformHtml(platform: string): Plugin {
  return {
    name: 'platform-html',
    transformIndexHtml(html) {
      return html.replace(/[ \t]*<!-- only:([\w-]+)\b[^>]*-->([\s\S]*?)<!-- \/only:\1 -->\n?/g, (_m, p: string, body: string) =>
        p === platform ? body.replace(/^\n/, '').replace(/[ \t]*$/, '') : '',
      );
    },
  };
}

export default defineConfig({
  plugins: [platformHtml(process.env.VITE_PLATFORM ?? 'web')],
  resolve: { alias: { '@airhockey/shared': fileURLToPath(new URL('../shared/src', import.meta.url)) } },
  // CrazyGames serves the files from a folder on its CDN: every path relative to the page.
  base: crazyGames ? './' : '/',
  build: {
    outDir: crazyGames ? 'dist-crazygames' : 'dist',
    // The game, plus the privacy policy and terms pages (privacy.html, terms.html). CrazyGames: the game alone (it
    // allows no links to other pages, and its own site has the legal ones).
    rolldownOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        ...(!crazyGames && {
          privacy: fileURLToPath(new URL('privacy.html', import.meta.url)),
          terms: fileURLToPath(new URL('terms.html', import.meta.url)),
        }),
      },
    },
    target: 'es2022',
    chunkSizeWarningLimit: 760,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
