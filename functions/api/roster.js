// functions/api/roster.js
// Cloudflare Pages Function to manage TBS Guild Roster for WoW: Forever
// Supports GET, POST (create or update), and DELETE with Cloudflare KV & static JSON fallback.

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  };
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

async function getBaselineRoster(context) {
  // 1. Try reading from Cloudflare KV
  if (context.env && context.env.LOGS_KV) {
    try {
      const kvData = await context.env.LOGS_KV.get('forever_roster', 'json');
      if (Array.isArray(kvData) && kvData.length > 0) {
        return kvData;
      }
    } catch (e) {
      console.warn('KV read failed:', e);
    }
  }

  // 2. Fallback to static data/forever-roster.json
  try {
    const assetUrl = new URL('/data/forever-roster.json', context.request.url);
    const assetRes = context.env.ASSETS
      ? await context.env.ASSETS.fetch(new Request(assetUrl))
      : await fetch(assetUrl.toString());

    if (assetRes && assetRes.ok) {
      const data = await assetRes.json();
      if (Array.isArray(data)) {
        return data;
      }
    }
  } catch (e) {
    console.warn('Asset fallback read failed:', e);
  }

  return [];
}

export async function onRequestGet(context) {
  try {
    const roster = await getBaselineRoster(context);
    return new Response(JSON.stringify({ success: true, roster }), {
      status: 200,
      headers: corsHeaders()
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: corsHeaders()
    });
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json();
    const { id, playerName, faction, race, className, spec, role, offspec, playstyle, notes, pin } = body;

    if (!playerName || !playerName.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'Player Name is required.' }), {
        status: 400,
        headers: corsHeaders()
      });
    }

    if (!faction || !race || !className || !spec || !role) {
      return new Response(JSON.stringify({ success: false, error: 'Faction, race, class, spec, and role are required.' }), {
        status: 400,
        headers: corsHeaders()
      });
    }

    const cleanName = playerName.trim();
    const roster = await getBaselineRoster(context);

    // Look for existing entry by ID or by player name (case-insensitive)
    const existingIndex = roster.findIndex(item => {
      if (id && item.id === id) return true;
      return item.playerName.toLowerCase() === cleanName.toLowerCase();
    });

    const nowIso = new Date().toISOString();
    let savedEntry = null;

    if (existingIndex >= 0) {
      const existing = roster[existingIndex];
      // PIN check: if existing entry has a non-empty PIN, require matching PIN
      if (existing.pin && existing.pin.trim() !== '') {
        if (!pin || pin.trim() !== existing.pin.trim()) {
          return new Response(JSON.stringify({
            success: false,
            error: 'This character is protected with an edit PIN. Please provide the correct PIN to update.'
          }), {
            status: 403,
            headers: corsHeaders()
          });
        }
      }

      savedEntry = {
        ...existing,
        playerName: cleanName,
        faction,
        race,
        className,
        spec,
        role,
        offspec: offspec ? offspec.trim() : '',
        playstyle: playstyle || 'Raid Casual',
        notes: notes ? notes.trim() : '',
        pin: pin && pin.trim() !== '' ? pin.trim() : (existing.pin || ''),
        updatedAt: nowIso
      };

      roster[existingIndex] = savedEntry;
    } else {
      // Create new entry
      savedEntry = {
        id: id || `tbs-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        playerName: cleanName,
        faction,
        race,
        className,
        spec,
        role,
        offspec: offspec ? offspec.trim() : '',
        playstyle: playstyle || 'Raid Casual',
        notes: notes ? notes.trim() : '',
        pin: pin ? pin.trim() : '',
        createdAt: nowIso,
        updatedAt: nowIso
      };

      roster.unshift(savedEntry);
    }

    // Persist to Cloudflare KV if bound
    if (context.env && context.env.LOGS_KV) {
      await context.env.LOGS_KV.put('forever_roster', JSON.stringify(roster));
    }

    return new Response(JSON.stringify({
      success: true,
      entry: savedEntry,
      roster
    }), {
      status: 200,
      headers: corsHeaders()
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: corsHeaders()
    });
  }
}

export async function onRequestDelete(context) {
  try {
    let targetId = null;
    let givenPin = null;

    const url = new URL(context.request.url);
    targetId = url.searchParams.get('id');
    givenPin = url.searchParams.get('pin');

    if (!targetId && context.request.method === 'DELETE') {
      try {
        const body = await context.request.json();
        targetId = body.id;
        givenPin = body.pin;
      } catch (e) {}
    }

    if (!targetId) {
      return new Response(JSON.stringify({ success: false, error: 'Target ID is required to delete.' }), {
        status: 400,
        headers: corsHeaders()
      });
    }

    const roster = await getBaselineRoster(context);
    const existingIndex = roster.findIndex(item => item.id === targetId);

    if (existingIndex < 0) {
      return new Response(JSON.stringify({ success: false, error: 'Entry not found.' }), {
        status: 404,
        headers: corsHeaders()
      });
    }

    const existing = roster[existingIndex];
    if (existing.pin && existing.pin.trim() !== '') {
      if (!givenPin || givenPin.trim() !== existing.pin.trim()) {
        return new Response(JSON.stringify({
          success: false,
          error: 'This character is protected with an edit PIN. Please provide the correct PIN to remove.'
        }), {
          status: 403,
          headers: corsHeaders()
        });
      }
    }

    roster.splice(existingIndex, 1);

    if (context.env && context.env.LOGS_KV) {
      await context.env.LOGS_KV.put('forever_roster', JSON.stringify(roster));
    }

    return new Response(JSON.stringify({ success: true, deletedId: targetId, roster }), {
      status: 200,
      headers: corsHeaders()
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: corsHeaders()
    });
  }
}
