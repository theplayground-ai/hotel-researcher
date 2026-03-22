const express = require('express');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');
const multer = require('multer');

const {
  quickScan, deepResearch, startJob, getJob, findRegion,
  readJSON, writeJSON, isDuplicate, REGIONS, DISCOVERED_FILE: DISC_PATH, HOTELS_FILE
} = require('./research/research');

const SEEDS_FILE = path.join(__dirname, 'research', 'mexico-seeds.json');
let seedsData = {};
try { seedsData = JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf8')); } catch {};

const app = express();
const PORT = 5555;
const DATA_FILE = path.join(__dirname, 'hotels.json');
const DISCOVERED_FILE = path.join(__dirname, 'data', 'discovered.json');
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());

// --- Demo Mode Middleware ---
// When DEMO_MODE=true, all write operations (POST/PUT/DELETE) return success without saving
const DEMO_MODE = process.env.DEMO_MODE === 'true';

if (DEMO_MODE) {
  console.log('🎭 Running in DEMO MODE - all changes are sandboxed (nothing saves)');
}

function demoGuard(req, res, next) {
  if (DEMO_MODE && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) {
    // Return a fake success response so the UI behaves normally
    return res.json({ success: true, demo: true, message: 'Demo mode - changes not saved' });
  }
  next();
}

// Apply demo guard to all /api routes
app.use('/api', demoGuard);

// Ensure data dir exists
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}
if (!fs.existsSync(DISCOVERED_FILE)) {
  fs.writeFileSync(DISCOVERED_FILE, '[]');
}

// --- Pexels Image System ---

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

// --- Helpers ---

function readHotels() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  return JSON.parse(raw);
}

function writeHotels(hotels) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(hotels, null, 2));
}

function parsePriceMin(priceStr) {
  if (!priceStr) return 0;
  const match = priceStr.replace(/,/g, '').match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

// --- Hotel CRUD Routes ---

// GET /api/hotels - list all with optional filters
app.get('/api/hotels', (req, res) => {
  let hotels = readHotels();
  const { region, minPrice, maxPrice, minRating, maxRating, search } = req.query;

  if (region) {
    hotels = hotels.filter(h => h.region.toLowerCase() === region.toLowerCase());
  }
  if (minPrice) {
    hotels = hotels.filter(h => parsePriceMin(h.avgPricePerNight) >= parseInt(minPrice, 10));
  }
  if (maxPrice) {
    hotels = hotels.filter(h => parsePriceMin(h.avgPricePerNight) <= parseInt(maxPrice, 10));
  }
  if (minRating) {
    hotels = hotels.filter(h => h.rating >= parseFloat(minRating));
  }
  if (maxRating) {
    hotels = hotels.filter(h => h.rating <= parseFloat(maxRating));
  }
  if (search) {
    const q = search.toLowerCase();
    hotels = hotels.filter(h =>
      h.name.toLowerCase().includes(q) ||
      h.location.toLowerCase().includes(q) ||
      (h.notes && h.notes.toLowerCase().includes(q))
    );
  }

  res.json({ count: hotels.length, hotels });
});

// POST /api/hotels - add a hotel
app.post('/api/hotels', (req, res) => {
  const hotels = readHotels();
  const now = new Date().toISOString();
  const hotel = {
    id: uuidv4(),
    name: req.body.name || '',
    website: req.body.website || '',
    location: req.body.location || '',
    region: req.body.region || '',
    avgPricePerNight: req.body.avgPricePerNight || '',
    address: req.body.address || '',
    phone: req.body.phone || '',
    email: req.body.email || '',
    instagram: req.body.instagram || '',
    rating: req.body.rating || 0,
    contactPerson: req.body.contactPerson || '',
    contactPosition: req.body.contactPosition || '',
    contactLinkedIn: req.body.contactLinkedIn || '',
    contactEmail: req.body.contactEmail || '',
    imageUrl: req.body.imageUrl || getPexelsUrl(req.body.name),
    outreach: {
      contacted: false,
      responded: false,
      approved: false,
      bookedDates: ''
    },
    notes: req.body.notes || '',
    createdAt: now,
    updatedAt: now
  };

  hotels.push(hotel);
  writeHotels(hotels);
  res.status(201).json(hotel);
});

// POST /api/hotels/:id/image - manually set hotel image
app.post('/api/hotels/:id/image', (req, res) => {
  const hotels = readHotels();
  const idx = hotels.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Hotel not found' });

  hotels[idx].imageUrl = req.body.imageUrl || '';
  hotels[idx].updatedAt = new Date().toISOString();
  writeHotels(hotels);
  res.json({ message: 'Image updated', hotel: hotels[idx] });
});

// PUT /api/hotels/:id - update a hotel
app.put('/api/hotels/:id', (req, res) => {
  const hotels = readHotels();
  const idx = hotels.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Hotel not found' });

  const updated = { ...hotels[idx], ...req.body, id: hotels[idx].id, updatedAt: new Date().toISOString() };
  if (req.body.outreach) {
    updated.outreach = { ...hotels[idx].outreach, ...req.body.outreach };
  }
  hotels[idx] = updated;
  writeHotels(hotels);
  res.json(updated);
});

// DELETE /api/hotels/:id - delete a hotel
app.delete('/api/hotels/:id', (req, res) => {
  let hotels = readHotels();
  const idx = hotels.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Hotel not found' });

  const removed = hotels.splice(idx, 1)[0];
  writeHotels(hotels);
  res.json({ message: 'Hotel deleted', hotel: removed });
});

// POST /api/hotels/import - import CSV
app.post('/api/hotels/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded. Send CSV as multipart field "file".' });

  try {
    const records = parse(req.file.buffer.toString(), { columns: true, skip_empty_lines: true, trim: true });
    const hotels = readHotels();
    const now = new Date().toISOString();
    let imported = 0;

    for (const row of records) {
      const hotel = {
        id: uuidv4(),
        name: row.name || '',
        website: row.website || '',
        location: row.location || '',
        region: row.region || '',
        avgPricePerNight: row.avgPricePerNight || '',
        address: row.address || '',
        phone: row.phone || '',
        email: row.email || '',
        instagram: row.instagram || '',
        rating: parseFloat(row.rating) || 0,
        contactPerson: row.contactPerson || '',
        contactPosition: row.contactPosition || '',
        contactLinkedIn: row.contactLinkedIn || '',
        contactEmail: row.contactEmail || '',
        imageUrl: row.imageUrl || getPexelsUrl(row.name),
        outreach: {
          contacted: row['outreach.contacted'] === 'true',
          responded: row['outreach.responded'] === 'true',
          approved: row['outreach.approved'] === 'true',
          bookedDates: row['outreach.bookedDates'] || ''
        },
        notes: row.notes || '',
        createdAt: now,
        updatedAt: now
      };
      hotels.push(hotel);
      imported++;
    }

    writeHotels(hotels);
    res.json({ message: `Imported ${imported} hotels`, total: hotels.length });
  } catch (err) {
    res.status(400).json({ error: 'Failed to parse CSV', details: err.message });
  }
});

// GET /api/hotels/export - export to CSV
app.get('/api/hotels/export', (req, res) => {
  const hotels = readHotels();
  const flat = hotels.map(h => ({
    id: h.id,
    name: h.name,
    website: h.website,
    location: h.location,
    region: h.region,
    avgPricePerNight: h.avgPricePerNight,
    address: h.address,
    phone: h.phone,
    email: h.email,
    instagram: h.instagram,
    rating: h.rating,
    contactPerson: h.contactPerson,
    contactPosition: h.contactPosition,
    contactLinkedIn: h.contactLinkedIn,
    contactEmail: h.contactEmail,
    imageUrl: h.imageUrl || '',
    'outreach.contacted': h.outreach?.contacted || false,
    'outreach.responded': h.outreach?.responded || false,
    'outreach.approved': h.outreach?.approved || false,
    'outreach.bookedDates': h.outreach?.bookedDates || '',
    notes: h.notes,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt
  }));

  const csv = stringify(flat, { header: true });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=hotels-export.csv');
  res.send(csv);
});

// POST /api/hotels/:id/outreach - update outreach status
app.post('/api/hotels/:id/outreach', (req, res) => {
  const hotels = readHotels();
  const idx = hotels.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Hotel not found' });

  hotels[idx].outreach = { ...hotels[idx].outreach, ...req.body };
  hotels[idx].updatedAt = new Date().toISOString();
  writeHotels(hotels);
  res.json({ message: 'Outreach updated', hotel: hotels[idx] });
});

// GET /api/stats - dashboard stats
app.get('/api/stats', (req, res) => {
  const hotels = readHotels();
  const total = hotels.length;
  const contacted = hotels.filter(h => h.outreach?.contacted).length;
  const responded = hotels.filter(h => h.outreach?.responded).length;
  const approved = hotels.filter(h => h.outreach?.approved).length;

  const prices = hotels.map(h => parsePriceMin(h.avgPricePerNight)).filter(p => p > 0);
  const avgPrice = prices.length > 0 ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length) : 0;
  const avgRating = total > 0 ? +(hotels.reduce((a, h) => a + (h.rating || 0), 0) / total).toFixed(1) : 0;

  const regions = {};
  hotels.forEach(h => {
    regions[h.region] = (regions[h.region] || 0) + 1;
  });

  // Count total researched: seeds + discovered + dashboard
  let totalResearched = total;
  try {
    for (const [, arr] of Object.entries(seedsData)) {
      if (Array.isArray(arr)) totalResearched += arr.length;
    }
    const discovered = readJSON(DISCOVERED_FILE);
    if (Array.isArray(discovered)) totalResearched += discovered.length;
  } catch {}

  res.json({
    total,
    totalResearched,
    contacted,
    responded,
    approved,
    avgPrice: `$${avgPrice}`,
    avgRating,
    regions
  });
});

// GET /api/hotels/:id - single hotel
app.get('/api/hotels/:id', (req, res) => {
  const hotels = readHotels();
  const hotel = hotels.find(h => h.id === req.params.id);
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
  res.json(hotel);
});

// GET /api/hotels/:id/timeline - outreach history
app.get('/api/hotels/:id/timeline', (req, res) => {
  const hotels = readHotels();
  const hotel = hotels.find(h => h.id === req.params.id);
  if (!hotel) return res.status(404).json({ error: 'Hotel not found' });
  res.json(hotel.timeline || []);
});

// POST /api/hotels/:id/timeline - add timeline entry
app.post('/api/hotels/:id/timeline', (req, res) => {
  const hotels = readHotels();
  const idx = hotels.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Hotel not found' });

  const entry = {
    id: uuidv4(),
    action: req.body.action || '',
    note: req.body.note || '',
    date: req.body.date || new Date().toISOString()
  };

  if (!hotels[idx].timeline) hotels[idx].timeline = [];
  hotels[idx].timeline.unshift(entry);
  hotels[idx].updatedAt = new Date().toISOString();
  writeHotels(hotels);
  res.status(201).json(entry);
});

// --- Research Engine Routes ---

// GET /api/regions - list pre-configured regions (only those with seed data)
app.get('/api/regions', (req, res) => {
  const regionsWithSeeds = REGIONS.filter(r => seedsData[r.id] && seedsData[r.id].length > 0);
  res.json(regionsWithSeeds.map(r => ({ id: r.id, name: r.name, state: r.state })));
});

// GET /api/research/seeds/:region - return pre-seeded hotels instantly
app.get('/api/research/seeds/:region', (req, res) => {
  const regionObj = findRegion(req.params.region);
  const regionKey = regionObj ? regionObj.id : req.params.region.toLowerCase().replace(/[^a-z0-9\-]/g, '');

  // Try region id first, then direct key match, then partial name match
  let seeds = (regionObj && seedsData[regionObj.id]) || seedsData[regionKey] || null;
  if (!seeds) {
    const search = req.params.region.toLowerCase();
    for (const [key, val] of Object.entries(seedsData)) {
      if (search.includes(key) || key.includes(search.replace(/[^a-z]/g, ''))) {
        seeds = val;
        break;
      }
    }
  }

  if (!seeds || seeds.length === 0) {
    return res.json({ count: 0, hotels: [], region: req.params.region });
  }

  // Deduplicate seeds against existing dashboard hotels
  const existing = readHotels();
  const filtered = seeds.filter(s => !isDuplicate(s, existing));

  // Format with IDs for the frontend
  const now = new Date().toISOString();
  const formatted = filtered.map(s => ({
    id: 'seed-' + require('uuid').v4().slice(0, 8),
    ...s,
    imageUrl: s.imageUrl || getPexelsUrl(s.name),
    status: 'seed',
    source: 'pre-researched',
    discoveredAt: now,
    createdAt: now,
    updatedAt: now
  }));

  res.json({ count: formatted.length, hotels: formatted, region: req.params.region });
});

// POST /api/research - start async deep research job
app.post('/api/research', (req, res) => {
  const { region, luxuryOnly } = req.body;
  if (!region) return res.status(400).json({ error: 'Region is required' });

  const jobId = startJob(region, 'deep', luxuryOnly !== false);
  res.json({ status: 'researching', jobId, message: `Deep research started for ${region}` });
});

// GET /api/research/:jobId - poll job status
app.get('/api/research/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    jobId: job.id,
    status: job.status,
    region: job.region,
    progress: job.progress,
    count: job.hotels.length,
    hotels: job.status === 'complete' || job.status === 'error' ? job.hotels : [],
    duplicates: job.status === 'complete' ? job.duplicates : [],
    error: job.error,
    startedAt: job.startedAt,
    completedAt: job.completedAt
  });
});

// POST /api/research/quick - synchronous Overpass-only scan
app.post('/api/research/quick', async (req, res) => {
  const { region } = req.body;
  if (!region) return res.status(400).json({ error: 'Region is required' });

  try {
    const progress = [];
    const result = await quickScan(region, (msg) => progress.push(msg));
    res.json({
      status: 'complete',
      region,
      count: result.hotels.length,
      hotels: result.hotels,
      duplicates: result.duplicates,
      progress
    });
  } catch (err) {
    res.status(500).json({ error: 'Quick scan failed: ' + err.message });
  }
});

// POST /api/hotels/discover - bulk add discovered hotels
app.post('/api/hotels/discover', (req, res) => {
  const { hotels: incoming } = req.body;
  if (!incoming || !Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Provide { hotels: [...] }' });
  }

  const mainHotels = readHotels();
  const now = new Date().toISOString();
  const added = [];

  for (const h of incoming) {
    // Skip duplicates
    if (isDuplicate(h, mainHotels)) continue;

    const hotel = {
      id: uuidv4(),
      name: h.name || '',
      website: h.website || '',
      location: h.location || '',
      region: h.region || '',
      avgPricePerNight: h.avgPricePerNight || '',
      address: h.address || '',
      phone: h.phone || '',
      email: h.email || '',
      instagram: h.instagram || '',
      rating: h.rating || 0,
      contactPerson: h.contactPerson || '',
      contactPosition: h.contactPosition || '',
      contactLinkedIn: h.contactLinkedIn || '',
      contactEmail: h.contactEmail || '',
      imageUrl: h.imageUrl || getPexelsUrl(h.name),
      outreach: { contacted: false, responded: false, approved: false, bookedDates: '' },
      notes: h.notes || `Discovered via research engine on ${now}`,
      createdAt: now,
      updatedAt: now
    };
    mainHotels.push(hotel);
    added.push(hotel);
  }

  writeHotels(mainHotels);
  res.json({ message: `Added ${added.length} hotels to dashboard`, added: added.length, total: mainHotels.length });
});

// GET /api/research/pending - list all discovered hotels pending review
app.get('/api/research/pending', (req, res) => {
  const discovered = readJSON(DISCOVERED_FILE);
  const pending = discovered.filter(h => h.status === 'discovered');
  res.json({ count: pending.length, hotels: pending });
});

// POST /api/research/approve/:id - move discovered hotel to main database
app.post('/api/research/approve/:id', (req, res) => {
  const discovered = readJSON(DISCOVERED_FILE);
  const idx = discovered.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Discovered hotel not found' });

  const hotel = discovered[idx];

  const mainHotel = {
    id: uuidv4(),
    name: hotel.name,
    website: hotel.website,
    location: hotel.location,
    region: hotel.region,
    avgPricePerNight: hotel.avgPricePerNight,
    address: hotel.address,
    phone: hotel.phone,
    email: hotel.email,
    instagram: hotel.instagram,
    rating: hotel.rating,
    contactPerson: hotel.contactPerson || '',
    contactPosition: hotel.contactPosition || '',
    contactLinkedIn: hotel.contactLinkedIn || '',
    contactEmail: hotel.contactEmail || '',
    imageUrl: hotel.imageUrl || getPexelsUrl(hotel.name),
    outreach: { contacted: false, responded: false, approved: false, bookedDates: '' },
    notes: hotel.notes || `Discovered via research engine on ${hotel.discoveredAt || 'unknown date'}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const hotels = readHotels();
  hotels.push(mainHotel);
  writeHotels(hotels);

  discovered[idx].status = 'approved';
  writeJSON(DISCOVERED_FILE, discovered);

  res.json({ message: 'Hotel added to dashboard', hotel: mainHotel });
});

// POST /api/research/dismiss/:id - dismiss a discovered hotel
app.post('/api/research/dismiss/:id', (req, res) => {
  const discovered = readJSON(DISCOVERED_FILE);
  const idx = discovered.findIndex(h => h.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Discovered hotel not found' });

  discovered[idx].status = 'dismissed';
  writeJSON(DISCOVERED_FILE, discovered);
  res.json({ message: 'Hotel dismissed' });
});

// --- Static files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Start ---

app.listen(PORT, () => {
  console.log(`Hotel Researcher API running on http://localhost:${PORT}`);
  console.log(`${readHotels().length} hotels loaded`);
  console.log(`${REGIONS.length} Mexican regions configured`);
});
