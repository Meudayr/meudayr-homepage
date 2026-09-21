# Meudayr.com Public API Documentation

Welcome to the public API for **[meudayr.com](https://meudayr.com)**. This API allows external services, Discord bots, web dashboards, and automation scripts to query WarcraftLogs reports and the World of Warcraft: Forever TBS Guild Roster in real time.

---

## ⚡ Quick Start

* **Base URL:** `https://meudayr.com`
* **Authentication:** None required for `GET` requests.
* **CORS:** Enabled (`Access-Control-Allow-Origin: *`). You can call these endpoints directly from frontend browsers, Node.js, Python, or Discord bots.
* **Data Format:** Standard `application/json`.

---

## 1. WarcraftLogs API

### `GET /api/logs`
Fetches parsed WarcraftLogs raid and Mythic+ dungeon reports across all configured guild accounts (Meudayr, Vember, Wubs, Ferraro).

#### Query Parameters
| Parameter | Type | Description | Example |
| :--- | :--- | :--- | :--- |
| `latest` | `boolean` (`1` or `true`) | Returns **only the single most recent report** object. Ideal for "Latest Log" Discord bot commands. | `/api/logs?latest=1` |
| `limit` | `integer` | Restricts the number of returned reports. | `/api/logs?limit=5` |
| `account` | `string` | Filter by WarcraftLogs account ID: `meudayr`, `vember`, `wubs`, or `ferraro`. | `/api/logs?account=meudayr` |
| `player` | `string` | Case-insensitive filter for reports where a player was present. | `/api/logs?player=Kaerra` |
| `class` | `string` | Filter reports containing a specific class (e.g. `Druid`, `Mage`, `Warrior`). | `/api/logs?class=Druid` |
| `difficulty` | `string` | Filter by difficulty (`Mythic+`, `Heroic`, `Normal`, `LFR`). | `/api/logs?difficulty=Mythic+` |
| `q` or `search` | `string` | Freeform text search matching report title, dungeon, boss, or zone. | `/api/logs?q=Blinding+Vale` |

#### Example Responses

##### 1. Latest Report (`GET /api/logs?latest=1`)
```json
{
  "success": true,
  "fetchedAt": "2026-09-21T00:00:52.611Z",
  "report": {
    "code": "mpNJCPZ74yXLBzh6",
    "title": "Mythic+ Season 2",
    "startTime": 1789840766511,
    "endTime": 1789842008361,
    "zone": {
      "name": "Mythic+ Season 2"
    },
    "dungeons": [
      "The Blinding Vale +11"
    ],
    "bosses": [
      "The Blinding Vale"
    ],
    "players": [
      "Kaerra",
      "Meudayr",
      "Sugarmommi",
      "Yem",
      "Lavendarmoon"
    ],
    "classes": [
      "Mage",
      "Druid",
      "Warrior",
      "Paladin",
      "Warlock"
    ],
    "difficulties": [
      "Mythic+"
    ],
    "keyLevels": [
      11
    ],
    "url": "https://www.warcraftlogs.com/reports/mpNJCPZ74yXLBzh6"
  }
}
```

##### 2. Filtered Reports (`GET /api/logs?player=Kaerra&limit=3`)
```json
{
  "success": true,
  "fetchedAt": "2026-09-21T00:00:52.611Z",
  "total": 42,
  "count": 3,
  "reports": [
    {
      "code": "mpNJCPZ74yXLBzh6",
      "title": "Mythic+ Season 2",
      "startTime": 1789840766511,
      "url": "https://www.warcraftlogs.com/reports/mpNJCPZ74yXLBzh6",
      "dungeons": ["The Blinding Vale +11"],
      "players": ["Kaerra", "Meudayr"]
    }
  ]
}
```

---

## 2. TBS Guild Roster API (WoW: Forever)

### `GET /api/roster`
Fetches the current TBS Horde guild roster registrations, specs, roles, playstyles, and professions.

#### Query Parameters
| Parameter | Type | Description | Example |
| :--- | :--- | :--- | :--- |
| `summary` | `boolean` (`1` or `true`) | Returns **aggregate guild counts** (total players, role breakdown, class breakdown, playstyles). | `/api/roster?summary=1` |
| `role` | `string` | Filter characters by role: `Tank`, `Healer`, `DPS`, `Melee DPS`, or `Ranged DPS`. | `/api/roster?role=Tank` |
| `class` | `string` | Filter characters by class: `Warrior`, `Priest`, `Druid`, `Shaman`, `Mage`, `Warlock`, `Hunter`, `Rogue`, `Paladin`. | `/api/roster?class=Warrior` |
| `player` | `string` | Case-insensitive search for a character by name. | `/api/roster?player=BeastMayo` |
| `playstyle` | `string` | Filter by playstyle: `Raiding`, `PvP`, `Leveling`, `Casual`. | `/api/roster?playstyle=Raiding` |
| `clean` | `boolean` (`1` or `true`) | Explicitly sanitizes out internal edit PINs. *(Note: PINs are automatically sanitized whenever any filter or summary is used).* | `/api/roster?clean=1` |

#### Example Responses

##### 1. Guild Roster Summary (`GET /api/roster?summary=1`)
```json
{
  "success": true,
  "total": 16,
  "roles": {
    "Tank": 2,
    "Healer": 4,
    "Melee DPS": 6,
    "Ranged DPS": 4
  },
  "classes": {
    "Warrior": 3,
    "Priest": 2,
    "Druid": 2,
    "Shaman": 3,
    "Mage": 2,
    "Warlock": 2,
    "Hunter": 1,
    "Rogue": 1
  },
  "playstyles": {
    "Raiding": 15,
    "PvP": 6
  }
}
```

##### 2. Filtered Roster (`GET /api/roster?role=Tank`)
```json
{
  "success": true,
  "total": 16,
  "count": 2,
  "roster": [
    {
      "id": "tbs-1789671070503-bs4g",
      "playerName": "BeastMayo",
      "faction": "Horde",
      "race": "Orc",
      "gender": "male",
      "className": "Warrior",
      "spec": "Protection",
      "role": "Tank",
      "roles": ["Tank"],
      "offspec": "Fury",
      "offspecRole": "Melee DPS",
      "playstyle": "Raiding",
      "playstyles": ["Raiding"],
      "professions": ["Mining", "Blacksmithing"],
      "notes": "Flexible with specs and raid times.",
      "isPinProtected": false,
      "createdAt": "2026-09-17T18:51:10.503Z"
    }
  ]
}
```

---

## 3. Discord Bot Integration Examples

### Example A: Discord.js (v14) Slash Commands

```javascript
// Example Discord.js v14 slash command handlers
const { EmbedBuilder } = require('discord.js');

// 1. /latestlog command
async function handleLatestLogCommand(interaction) {
  await interaction.deferReply();

  try {
    const res = await fetch('https://meudayr.com/api/logs?latest=1');
    const data = await res.json();

    if (!data.success || !data.report) {
      return interaction.editReply('No recent raid or dungeon logs found.');
    }

    const report = data.report;
    const dateStr = new Date(report.startTime).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });

    const embed = new EmbedBuilder()
      .setColor('#22c55e')
      .setTitle(`📜 Latest Log: ${report.title}`)
      .setURL(report.url)
      .setDescription(`**Zone:** ${report.zone?.name || 'Unknown'}\n**Date:** ${dateStr}`)
      .addFields(
        { name: 'Difficulties', value: report.difficulties?.join(', ') || 'Normal', inline: true },
        { name: 'Bosses / Dungeons', value: report.dungeons?.slice(0, 3).join('\n') || 'N/A', inline: true },
        { name: 'Raid Group', value: report.players?.slice(0, 8).join(', ') + (report.players?.length > 8 ? '...' : '') || 'N/A' }
      )
      .setFooter({ text: 'WarcraftLogs • meudayr.com' });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error(error);
    await interaction.editReply('Failed to fetch the latest log from meudayr.com.');
  }
}

// 2. /roster command
async function handleRosterSummaryCommand(interaction) {
  await interaction.deferReply();

  try {
    const res = await fetch('https://meudayr.com/api/roster?summary=1');
    const data = await res.json();

    if (!data.success) {
      return interaction.editReply('Failed to retrieve guild roster summary.');
    }

    const embed = new EmbedBuilder()
      .setColor('#c09d52')
      .setTitle('🛡️ TBS Guild Roster Summary')
      .setURL('https://meudayr.com/forever.html')
      .setDescription(`**Total Registered:** ${data.total} Guild Members`)
      .addFields(
        { name: '🛡️ Tanks', value: `${data.roles['Tank'] || 0}`, inline: true },
        { name: '💚 Healers', value: `${data.roles['Healer'] || 0}`, inline: true },
        { name: '⚔️ Melee DPS', value: `${data.roles['Melee DPS'] || 0}`, inline: true },
        { name: '🏹 Ranged DPS', value: `${data.roles['Ranged DPS'] || 0}`, inline: true },
        {
          name: 'Class Breakdown',
          value: Object.entries(data.classes).map(([cls, count]) => `**${cls}:** ${count}`).join(' • ')
        }
      )
      .setFooter({ text: 'WoW: Forever • meudayr.com/forever.html' });

    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error(error);
    await interaction.editReply('Error loading guild roster.');
  }
}
```

---

### Example B: Python (`discord.py`) Slash Commands

```python
import discord
from discord import app_commands
import aiohttp
from datetime import datetime

# 1. /latestlog command
@app_commands.command(name="latestlog", description="Get the most recent raid or dungeon log")
async def latest_log(interaction: discord.Interaction):
    await interaction.response.defer()
    
    async with aiohttp.ClientSession() as session:
        async with session.get("https://meudayr.com/api/logs?latest=1") as resp:
            if resp.status != 200:
                return await interaction.followup.send("Failed to reach meudayr.com logs API.")
            
            data = await resp.json()
            report = data.get("report")
            if not report:
                return await interaction.followup.send("No logs found.")
            
            date_str = datetime.fromtimestamp(report["startTime"] / 1000).strftime("%b %d, %Y")
            
            embed = discord.Embed(
                title=f"📜 {report['title']}",
                url=report["url"],
                description=f"**Zone:** {report.get('zone', {}).get('name', 'N/A')}\n**Date:** {date_str}",
                color=0x22C55E
            )
            embed.add_field(name="Dungeons / Fights", value="\n".join(report.get("dungeons", [])[:3]) or "N/A", inline=False)
            embed.add_field(name="Players Present", value=", ".join(report.get("players", [])[:6]) + "...", inline=False)
            embed.set_footer(text="WarcraftLogs • meudayr.com")
            
            await interaction.followup.send(embed=embed)

# 2. /roster command
@app_commands.command(name="roster", description="Get the TBS Guild Roster summary")
async def roster_summary(interaction: discord.Interaction):
    await interaction.response.defer()
    
    async with aiohttp.ClientSession() as session:
        async with session.get("https://meudayr.com/api/roster?summary=1") as resp:
            if resp.status != 200:
                return await interaction.followup.send("Failed to retrieve roster data.")
            
            data = await resp.json()
            roles = data.get("roles", {})
            classes = data.get("classes", {})
            
            embed = discord.Embed(
                title="🛡️ TBS Guild Roster (WoW: Forever)",
                url="https://meudayr.com/forever.html",
                description=f"**Total Registered Members:** {data.get('total', 0)}",
                color=0xC09D52
            )
            embed.add_field(name="🛡️ Tanks", value=str(roles.get("Tank", 0)), inline=True)
            embed.add_field(name="💚 Healers", value=str(roles.get("Healer", 0)), inline=True)
            embed.add_field(name="⚔️ Melee DPS", value=str(roles.get("Melee DPS", 0)), inline=True)
            embed.add_field(name="🏹 Ranged DPS", value=str(roles.get("Ranged DPS", 0)), inline=True)
            
            class_str = " • ".join([f"**{c}:** {n}" for c, n in classes.items()])
            embed.add_field(name="Class Counts", value=class_str or "None", inline=False)
            embed.set_footer(text="meudayr.com/forever.html")
            
            await interaction.followup.send(embed=embed)
```
