// functions/api/roster.js
// Cloudflare Pages Function to manage TBS Guild Roster for WoW: Forever
// Supports GET, POST (create or update), and DELETE with Cloudflare KV & static JSON fallback.
// Supports multi-role, multi-playstyle, and admin mode PIN bypass.

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-admin-key',
    'Cache-Control': 'no-cache, no-store, must-revalidate'
  };
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders()
  });
}

function getValidAdminKey(env) {
  return (env && env.ADMIN_KEY) || 'dontgivemeadpi';
}

async function getBaselineRoster(context) {
  // 1. Try reading from Cloudflare KV
  if (context.env && context.env.LOGS_KV) {
    try {
      const kvData = await context.env.LOGS_KV.get('forever_roster', 'json');
      if (Array.isArray(kvData)) {
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
    const url = new URL(context.request.url);
    if (url.searchParams.get('verify_admin') === '1') {
      const headerKey = context.request.headers.get('x-admin-key');
      const paramKey = url.searchParams.get('admin_key');
      const providedKey = headerKey || paramKey;
      const validKey = getValidAdminKey(context.env);

      if (providedKey && providedKey === validKey) {
        return new Response(JSON.stringify({ success: true, verified: true }), {
          status: 200,
          headers: corsHeaders()
        });
      } else {
        return new Response(JSON.stringify({ success: false, verified: false, error: 'Invalid admin password.' }), {
          status: 403,
          headers: corsHeaders()
        });
      }
    }

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
    const { id, playerName, faction, race, className, spec, role, roles, offspec, offspecRole, playstyle, playstyles, professions, profession1, profession2, notes, pin, currentPin, newPin, admin } = body;

    if (!playerName || !playerName.trim()) {
      return new Response(JSON.stringify({ success: false, error: 'Player Name is required.' }), {
        status: 400,
        headers: corsHeaders()
      });
    }

    const resolvedRoles = Array.isArray(roles) && roles.length > 0 ? roles : (role ? [role] : []);
    if (!race || !className || !spec || resolvedRoles.length === 0) {
      return new Response(JSON.stringify({ success: false, error: 'Race, class, spec, and at least one role are required.' }), {
        status: 400,
        headers: corsHeaders()
      });
    }

    const resolvedPlaystyles = Array.isArray(playstyles) && playstyles.length > 0 ? playstyles : (playstyle ? [playstyle] : ['Raiding']);
    const primaryRole = resolvedRoles[0];
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
    const roster = await getBaselineRoster(context);

    // Look for existing entry by ID or by player name (case-insensitive)
    const existingIndex = roster.findIndex(item => {
      if (id && item.id === id) return true;
      return item.playerName.toLowerCase() === cleanName.toLowerCase();
    });

    const validKey = getValidAdminKey(context.env);
    const providedAdminKey = context.request.headers.get('x-admin-key') || body.adminKey;
    const isAdmin = Boolean(providedAdminKey && providedAdminKey === validKey);
    const nowIso = new Date().toISOString();
    let savedEntry = null;

    const cleanNotes = notes ? notes.trim().slice(0, 300) : '';

    if (existingIndex >= 0) {
      const existing = roster[existingIndex];
      // PIN check: if existing entry has a PIN, require matching PIN unless admin
      const authPin = (currentPin !== undefined && currentPin !== null) ? currentPin : pin;
      if (!isAdmin && existing.pin && existing.pin.trim() !== '') {
        if (!authPin || authPin.trim() !== existing.pin.trim()) {
          return new Response(JSON.stringify({
            success: false,
            error: 'This character is protected with an edit PIN. Please provide the correct PIN to update (or use Admin Mode).'
          }), {
            status: 403,
            headers: corsHeaders()
          });
        }
      }

      // Determine saved PIN: if newPin is explicitly provided (even empty string to remove PIN), use it.
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
        className,
        spec,
        role: primaryRole,
        roles: resolvedRoles,
        offspec: offspec ? offspec.trim() : '',
        offspecRole: offspecRole ? offspecRole.trim() : '',
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
      // Create new entry
      savedEntry = {
        id: id || `tbs-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
        playerName: cleanName,
        faction: 'Horde',
        race,
        className,
        spec,
        role: primaryRole,
        roles: resolvedRoles,
        offspec: offspec ? offspec.trim() : '',
        offspecRole: offspecRole ? offspecRole.trim() : '',
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
    const validKey = getValidAdminKey(context.env);
    let targetId = null;
    let givenPin = null;

    const url = new URL(context.request.url);
    targetId = url.searchParams.get('id');
    givenPin = url.searchParams.get('pin');
    let providedAdminKey = context.request.headers.get('x-admin-key') || url.searchParams.get('admin_key');

    if (!targetId && context.request.method === 'DELETE') {
      try {
        const body = await context.request.json();
        targetId = body.id;
        givenPin = body.pin;
        if (body.adminKey) providedAdminKey = body.adminKey;
      } catch (e) {}
    }

    const isAdmin = Boolean(providedAdminKey && providedAdminKey === validKey);

    if (isAdmin && (url.searchParams.get('clear_all') === '1' || targetId === 'all')) {
      if (context.env && context.env.LOGS_KV) {
        await context.env.LOGS_KV.put('forever_roster', JSON.stringify([]));
      }
      return new Response(JSON.stringify({ success: true, cleared: true, roster: [] }), {
        status: 200,
        headers: corsHeaders()
      });
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
    if (!isAdmin && existing.pin && existing.pin.trim() !== '') {
      if (!givenPin || givenPin.trim() !== existing.pin.trim()) {
        return new Response(JSON.stringify({
          success: false,
          error: 'This character is protected with an edit PIN. Please provide the correct PIN to remove (or use Admin Mode).'
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
