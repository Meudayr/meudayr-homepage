// functions/api/inspect.js
export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const code = url.searchParams.get('code') || 'ZQLWf6hYGJb1rCDR';
    const clientId = context.env?.WCL_CLIENT_ID;
    const clientSecret = context.env?.WCL_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      return new Response(JSON.stringify({ error: 'Missing credentials' }), { status: 500 });
    }

    const credentials = btoa(`${clientId}:${clientSecret}`);
    const tokenRes = await fetch('https://www.warcraftlogs.com/oauth/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!tokenRes.ok) {
      const headers = {};
      tokenRes.headers.forEach((v, k) => { headers[k] = v; });
      return new Response(JSON.stringify({
        tokenError: true,
        status: tokenRes.status,
        headers,
        body: await tokenRes.text()
      }, null, 2), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const tokenData = await tokenRes.json();
    const token = tokenData.access_token;

    const query = `
      query {
        reportData {
          report(code: "${code}") {
            code
            title
            startTime
            endTime
            visibility
            owner {
              id
              name
            }
            guild {
              id
              name
            }
          }
        }
      }
    `;

    const res = await fetch('https://www.warcraftlogs.com/api/v2/client', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ query })
    });

    const headers = {};
    res.headers.forEach((v, k) => { headers[k] = v; });
    const bodyText = await res.text();
    let bodyJson;
    try { bodyJson = JSON.parse(bodyText); } catch(e) { bodyJson = bodyText; }

    return new Response(JSON.stringify({ status: res.status, headers, body: bodyJson }, null, 2), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), { status: 500 });
  }
}
