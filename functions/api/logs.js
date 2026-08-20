// functions/api/logs.js
// Cloudflare Pages Function to fetch live WarcraftLogs reports on-demand

const WCL_USER_ID = 323892; // Meudayr's WarcraftLogs user ID
const REPORTS_PER_PAGE = 25;

async function getAccessToken(clientId, clientSecret) {
  const credentials = btoa(`${clientId}:${clientSecret}`);
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

export async function onRequest(context) {
  return handleLogsRequest(context);
}

export async function onRequestGet(context) {
  return handleLogsRequest(context);
}

async function handleLogsRequest(context) {
  const { env } = context;
  const clientId = env?.WCL_CLIENT_ID;
  const clientSecret = env?.WCL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return new Response(JSON.stringify({
      error: 'WCL credentials not configured in Cloudflare Pages environment variables',
      fallback: true
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, max-age=0',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }

  try {
    const token = await getAccessToken(clientId, clientSecret);
    let allReports = [];
    let page = 1;
    let hasMore = true;

    while (hasMore && page <= 10) {
      const result = await fetchReportsPage(token, page);
      const pageReports = result.data ?? [];
      allReports = allReports.concat(pageReports);
      hasMore = result.has_more_pages === true;
      page++;
    }

    const output = {
      fetchedAt: new Date().toISOString(),
      character: 'Meudayr',
      server: 'Crushridge-US',
      reports: allReports,
      live: true
    };

    return new Response(JSON.stringify(output), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, max-age=0',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: err.message,
      fallback: true
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store, max-age=0',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}
