// scripts/fetch-logs.js
// Run via GitHub Actions to securely fetch WarcraftLogs data and write data/logs.json
// Secrets are passed via environment variables: WCL_CLIENT_ID, WCL_CLIENT_SECRET

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_ID = process.env.WCL_CLIENT_ID;
const CLIENT_SECRET = process.env.WCL_CLIENT_SECRET;
const REPORTS_PER_PAGE = 25;

const ACCOUNTS = [
  { id: 'meudayr', name: 'Meudayr', userId: 323892, server: 'Crushridge-US', default: true },
  { id: 'vember', name: 'Vember', userId: 3015473, server: 'US' },
  { id: 'wubs', name: 'Wubs', userId: 48864, server: 'US' },
  { id: 'ferraro', name: 'Ferraro', userId: 2552220, server: 'US' }
];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing WCL_CLIENT_ID or WCL_CLIENT_SECRET environment variables.');
  process.exit(1);
}

// Step 1: Get OAuth access token using client credentials flow
async function getAccessToken() {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
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
    throw new Error(`Failed to get access token: ${res.status} ${text}`);
  }

  const data = await res.json();
  console.log('Access token obtained successfully.');
  return data.access_token;
}

// Step 2: Query a single page of reports for a given user ID
async function fetchReportsPage(token, page, userId) {
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

// Step 3: Paginate through ALL reports for an account
async function fetchAllReports(token, account) {
  let allReports = [];
  let page = 1;
  let hasMore = true;

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

  while (hasMore) {
    console.log(`  [${account.name}] Fetching page ${page}...`);
    const result = await fetchReportsPage(token, page, account.userId);
    const rawReports = result.data ?? [];

    const pageReports = rawReports.map(r => {
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

    console.log(`  [${account.name}] Page ${page}: got ${pageReports.length} reports. Total so far: ${allReports.length + pageReports.length} / ${result.total}`);
    allReports = allReports.concat(pageReports);

    hasMore = result.has_more_pages === true;
    page++;

    // Safety cap to avoid infinite loops
    if (page > 20) {
      console.log(`  [${account.name}] Reached page limit of 20, stopping.`);
      break;
    }
  }

  return allReports;
}

// Main
async function main() {
  try {
    console.log('Fetching WarcraftLogs access token...');
    const token = await getAccessToken();

    const reportsByAccount = {};
    const accountList = [];

    for (const acc of ACCOUNTS) {
      console.log(`\nQuerying reports for ${acc.name} (User ID ${acc.userId})...`);
      const reports = await fetchAllReports(token, acc);
      console.log(`Total reports fetched for ${acc.name}: ${reports.length}`);

      if (reports.length === 0) {
        console.warn(`WARNING: 0 reports returned for ${acc.name}. Reports may be set to Private on WarcraftLogs.`);
      }

      reportsByAccount[acc.id] = reports;
      accountList.push({
        id: acc.id,
        name: acc.name,
        userId: acc.userId,
        server: acc.server,
        reportsCount: reports.length,
        default: !!acc.default
      });
    }

    const defaultAcc = ACCOUNTS.find(a => a.default) || ACCOUNTS[0];

    const output = {
      fetchedAt: new Date().toISOString(),
      accounts: accountList,
      reportsByAccount: reportsByAccount,
      // Backward compatibility fields:
      character: defaultAcc.name,
      server: defaultAcc.server,
      reports: reportsByAccount[defaultAcc.id] || []
    };

    const outDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, 'logs.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\nSuccessfully wrote multi-account logs data to ${outPath}`);

  } catch (err) {
    console.error('Error fetching logs:', err.message);
    process.exit(1);
  }
}

main();
