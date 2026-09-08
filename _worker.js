// _worker.js
// Universal entrypoint supporting both Cloudflare Workers (Static Assets) and Cloudflare Pages
import { onRequestGet as handleLogs } from './functions/api/logs.js';
import { onRequest as handleRefresh } from './functions/api/refresh.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/logs') {
      return handleLogs({
        request,
        env,
        waitUntil: (p) => ctx.waitUntil(p),
        next: () => (env.ASSETS ? env.ASSETS.fetch(request) : fetch(request))
      });
    }

    if (url.pathname === '/api/refresh') {
      return handleRefresh({
        request,
        env,
        waitUntil: (p) => ctx.waitUntil(p),
        next: () => (env.ASSETS ? env.ASSETS.fetch(request) : fetch(request))
      });
    }

    // Pass through to static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return fetch(request);
  }
};
