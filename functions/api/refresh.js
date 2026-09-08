// functions/api/refresh.js
// Cloudflare Pages Function to fetch fresh logs from WarcraftLogs API on demand,
// merge with existing historical reports, and cache directly into Cloudflare KV.

const ACCOUNTS = [
  { id: 'meudayr', name: 'Meudayr', userId: 323892, server: 'Crushridge-US', default: true },
  { id: 'vember', name: 'Vember', userId: 3015473, server: 'US' },
  { id: 'wubs', name: 'Wubs', userId: 48864, server: 'US' },
  { id: 'ferraro', name: 'Ferraro', userId: 2552220, server: 'US' }
];

const REPORTS_PER_PAGE = 25;
const MAX_PAGES_ON_REFRESH = 20;

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

  return allRecent;
}

export async function onRequest(context) {
  // Allow both GET and POST for flexibility
  if (context.request.method !== 'GET' && context.request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method Not Allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }

  try {
    const clientId = context.env?.WCL_CLIENT_ID;
    const clientSecret = context.env?.WCL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return new Response(JSON.stringify({
        error: 'Missing WCL_CLIENT_ID or WCL_CLIENT_SECRET environment variables in Cloudflare Pages.'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
      });
    }

    // 1. Get access token
    const token = await getAccessToken(clientId, clientSecret);

    // 2. Fetch existing baseline logs from KV or static asset to preserve historical records
    let existingData = null;
    if (context.env?.LOGS_KV) {
      existingData = await context.env.LOGS_KV.get('warcraft_logs', 'json');
    }
    if (!existingData) {
      const assetUrl = new URL('/data/logs.json', context.request.url);
      const assetRes = context.env.ASSETS ? await context.env.ASSETS.fetch(assetUrl) : await fetch(assetUrl.toString());
      if (assetRes && assetRes.ok) {
        existingData = await assetRes.json();
      }
    }

    const existingReportsByAccount = existingData?.reportsByAccount || {};

    // 3. Fetch all accounts in parallel!
    const accountResults = await Promise.all(
      ACCOUNTS.map(async acc => {
        try {
          const freshReports = await fetchAccountRecentReports(token, acc);
          return { id: acc.id, freshReports, error: null };
        } catch (err) {
          console.error(`Error fetching for ${acc.name}:`, err.message);
          return { id: acc.id, freshReports: [], error: err.message };
        }
      })
    );

    // 4. Mirror WarcraftLogs public reports (reflects additions, privacy changes, and deletions)
    const updatedReportsByAccount = {};
    const accountList = [];

    for (const acc of ACCOUNTS) {
      const incomingResult = accountResults.find(r => r.id === acc.id);
      let reportList = incomingResult && incomingResult.freshReports && incomingResult.error === null
        ? incomingResult.freshReports
        : (existingReportsByAccount[acc.id] || []);

      reportList.sort((a, b) => b.startTime - a.startTime);
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
    if (context.env?.LOGS_KV) {
      await context.env.LOGS_KV.put('warcraft_logs', JSON.stringify(finalOutput));
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
