// worker.js
// Cloudflare Worker entrypoint: serves static assets and provides /api/logs and /api/refresh

const ACCOUNTS = [
  { id: 'meudayr', name: 'Meudayr', userId: 323892, server: 'Crushridge-US', default: true },
  { id: 'vember', name: 'Vember', userId: 3015473, server: 'US' },
  { id: 'wubs', name: 'Wubs', userId: 48864, server: 'US' },
  { id: 'ferraro', name: 'Ferraro', userId: 2552220, server: 'US' }
];

const REPORTS_PER_PAGE = 25;
const MAX_PAGES_ON_REFRESH = 2; // Up to 50 reports per account (fast, ~1.5s total, well under API rate limits)

const diffMap = {
  1: 'LFR',
  2: 'Heroic',
  3: 'Normal',
  4: 'Heroic',
  5: 'Mythic',
  7: 'LFR',
  8: 'Challenge Mode',
  9: '40 Man',
  10: 'Mythic+',
  14: 'Normal',
  15: 'Heroic',
  16: 'Mythic',
  17: 'LFR'
};

const PURGED_LOG_CODES = new Set(['6xfYGHbr3KNP4yVj', 'mChqxT1np2zANvbB', '8yxL1PvfNaVT9Z6h']);

function isTestReport(r) {
  if (!r) return false;
  return PURGED_LOG_CODES.has(r.code);
}

function filterCleanReports(reports = []) {
  if (!Array.isArray(reports)) return [];
  return reports.filter(r => !isTestReport(r));
}

function reconcileReports(existingList = [], freshReports = [], hasMorePages = false) {
  const cleanExisting = filterCleanReports(existingList);
  const cleanFresh = filterCleanReports(freshReports);

  // If there are no more pages on WarcraftLogs (e.g. account has <= 50 logs total),
  // then cleanFresh is the complete, 100% authoritative list!
  if (!hasMorePages || cleanFresh.length === 0) {
    cleanFresh.sort((a, b) => b.startTime - a.startTime);
    return cleanFresh;
  }

  // If there are more pages beyond what we fetched:
  // The oldest report in cleanFresh defines our cutoff timestamp.
  const cutoffTime = cleanFresh[cleanFresh.length - 1].startTime;

  // Any report from cleanExisting that is strictly OLDER than cutoffTime is preserved.
  // Any report with startTime >= cutoffTime was within our fetched window:
  // if it's not in cleanFresh, it was deleted or made private on WarcraftLogs, so it is omitted!
  const olderHistorical = cleanExisting.filter(r => r.startTime < cutoffTime);

  const combined = [...cleanFresh, ...olderHistorical];
  const seen = new Set();
  const deduped = [];
  for (const r of combined) {
    if (!seen.has(r.code)) {
      seen.add(r.code);
      deduped.push(r);
    }
  }
  deduped.sort((a, b) => b.startTime - a.startTime);
  return deduped;
}

let memoryToken = null;
let memoryTokenExpiresAt = 0;

async function getAccessToken(clientId, clientSecret, env) {
  const now = Date.now();
  if (memoryToken && now < memoryTokenExpiresAt - 60000) {
    return memoryToken;
  }
  if (env && env.LOGS_KV) {
    try {
      const kvToken = await env.LOGS_KV.get('wcl_token', 'json');
      if (kvToken && kvToken.token && now < kvToken.expiresAt - 60000) {
        memoryToken = kvToken.token;
        memoryTokenExpiresAt = kvToken.expiresAt;
        return memoryToken;
      }
    } catch(e) {}
  }

  const credentials = btoa(`${clientId}:${clientSecret}`);
  const res = await fetch('https://www.warcraftlogs.com/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const text = await res.text();
    throw new Error(`Failed to get access token from WarcraftLogs: ${res.status} [Retry-After: ${headers['retry-after'] || 'none'}] ${text}`);
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresIn = data.expires_in || 86400;
  const expiresAt = now + (expiresIn * 1000);

  memoryToken = token;
  memoryTokenExpiresAt = expiresAt;

  if (env && env.LOGS_KV) {
    try {
      await env.LOGS_KV.put('wcl_token', JSON.stringify({ token, expiresAt }), {
        expirationTtl: Math.min(expiresIn, 86400)
      });
    } catch(e) {}
  }

  return token;
}

async function fetchReportsPage(token, userId, page) {
  const query = `
    query {
      reportData {
        reports(userID: ${userId}, limit: ${REPORTS_PER_PAGE}, page: ${page}) {
          data {
            code
            title
            startTime
            endTime
            zone {
              name
            }
            fights {
              name
              difficulty
              keystoneLevel
              gameZone {
                name
              }
            }
            masterData {
              actors(type: "Player") {
                name
                subType
              }
            }
          }
          total
          per_page
          current_page
          has_more_pages
        }
      }
    }
  `;

  const res = await fetch('https://www.warcraftlogs.com/api/v2/client', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GraphQL request failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data?.reportData?.reports ?? { data: [], has_more_pages: false, total: 0 };
}

function processRawReports(rawReports) {
  return rawReports.map(r => {
    const dungeonSet = new Set();
    const bossSet = new Set();
    const playerSet = new Set();
    const classSet = new Set();
    const difficultySet = new Set();
    const keyLevelSet = new Set();

    if (Array.isArray(r.fights)) {
      r.fights.forEach(f => {
        if (f.difficulty && diffMap[f.difficulty]) {
          difficultySet.add(diffMap[f.difficulty]);
        }
        if (f.keystoneLevel) {
          keyLevelSet.add(f.keystoneLevel);
        }
        if (f.gameZone && f.gameZone.name) {
          const dName = f.gameZone.name;
          let fullDungeon = dName;
          if (f.keystoneLevel) {
            fullDungeon = `${dName} +${f.keystoneLevel}`;
          } else if (f.difficulty && diffMap[f.difficulty] && diffMap[f.difficulty] !== 'Mythic+') {
            fullDungeon = `${dName} ${diffMap[f.difficulty]}`;
          }
          dungeonSet.add(fullDungeon);
        }
        if (f.name && f.name !== 'Trash' && f.name !== 'Trash Mob') {
          bossSet.add(f.name);
        }
      });
    }

    if (r.zone && r.zone.name && !r.zone.name.includes('Season') && r.zone.name !== 'VS / DR / MQD') {
      const raidDiffs = Array.from(difficultySet).filter(d => d !== 'Mythic+');
      const raidTag = raidDiffs.length > 0 ? `${r.zone.name} ${raidDiffs.join('/')}` : r.zone.name;
      dungeonSet.add(raidTag);
    }

    if (r.masterData && Array.isArray(r.masterData.actors)) {
      r.masterData.actors.forEach(a => {
        if (a.name && typeof a.name === 'string') {
          playerSet.add(a.name);
        }
        if (a.subType && typeof a.subType === 'string') {
          classSet.add(a.subType);
        }
      });
    }

    return {
      code: r.code,
      title: r.title,
      startTime: r.startTime,
      endTime: r.endTime,
      zone: r.zone,
      dungeons: Array.from(dungeonSet),
      bosses: Array.from(bossSet),
      players: Array.from(playerSet),
      classes: Array.from(classSet),
      difficulties: Array.from(difficultySet),
      keyLevels: Array.from(keyLevelSet)
    };
  });
}

async function fetchAccountRecentReports(token, account) {
  let allRecent = [];
  let page = 1;
  let hasMore = true;

  while (hasMore && page <= MAX_PAGES_ON_REFRESH) {
    const result = await fetchReportsPage(token, account.userId, page);
    const processed = processRawReports(result.data ?? []);
    allRecent = allRecent.concat(processed);
    hasMore = result.has_more_pages === true;
    page++;
  }

  return { reports: allRecent, hasMorePages: hasMore };
}

async function performRefresh(env, requestUrl = null) {
  const clientId = env.WCL_CLIENT_ID;
  const clientSecret = env.WCL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Missing WCL_CLIENT_ID or WCL_CLIENT_SECRET environment variables.');
  }

  // 1. Get access token (cached in KV / memory)
  const token = await getAccessToken(clientId, clientSecret, env);

  // 2. Fetch existing baseline logs from KV or static asset to preserve historical records
  let existingData = null;
  if (env.LOGS_KV) {
    existingData = await env.LOGS_KV.get('warcraft_logs', 'json');
  }
  if (!existingData && env.ASSETS && requestUrl) {
    const assetUrl = new URL('/data/logs.json', requestUrl);
    const assetRes = await env.ASSETS.fetch(new Request(assetUrl));
    if (assetRes && assetRes.ok) {
      existingData = await assetRes.json();
    }
  }

  const existingReportsByAccount = existingData?.reportsByAccount || {};

  // 3. Fetch all accounts in parallel with safety
  const accountResults = await Promise.all(
    ACCOUNTS.map(async acc => {
      try {
        const { reports, hasMorePages } = await fetchAccountRecentReports(token, acc);
        return { id: acc.id, freshReports: reports, hasMorePages, error: null };
      } catch (err) {
        return { id: acc.id, freshReports: [], hasMorePages: false, error: err.message };
      }
    })
  );

  // If WarcraftLogs threw an error for the primary account (e.g. rate limit), throw error
  const meudayrResult = accountResults.find(r => r.id === 'meudayr');
  if (meudayrResult && meudayrResult.error) {
    throw new Error(`WarcraftLogs fetch failed: ${meudayrResult.error}`);
  }

  // 4. Reconcile logs with smart sliding window
  const updatedReportsByAccount = {};
  const accountList = [];

  for (const acc of ACCOUNTS) {
    const incoming = accountResults.find(r => r.id === acc.id);
    const existingList = existingReportsByAccount[acc.id] || [];

    let reportList;
    if (incoming && incoming.error === null && incoming.freshReports) {
      reportList = reconcileReports(existingList, incoming.freshReports, incoming.hasMorePages);
    } else {
      reportList = filterCleanReports(existingList);
    }

    updatedReportsByAccount[acc.id] = reportList;

    accountList.push({
      id: acc.id,
      name: acc.name,
      userId: acc.userId,
      server: acc.server,
      reportsCount: reportList.length,
      default: !!acc.default
    });
  }

  const defaultAcc = ACCOUNTS.find(a => a.default) || ACCOUNTS[0];

  const finalOutput = {
    fetchedAt: new Date().toISOString(),
    accounts: accountList,
    reportsByAccount: updatedReportsByAccount,
    character: defaultAcc.name,
    server: defaultAcc.server,
    reports: updatedReportsByAccount[defaultAcc.id] || []
  };

  // 5. Store into Cloudflare KV if bound
  if (env.LOGS_KV) {
    await env.LOGS_KV.put('warcraft_logs', JSON.stringify(finalOutput));
  }

  return finalOutput;
}

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

  // Ensure each report has the direct warcraftlogs URL
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

  // 1. Check x-api-key header
  const headerKey = request.headers.get('x-api-key');
  if (headerKey && headerKey.trim() === expectedKey) {
    return { authorized: true };
  }

  // 2. Check Authorization: Bearer <key>
  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token === expectedKey) {
      return { authorized: true };
    }
  }

  // 3. Check query parameters ?api_key= or ?key=
  const queryKey = url.searchParams.get('api_key') || url.searchParams.get('key');
  if (queryKey && queryKey.trim() === expectedKey) {
    return { authorized: true };
  }

  // 4. Same-origin browser exemption (allows meudayr.com web visitors to view pages seamlessly)
  const secFetchSite = request.headers.get('sec-fetch-site');
  const referer = request.headers.get('referer');
  const origin = request.headers.get('origin');

  const isInternal = secFetchSite === 'same-origin' ||
    (referer && (referer.startsWith('https://meudayr.com') || referer.startsWith('http://localhost') || referer.startsWith('http://127.0.0.1'))) ||
    (origin && (origin === 'https://meudayr.com' || origin === 'http://localhost' || origin === 'http://127.0.0.1'));

  if (isInternal) {
    return { authorized: true, isInternal: true };
  }

  // If a key was provided but was invalid
  if (headerKey || authHeader || queryKey) {
    return {
      authorized: false,
      status: 403,
      error: 'Forbidden: Invalid API key.'
    };
  }

  // If no key was provided from an external source
  return {
    authorized: false,
    status: 401,
    error: 'Unauthorized: An API key is required to access this endpoint. Please provide it via the "x-api-key" header or "?api_key=" query parameter.'
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Global CORS preflight handler for API routes
    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization, x-admin-key',
          'Cache-Control': 'no-cache, no-store, must-revalidate'
        }
      });
    }

    // Protect all /api/ endpoints with API Key verification (while exempting same-origin browser visitors)
    if (url.pathname.startsWith('/api/')) {
      const auth = authenticateApiRequest(request, env, url);
      if (!auth.authorized) {
        return new Response(JSON.stringify({
          success: false,
          error: auth.error
        }), {
          status: auth.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type, x-api-key, Authorization, x-admin-key',
            'Cache-Control': 'no-cache, no-store, must-revalidate'
          }
        });
      }
    }

    // Route: GET /api/logs
    if (url.pathname === '/api/logs') {
      try {
        if (env.LOGS_KV) {
          const cached = await env.LOGS_KV.get('warcraft_logs', 'json');
          if (cached && (cached.reportsByAccount || (Array.isArray(cached.reports) && cached.reports.length > 0))) {
            // Sanitize cached KV: immediately strip any private / test logs
            let sanitized = false;
            if (cached.reportsByAccount) {
              for (const accId of Object.keys(cached.reportsByAccount)) {
                const beforeCount = cached.reportsByAccount[accId].length;
                cached.reportsByAccount[accId] = filterCleanReports(cached.reportsByAccount[accId]);
                if (cached.reportsByAccount[accId].length !== beforeCount) {
                  sanitized = true;
                }
              }
            }
            if (Array.isArray(cached.reports)) {
              const beforeCount = cached.reports.length;
              cached.reports = filterCleanReports(cached.reports);
              if (cached.reports.length !== beforeCount) {
                sanitized = true;
              }
            }
            if (Array.isArray(cached.accounts) && cached.reportsByAccount) {
              for (const acc of cached.accounts) {
                if (cached.reportsByAccount[acc.id]) {
                  acc.reportsCount = cached.reportsByAccount[acc.id].length;
                }
              }
            }
            if (sanitized && env.LOGS_KV) {
              if (ctx && ctx.waitUntil) {
                ctx.waitUntil(env.LOGS_KV.put('warcraft_logs', JSON.stringify(cached)));
              } else {
                await env.LOGS_KV.put('warcraft_logs', JSON.stringify(cached));
              }
            }

            const responseData = filterLogsResponse(cached, url);
            return new Response(JSON.stringify(responseData), {
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'no-cache, no-store, must-revalidate',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }
        }

        // Fallback to static asset data/logs.json
        if (env.ASSETS) {
          const assetUrl = new URL('/data/logs.json', request.url);
          const assetRes = await env.ASSETS.fetch(new Request(assetUrl));
          if (assetRes && assetRes.ok) {
            const json = await assetRes.json();
            if (json.reportsByAccount) {
              for (const accId of Object.keys(json.reportsByAccount)) {
                json.reportsByAccount[accId] = filterCleanReports(json.reportsByAccount[accId]);
              }
            }
            if (Array.isArray(json.reports)) {
              json.reports = filterCleanReports(json.reports);
            }
            const responseData = filterLogsResponse(json, url);
            return new Response(JSON.stringify(responseData), {
              headers: {
                'Content-Type': 'application/json',
                'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
                'Access-Control-Allow-Origin': '*'
              }
            });
          }
        }

        return new Response(JSON.stringify({ error: 'No logs available' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Route: /api/refresh (GET or POST)
    if (url.pathname === '/api/refresh') {
      try {
        const finalOutput = await performRefresh(env, request.url);
        return new Response(JSON.stringify(finalOutput), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      }
    }

    // Route: /api/roster (GET, POST, DELETE, OPTIONS)
    if (url.pathname === '/api/roster') {
      const rosterCorsHeaders = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
        'Cache-Control': 'no-cache, no-store, must-revalidate'
      };

      const validAdminKey = (env && env.ADMIN_KEY) || 'dontgivemeadpi';

      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: rosterCorsHeaders });
      }

      async function getWorkerRoster() {
        if (env.LOGS_KV) {
          try {
            const kvData = await env.LOGS_KV.get('forever_roster', 'json');
            if (Array.isArray(kvData)) return kvData;
          } catch (e) {}
        }
        if (env.ASSETS) {
          try {
            const assetUrl = new URL('/data/forever-roster.json', request.url);
            const res = await env.ASSETS.fetch(new Request(assetUrl));
            if (res && res.ok) {
              const data = await res.json();
              if (Array.isArray(data)) return data;
            }
          } catch (e) {}
        }
        return [];
      }

      if (request.method === 'GET') {
        try {
          if (url.searchParams.get('verify_admin') === '1') {
            const headerKey = request.headers.get('x-admin-key');
            const paramKey = url.searchParams.get('admin_key');
            const providedKey = headerKey || paramKey;

            if (providedKey && providedKey === validAdminKey) {
              return new Response(JSON.stringify({ success: true, verified: true }), {
                status: 200,
                headers: rosterCorsHeaders
              });
            } else {
              return new Response(JSON.stringify({ success: false, verified: false, error: 'Invalid admin password.' }), {
                status: 403,
                headers: rosterCorsHeaders
              });
            }
          }

          const rawRoster = await getWorkerRoster();

          // Summary endpoint: ?summary=1 or ?summary=true
          if (url.searchParams.get('summary') === '1' || url.searchParams.get('summary') === 'true') {
            const roles = { 'Tank': 0, 'Healer': 0, 'Melee DPS': 0, 'Ranged DPS': 0 };
            const classes = {};
            const playstyles = {};

            for (const item of rawRoster) {
              const role = item.role || (Array.isArray(item.roles) && item.roles[0]) || 'Unknown';
              roles[role] = (roles[role] || 0) + 1;

              const cls = item.className || 'Unknown';
              classes[cls] = (classes[cls] || 0) + 1;

              const psList = Array.isArray(item.playstyles) && item.playstyles.length > 0 ? item.playstyles : (item.playstyle ? [item.playstyle] : []);
              for (const ps of psList) {
                playstyles[ps] = (playstyles[ps] || 0) + 1;
              }
            }

            return new Response(JSON.stringify({
              success: true,
              total: rawRoster.length,
              roles,
              classes,
              playstyles
            }), {
              status: 200,
              headers: rosterCorsHeaders
            });
          }

          // Query filters
          const roleFilter = url.searchParams.get('role');
          const classFilter = url.searchParams.get('class');
          const playerFilter = url.searchParams.get('player') || url.searchParams.get('name');
          const playstyleFilter = url.searchParams.get('playstyle');
          const cleanParam = url.searchParams.get('clean');

          let filtered = rawRoster;

          if (roleFilter) {
            const rf = roleFilter.toLowerCase();
            filtered = filtered.filter(item => {
              if (item.role && item.role.toLowerCase() === rf) return true;
              if (Array.isArray(item.roles) && item.roles.some(r => r.toLowerCase() === rf)) return true;
              if (rf === 'dps' && item.role && item.role.toLowerCase().includes('dps')) return true;
              return false;
            });
          }

          if (classFilter) {
            const cf = classFilter.toLowerCase();
            filtered = filtered.filter(item => item.className && item.className.toLowerCase() === cf);
          }

          if (playerFilter) {
            const pf = playerFilter.toLowerCase();
            filtered = filtered.filter(item => item.playerName && item.playerName.toLowerCase().includes(pf));
          }

          if (playstyleFilter) {
            const psf = playstyleFilter.toLowerCase();
            filtered = filtered.filter(item => {
              if (item.playstyle && item.playstyle.toLowerCase() === psf) return true;
              if (Array.isArray(item.playstyles) && item.playstyles.some(p => p.toLowerCase() === psf)) return true;
              return false;
            });
          }

          // If any filter is used or clean=1, sanitize pin field for privacy
          const hasFilter = roleFilter || classFilter || playerFilter || playstyleFilter || cleanParam === '1' || cleanParam === 'true';
          const finalRoster = hasFilter
            ? filtered.map(({ pin, ...safeItem }) => ({ ...safeItem, isPinProtected: Boolean(pin && pin.trim()) }))
            : filtered;

          return new Response(JSON.stringify({
            success: true,
            total: rawRoster.length,
            count: finalRoster.length,
            roster: finalRoster
          }), {
            status: 200,
            headers: rosterCorsHeaders
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), {
            status: 500,
            headers: rosterCorsHeaders
          });
        }
      }

      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const { id, playerName, faction, race, gender, className, spec, role, roles, offspec, offspecRole, playstyle, playstyles, professions, profession1, profession2, notes, pin, currentPin, newPin, admin } = body;

          if (!playerName || !playerName.trim()) {
            return new Response(JSON.stringify({ success: false, error: 'Player Name is required.' }), {
              status: 400,
              headers: rosterCorsHeaders
            });
          }

          // Hardlock roles to spec defaults (server-side enforcement)
          const SPEC_DEFAULT_ROLES = {
            'Warrior': { 'Arms': 'Melee DPS', 'Fury': 'Melee DPS', 'Protection': 'Tank' },
            'Paladin': { 'Holy': 'Healer', 'Protection': 'Tank', 'Retribution': 'Melee DPS' },
            'Hunter': { 'Beast Mastery': 'Ranged DPS', 'Marksmanship': 'Ranged DPS', 'Survival': 'Melee DPS' },
            'Rogue': { 'Assassination': 'Melee DPS', 'Combat': 'Melee DPS', 'Subtlety': 'Melee DPS' },
            'Priest': { 'Discipline': 'Healer', 'Holy': 'Healer', 'Shadow': 'Ranged DPS' },
            'Shaman': { 'Elemental': 'Ranged DPS', 'Enhancement': 'Melee DPS', 'Restoration': 'Healer' },
            'Mage': { 'Arcane': 'Ranged DPS', 'Fire': 'Ranged DPS', 'Frost': 'Ranged DPS' },
            'Warlock': { 'Affliction': 'Ranged DPS', 'Demonology': 'Ranged DPS', 'Destruction': 'Ranged DPS' },
            'Druid': { 'Balance': 'Ranged DPS', 'Restoration': 'Healer' }
          };

          let primaryRole = (Array.isArray(roles) && roles.length > 0 ? roles[0] : role) || '';
          if (className === 'Druid' && spec === 'Feral Combat') {
            if (primaryRole !== 'Tank' && primaryRole !== 'Melee DPS') {
              primaryRole = 'Melee DPS';
            }
          } else if (SPEC_DEFAULT_ROLES[className]?.[spec]) {
            primaryRole = SPEC_DEFAULT_ROLES[className][spec];
          }

          const resolvedRoles = primaryRole ? [primaryRole] : [];
          if (!race || !className || !spec || resolvedRoles.length === 0) {
            return new Response(JSON.stringify({ success: false, error: 'Race, class, spec, and at least one role are required.' }), {
              status: 400,
              headers: rosterCorsHeaders
            });
          }

          let finalOffspecRole = (offspecRole || '').trim();
          if (offspec) {
            if (className === 'Druid' && offspec === 'Feral Combat') {
              if (finalOffspecRole !== 'Tank' && finalOffspecRole !== 'Melee DPS') {
                finalOffspecRole = primaryRole === 'Tank' ? 'Melee DPS' : 'Tank';
              }
            } else if (SPEC_DEFAULT_ROLES[className]?.[offspec]) {
              finalOffspecRole = SPEC_DEFAULT_ROLES[className][offspec];
            }
          } else {
            finalOffspecRole = '';
          }

          const resolvedPlaystyles = Array.isArray(playstyles) && playstyles.length > 0 ? playstyles : (playstyle ? [playstyle] : ['Raiding']);
          const primaryPlaystyle = resolvedPlaystyles[0];

          let resolvedProfessions = [];
          if (Array.isArray(professions)) {
            resolvedProfessions = professions.filter(p => typeof p === 'string' && p.trim() !== '').map(p => p.trim()).slice(0, 2);
          } else {
            const p1 = (profession1 || '').trim();
            const p2 = (profession2 || '').trim();
            if (p1) resolvedProfessions.push(p1);
            if (p2 && p2 !== p1) resolvedProfessions.push(p2);
          }

          const cleanName = playerName.trim();
          const roster = await getWorkerRoster();

          // Look for existing entry strictly by ID for edits, or verify no duplicate name for new entries
          if (!id) {
            // New character submission: cannot overwrite any existing character with the same name
            const nameConflict = roster.find(item => item.playerName.toLowerCase() === cleanName.toLowerCase());
            if (nameConflict) {
              return new Response(JSON.stringify({
                success: false,
                error: `A character named "${cleanName}" already exists in the roster. Characters cannot be overwritten — to make changes or re-submit, please delete the existing character first.`
              }), {
                status: 409,
                headers: rosterCorsHeaders
              });
            }
          } else {
            // Editing existing character by ID: ensure no other character has this name
            const duplicateName = roster.find(item => item.id !== id && item.playerName.toLowerCase() === cleanName.toLowerCase());
            if (duplicateName) {
              return new Response(JSON.stringify({
                success: false,
                error: `Another character named "${cleanName}" already exists in the roster.`
              }), {
                status: 409,
                headers: rosterCorsHeaders
              });
            }
          }

          const existingIndex = id ? roster.findIndex(item => item.id === id) : -1;

          const providedAdminKey = request.headers.get('x-admin-key') || body.adminKey;
          const isAdmin = Boolean(providedAdminKey && providedAdminKey === validAdminKey);
          const nowIso = new Date().toISOString();
          let savedEntry = null;

          const cleanNotes = notes ? notes.trim().slice(0, 300) : '';

          if (existingIndex >= 0) {
            const existing = roster[existingIndex];
            const authPin = (currentPin !== undefined && currentPin !== null) ? currentPin : pin;
            if (!isAdmin && existing.pin && existing.pin.trim() !== '') {
              if (!authPin || authPin.trim() !== existing.pin.trim()) {
                return new Response(JSON.stringify({
                  success: false,
                  error: 'This character is protected with an edit PIN. Please provide the correct PIN to update (or use Admin Mode).'
                }), {
                  status: 403,
                  headers: rosterCorsHeaders
                });
              }
            }

            let finalPin = existing.pin || '';
            if (newPin !== undefined && newPin !== null) {
              finalPin = newPin.trim();
            } else if (pin && pin.trim() !== '') {
              finalPin = pin.trim();
            }

            savedEntry = {
              ...existing,
              playerName: cleanName,
              faction: 'Horde',
              race,
              gender: gender === 'female' ? 'female' : (gender === 'male' ? 'male' : (existing.gender || 'male')),
              className,
              spec,
              role: primaryRole,
              roles: resolvedRoles,
              offspec: offspec ? offspec.trim() : '',
              offspecRole: finalOffspecRole,
              playstyle: primaryPlaystyle,
              playstyles: resolvedPlaystyles,
              professions: resolvedProfessions,
              profession1: resolvedProfessions[0] || '',
              profession2: resolvedProfessions[1] || '',
              notes: cleanNotes,
              pin: finalPin,
              updatedAt: nowIso
            };
            roster[existingIndex] = savedEntry;
          } else {
            savedEntry = {
              id: id || `tbs-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
              playerName: cleanName,
              faction: 'Horde',
              race,
              gender: gender === 'female' ? 'female' : 'male',
              className,
              spec,
              role: primaryRole,
              roles: resolvedRoles,
              offspec: offspec ? offspec.trim() : '',
              offspecRole: finalOffspecRole,
              playstyle: primaryPlaystyle,
              playstyles: resolvedPlaystyles,
              professions: resolvedProfessions,
              profession1: resolvedProfessions[0] || '',
              profession2: resolvedProfessions[1] || '',
              notes: cleanNotes,
              pin: pin ? pin.trim() : '',
              createdAt: nowIso,
              updatedAt: nowIso
            };
            roster.unshift(savedEntry);
          }

          if (env.LOGS_KV) {
            await env.LOGS_KV.put('forever_roster', JSON.stringify(roster));
          }

          return new Response(JSON.stringify({ success: true, entry: savedEntry, roster }), {
            status: 200,
            headers: rosterCorsHeaders
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), {
            status: 500,
            headers: rosterCorsHeaders
          });
        }
      }

      if (request.method === 'DELETE') {
        try {
          let targetId = url.searchParams.get('id');
          let givenPin = url.searchParams.get('pin');
          let providedAdminKey = request.headers.get('x-admin-key') || url.searchParams.get('admin_key');

          if (!targetId) {
            try {
              const body = await request.json();
              targetId = body.id;
              givenPin = body.pin;
              if (body.adminKey) providedAdminKey = body.adminKey;
            } catch (e) {}
          }

          const isAdmin = Boolean(providedAdminKey && providedAdminKey === validAdminKey);

          if (isAdmin && (url.searchParams.get('clear_all') === '1' || targetId === 'all')) {
            if (env.LOGS_KV) {
              await env.LOGS_KV.put('forever_roster', JSON.stringify([]));
            }
            return new Response(JSON.stringify({ success: true, cleared: true, roster: [] }), {
              status: 200,
              headers: rosterCorsHeaders
            });
          }

          if (!targetId) {
            return new Response(JSON.stringify({ success: false, error: 'Target ID is required.' }), {
              status: 400,
              headers: rosterCorsHeaders
            });
          }

          const roster = await getWorkerRoster();
          const existingIndex = roster.findIndex(item => item.id === targetId);

          if (existingIndex < 0) {
            return new Response(JSON.stringify({ success: false, error: 'Entry not found.' }), {
              status: 404,
              headers: rosterCorsHeaders
            });
          }

          const existing = roster[existingIndex];
          if (!isAdmin && existing.pin && existing.pin.trim() !== '') {
            if (!givenPin || givenPin.trim() !== existing.pin.trim()) {
              return new Response(JSON.stringify({
                success: false,
                error: 'This character is protected with an edit PIN. Please provide the correct PIN to remove (or use Admin Mode).'
              }), {
                status: 403,
                headers: rosterCorsHeaders
              });
            }
          }

          roster.splice(existingIndex, 1);
          if (env.LOGS_KV) {
            await env.LOGS_KV.put('forever_roster', JSON.stringify(roster));
          }

          return new Response(JSON.stringify({ success: true, deletedId: targetId, roster }), {
            status: 200,
            headers: rosterCorsHeaders
          });
        } catch (e) {
          return new Response(JSON.stringify({ success: false, error: e.message }), {
            status: 500,
            headers: rosterCorsHeaders
          });
        }
      }
    }

    // Default: pass through to static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },

  // Native Cloudflare Worker Cron Trigger (scheduled event)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(performRefresh(env));
  }
};
