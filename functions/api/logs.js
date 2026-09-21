// functions/api/logs.js
// Cloudflare Pages Function to serve cached WarcraftLogs data from Cloudflare KV
// with seamless fallback to static data/logs.json

function filterLogsResponse(data, url) {
  const latestParam = url.searchParams.get('latest');
  const limitParam = url.searchParams.get('limit');
  const accountParam = url.searchParams.get('account');
  const playerParam = url.searchParams.get('player');
  const classParam = url.searchParams.get('class');
  const difficultyParam = url.searchParams.get('difficulty');
  const searchParam = url.searchParams.get('search') || url.searchParams.get('q');

  const hasFilter = latestParam || limitParam || accountParam || playerParam || classParam || difficultyParam || searchParam;

  if (!hasFilter) {
    return data;
  }

  let reports = [];
  if (accountParam && data.reportsByAccount && data.reportsByAccount[accountParam.toLowerCase()]) {
    reports = [...data.reportsByAccount[accountParam.toLowerCase()]];
  } else if (Array.isArray(data.reports)) {
    reports = [...data.reports];
  }

  reports = reports.map(r => r.url ? r : { ...r, url: `https://www.warcraftlogs.com/reports/${r.code}` });

  if (playerParam) {
    const q = playerParam.toLowerCase();
    reports = reports.filter(r => Array.isArray(r.players) && r.players.some(p => p.toLowerCase().includes(q)));
  }

  if (classParam) {
    const q = classParam.toLowerCase();
    reports = reports.filter(r => Array.isArray(r.classes) && r.classes.some(c => c.toLowerCase() === q));
  }

  if (difficultyParam) {
    const q = difficultyParam.toLowerCase();
    reports = reports.filter(r => Array.isArray(r.difficulties) && r.difficulties.some(d => d.toLowerCase().includes(q)));
  }

  if (searchParam) {
    const q = searchParam.toLowerCase();
    reports = reports.filter(r => {
      if (r.title && r.title.toLowerCase().includes(q)) return true;
      if (r.zone?.name && r.zone.name.toLowerCase().includes(q)) return true;
      if (Array.isArray(r.dungeons) && r.dungeons.some(d => d.toLowerCase().includes(q))) return true;
      if (Array.isArray(r.bosses) && r.bosses.some(b => b.toLowerCase().includes(q))) return true;
      return false;
    });
  }

  reports.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));

  if (latestParam === 'true' || latestParam === '1') {
    const latest = reports.length > 0 ? reports[0] : null;
    return {
      success: true,
      fetchedAt: data.fetchedAt,
      report: latest
    };
  }

  const total = reports.length;
  if (limitParam) {
    const limit = Math.max(1, parseInt(limitParam, 10) || 10);
    reports = reports.slice(0, limit);
  }

  return {
    success: true,
    fetchedAt: data.fetchedAt,
    total,
    count: reports.length,
    reports
  };
}

const DEFAULT_API_KEY = 'meu_live_k8f92a3c71e04b6d9e5f';

function authenticateApiRequest(request, env, url) {
  const expectedKey = (env && env.API_KEY) || DEFAULT_API_KEY;

  const headerKey = request.headers.get('x-api-key');
  if (headerKey && headerKey.trim() === expectedKey) return { authorized: true };

  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token === expectedKey) return { authorized: true };
  }

  const queryKey = url.searchParams.get('api_key') || url.searchParams.get('key');
  if (queryKey && queryKey.trim() === expectedKey) return { authorized: true };

  const secFetchSite = request.headers.get('sec-fetch-site');
  const referer = request.headers.get('referer');
  const origin = request.headers.get('origin');

  const isInternal = secFetchSite === 'same-origin' ||
    (referer && (referer.startsWith('https://meudayr.com') || referer.startsWith('http://localhost') || referer.startsWith('http://127.0.0.1'))) ||
    (origin && (origin === 'https://meudayr.com' || origin === 'http://localhost' || origin === 'http://127.0.0.1'));

  if (isInternal) return { authorized: true, isInternal: true };

  if (headerKey || authHeader || queryKey) {
    return { authorized: false, status: 403, error: 'Forbidden: Invalid API key.' };
  }

  return {
    authorized: false,
    status: 401,
    error: 'Unauthorized: An API key is required to access this endpoint. Please provide it via the "x-api-key" header or "?api_key=" query parameter.'
  };
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    }
  });
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);

    const auth = authenticateApiRequest(context.request, context.env, url);
    if (!auth.authorized) {
      return new Response(JSON.stringify({ success: false, error: auth.error }), {
        status: auth.status,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });
    }

    // 1. Try reading from Cloudflare KV if bound
    if (context.env && context.env.LOGS_KV) {
      const cached = await context.env.LOGS_KV.get('warcraft_logs', 'json');
      if (cached && (cached.reportsByAccount || (Array.isArray(cached.reports) && cached.reports.length > 0))) {
        const responseData = filterLogsResponse(cached, url);
        return new Response(JSON.stringify(responseData), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // 2. Fallback to static asset data/logs.json
    const assetUrl = new URL('/data/logs.json', context.request.url);
    const assetRes = context.env.ASSETS ? await context.env.ASSETS.fetch(assetUrl) : await fetch(assetUrl.toString());
    
    if (assetRes && assetRes.ok) {
      const data = await assetRes.json();
      const responseData = filterLogsResponse(data, url);
      return new Response(JSON.stringify(responseData), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    return new Response(JSON.stringify({ error: 'No logs available yet.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
