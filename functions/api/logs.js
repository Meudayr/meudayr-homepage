// functions/api/logs.js
// Cloudflare Pages Function to serve cached WarcraftLogs data from Cloudflare KV
// with seamless fallback to static data/logs.json

export async function onRequestGet(context) {
  try {
    // 1. Try reading from Cloudflare KV if bound
    if (context.env && context.env.LOGS_KV) {
      const cached = await context.env.LOGS_KV.get('warcraft_logs', 'json');
      if (cached && (cached.reportsByAccount || (Array.isArray(cached.reports) && cached.reports.length > 0))) {
        return new Response(JSON.stringify(cached), {
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // 2. Fallback to static asset data/logs.json
    const assetUrl = new URL('/data/logs.json', context.request.url);
    const assetRes = context.env.ASSETS ? await context.env.ASSETS.fetch(assetUrl) : await fetch(assetUrl.toString());
    
    if (assetRes && assetRes.ok) {
      const data = await assetRes.json();
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=60, stale-while-revalidate=300',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    return new Response(JSON.stringify({ error: 'No logs available yet.' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  }
}
