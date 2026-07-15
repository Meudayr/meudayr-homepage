// scripts/fetch-logs.js
// Run via GitHub Actions to securely fetch WarcraftLogs data and write data/logs.json
// Secrets are passed via environment variables: WCL_CLIENT_ID, WCL_CLIENT_SECRET

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CLIENT_ID = process.env.WCL_CLIENT_ID;
const CLIENT_SECRET = process.env.WCL_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing WCL_CLIENT_ID or WCL_CLIENT_SECRET environment variables.');
  process.exit(1);
}

// Step 1: Get OAuth access token
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
  return data.access_token;
}

// Step 2: Query WarcraftLogs API for Meudayr's recent reports
async function fetchReports(token) {
  const query = `
    query {
      characterData {
        character(name: "Meudayr", serverSlug: "crushridge", serverRegion: "US") {
          recentReports: reports(limit: 15) {
            data {
              code
              title
              startTime
              endTime
              zone {
                name
              }
            }
          }
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

  return json.data?.characterData?.character?.recentReports?.data ?? [];
}

// Main
async function main() {
  try {
    console.log('Fetching WarcraftLogs access token...');
    const token = await getAccessToken();

    console.log('Querying reports for Meudayr on Crushridge-US...');
    const reports = await fetchReports(token);

    console.log(`Fetched ${reports.length} reports.`);

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
    console.log(`Wrote ${outPath}`);

  } catch (err) {
    console.error('Error fetching logs:', err.message);
    process.exit(1);
  }
}

main();
