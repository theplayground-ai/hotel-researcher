// Hotel Researcher Dashboard - Visual Card Grid

(function () {
  'use strict';

  const API = '/api/hotels';
  const API_STATS = '/api/stats';

  let hotels = [];
  let allHotels = [];
  let sortKey = 'name-asc';
  let activeRegion = '';
  let searchQuery = '';
  let favorites = JSON.parse(localStorage.getItem('hotel-favorites') || '[]');

  // DOM refs
  const grid = document.getElementById('cards-grid');
  const emptyState = document.getElementById('empty-state');
  const searchInput = document.getElementById('search-input');
  const sortSelect = document.getElementById('sort-select');
  const filterBar = document.getElementById('filter-bar');
  const modalOverlay = document.getElementById('modal-overlay');
  const importOverlay = document.getElementById('import-overlay');
  const emailOverlay = document.getElementById('email-overlay');
  const hotelForm = document.getElementById('hotel-form');
  const modalTitle = document.getElementById('modal-title');

  // ---------- IMAGE HELPERS ----------

  const PEXELS_IDS = [261102, 338504, 189296, 258154, 1134176, 2507010, 2034335, 1268871, 2373201, 1457842, 2029722, 3155666, 2462015, 1743231, 2417842, 2029731, 3225531, 2404843, 1488327, 2096983];
  function getPexelsUrl(name) {
    let hash = 0;
    const n = (name || '').toLowerCase();
    for (let i = 0; i < n.length; i++) { hash = ((hash << 5) - hash) + n.charCodeAt(i); hash = hash & hash; }
    const idx = Math.abs(hash) % PEXELS_IDS.length;
    const id = PEXELS_IDS[idx];
    return 'https://images.pexels.com/photos/' + id + '/pexels-photo-' + id + '.jpeg?auto=compress&cs=tinysrgb&w=800';
  }

  function getImageUrl(hotel) {
    if (hotel.imageUrl) return hotel.imageUrl;
    return getPexelsUrl(hotel.name);
  }

  function getInitials(name) {
    if (!name) return '?';
    return name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
  }

  function handleImgError(img) {
    const wrap = img.parentElement;
    img.remove();
    const initials = wrap.dataset.initials || '?';
    const fallback = document.createElement('div');
    fallback.className = 'card-initials';
    fallback.textContent = initials;
    wrap.insertBefore(fallback, wrap.firstChild);
  }

  // ---------- API ----------

  async function fetchHotels() {
    try {
      const res = await fetch(API);
      if (!res.ok) throw new Error(res.statusText);
      const data = await res.json();
      allHotels = data.hotels || data;
      if (Array.isArray(data)) allHotels = data;
    } catch (e) {
      console.error('Failed to fetch hotels:', e);
      allHotels = [];
    }
    buildRegionFilters();
    applyFilters();
  }

  async function fetchStats() {
    try {
      const res = await fetch(API_STATS);
      if (!res.ok) throw new Error(res.statusText);
      const stats = await res.json();
      setText('stat-total', stats.totalResearched ?? stats.total ?? 0);
      setText('stat-avg-price', stats.avgPrice || '$0');
      setText('stat-avg-rating', stats.avgRating ? stats.avgRating + '/10' : '0');
      setText('stat-contacted', stats.contacted ?? 0);
      setText('stat-responded', stats.responded ?? 0);
    } catch (e) {
      console.error('Failed to fetch stats:', e);
    }
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  async function saveHotel(data) {
    const isEdit = !!data.id;
    const url = isEdit ? API + '/' + data.id : API;
    const method = isEdit ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  }

  async function deleteHotel(id) {
    const res = await fetch(API + '/' + id, { method: 'DELETE' });
    if (!res.ok) throw new Error(await res.text());
  }

  // ---------- FILTERS & SORT ----------

  function buildRegionFilters() {
    const regions = [...new Set(allHotels.map(h => h.region).filter(Boolean))].sort();
    // Remove old dynamic pills
    filterBar.querySelectorAll('.filter-pill[data-region]:not([data-region=""])').forEach(el => el.remove());

    const allBtn = filterBar.querySelector('[data-region=""]');
    regions.forEach(r => {
      const btn = document.createElement('button');
      btn.className = 'filter-pill';
      btn.dataset.region = r;
      btn.textContent = r;
      allBtn.after(btn);
    });

    // Re-bind clicks
    filterBar.querySelectorAll('.filter-pill[data-region]').forEach(btn => {
      btn.addEventListener('click', () => {
        filterBar.querySelectorAll('.filter-pill[data-region]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeRegion = btn.dataset.region;
        applyFilters();
      });
    });
  }

  function parsePriceMin(str) {
    if (!str) return 0;
    const m = str.replace(/,/g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : 0;
  }

  function applyFilters() {
    let filtered = allHotels;

    if (activeRegion) {
      filtered = filtered.filter(h => h.region === activeRegion);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(h =>
        (h.name || '').toLowerCase().includes(q) ||
        (h.location || '').toLowerCase().includes(q) ||
        (h.email || '').toLowerCase().includes(q) ||
        (h.contactPerson || '').toLowerCase().includes(q)
      );
    }

    // Sort — featured hotels always pin to top
    const [key, dir] = sortKey.split('-');
    filtered.sort((a, b) => {
      const fa = a.featured ? 1 : 0;
      const fb = b.featured ? 1 : 0;
      if (fa !== fb) return fb - fa;

      let va, vb;
      if (key === 'price') {
        va = parsePriceMin(a.avgPricePerNight);
        vb = parsePriceMin(b.avgPricePerNight);
      } else if (key === 'rating') {
        va = a.rating || 0;
        vb = b.rating || 0;
      } else {
        va = (a.name || '').toLowerCase();
        vb = (b.name || '').toLowerCase();
      }
      if (va < vb) return dir === 'asc' ? -1 : 1;
      if (va > vb) return dir === 'asc' ? 1 : -1;
      return 0;
    });

    hotels = filtered;
    renderCards();
  }

  // ---------- RENDER CARDS ----------

  function getStage(h) {
    const o = h.outreach || {};
    if (o.bookedDates) return 'booked';
    if (o.approved) return 'approved';
    if (o.responded) return 'responded';
    if (o.contacted) return 'contacted';
    return 'not_contacted';
  }

  function stageLabel(stage) {
    return stage.replace(/_/g, ' ');
  }

  function renderCards() {
    if (hotels.length === 0) {
      grid.innerHTML = '';
      emptyState.style.display = 'block';
      return;
    }

    emptyState.style.display = 'none';

    grid.innerHTML = hotels.map(h => {
      const stage = getStage(h);
      const isFav = favorites.includes(h.id);
      const priceDisplay = h.avgPricePerNight || '';
      const ratingDisplay = h.rating ? h.rating + '/10' : '';
      const initials = getInitials(h.name);
      const imgUrl = getImageUrl(h);

      const imgHtml = imgUrl
        ? `<img class="card-img" src="${esc(imgUrl)}" alt="${esc(h.name)}" loading="lazy" onerror="this.parentElement.querySelector('.card-initials')||handleImgError(this)">`
        : `<div class="card-initials">${esc(initials)}</div>`;

      return `
        <div class="hotel-card ${isFav ? 'shortlisted' : ''}" data-id="${h.id}">
          <div class="card-img-wrap" data-initials="${esc(initials)}">
            ${imgHtml}
            <div class="card-gradient"></div>
            ${ratingDisplay ? `<span class="card-rating">${esc(ratingDisplay)}</span>` : ''}
            ${priceDisplay ? `<span class="card-price">${esc(priceDisplay)}</span>` : ''}
            <button class="card-fav" onclick="event.stopPropagation();toggleFav('${h.id}')" title="Shortlist">${isFav ? '&#9829;' : '&#9825;'}</button>
          </div>
          <div class="card-body">
            <h3 class="card-name">${esc(h.name)}</h3>
            <p class="card-location">\uD83D\uDCCD ${esc(h.location || h.region || 'Unknown')}</p>
            <div class="card-actions">
              <button class="btn-email" onclick="event.stopPropagation();openEmailComposer(findHotel('${h.id}'))">&#9993; Draft Email</button>
              <span class="status-pill status-${stage}">${stageLabel(stage)}</span>
            </div>
          </div>
        </div>`;
    }).join('');

    // Card click -> hotel detail
    grid.querySelectorAll('.hotel-card').forEach(card => {
      card.addEventListener('click', () => {
        window.location.href = 'hotel.html?id=' + card.dataset.id;
      });
    });
  }

  // ---------- FAVORITES ----------

  window.toggleFav = function(id) {
    const idx = favorites.indexOf(id);
    if (idx >= 0) favorites.splice(idx, 1);
    else favorites.push(id);
    localStorage.setItem('hotel-favorites', JSON.stringify(favorites));
    renderCards();
  };

  window.findHotel = function(id) {
    return allHotels.find(h => h.id === id) || {};
  };

  window.handleImgError = handleImgError;

  // ---------- MODAL ----------

  function openModal() { modalOverlay.classList.add('active'); }
  function closeModal() { modalOverlay.classList.remove('active'); hotelForm.reset(); document.getElementById('form-id').value = ''; }

  function openAddModal() {
    modalTitle.textContent = 'Add Hotel';
    document.getElementById('form-id').value = '';
    hotelForm.reset();
    openModal();
  }

  // ---------- IMPORT / EXPORT ----------

  function openImportModal() { importOverlay.classList.add('active'); }
  function closeImportModal() { importOverlay.classList.remove('active'); document.getElementById('csv-file').value = ''; }

  function exportCSV() {
    window.location.href = '/api/hotels/export';
  }

  // ---------- EMAIL COMPOSER ----------

  function generateEmailTemplate(h) {
    const contactName = h.contactPerson || h.contact_person || 'the team at ' + h.name;
    const location = h.location || '';
    const subject = 'Video Production Collaboration - ' + h.name + ' x Amber Pacific Studios';

    let body = 'Hi ' + contactName + ',\n\n';
    body += 'My name is Chris Stanley, founder of Amber Pacific Studios, a boutique video production company based in Vancouver. We specialize in cinematic, beautifully crafted video content designed to showcase luxury experiences at their best.\n\n';
    body += 'I came across ' + h.name + ' and was genuinely impressed by your property in ' + location + '. The level of detail and atmosphere you\'ve created is exactly the kind of setting that translates beautifully on camera.\n\n';
    body += 'I\'d love to explore a potential collaboration where we produce high-end video content for ' + h.name + ', whether that\'s for your website, social channels, or marketing campaigns. We handle everything from concept to final delivery, and our work is built to elevate how guests discover and connect with properties like yours.\n\n';
    body += 'You can view our portfolio and past work here: https://amberpacificstudios.com\n\n';

    const region = (h.region || '').toLowerCase();
    if (region.includes('los cabos') || region.includes('cabo')) {
      body += 'I recently spent time filming in the Cabo region and would love to bring that same cinematic perspective to ' + h.name + '.\n\n';
    }

    body += 'I\'d be happy to put together a custom proposal tailored to ' + h.name + '. Would you be open to a quick call or email exchange to discuss?\n\n';
    body += 'Looking forward to hearing from you.\n\n';
    body += 'Best,\nChris Stanley\nFounder, Amber Pacific Studios\nwww.amberpacificstudios.com\n@chrisstanleyhd';

    return { to: h.email || '', subject, body };
  }

  window.openEmailComposer = function(h) {
    const email = generateEmailTemplate(h);
    document.getElementById('email-hotel-id').value = h.id;
    document.getElementById('email-to').value = email.to;
    document.getElementById('email-subject').value = email.subject;
    document.getElementById('email-body').value = email.body;
    emailOverlay.classList.add('active');
    document.getElementById('email-copy').classList.remove('copied');
    document.getElementById('email-copy').textContent = 'Copy to Clipboard';
    const markBtn = document.getElementById('email-mark-contacted');
    markBtn.classList.remove('marked');
    markBtn.textContent = 'Mark as Contacted';
  };

  function closeEmailModal() { emailOverlay.classList.remove('active'); }

  // ---------- HELPERS ----------

  function esc(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  async function refresh() {
    await Promise.all([fetchHotels(), fetchStats()]);
  }

  // ---------- EVENTS ----------

  let filterTimeout;
  searchInput.addEventListener('input', () => {
    clearTimeout(filterTimeout);
    filterTimeout = setTimeout(() => {
      searchQuery = searchInput.value.trim();
      applyFilters();
    }, 200);
  });

  sortSelect.addEventListener('change', () => {
    sortKey = sortSelect.value;
    applyFilters();
  });

  document.getElementById('btn-add').addEventListener('click', openAddModal);
  document.getElementById('btn-export').addEventListener('click', exportCSV);
  document.getElementById('btn-import').addEventListener('click', openImportModal);

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

  document.getElementById('import-close').addEventListener('click', closeImportModal);
  document.getElementById('import-cancel').addEventListener('click', closeImportModal);
  importOverlay.addEventListener('click', e => { if (e.target === importOverlay) closeImportModal(); });

  // Import submit
  document.getElementById('import-submit').addEventListener('click', async () => {
    const fileInput = document.getElementById('csv-file');
    if (!fileInput.files.length) return alert('Please select a CSV file.');

    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    try {
      const res = await fetch('/api/hotels/import', { method: 'POST', body: formData });
      if (!res.ok) throw new Error(await res.text());
      closeImportModal();
      await refresh();
    } catch (err) {
      alert('Import failed: ' + err.message);
    }
  });

  // Form submit
  hotelForm.addEventListener('submit', async e => {
    e.preventDefault();
    const data = {
      name: document.getElementById('form-name').value.trim(),
      location: document.getElementById('form-location').value.trim(),
      region: document.getElementById('form-region').value.trim(),
      avgPricePerNight: document.getElementById('form-price').value.trim(),
      rating: document.getElementById('form-rating').value ? Number(document.getElementById('form-rating').value) : 0,
      address: document.getElementById('form-address').value.trim(),
      phone: document.getElementById('form-phone').value.trim(),
      email: document.getElementById('form-email').value.trim(),
      instagram: document.getElementById('form-instagram').value.trim(),
      contactPerson: document.getElementById('form-contact-person').value.trim(),
      contactPosition: document.getElementById('form-contact-position').value.trim(),
      website: document.getElementById('form-website').value.trim(),
      notes: document.getElementById('form-notes').value.trim()
    };
    const id = document.getElementById('form-id').value;
    if (id) data.id = id;

    try {
      await saveHotel(data);
      closeModal();
      await refresh();
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  });

  // Email events
  document.getElementById('email-close').addEventListener('click', closeEmailModal);
  emailOverlay.addEventListener('click', e => { if (e.target === emailOverlay) closeEmailModal(); });

  document.getElementById('email-copy').addEventListener('click', () => {
    const subject = document.getElementById('email-subject').value;
    const body = document.getElementById('email-body').value;
    navigator.clipboard.writeText('Subject: ' + subject + '\n\n' + body).then(() => {
      const btn = document.getElementById('email-copy');
      btn.classList.add('copied');
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.classList.remove('copied'); btn.textContent = 'Copy to Clipboard'; }, 2000);
    });
  });

  document.getElementById('email-gmail').addEventListener('click', () => {
    const to = document.getElementById('email-to').value;
    const subject = document.getElementById('email-subject').value;
    const body = document.getElementById('email-body').value;
    window.open('mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body), '_blank');
  });

  document.getElementById('email-mark-contacted').addEventListener('click', async () => {
    const markBtn = document.getElementById('email-mark-contacted');
    if (markBtn.classList.contains('marked')) return;
    const hotelId = document.getElementById('email-hotel-id').value;
    const subject = document.getElementById('email-subject').value;
    const to = document.getElementById('email-to').value;

    await fetch(API + '/' + hotelId + '/outreach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacted: true })
    });
    await fetch(API + '/' + hotelId + '/timeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'Email Sent', note: 'Outreach email to ' + to + ' - ' + subject })
    });

    markBtn.classList.add('marked');
    markBtn.textContent = 'Contacted';
    await refresh();
  });

  // Keyboard
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal();
      closeImportModal();
      closeEmailModal();
    }
  });

  // ---------- INIT ----------
  refresh();
})();
