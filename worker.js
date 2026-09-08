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

async function getAccessToken(clientId, clientSecret) {
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
    const text = await res.text();
    throw new Error(`Failed to get access token from WarcraftLogs: ${res.status} ${text}`);
  }

  const data = await res.json();
  return data.access_token;
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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Route: GET /api/inspect (inspect specific report code)
    if (url.pathname === '/api/inspect') {
      try {
        const code = url.searchParams.get('code') || 'ZQLWf6hYGJb1rCDR';
        const clientId = env.WCL_CLIENT_ID;
        const clientSecret = env.WCL_CLIENT_SECRET;
        const token = await getAccessToken(clientId, clientSecret);
        const query = `
          query {
            reportData {
              report(code: "${code}") {
                code
                title
                startTime
                endTime
                visibility
                owner {
                  id
                  name
                }
                guild {
                  id
                  name
                }
                fights {
                  id
                  name
                }
              }
            }
          }
        `;
        const res = await fetch('https://www.warcraftlogs.com/api/v2/client', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ query })
        });
        const headers = {};
        res.headers.forEach((v, k) => { headers[k] = v; });
        const bodyText = await res.text();
        let bodyJson;
        try { bodyJson = JSON.parse(bodyText); } catch(e) { bodyJson = bodyText; }
        return new Response(JSON.stringify({ status: res.status, headers, body: bodyJson }, null, 2), {
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500 });
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

            return new Response(JSON.stringify(cached), {
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
            return new Response(JSON.stringify(json), {
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
        const clientId = env.WCL_CLIENT_ID;
        const clientSecret = env.WCL_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
          return new Response(JSON.stringify({
            error: 'Missing WCL_CLIENT_ID or WCL_CLIENT_SECRET environment variables.'
          }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
        }

        // 1. Get access token
        const token = await getAccessToken(clientId, clientSecret);

        // 2. Fetch existing baseline logs from KV or static asset to preserve historical records
        let existingData = null;
        if (env.LOGS_KV) {
          existingData = await env.LOGS_KV.get('warcraft_logs', 'json');
        }
        if (!existingData && env.ASSETS) {
          const assetUrl = new URL('/data/logs.json', request.url);
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

        // If WarcraftLogs threw an error for the primary account (e.g. rate limit), return 502 with error details
        const meudayrResult = accountResults.find(r => r.id === 'meudayr');
        if (meudayrResult && meudayrResult.error) {
          return new Response(JSON.stringify({
            error: meudayrResult.error,
            accounts: accountResults.map(r => ({ id: r.id, error: r.error }))
          }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
          });
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

    // Default: pass through to static assets
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  }
};
