// scripts/fetch-logs.js
// Run via GitHub Actions to securely fetch WarcraftLogs data and write data/logs.json
// Secrets are passed via environment variables: WCL_CLIENT_ID, WCL_CLIENT_SECRET

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_ID = process.env.WCL_CLIENT_ID;
const CLIENT_SECRET = process.env.WCL_CLIENT_SECRET;
const WCL_USER_ID = 323892; // Meudayr's WarcraftLogs user ID
const REPORTS_PER_PAGE = 25;

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

// Step 2: Query a single page of reports
async function fetchReportsPage(token, page) {
  const query = `
    query {
      reportData {
        reports(userID: ${WCL_USER_ID}, limit: ${REPORTS_PER_PAGE}, page: ${page}) {
          data {
            code
            title
            startTime
            endTime
            zone {
              name
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

// Step 3: Paginate through ALL reports
async function fetchAllReports(token) {
  let allReports = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    console.log(`  Fetching page ${page}...`);
    const result = await fetchReportsPage(token, page);
    const pageReports = result.data ?? [];

    console.log(`  Page ${page}: got ${pageReports.length} reports. Total so far: ${allReports.length + pageReports.length} / ${result.total}`);
    allReports = allReports.concat(pageReports);

    hasMore = result.has_more_pages === true;
    page++;

    // Safety cap to avoid infinite loops
    if (page > 20) {
      console.log('Reached page limit of 20, stopping.');
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

    console.log(`Querying all reports for user ID ${WCL_USER_ID} (Meudayr)...`);
    const reports = await fetchAllReports(token);

    console.log(`Total reports fetched: ${reports.length}`);

    if (reports.length === 0) {
      console.warn('WARNING: 0 reports returned. Reports may be set to Private on WarcraftLogs.');
      console.warn('Fix: Go to warcraftlogs.com and set each report\'s visibility to Public.');
    }

    const output = {
      fetchedAt: new Date().toISOString(),
      character: 'Meudayr',
      server: 'Crushridge-US',
      reports,
    };

    const outDir = path.join(__dirname, '..', 'data');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const outPath = path.join(outDir, 'logs.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`Successfully wrote ${reports.length} reports to ${outPath}`);

  } catch (err) {
    console.error('Error fetching logs:', err.message);
    process.exit(1);
  }
}

main();
