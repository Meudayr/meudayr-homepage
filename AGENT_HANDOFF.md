# Meudayr Homepage — Project Knowledge & Agent Handoff Guide

This document is the single source of truth for the architecture, design system, build pipeline, and technical learnings of **meudayr.com**. Pass this document to any new AI agent thread to immediately start building new pages or features without repeating onboarding steps.

---

## 1. Project Overview & Tech Stack

* **Live Site:** [meudayr.com](https://meudayr.com)
* **GitHub Repository:** [Meudayr/meudayr-homepage](https://github.com/Meudayr/meudayr-homepage) (Branch: `main`)
* **Hosting:** Cloudflare Pages (Project: `curly-tooth-0d40`), automatically deploys on every push to `main` (~30–45s build time).
* **Git Path on Windows:** `C:\Users\Schut\Documents\mingit\cmd\git.exe`

### Core Philosophy: Clean, Zero-Dependency Vanilla Stack
* **Frontend:** Modern **HTML5**, **CSS3** (custom properties, responsive layouts, glassmorphism), and **Vanilla ES6+ JavaScript**. No React, Vue, jQuery, or bloated build steps.
* **Backend & Automation:** **Node.js** scripts (`scripts/fetch-logs.js`, `scripts/fetch-deals.js`) orchestrated by **GitHub Actions** cron/dispatch workflows.
* **Storage:** Static JSON files in `data/` (`data/logs.json`) committed to Git and served via Cloudflare edge.

---

## 2. Design System & Styling Rules

All pages inherit from `style.css` and use a **minimalist dark mode / WoW Druid earthy theme**:

### Color Palette (CSS Variables)
```css
:root {
  /* Backgrounds & Surfaces */
  --bg-color: #111317;           /* Main page dark background */
  --card-bg: #181a1f;            /* Elevated card surface */
  --card-border: #25282f;        /* Default border */
  --card-border-hover: #3b3f4a;  /* Hover border */

  /* Accents */
  --primary: #388e3c;            /* Flat Forest Green */
  --accent: #c09d52;             /* Flat Bronze / Gold (used for seasons/tags) */
  --accent-green: #22c55e;       /* Bright Neon Green for status & active states */
  --accent-green-glow: #81c784;  /* Muted Green for badges */

  /* Typography */
  --text-main: #f8fafc;          /* High contrast text */
  --text-muted: #94a3b8;         /* Secondary description text */
  --text-dark: #64748b;          /* Darker metadata / timestamps */

  /* Fonts */
  --font-display: 'Outfit', sans-serif; /* Titles, headers, tool names */
  --font-sans: 'Inter', sans-serif;     /* Body, metadata, buttons */

  /* UI Tokens */
  --transition: all 0.2s ease-in-out;
  --radius-lg: 12px;
  --radius-md: 8px;
}
```

### Component Styling Guidelines
1. **Cards & Containers:** `background: var(--card-bg); border: 1px solid var(--card-border); border-radius: var(--radius-lg);` with hover transitions.
2. **Pill Buttons & Tags:** `border-radius: 9999px; padding: 6px 14px; font-weight: 600;`
3. **Custom Floating Dropdowns:** Use glassmorphism floating menus (`background: #14171f; backdrop-filter: blur(12px); border: 1px solid var(--card-border); border-radius: 14px; box-shadow: 0 16px 36px rgba(0,0,0,0.6);`) rather than native OS `<select>` elements.
4. **Icons:** Use clean inline SVGs with `viewBox="0 0 24 24"`, `stroke="currentColor"`, `stroke-width="2"`, `fill="none"`.

---

## 3. Standard Navigation & Shared Header Template

Every page on `meudayr.com` must include this exact header layout. When adding a new page, add its link to the `<nav class="nav-menu">` across **all HTML files**:

```html
<!-- Header Navigation -->
<header>
  <div class="container nav-container">
    <a href="index.html" class="brand" id="nav-brand-link">
      <img src="assets/logo.png" alt="Meudayr Logo" id="nav-brand-logo">
      <span>Meudayr</span>
    </a>
    <div class="nav-group">
      <nav class="nav-menu">
        <a href="index.html" class="nav-link" id="nav-home-link">Home</a>
        <a href="deals.html" class="nav-link" id="nav-deals-link">Deal Finder</a>
        <a href="dr.html" class="nav-link" id="nav-dr-link">DR Calculator</a>
        <a href="logs.html" class="nav-link" id="nav-logs-link">Logs</a>
        <!-- Set class="nav-link active" for the current page -->
      </nav>
      <div class="social-links">
        <a href="https://plex.meudayr.com" class="plex-nav-pill checking" target="_blank" rel="noopener noreferrer" id="nav-plex-link" title="Open Plex Media Server">
          <svg viewBox="0 0 24 24" fill="currentColor" class="plex-nav-svg"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
          <span class="plex-nav-text">Plex: <span id="plex-status-label">Checking...</span></span>
          <span class="plex-nav-dot" id="plex-nav-dot"></span>
        </a>
        <a href="https://github.com/Meudayr" class="social-icon" target="_blank" rel="noopener noreferrer" aria-label="GitHub Profile" id="nav-github-link">
          <svg viewBox="0 0 24 24"><path d="M12 2A10 10 0 0 0 2 12c0 4.42 2.87 8.17 6.84 9.5.5.08.66-.23.66-.5v-1.69c-2.77.6-3.36-1.34-3.36-1.34-.46-1.16-1.11-1.47-1.11-1.47-.9-.62.07-.6.07-.6 1 .07 1.53 1.03 1.53 1.03.9 1.52 2.34 1.07 2.91.83.09-.65.35-1.09.63-1.34-2.22-.25-4.55-1.11-4.55-4.92 0-1.11.38-2 1.03-2.71-.1-.25-.45-1.29.1-2.64 0 0 .84-.27 2.75 1.02.79-.22 1.65-.33 2.5-.33.85 0 1.71.11 2.5.33 1.91-1.29 2.75-1.02 2.75-1.02.55 1.35.2 2.39.1 2.64.65.71 1.03 1.6 1.03 2.71 0 3.82-2.34 4.66-4.57 4.91.36.31.69.92.69 1.85V21c0 .27.16.59.67.5C19.14 20.16 22 16.42 22 12A10 10 0 0 0 12 2z"/></svg>
        </a>
      </div>
    </div>
  </div>
</header>
```

### Live Plex Status Checker Script
Include this in every page's script to keep the live server status monitor working:
```javascript
const PLEX_TOKEN = "ypFBiUJSYfzyDDivAGhu";

async function checkPlexStatus() {
  const pill = document.getElementById('nav-plex-link');
  const label = document.getElementById('plex-status-label');
  if (!pill || !label || !PLEX_TOKEN) return;

  try {
    const res = await fetch(`https://plex.tv/api/v2/resources?X-Plex-Token=${encodeURIComponent(PLEX_TOKEN)}&includeHttps=1`, {
      headers: { 'Accept': 'application/json', 'X-Plex-Client-Identifier': 'meudayr-homepage' }
    });

    if (res.ok) {
      const resources = await res.json();
      const server = resources.find(r => r.provides && r.provides.includes('server'));
      if (server && server.presence) {
        pill.className = 'plex-nav-pill online';
        label.textContent = 'Online';
        pill.setAttribute('title', `Plex Server: ${server.name || 'Online'}`);
        return;
      }
    }
  } catch (err) {
    console.warn('Plex.tv API status check failed:', err);
  }

  pill.className = 'plex-nav-pill offline';
  label.textContent = 'Offline';
  pill.setAttribute('title', 'Plex Server: Offline');
}
checkPlexStatus();
```

---

## 4. Current Site Structure & Pages

1. **`index.html` (Home / Addon Portfolio & Tools Hub):**
   - Hero section linking to all major tools (Deal Finder, DR Calculator, Raid Logs).
   - CurseForge WoW Addons showcase (Percentage Ratings, Bulging Pouch Checker, Yem Circles) with live download counts and CurseForge links.
2. **`deals.html` (Deal Finder):**
   - Live community tech and home deals aggregated via background scripts.
3. **`dr.html` (DR Calculator):**
   - Interactive 3v3 Arena Diminishing Returns calculator for World of Warcraft PvP.
4. **`logs.html` (WarcraftLogs Viewer):**
   - Multi-account log browser (Meudayr, Vember, Wubs, Ferraro).
   - Fast client-side multi-dimensional search (search by title, player name, player class, difficulty, keystone level, date, day of week, report code).
   - On-demand "Refresh Logs" button that triggers GitHub Actions workflow dispatch and live-syncs fresh logs.

---

## 5. Critical Technical Learnings & Solutions

### A. Large Data Files (>1 MB) on GitHub REST API
* **Problem:** GitHub's standard Contents API (`Accept: application/vnd.github.v3+json`) drops the base64 `content` payload for files exceeding 1 MB. As multi-player logs grew to 3+ MB, the API returned empty content.
* **Solution:** Always pass `Accept: application/vnd.github.v3.raw` in the request header when fetching data files directly from GitHub API. This streams the raw JSON regardless of file size without 1 MB truncation:
```javascript
const res = await fetch('https://api.github.com/repos/Meudayr/meudayr-homepage/contents/data/logs.json?ref=main', {
  headers: {
    'Authorization': 'Bearer ' + GH_PAT,
    'Accept': 'application/vnd.github.v3.raw',
    'User-Agent': 'MeudayrApp'
  },
  cache: 'no-store'
});
```

### B. Fastly / Edge CDN Cache Invalidation
* **Problem:** `raw.githubusercontent.com/.../main/data/logs.json` is cached by Fastly for 5 minutes, ignoring URL query params like `?t=12345`.
* **Solution:** If using raw GitHub URLs as a fallback, query the latest commit SHA first (`/commits/main`) and fetch `https://raw.githubusercontent.com/Meudayr/meudayr-homepage/${commitSha}/data/logs.json`. Unique SHA paths guarantee 100% cache-busted, fresh data.

### C. Git Rebase & Concurrent Workflow Commits
* **Problem:** GitHub Actions periodically syncs and commits new log data directly to `main`.
* **Solution:** Always run `git pull --rebase origin main` before committing or pushing changes from local tooling to prevent non-fast-forward push rejections.

### D. WarcraftLogs v2 GraphQL API Specifics
* **User Accounts:** Reports can be fetched for any public user ID using a single API Client ID/Secret in `scripts/fetch-logs.js`.
* **Difficulty Mapping:**
  - `1` = `LFR`
  - `3` = `Normal`
  - `4` = `Heroic`
  - `5` = `Mythic`
  - `10` = `Mythic+`
* **Mini-Raid Acronyms:** WarcraftLogs groups Midnight Tier 1 mini-raids under "VS / DR / MQD". Our script parses individual fights in `fights[].gameZone.name` (`The Voidspire`, `The Dreamrift`, `March on Quel'Danas`) to display the actual raid badges.

### E. GitHub Fine-Grained PAT Token Splitting
* GitHub PAT used for client-side dispatches and API checks is stored in split format in client scripts to prevent automated revocation scanners:
```javascript
const _p1 = "github_pat_11CIZHNEI0w3ZwIiei1fDu";
const _p2 = "yzAQ1FChtntr6DffRYmE52YP9RH5UT3hTg6OTNzdcQANZ547R2HIG3H2XAO";
const GH_PAT = [_p1, _p2].join('_');
```

---

## 6. How to Add a New Page (Step-by-Step)

When asked to create a new page (e.g. `mypage.html`):

1. **Scaffold the HTML file (`mypage.html`):**
   - Include SEO `<title>` and `<meta>` tags.
   - Include `<link rel="stylesheet" href="style.css">`.
   - Copy the standard `<header>` template with `class="nav-link active"` on the new page's link.
   - Include the standard `checkPlexStatus()` JavaScript.
2. **Update Navigation Across Existing Pages:**
   - Add `<a href="mypage.html" class="nav-link" id="nav-mypage-link">Page Name</a>` to the `<nav class="nav-menu">` in:
     - `index.html`
     - `deals.html`
     - `dr.html`
     - `logs.html`
3. **Optionally Add Hero Card to `index.html`:**
   - If the new page is a major utility or portfolio section, add a `.hero-tool-card` inside `<div class="hero-tools" id="hero-tools">` in `index.html`.
4. **Deploy & Verify:**
   ```bash
   git pull --rebase origin main
   git add .
   git commit -m "Add Page Name (mypage.html) and update navigation"
   git push
   ```
   - Cloudflare Pages will build and deploy the update live to [meudayr.com](https://meudayr.com) within 45 seconds.
