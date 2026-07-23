export async function onRequest(context) {
  // Read PLEX_TOKEN from Cloudflare environment variable, or fallback config
  const token = context.env.PLEX_TOKEN || "";

  if (!token) {
    return new Response(JSON.stringify({ 
      online: false,
      error: "PLEX_TOKEN environment variable is missing. Set PLEX_TOKEN in Cloudflare Pages settings." 
    }), {
      status: 200,
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "no-store"
      }
    });
  }

  try {
    const response = await fetch(`https://plex.tv/api/v2/resources?X-Plex-Token=${encodeURIComponent(token)}&includeHttps=1`, {
      headers: {
        "Accept": "application/json",
        "X-Plex-Client-Identifier": "meudayr-homepage"
      }
    });

    if (!response.ok) {
      return new Response(JSON.stringify({ 
        online: false, 
        error: `Plex API returned HTTP ${response.status}` 
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const resources = await response.json();
    
    // Find device that provides 'server'
    const server = resources.find(r => r.provides && r.provides.includes("server"));

    if (!server) {
      return new Response(JSON.stringify({ 
        online: false, 
        error: "No Plex Media Server found under this account." 
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const isOnline = Boolean(server.presence);

    return new Response(JSON.stringify({
      online: isOnline,
      name: server.name || "Plex Server",
      productVersion: server.productVersion || null,
      lastSeenAt: server.lastSeenAt || null
    }), {
      status: 200,
      headers: { 
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=30"
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({ 
      online: false, 
      error: err.message || "Failed to reach plex.tv" 
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
}
