// Hotel Researcher - Static Demo Data Layer
// Provides localStorage-backed sandbox so each visitor gets isolated state
// No backend required - works on GitHub Pages

(function() {
  'use strict';

  const STORAGE_KEY = 'hotel-researcher-db';
  const VERSION_KEY = 'hotel-researcher-version';
  const DATA_VERSION = '4';

  let _hotels = null;
  let _regions = null;
  let _seeds = null;
  let _ready = false;
  let _readyCallbacks = [];

  // ---------- INIT ----------

  async function init() {
    try {
      // Determine base path for data files
      const basePath = getBasePath();

      const [hotelsRes, regionsRes, seedsRes] = await Promise.all([
        fetch(basePath + 'data/hotels.json'),
        fetch(basePath + 'data/regions.json'),
        fetch(basePath + 'data/seeds.json')
      ]);

      const defaultHotels = await hotelsRes.json();
      _regions = await regionsRes.json();
      _seeds = await seedsRes.json();

      // Check if we need to reset localStorage (new version or first visit)
      const storedVersion = localStorage.getItem(VERSION_KEY);
      if (storedVersion !== DATA_VERSION) {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.setItem(VERSION_KEY, DATA_VERSION);
      }

      // Load from localStorage or initialize from defaults
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        try {
          _hotels = JSON.parse(stored);
        } catch(e) {
          _hotels = JSON.parse(JSON.stringify(defaultHotels));
        }
      } else {
        _hotels = JSON.parse(JSON.stringify(defaultHotels));
      }

      // Normalize: ensure all hotels have required fields
      _hotels.forEach(h => {
        if (!h.outreach) h.outreach = { contacted: false, responded: false, approved: false, bookedDates: '' };
        if (!h.timeline) h.timeline = [];
        if (!h.id) h.id = generateId();
        // Normalize lng/lon
        if (h.lon && !h.lng) h.lng = h.lon;
      });

      _save();
      _ready = true;
      _readyCallbacks.forEach(cb => cb());
      _readyCallbacks = [];
    } catch(e) {
      console.error('HotelDB init failed:', e);
      // Fallback: empty data
      _hotels = [];
      _regions = [];
      _seeds = {};
      _ready = true;
      _readyCallbacks.forEach(cb => cb());
      _readyCallbacks = [];
    }
  }

  function getBasePath() {
    // Handle both local dev and GitHub Pages
    const path = window.location.pathname;
    const lastSlash = path.lastIndexOf('/');
    return path.substring(0, lastSlash + 1);
  }

  function generateId() {
    return 'h-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 8);
  }

  function _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(_hotels));
    } catch(e) {
      console.warn('localStorage save failed:', e);
    }
  }

  // ---------- PUBLIC API ----------

  window.HotelDB = {
    ready: function(cb) {
      if (_ready) { cb(); return; }
      _readyCallbacks.push(cb);
    },

    getHotels: function(filters) {
      let result = [..._hotels];
      if (!filters) return result;

      if (filters.region) {
        result = result.filter(h => h.region === filters.region);
      }
      if (filters.search) {
        const q = filters.search.toLowerCase();
        result = result.filter(h =>
          (h.name || '').toLowerCase().includes(q) ||
          (h.location || '').toLowerCase().includes(q) ||
          (h.email || '').toLowerCase().includes(q) ||
          (h.contactPerson || '').toLowerCase().includes(q)
        );
      }
      if (filters.minRating) {
        result = result.filter(h => (h.rating || 0) >= filters.minRating);
      }
      if (filters.status) {
        result = result.filter(h => getStage(h) === filters.status);
      }
      return result;
    },

    getHotel: function(id) {
      return _hotels.find(h => h.id === id) || null;
    },

    saveHotel: function(data) {
      if (data.id) {
        const idx = _hotels.findIndex(h => h.id === data.id);
        if (idx >= 0) {
          Object.assign(_hotels[idx], data, { updatedAt: new Date().toISOString() });
        }
      } else {
        data.id = generateId();
        data.createdAt = new Date().toISOString();
        data.updatedAt = data.createdAt;
        if (!data.outreach) data.outreach = { contacted: false, responded: false, approved: false, bookedDates: '' };
        if (!data.timeline) data.timeline = [];
        _hotels.push(data);
      }
      _save();
      return data;
    },

    deleteHotel: function(id) {
      _hotels = _hotels.filter(h => h.id !== id);
      _save();
    },

    updateOutreach: function(id, outreach) {
      const hotel = _hotels.find(h => h.id === id);
      if (hotel) {
        hotel.outreach = { ...hotel.outreach, ...outreach };
        hotel.updatedAt = new Date().toISOString();
        _save();
      }
    },

    addTimeline: function(id, entry) {
      const hotel = _hotels.find(h => h.id === id);
      if (hotel) {
        if (!hotel.timeline) hotel.timeline = [];
        hotel.timeline.unshift({
          ...entry,
          date: new Date().toISOString()
        });
        hotel.updatedAt = new Date().toISOString();
        _save();
      }
    },

    getTimeline: function(id) {
      const hotel = _hotels.find(h => h.id === id);
      return hotel ? (hotel.timeline || []) : [];
    },

    addDiscoveredHotels: function(hotels) {
      let added = 0;
      hotels.forEach(h => {
        // Check for duplicates by normalized name
        const norm = (h.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const exists = _hotels.some(existing => {
          return (existing.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === norm;
        });
        if (!exists) {
          h.id = h.id || generateId();
          h.createdAt = new Date().toISOString();
          h.updatedAt = h.createdAt;
          if (!h.outreach) h.outreach = { contacted: false, responded: false, approved: false, bookedDates: '' };
          if (!h.timeline) h.timeline = [];
          _hotels.push(h);
          added++;
        }
      });
      _save();
      return added;
    },

    getStats: function() {
      const total = _hotels.length;
      let totalPrice = 0;
      let priceCount = 0;
      let totalRating = 0;
      let ratingCount = 0;
      let contacted = 0;
      let responded = 0;

      _hotels.forEach(h => {
        // Parse price
        const priceStr = (h.avgPricePerNight || '').replace(/,/g, '');
        const priceMatch = priceStr.match(/\d+/);
        if (priceMatch) {
          totalPrice += parseInt(priceMatch[0], 10);
          priceCount++;
        }
        // Rating
        if (h.rating) {
          totalRating += h.rating;
          ratingCount++;
        }
        // Outreach
        const o = h.outreach || {};
        if (o.contacted) contacted++;
        if (o.responded) responded++;
      });

      return {
        total,
        avgPrice: priceCount > 0 ? '$' + Math.round(totalPrice / priceCount) : '$0',
        avgRating: ratingCount > 0 ? (totalRating / ratingCount).toFixed(1) : '0',
        contacted,
        responded
      };
    },

    getRegions: function() {
      return _regions || [];
    },

    getSeeds: function(regionKey) {
      if (!_seeds) return [];
      // Try exact key match first, then fuzzy
      if (_seeds[regionKey]) return _seeds[regionKey];
      // Try matching by region name to key
      const key = regionKey.toLowerCase().replace(/[^a-z]/g, '-').replace(/-+/g, '-');
      if (_seeds[key]) return _seeds[key];
      // Try matching region name from regions list
      const region = (_regions || []).find(r => r.name === regionKey);
      if (region && _seeds[region.id]) return _seeds[region.id];
      return [];
    },

    // Fake scan - returns seed data with realistic delays
    runQuickScan: function(region, onProgress, onComplete) {
      const seeds = this.getSeeds(region);
      const existingNames = new Set(_hotels.map(h => (h.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')));

      // Separate into new and duplicates
      const results = [];
      const duplicates = [];
      seeds.forEach(s => {
        const seedCopy = { ...s, id: s.id || generateId(), source: 'OpenStreetMap' };
        const norm = (s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (existingNames.has(norm)) {
          duplicates.push(seedCopy);
        } else {
          results.push(seedCopy);
        }
      });

      // Simulate progress
      const messages = [
        'Connecting to OpenStreetMap Overpass API...',
        'Querying hotel nodes in ' + region + '...',
        'Filtering 4+ star properties...',
        'Cross-referencing with existing database...',
        'Extracting contact information...',
        'Scan complete.'
      ];

      let step = 0;
      const interval = setInterval(() => {
        if (step < messages.length) {
          if (onProgress) onProgress(messages[step], step, messages.length);
          step++;
        }
        if (step >= messages.length) {
          clearInterval(interval);
          setTimeout(() => {
            if (onComplete) onComplete(results, duplicates);
          }, 300);
        }
      }, 600);

      return { cancel: () => clearInterval(interval) };
    },

    runDeepResearch: function(region, onProgress, onComplete) {
      const seeds = this.getSeeds(region);
      const existingNames = new Set(_hotels.map(h => (h.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')));

      const results = [];
      const duplicates = [];
      seeds.forEach(s => {
        const seedCopy = { ...s, id: s.id || generateId(), source: 'Deep Research' };
        const norm = (s.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        if (existingNames.has(norm)) {
          duplicates.push(seedCopy);
        } else {
          results.push(seedCopy);
        }
      });

      const messages = [
        'Initializing research engine...',
        'Querying OpenStreetMap Overpass API for ' + region + '...',
        'Found ' + (results.length + duplicates.length) + ' hotel candidates...',
        'Scraping hotel websites for contact info...',
        'Checking social media presence...',
        'Extracting email addresses from websites...',
        'Verifying phone numbers...',
        'Analyzing pricing data...',
        'Cross-referencing with existing database...',
        'Compiling results...',
        'Research complete. ' + results.length + ' new hotels found.'
      ];

      let step = 0;
      const partialResults = [];
      const interval = setInterval(() => {
        if (step < messages.length) {
          // Progressively reveal results
          if (step >= 3 && partialResults.length < results.length) {
            const toAdd = Math.min(2, results.length - partialResults.length);
            for (let i = 0; i < toAdd; i++) {
              partialResults.push(results[partialResults.length]);
            }
          }
          if (onProgress) onProgress(messages[step], step, messages.length, [...partialResults]);
          step++;
        }
        if (step >= messages.length) {
          clearInterval(interval);
          setTimeout(() => {
            if (onComplete) onComplete(results, duplicates);
          }, 500);
        }
      }, 1200);

      return { cancel: () => clearInterval(interval) };
    },

    // Reset to defaults
    reset: function() {
      localStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(VERSION_KEY);
      window.location.reload();
    }
  };

  // Helper used across pages
  function getStage(h) {
    const o = h.outreach || {};
    if (o.bookedDates) return 'booked';
    if (o.approved) return 'approved';
    if (o.responded) return 'responded';
    if (o.contacted) return 'contacted';
    return 'not_contacted';
  }

  // Expose helper
  window.HotelDB.getStage = getStage;

  // Auto-init
  init();
})();
