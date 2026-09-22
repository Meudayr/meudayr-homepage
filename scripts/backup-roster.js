// scripts/backup-roster.js
// Fetches the live World of Warcraft: Forever TBS guild roster from production
// and writes both data/forever-roster.json (for static fallback) and a timestamped snapshot.

const fs = require('fs');
const path = require('path');

const ROSTER_API_URL = process.env.ROSTER_API_URL || 'https://meudayr.com/api/roster';
const API_KEY = process.env.API_KEY || 'meu_live_k8f92a3c71e04b6d9e5f';

async function backupRoster() {
  console.log(`Fetching live roster from ${ROSTER_API_URL}...`);
  const res = await fetch(ROSTER_API_URL, {
    headers: {
      'x-api-key': API_KEY
    }
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Failed to fetch roster: ${res.status} ${errorText}`);
  }

  const data = await res.json();
  const rosterArray = Array.isArray(data) ? data : (data.roster || []);

  if (!Array.isArray(rosterArray) || rosterArray.length === 0) {
    console.warn('Warning: Fetched roster is empty or not an array:', data);
  } else {
    console.log(`Successfully fetched ${rosterArray.length} roster characters.`);
  }

  const rootDir = path.resolve(__dirname, '..');
  const dataDir = path.join(rootDir, 'data');
  const backupsDir = path.join(dataDir, 'backups');

  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });

  // 1. Write data/forever-roster.json as an Array (for getBaselineRoster fallback)
  const rosterJsonPath = path.join(dataDir, 'forever-roster.json');
  fs.writeFileSync(rosterJsonPath, JSON.stringify(rosterArray, null, 2) + '\n', 'utf8');
  console.log(`Updated baseline fallback: ${rosterJsonPath}`);

  // 2. Write timestamped snapshot
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const snapshotData = {
    snapshotDate: now.toISOString(),
    totalMembers: rosterArray.length,
    characters: rosterArray
  };
  const snapshotPath = path.join(backupsDir, `forever-roster-snapshot-${dateStr}.json`);
  fs.writeFileSync(snapshotPath, JSON.stringify(snapshotData, null, 2) + '\n', 'utf8');
  console.log(`Created snapshot backup: ${snapshotPath}`);

  return rosterArray;
}

if (require.main === module) {
  backupRoster().catch(err => {
    console.error('Backup failed:', err);
    process.exit(1);
  });
}

module.exports = { backupRoster };
