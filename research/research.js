/**
 * Hotel Research Engine v2
 * Discovers luxury hotels using Overpass API (OpenStreetMap), website scraping (cheerio),
 * and DuckDuckGo fallback. All free, no paid APIs.
 *
 * Usage (CLI):  node research/research.js "Tulum"
 * Usage (API):  require('./research/research').quickScan("Tulum")
 *                                             .deepResearch("Tulum")
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const cheerio = require('cheerio');

const REGIONS = require('./regions.json');
const DISCOVERED_FILE = path.join(__dirname, '..', 'data', 'discovered.json');
const HOTELS_FILE = path.join(__dirname, '..', 'hotels.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const PEXELS_IDS = [
  261102, 338504, 189296, 258154, 1134176,
  2507010, 2034335, 1268871, 2373201, 1457842,
  2029722, 3155666, 2462015, 1743231, 2417842,
  2029731, 3225531, 2404843, 1488327, 2096983
];

function getPexelsUrl(hotelName) {
  let hash = 0;
  const name = (hotelName || '').toLowerCase();
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash = hash & hash;
  }
  const idx = Math.abs(hash) % PEXELS_IDS.length;
  const id = PEXELS_IDS[idx];
  return `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&w=800`;
}

// --------------- helpers ---------------

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return []; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function findRegion(query) {
  const q = query.toLowerCase().trim();
  return REGIONS.find(r =>
    r.id === q ||
    r.name.toLowerCase() === q ||
    r.searchTerms.some(t => t.toLowerCase() === q)
  );
}

// --------------- Overpass API (OpenStreetMap) ---------------

function buildOverpassQuery(region) {
  const r = findRegion(region);
  if (!r) {
    // Fallback: use bbox search if region not pre-configured
    return null;
  }

  const [west, south, east, north] = r.bbox;

  return `[out:json][timeout:30];
(
  nwr["tourism"="hotel"]["stars"~"4|5"](${south},${west},${north},${east});
  nwr["tourism"="hotel"]["name"~"Resort|Luxury|Boutique|Grand|Premium|Spa",i](${south},${west},${north},${east});
  nwr["tourism"="resort"](${south},${west},${north},${east});
);
out body center;`;
}

async function queryOverpass(region, retried = false) {
  const query = buildOverpassQuery(region);
  if (!query) {
    console.log('  No pre-configured region found, using DuckDuckGo only');
    return [];
  }

  try {
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query)
    });

    if (res.status === 429) {
      if (!retried) {
        console.log('  Overpass rate-limited, waiting 10 seconds...');
        await sleep(10000);
        return queryOverpass(region, true);
      }
      console.log('  Overpass still rate-limited, skipping');
      return [];
    }

    if (!res.ok) {
      console.log(`  Overpass returned ${res.status}`);
      return [];
    }

    const data = await res.json();
    const elements = data.elements || [];

    return elements
      .filter(el => el.tags && el.tags.name)
      .map(el => {
        const tags = el.tags;
        const lat = el.center ? el.center.lat : el.lat;
        const lon = el.center ? el.center.lon : el.lon;

        return {
          name: tags.name,
          lat: lat || null,
          lon: lon || null,
          website: tags.website || tags['contact:website'] || '',
          phone: tags.phone || tags['contact:phone'] || '',
          email: tags.email || tags['contact:email'] || '',
          stars: tags.stars || '',
          address: [tags['addr:street'], tags['addr:housenumber'], tags['addr:city'], tags['addr:postcode']]
            .filter(Boolean).join(', ') || '',
          source: 'overpass'
        };
      });
  } catch (err) {
    console.log(`  Overpass error: ${err.message}`);
    return [];
  }
}

// --------------- DuckDuckGo fallback ---------------

async function searchDDG(query) {
  try {
    const url = `https://lite.duckduckgo.com/lite?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow'
    });
    const html = await res.text();
    const $ = cheerio.load(html);

    const results = [];
    $('a.result-link, td a[href*="//"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const title = $(el).text().trim();
      if (href && title && !href.includes('duckduckgo.com')) {
        let cleanUrl = href;
        const uddg = href.match(/uddg=([^&]+)/);
        if (uddg) cleanUrl = decodeURIComponent(uddg[1]);
        results.push({ title, url: cleanUrl });
      }
    });

    return results;
  } catch (err) {
    console.log(`  DuckDuckGo search failed: ${err.message}`);
    return [];
  }
}

async function ddgHotelSearch(region) {
  const regionObj = findRegion(region);
  const searchName = regionObj ? regionObj.name : region;

  const queries = [
    `luxury 5 star hotels ${searchName} Mexico`,
    `best boutique resort ${searchName} Mexico`
  ];

  const all = [];
  for (const q of queries) {
    const results = await searchDDG(q);
    all.push(...results);
    await sleep(1000);
  }

  // Extract hotel names from search results
  const hotels = [];
  const skipDomains = ['youtube.com', 'facebook.com', 'twitter.com', 'pinterest.com', 'wikipedia.org', 'reddit.com', 'duckduckgo.com'];

  for (const r of all) {
    const urlLower = (r.url || '').toLowerCase();
    if (skipDomains.some(d => urlLower.includes(d))) continue;

    let name = r.title
      .replace(/\s*[-|]\s*(TripAdvisor|Booking\.com|Hotels\.com|Expedia|Trivago|Kayak|Google|Tripadvisor).*$/i, '')
      .replace(/\s*[-|]\s*Prices.*$/i, '')
      .replace(/^\d+\s+(Best|Top)\s+/i, '')
      .replace(/\s*\d+\s+Stars?$/i, '')
      .trim();

    if (/^\d+\s+(best|top|luxury)/i.test(name)) continue;
    if (name.length < 3 || name.length > 80) continue;

    let website = '';
    if (!urlLower.includes('tripadvisor.com') && !urlLower.includes('booking.com') && !urlLower.includes('hotels.com')) {
      try { website = new URL(r.url).origin; } catch { website = r.url; }
    }

    hotels.push({ name, website, source: 'duckduckgo' });
  }

  return hotels;
}

// --------------- Website scraper (cheerio) ---------------

async function scrapeWebsite(url) {
  const info = { email: '', phone: '', instagram: '', price: '', description: '', websiteReachable: true };
  if (!url) return { ...info, websiteReachable: false };

  // Normalize URL
  if (!url.startsWith('http')) url = 'https://' + url;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeout);

    if (!res.ok) return { ...info, websiteReachable: false };
    const html = await res.text();
    const $ = cheerio.load(html);

    // Email: mailto links first, then regex
    $('a[href^="mailto:"]').each((_, el) => {
      const email = $(el).attr('href').replace('mailto:', '').split('?')[0].trim();
      if (email && !info.email) {
        if (/reserv|contact|info|book|hello|front|recep/i.test(email)) {
          info.email = email;
        } else if (!info.email) {
          info.email = email;
        }
      }
    });
    if (!info.email) {
      const emailMatch = html.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g);
      if (emailMatch) {
        const valid = emailMatch.filter(e =>
          !e.includes('.png') && !e.includes('.jpg') && !e.includes('.css') &&
          !e.includes('.js') && !e.includes('sentry') && !e.includes('webpack') &&
          !e.includes('example.com') && !e.includes('wixpress')
        );
        const preferred = valid.find(e => /reserv|contact|info|book|hello|front/i.test(e));
        info.email = preferred || valid[0] || '';
      }
    }

    // Instagram
    $('a[href*="instagram.com"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const igMatch = href.match(/instagram\.com\/([a-zA-Z0-9_.]+)/);
      if (igMatch && igMatch[1] !== 'p' && igMatch[1] !== 'explore' && igMatch[1] !== 'reel') {
        info.instagram = '@' + igMatch[1];
      }
    });

    // Phone
    $('a[href^="tel:"]').each((_, el) => {
      if (!info.phone) {
        info.phone = $(el).attr('href').replace('tel:', '').trim();
      }
    });
    if (!info.phone) {
      const phoneMatch = html.match(/(\+\d[\d\s\-().]{7,18}\d)/);
      if (phoneMatch) info.phone = phoneMatch[1].trim();
    }

    // Price
    const pricePatterns = [
      /(?:from|starting|rates?\s*:?\s*)\s*\$\s*([\d,]+)/i,
      /\$\s*([\d,]+)\s*(?:\/?\s*(?:per\s*)?night|USD|usd|MXN|noche)/i,
      /(?:USD|MXN)\s*([\d,]+)\s*(?:\/?\s*night)?/i
    ];
    for (const pat of pricePatterns) {
      const m = html.match(pat);
      if (m) {
        info.price = '$' + m[1].replace(/,/g, '');
        break;
      }
    }

    // Description from meta tags
    const metaDesc = $('meta[name="description"]').attr('content') ||
                     $('meta[property="og:description"]').attr('content') || '';
    info.description = metaDesc.substring(0, 300);

    // Try structured data for address
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        const addr = data.address || (data['@graph'] && data['@graph'].find(i => i.address))?.address;
        if (addr) {
          if (typeof addr === 'string') info.address = addr;
          else info.address = [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean).join(', ');
        }
      } catch {}
    });

  } catch (err) {
    info.websiteReachable = false;
  }

  return info;
}

// --------------- Deduplication ---------------

function isDuplicate(candidate, existingHotels) {
  const candidateName = candidate.name.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const h of existingHotels) {
    const existingName = h.name.toLowerCase().replace(/[^a-z0-9]/g, '');

    // Exact match
    if (candidateName === existingName) return true;

    // Levenshtein distance < 3
    if (candidateName.length > 5 && existingName.length > 5) {
      if (levenshtein(candidateName, existingName) < 3) return true;
    }

    // Same email
    if (candidate.email && h.email && candidate.email.toLowerCase() === h.email.toLowerCase()) return true;
  }

  return false;
}

// --------------- Quick scan (Overpass only) ---------------

async function quickScan(region, onProgress) {
  const log = onProgress || console.log;
  const regionObj = findRegion(region);
  const regionName = regionObj ? regionObj.name : region;
  const stateName = regionObj ? regionObj.state : '';

  log(`Searching OpenStreetMap for hotels in ${regionName}...`);

  let results = await queryOverpass(region);
  log(`Overpass returned ${results.length} hotels`);

  // If fewer than 5, supplement with DuckDuckGo
  if (results.length < 5) {
    log(`Few Overpass results, searching DuckDuckGo...`);
    const ddgResults = await ddgHotelSearch(region);
    log(`DuckDuckGo found ${ddgResults.length} additional candidates`);

    // Merge, avoiding duplicates
    const existingNames = new Set(results.map(r => r.name.toLowerCase().replace(/[^a-z0-9]/g, '')));
    for (const d of ddgResults) {
      const key = d.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!existingNames.has(key)) {
        existingNames.add(key);
        results.push({ ...d, lat: null, lon: null, stars: '', address: '' });
      }
    }
  }

  // Deduplicate against existing database
  const existing = [...readJSON(HOTELS_FILE), ...readJSON(DISCOVERED_FILE)];
  const deduped = [];
  const duplicates = [];

  for (const r of results) {
    if (isDuplicate(r, existing)) {
      duplicates.push({ ...r, isDuplicate: true });
    } else {
      deduped.push(r);
    }
  }

  log(`${deduped.length} new hotels, ${duplicates.length} already in database`);

  // Format as hotel objects
  const now = new Date().toISOString();
  const hotels = deduped.map(r => ({
    id: 'disc-' + uuidv4().slice(0, 8),
    name: r.name,
    website: r.website || '',
    location: regionName,
    region: regionName,
    lat: r.lat || null,
    lon: r.lon || null,
    avgPricePerNight: '',
    address: r.address || '',
    phone: r.phone || '',
    email: r.email || '',
    instagram: '',
    rating: r.stars ? parseInt(r.stars) * 2 : 0,
    contactPerson: '',
    contactPosition: '',
    contactLinkedIn: '',
    contactEmail: '',
    outreach: { contacted: false, responded: false, approved: false, bookedDates: '' },
    notes: '',
    imageUrl: getPexelsUrl(r.name),
    status: 'discovered',
    source: r.source || 'overpass',
    websiteReachable: true,
    discoveredAt: now,
    createdAt: now,
    updatedAt: now
  }));

  const dupeHotels = duplicates.map(r => ({
    id: 'dupe-' + uuidv4().slice(0, 8),
    name: r.name,
    website: r.website || '',
    location: regionName,
    region: regionName,
    lat: r.lat || null,
    lon: r.lon || null,
    isDuplicate: true,
    source: r.source || 'overpass'
  }));

  return { hotels, duplicates: dupeHotels };
}

// --------------- Deep research (Overpass + website scraping) ---------------

async function deepResearch(region, onProgress) {
  const log = onProgress || console.log;

  // Step 1: Quick scan
  const { hotels: quickResults, duplicates } = await quickScan(region, log);

  if (quickResults.length === 0) {
    return { hotels: [], duplicates };
  }

  // Step 2: Scrape each hotel's website
  log(`Scraping ${quickResults.length} hotel websites for details...`);
  const enriched = [];

  for (let i = 0; i < quickResults.length; i++) {
    const hotel = quickResults[i];
    log(`[${i + 1}/${quickResults.length}] Scraping ${hotel.name}...`);

    if (hotel.website) {
      try {
        const scraped = await scrapeWebsite(hotel.website);
        hotel.email = scraped.email || hotel.email;
        hotel.phone = scraped.phone || hotel.phone;
        hotel.instagram = scraped.instagram || hotel.instagram;
        hotel.avgPricePerNight = scraped.price || hotel.avgPricePerNight;
        hotel.websiteReachable = scraped.websiteReachable;
        if (scraped.address) hotel.address = scraped.address;
        if (scraped.description) hotel.notes = scraped.description;
      } catch (err) {
        hotel.websiteReachable = false;
      }
    } else {
      hotel.websiteReachable = false;
    }

    enriched.push(hotel);
    await sleep(300);
  }

  // Save to discovered queue
  const existingDiscovered = readJSON(DISCOVERED_FILE);
  existingDiscovered.push(...enriched);
  writeJSON(DISCOVERED_FILE, existingDiscovered);

  log(`Found ${enriched.length} hotels in ${region}`);

  return { hotels: enriched, duplicates };
}

// --------------- Job management ---------------

const jobs = new Map();

function startJob(region, mode, luxuryOnly) {
  const jobId = 'job-' + uuidv4().slice(0, 8);
  const job = {
    id: jobId,
    region,
    mode,
    status: 'researching',
    progress: [],
    hotels: [],
    duplicates: [],
    error: null,
    startedAt: new Date().toISOString(),
    completedAt: null
  };

  jobs.set(jobId, job);

  const onProgress = (msg) => {
    job.progress.push(msg);
  };

  const fn = mode === 'quick' ? quickScan : deepResearch;

  fn(region, onProgress)
    .then(result => {
      job.hotels = result.hotels;
      job.duplicates = result.duplicates;
      job.status = 'complete';
      job.completedAt = new Date().toISOString();
    })
    .catch(err => {
      job.status = 'error';
      job.error = err.message;
      job.completedAt = new Date().toISOString();
    });

  return jobId;
}

function getJob(jobId) {
  return jobs.get(jobId) || null;
}

// --------------- CLI entry point ---------------

if (require.main === module) {
  const region = process.argv[2];
  if (!region) {
    console.log('Usage: node research/research.js "Tulum"');
    console.log('\nAvailable regions:');
    REGIONS.forEach(r => console.log(`  - ${r.name} (${r.state})`));
    process.exit(1);
  }

  const deep = process.argv.includes('--deep');

  const fn = deep ? deepResearch : quickScan;
  fn(region)
    .then(result => {
      console.log(`\nDiscovered ${result.hotels.length} hotels:`);
      for (const h of result.hotels) {
        console.log(`  - ${h.name} | ${h.website || 'no site'} | ${h.email || 'no email'} | ${h.instagram || 'no IG'}`);
      }
      if (result.duplicates.length > 0) {
        console.log(`\n${result.duplicates.length} duplicates skipped (already in database)`);
      }
    })
    .catch(err => {
      console.error('Research failed:', err.message);
      process.exit(1);
    });
}

module.exports = {
  quickScan,
  deepResearch,
  startJob,
  getJob,
  findRegion,
  readJSON,
  writeJSON,
  isDuplicate,
  REGIONS,
  DISCOVERED_FILE,
  HOTELS_FILE
};
