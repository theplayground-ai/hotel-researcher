#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const HOTELS_FILE = path.join(__dirname, '..', 'hotels.json');
const TIMEOUT_MS = 3000;

function readHotels() {
  return JSON.parse(fs.readFileSync(HOTELS_FILE, 'utf8'));
}

function writeHotels(hotels) {
  fs.writeFileSync(HOTELS_FILE, JSON.stringify(hotels, null, 2));
}

function normalizeUrl(website) {
  if (!website) return null;
  let url = website.trim();
  if (!url.startsWith('http')) url = 'https://' + url;
  return url;
}

function generateUnsplashUrl(hotel) {
  const location = (hotel.location || hotel.region || 'luxury').replace(/\s+/g, '+');
  return 'https://source.unsplash.com/600x400/?luxury+hotel+' + encodeURIComponent(location);
}

async function fetchWithTimeout(url, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      },
      redirect: 'follow'
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

function extractImageUrl(html, baseUrl) {
  const $ = cheerio.load(html);

  // 1. Try og:image meta tag
  const ogImage = $('meta[property="og:image"]').attr('content')
    || $('meta[name="og:image"]').attr('content');
  if (ogImage) return resolveUrl(ogImage, baseUrl);

  // 2. Try twitter:image
  const twitterImage = $('meta[name="twitter:image"]').attr('content')
    || $('meta[property="twitter:image"]').attr('content');
  if (twitterImage) return resolveUrl(twitterImage, baseUrl);

  // 3. Look for hero/banner/header images
  const heroPatterns = ['hero', 'banner', 'header', 'masthead', 'cover'];
  for (const pattern of heroPatterns) {
    const img = $('img').filter((_, el) => {
      const src = $(el).attr('src') || '';
      const cls = $(el).attr('class') || '';
      const id = $(el).attr('id') || '';
      const alt = $(el).attr('alt') || '';
      return src.toLowerCase().includes(pattern)
        || cls.toLowerCase().includes(pattern)
        || id.toLowerCase().includes(pattern)
        || alt.toLowerCase().includes(pattern);
    }).first();
    const src = img.attr('src') || img.attr('data-src');
    if (src) return resolveUrl(src, baseUrl);
  }

  // 4. Look for background images in style attributes
  const bgEl = $('[style*="background-image"]').first();
  if (bgEl.length) {
    const style = bgEl.attr('style') || '';
    const match = style.match(/url\(['"]?([^'")\s]+)['"]?\)/);
    if (match) return resolveUrl(match[1], baseUrl);
  }

  // 5. First large image (width attribute > 400 or no width specified and looks like a photo)
  const firstLargeImg = $('img').filter((_, el) => {
    const width = parseInt($(el).attr('width') || '0', 10);
    const src = $(el).attr('src') || '';
    if (width > 400) return true;
    // Skip tiny icons, logos, spacers
    if (src.includes('logo') || src.includes('icon') || src.includes('spacer') || src.includes('pixel')) return false;
    if (src.endsWith('.svg') || src.endsWith('.gif')) return false;
    // Accept if no width is specified (likely a full-width image)
    if (!$(el).attr('width') && (src.endsWith('.jpg') || src.endsWith('.jpeg') || src.endsWith('.png') || src.endsWith('.webp'))) return true;
    return false;
  }).first();
  const largeSrc = firstLargeImg.attr('src') || firstLargeImg.attr('data-src');
  if (largeSrc) return resolveUrl(largeSrc, baseUrl);

  return null;
}

function resolveUrl(src, baseUrl) {
  if (!src) return null;
  if (src.startsWith('//')) return 'https:' + src;
  if (src.startsWith('http')) return src;
  try {
    return new URL(src, baseUrl).href;
  } catch {
    return src;
  }
}

async function main() {
  const hotels = readHotels();
  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  let unsplash = 0;

  console.log(`Processing ${hotels.length} hotels...\n`);

  for (const hotel of hotels) {
    // Skip if already has an image
    if (hotel.imageUrl) {
      console.log(`  [SKIP] ${hotel.name} - already has image`);
      skipped++;
      continue;
    }

    const url = normalizeUrl(hotel.website);
    if (url) {
      console.log(`  [FETCH] ${hotel.name} - ${url}`);
      const html = await fetchWithTimeout(url, TIMEOUT_MS);
      if (html) {
        const imageUrl = extractImageUrl(html, url);
        if (imageUrl) {
          hotel.imageUrl = imageUrl;
          hotel.updatedAt = new Date().toISOString();
          console.log(`    -> Found: ${imageUrl.substring(0, 80)}...`);
          fetched++;
          continue;
        }
      }
      console.log(`    -> No image found, using Unsplash fallback`);
    } else {
      console.log(`  [NO WEBSITE] ${hotel.name} - using Unsplash fallback`);
    }

    // Fallback: Unsplash
    hotel.imageUrl = generateUnsplashUrl(hotel);
    hotel.updatedAt = new Date().toISOString();
    unsplash++;
  }

  writeHotels(hotels);

  console.log(`\nDone!`);
  console.log(`  Fetched from websites: ${fetched}`);
  console.log(`  Unsplash fallbacks: ${unsplash}`);
  console.log(`  Skipped (already had image): ${skipped}`);
  console.log(`  Total hotels: ${hotels.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
