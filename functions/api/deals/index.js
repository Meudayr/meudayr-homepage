const SUBREDDIT_MAP = {
  gaming_pcs: ['buildapcsales', 'prebuilts'],
  laptops: ['laptopdeals', 'buildapcsales'],
  vacuums: ['RobotVacuums', 'deals'],
  tvs: ['OLED', 'Monitors'],
  consoles: ['GameDeals', 'consoles'],
  appliances: ['Appliances', 'CostcoDeals', 'deals'],
  default: ['buildapcsales', 'deals']
};

const DOMAIN_STORE_MAP = {
  'walmart.com': 'Walmart',
  'bestbuy.com': 'Best Buy',
  'amazon.com': 'Amazon',
  'ebay.com': 'eBay',
  'costco.com': 'Costco',
  'target.com': 'Target',
  'samsclub.com': "Sam's Club",
  'homedepot.com': 'Home Depot',
  'lowes.com': "Lowe's",
  'microcenter.com': 'Micro Center',
  'newegg.com': 'Newegg',
  'lenovo.com': 'Lenovo',
  'dell.com': 'Dell',
  'hp.com': 'HP',
  'apple.com': 'Apple Store',
  'woot.com': 'Woot!',
  'bhphotovideo.com': 'B&H Photo',
  'cyberpowerpc.com': 'CyberPowerPC',
  'skytechgaming.com': 'Skytech Gaming',
  'ollies.us': "Ollie's Bargain Outlet"
};

const GLOBAL_NON_HARDWARE_KEYWORDS = [
  'shoe', 'sneaker', 'boot', 'apparel', 'shirt', 'pant', 'short', 'jacket', 'hoodie', 'sock', 'bra', 'underwear', 'clothing'
];

const STANDALONE_PERIPHERAL_KEYWORDS = [
  'monitor', 'headset', 'mouse', 'keyboard', 'switch 2', 'switch', 'game download',
  'pcdd', 'steam', 'backpack', 'bag', 'sleeve', 'dock', 'cable', 'mount'
];

const LAPTOP_EXCLUSION_KEYWORDS = [
  'backpack', 'bag', 'sleeve', 'case', 'skin', 'cover', 'charger', 'stand', 'docking station', 'cable', 'protector', 'mount'
];

const VACUUM_EXCLUSION_KEYWORDS = [
  'foodsaver', 'preserver', 'sealer', 'battery', 'bogo', 'paint sprayer'
];

const APPLIANCE_EXCLUSION_KEYWORDS = [
  'baking soda', 'vent', 'coupling', 'connector', 'duct', 'filter', 'cleaner',
  'mat', 'cover', 'pad', 'hose', 'cord', 'lint', 'thermometer', 'container', 'milk', 'pan', 'pot',
  'smoker', 'hair dryer', 'bottle', 'knife', 'spoon', 'fork', 'shelf', 'light bulb', 'rack', 'tray'
];

function detectStoreName(itemXml = '', title = '', url = '') {
  const fullText = `${itemXml} ${title} ${url}`.toLowerCase();

  const exitMatch = itemXml.match(/data-product-exitWebsite="([^"]+)"/i) ||
                    itemXml.match(/href="[^"]*exitWebsite=([^"&]+)"/i) ||
                    fullText.match(/\[([a-z0-9.-]+\.(?:com|net|org))\]/i);

  if (exitMatch) {
    const domain = exitMatch[1].toLowerCase().replace(/^www\./, '');
    for (const [key, storeName] of Object.entries(DOMAIN_STORE_MAP)) {
      if (domain.includes(key)) return storeName;
    }
  }

  if (fullText.includes('best buy') || fullText.includes('bestbuy')) return 'Best Buy';
  if (fullText.includes('amazon')) return 'Amazon';
  if (fullText.includes('walmart')) return 'Walmart';
  if (fullText.includes('ebay')) return 'eBay';
  if (fullText.includes('costco')) return 'Costco';
  if (fullText.includes('target')) return 'Target';
  if (fullText.includes("sam's club") || fullText.includes('sams club') || fullText.includes('samsclub')) return "Sam's Club";
  if (fullText.includes('home depot') || fullText.includes('homedepot')) return 'Home Depot';
  if (fullText.includes('lowes') || fullText.includes("lowe's")) return "Lowe's";
  if (fullText.includes('micro center') || fullText.includes('microcenter')) return 'Micro Center';
  if (fullText.includes('newegg')) return 'Newegg';
  if (fullText.includes('lenovo')) return 'Lenovo';
  if (fullText.includes('dell')) return 'Dell';
  if (fullText.includes('hp ') || fullText.includes('hp.com')) return 'HP';
  if (fullText.includes('apple')) return 'Apple Store';
  if (fullText.includes('woot')) return 'Woot!';
  if (fullText.includes('b&h') || fullText.includes('bhphoto')) return 'B&H Photo';

  const atMatch = title.match(/@([a-z0-9]+)/i);
  if (atMatch) {
    const rawStr = atMatch[1].toLowerCase();
    if (rawStr.includes('ebay')) return 'eBay';
    if (rawStr.includes('walmart')) return 'Walmart';
    if (rawStr.includes('amazon')) return 'Amazon';
    if (rawStr.includes('target')) return 'Target';
    if (rawStr.includes('bestbuy')) return 'Best Buy';
  }

  return 'Retailer Deal';
}

function parseExplicitPricesFromTitle(title) {
  const matches = title.match(/\$(\d+(?:,\d{3})*(?:\.\d{1,2})?)/g) || [];
  const numbers = matches.map(m => parseFloat(m.replace('$', '').replace(/,/g, '')));

  if (numbers.length === 0) return { salePrice: 0, originalPrice: 0, discountPercentage: 0 };

  let salePrice = numbers[0];
  let originalPrice = 0;

  if (numbers.length > 1) {
    for (let i = 1; i < numbers.length; i++) {
      if (numbers[i] > salePrice) {
        originalPrice = numbers[i];
        break;
      }
    }
  }

  if (originalPrice === 0) {
    const offMatch = title.match(/\$(\d+(?:,\d{3})*(?:\.\d{1,2})?)\s*(?:off|discount|savings)/i);
    if (offMatch) {
      const offVal = parseFloat(offMatch[1].replace('$', '').replace(/,/g, ''));
      if (offVal > 0 && offVal < salePrice * 2) {
        originalPrice = salePrice + offVal;
      }
    }
  }

  let discountPercentage = 0;
  if (originalPrice > salePrice) {
    discountPercentage = Math.round(((originalPrice - salePrice) / originalPrice) * 100);
  } else {
    originalPrice = 0;
  }

  return { salePrice, originalPrice, discountPercentage };
}

function isRelevantToCategory(title, category, query) {
  const titleLower = title.toLowerCase();
  const qLower = (query || '').toLowerCase();

  if (GLOBAL_NON_HARDWARE_KEYWORDS.some(k => titleLower.includes(k))) return false;

  if (category === 'gaming_pcs' || qLower.includes('gaming pc') || qLower.includes('prebuilt') || qLower.includes('desktop')) {
    if (titleLower.includes('laptop') || titleLower.includes('macbook') || titleLower.includes('notebook') || titleLower.includes('[laptop]')) return false;
    if (STANDALONE_PERIPHERAL_KEYWORDS.some(k => titleLower.includes(k))) return false;
    if (titleLower.includes('[ssd') || titleLower.includes('[cpu]') || titleLower.includes('[gpu]') || titleLower.includes('[motherboard]') || titleLower.includes('[ram]')) return false;
    return /\[prebuilt\]|desktop|prebuilt|gaming pc|gaming rig|tower|cyberpower|skytech|powerspec|omen|legion tower|abs|ibuypower|msi|rog|yeyian|lenovo tower/i.test(title);
  }

  if (category === 'laptops' || qLower.includes('laptop') || qLower.includes('macbook')) {
    const isAccessory = LAPTOP_EXCLUSION_KEYWORDS.some(k => titleLower.includes(k));
    const hasLaptopSpec = /i[3579]|ryzen|rtx|gtx|gb|ssd|oled|macbook|chromebook|thinkpad|zenbook|legion|zephyrus|g14|g16|swift|gram|vivobook|omnibook/i.test(title);
    if (isAccessory && !hasLaptopSpec) return false;
    return /laptop|macbook|chromebook|notebook|vivobook|zenbook|thinkpad|zephyrus|g14|g16|gram|swift|legion 5|legion 7/i.test(title);
  }

  if (category === 'vacuums' || qLower.includes('vacuum')) {
    if (VACUUM_EXCLUSION_KEYWORDS.some(k => titleLower.includes(k))) return false;
    return /vacuum|vac|roborock|roomba|dyson|dreame|shark|eufy|tineco|bissel/i.test(title);
  }

  if (category === 'tvs') {
    if (titleLower.includes('mount') || titleLower.includes('cable') || titleLower.includes('stand') || titleLower.includes('arm')) return false;
    return /\btv\b|oled|qled|uhd|smart tv|monitor|curved monitor|gaming monitor|display|\binch\b.*monitor|hz.*monitor/i.test(title);
  }

  if (category === 'consoles') {
    if (titleLower.includes('gaming pc') || titleLower.includes('prebuilt') || titleLower.includes('gpu') || titleLower.includes('graphics card')) return false;
    return /\bps5\b|\bps4\b|xbox|nintendo|switch|game|\bsnes\b|\bnes\b|\bn64\b|\bgba\b|\bgamecube\b|playstation|console|controller|\bsteam deck\b|\bvr\b|meta quest|\bpsvr\b/i.test(title);
  }

  if (category === 'appliances' || qLower.includes('appliance')) {
    if (APPLIANCE_EXCLUSION_KEYWORDS.some(k => titleLower.includes(k))) return false;
    return /refrigerator|fridge|freezer|washer|washing machine|dryer|laundry tower|dishwasher|electric range|gas range|cooktop|wall oven|over-the-range microwave|microwave/i.test(title);
  }

  return true;
}

async function fetchSlickdeals(query, category, includeArchive = false) {
  try {
    let searchQueries = ['deals'];
    if (category === 'gaming_pcs') searchQueries = ['gaming desktop'];
    else if (category === 'laptops') searchQueries = ['laptop', 'macbook'];
    else if (category === 'vacuums') searchQueries = ['vacuum'];
    else if (category === 'tvs') searchQueries = ['oled tv', 'gaming monitor', '4k monitor'];
    else if (category === 'consoles') searchQueries = ['ps5', 'xbox', 'nintendo switch', 'video game'];
    else if (category === 'appliances') searchQueries = ['refrigerator', 'washer dryer', 'dishwasher', 'electric range'];
    else if (query && !query.includes('&')) searchQueries = [query];

    let rawXml = '';
    for (const sq of searchQueries) {
      const searchUrl = `https://slickdeals.net/newsearch.php?mode=popdeals&searchmode=4&q=${encodeURIComponent(sq)}&rss=1`;
      try {
        const res = await fetch(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0 DealCraftServer/1.0' } });
        if (res.ok) rawXml += await res.text();
      } catch (e) {}
    }

    const itemMatches = rawXml.match(/<item>[\s\S]*?<\/item>/g) || [];
    const deals = [];
    const now = new Date();
    const maxHours = includeArchive ? 168 : 96;
    const minPrice = category === 'appliances' ? 90 : 5;

    for (let i = 0; i < itemMatches.length; i++) {
      const item = itemMatches[i];
      const titleMatch = item.match(/<title>(.*?)<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      const pubDateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      const descMatch = item.match(/<description>(.*?)<\/description>/);
      const scoreMatch = item.match(/Thumb Score:\s*([+-]?\d+)/i);

      if (!titleMatch || !linkMatch) continue;

      let title = titleMatch[1].replace(/<!\[CDATA\[/g, '').replace(/\]\]>/g, '').replace(/&amp;/g, '&').trim();
      let link = linkMatch[1].replace(/&amp;/g, '&').trim();
      let desc = descMatch ? descMatch[1] : '';
      const titleLower = title.toLowerCase();
      const descLower = desc.toLowerCase();

      if (titleLower.includes('expired') || titleLower.includes('dead deal') || titleLower.includes('sold out') || titleLower.includes('out of stock') || descLower.includes('expired') || descLower.includes('dead deal') || descLower.includes('sold out')) continue;

      let timeAgoText = 'Active Hot Deal';
      let hoursOld = 0;
      if (pubDateMatch) {
        const pubDate = new Date(pubDateMatch[1]);
        const diffMs = now.getTime() - pubDate.getTime();
        hoursOld = Math.max(1, Math.round(diffMs / (1000 * 3600)));
        if (hoursOld > maxHours) continue;
        timeAgoText = hoursOld > 24 ? `${Math.round(hoursOld / 24)}d ago` : `${hoursOld}h ago`;
      }

      if (!isRelevantToCategory(title, category, query)) continue;

      const { salePrice, originalPrice, discountPercentage } = parseExplicitPricesFromTitle(title);
      if (!salePrice || salePrice < minPrice) continue;

      const store = detectStoreName(item, title, link);
      const productName = title.split('-')[0].replace(/\[.*?\]/g, '').trim() || title.slice(0, 45);
      let realUpvotes = scoreMatch ? Math.max(0, parseInt(scoreMatch[1], 10)) : undefined;

      deals.push({
        id: `sd_${i}`,
        title,
        productName,
        store,
        originalPrice,
        salePrice,
        discountPercentage,
        url: link,
        redditThreadUrl: link,
        source: 'Slickdeals Active Deal',
        upvotes: realUpvotes,
        postedTimeAgo: timeAgoText,
        isArchive: hoursOld > 96,
        isHot: (realUpvotes && realUpvotes > 20) || discountPercentage > 15
      });
    }

    return deals;
  } catch (err) {
    return [];
  }
}

async function fetchRedditSubreddit(subreddit, query, category) {
  try {
    const rssUrl = `https://www.reddit.com/r/${subreddit}/.rss`;
    const res = await fetch(rssUrl, {
      headers: { 'User-Agent': 'facebookexternalhit/1.1' }
    });
    if (!res.ok) return [];
    const xml = await res.text();

    const entryMatches = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    const deals = [];
    const maxEntriesToProcess = Math.min(15, entryMatches.length);

    for (let idx = 0; idx < maxEntriesToProcess; idx++) {
      const entry = entryMatches[idx];
      const rawTitle = (entry.match(/<title>(.*?)<\/title>/) || [])[1] || '';
      const cleanTitle = rawTitle.replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const titleLower = cleanTitle.toLowerCase();

      if (titleLower.includes('weekly request') || titleLower.includes('meta') || titleLower.includes('announcement') || titleLower.includes('expired') || titleLower.includes('out of stock') || titleLower.includes('dead deal')) continue;
      if (!isRelevantToCategory(cleanTitle, category, query)) continue;

      const { salePrice, originalPrice, discountPercentage } = parseExplicitPricesFromTitle(cleanTitle);
      const minPrice = category === 'appliances' ? 90 : 10;
      if (!salePrice || salePrice < minPrice) continue;

      const threadMatch = entry.match(/<link href="(https:\/\/www\.reddit\.com\/r\/[^"]+)"/);
      const threadUrl = threadMatch ? threadMatch[1] : `https://www.reddit.com/r/${subreddit}/`;

      const store = detectStoreName(entry, cleanTitle, threadUrl);
      const productName = cleanTitle.split('-')[0].replace(/\[.*?\]/g, '').trim() || cleanTitle.slice(0, 45);

      deals.push({
        id: `reddit_${subreddit}_${idx}`,
        title: cleanTitle,
        productName,
        store,
        originalPrice,
        salePrice,
        discountPercentage,
        url: threadUrl,
        redditThreadUrl: threadUrl,
        source: `Reddit r/${subreddit}`,
        upvotes: undefined,
        postedTimeAgo: 'Recent Post',
        isArchive: false,
        isHot: discountPercentage > 15
      });
    }

    return deals;
  } catch (err) {
    return [];
  }
}

async function handleDealsRequest(request) {
  const url = new URL(request.url);
  const query = url.searchParams.get('q') || 'gaming pc';
  const category = url.searchParams.get('category') || 'gaming_pcs';
  const includeArchive = url.searchParams.get('includeArchive') === 'true';

  const slickdealsResults = await fetchSlickdeals(query, category, includeArchive);

  let targetSubreddits = SUBREDDIT_MAP[category] || SUBREDDIT_MAP.default;

  let redditResults = [];
  for (const sub of targetSubreddits) {
    const deals = await fetchRedditSubreddit(sub, query, category);
    redditResults = redditResults.concat(deals);
  }

  const combined = [...slickdealsResults, ...redditResults];
  const seen = new Set();
  const uniqueDeals = combined.filter(d => {
    const normKey = d.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 45);
    if (seen.has(normKey)) return false;
    seen.add(normKey);
    return true;
  });

  return new Response(JSON.stringify({
    query,
    category,
    includeArchive,
    count: uniqueDeals.length,
    deals: uniqueDeals
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

export async function onRequest(context) {
  return handleDealsRequest(context.request);
}

export async function onRequestGet(context) {
  return handleDealsRequest(context.request);
}
