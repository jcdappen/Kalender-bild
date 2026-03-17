#!/usr/bin/env node
'use strict';

const fs   = require('fs');
const path = require('path');

const BASE_URL = 'https://gemeindekonkordia.church.tools';
const API_BASE = `${BASE_URL}/api`;
const TOKEN    = process.env.CHURCHTOOLS_TOKEN;

if (!TOKEN) {
  console.error('Fehler: CHURCHTOOLS_TOKEN ist nicht gesetzt.');
  process.exit(1);
}

const IMAGES_DIR   = path.resolve(__dirname, '..', 'assets', 'images');
const TERMINE_FILE = path.resolve(__dirname, '..', 'data', 'termine.json');

// Kalender-IDs die abgefragt werden sollen
const CALENDAR_IDS = [1, 2, 3, 10, 33];

// Farben nach Kalender-Name (aus appointment.calendar.name)
const COLOR_MAP = {
  'Gottesdienste':           '#f39c12',
  'Gottesdienst':            '#f39c12',
  'Kinder':                  '#3498db',
  'Senioren':                '#9b59b6',
  'Jugend':                  '#e74c3c',
  'Sonstige Veranstaltungen': '#27ae60',
  'Sonstige Veranstaltung':  '#27ae60',
};

async function apiGet(endpoint) {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: `Login ${TOKEN}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function downloadFile(url, destPath) {
  // Bilder sind securityLevelId=0 (öffentlich) – kein Auth-Header nötig.
  // Redirects manuell folgen um Loops durch den Auth-Header zu vermeiden.
  let current = url;
  for (let i = 0; i < 10; i++) {
    let res;
    try {
      res = await fetch(current, { redirect: 'manual' });
    } catch {
      return false;
    }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) break;
      current = loc.startsWith('http') ? loc : new URL(loc, current).href;
      continue;
    }
    if (!res.ok) {
      return false;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 500) return false;
    fs.writeFileSync(destPath, buffer);
    return true;
  }
  console.warn(`  Bild-Download: zu viele Redirects für ${url}`);
  return false;
}

// /api/calendars/{id}/appointments
// Jeder Eintrag: { appointment: {...}, calculated: { startDate, endDate } }
async function fetchAppointments(from, to) {
  const all = [];
  for (const calId of CALENDAR_IDS) {
    let page = 1;
    let countForCal = 0;
    while (true) {
      const params = new URLSearchParams({ from, to, limit: '100', page: String(page) });
      let data;
      try {
        data = await apiGet(`/calendars/${calId}/appointments?${params}`);
      } catch (e) {
        console.warn(`  Kalender ${calId} Fehler: ${e.message}`);
        break;
      }

      for (const item of (data.data || [])) {
        const appt       = item.appointment || item;
        // ChurchTools: Daten in item.base (= item.appointment.base)
        const base       = appt.base || appt;
        const startDate  = item.calculated?.startDate || base.startDate;
        const endDate    = item.calculated?.endDate   || base.endDate;
        all.push({ ...base, _source: 'appointments', id: `${base.id || item.id}_${startDate}`, startDate, endDate });
        countForCal++;
      }

      const pg = data.meta?.pagination;
      if (!pg || page >= (pg.lastPage || 1)) break;
      page++;
    }
    console.log(`  Kalender ${calId}: ${countForCal} Termine`);
  }
  console.log(`  Gesamt Appointments: ${all.length}`);
  return all;
}

async function main() {
  fs.mkdirSync(IMAGES_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(TERMINE_FILE), { recursive: true });

  // Datumsbereich: heute → +90 Tage
  const now = new Date();
  const from = now.toISOString().split('T')[0];
  const future = new Date(now);
  future.setDate(future.getDate() + 90);
  const to = future.toISOString().split('T')[0];

  console.log(`Lade Termine von ${from} bis ${to} …`);

  const allItems = await fetchAppointments(from, to);

  const termine = [];

  for (const event of allItems) {
    // appointment.startDate / appointment.endDate
    const startDate = event.startDate;
    if (!startDate || new Date(startDate) < now) continue;

    const id      = event.id;
    const endDate = event.endDate || startDate;

    // ChurchTools: caption (nicht title)
    const title = event.caption || event.title || 'Termin';

    const calendarName = event.calendar?.name || 'Sonstige Veranstaltungen';
    // Farbe: erst ChurchTools-Kalenderfarbe, dann COLOR_MAP, dann Standardfarbe
    const color        = event.calendar?.color || COLOR_MAP[calendarName] || '#27ae60';

    // ChurchTools: description = lange Beschreibung (note = veralteter Alias für subtitle)
    const description = event.description || event.information || '';

    // appointment.address.name + street + zip + city
    const addr = event.address;
    let location = '';
    if (addr && typeof addr === 'object') {
      const namePart = [addr.name, addr.addition].filter(Boolean).join(' – ');
      const cityPart = [addr.zip, addr.city].filter(Boolean).join(' ');
      location = [namePart, addr.street, cityPart].filter(Boolean).join(', ');
    }

    // ChurchTools: image kann null, String-URL oder Objekt mit imageUrl/fileUrl/url sein
    const img = event.image;
    const fileId   = String(id).replace(/[^a-zA-Z0-9]/g, '_');
    const destPath = path.join(IMAGES_DIR, `${fileId}.jpg`);
    let imagePath  = 'assets/images/placeholder.jpg';

    const imageUrls = [];
    if (img?.fileUrl)  imageUrls.push(img.fileUrl);
    if (img?.imageUrl) imageUrls.push(img.imageUrl);
    if (typeof img === 'string') imageUrls.push(img);

    for (const u of imageUrls) {
      const full = u.startsWith('http') ? u : `${BASE_URL}${u}`;
      if (await downloadFile(full, destPath)) {
        imagePath = `assets/images/${fileId}.jpg`;
        console.log(`  Bild: ${fileId}.jpg (von ${full})`);
        break;
      }
    }

    const link = event.link || '';

    termine.push({ id, title, startDate, endDate, category: calendarName, color, image: imagePath, location, description, link });
  }

  termine.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  fs.writeFileSync(TERMINE_FILE, JSON.stringify(termine, null, 2));
  console.log(`\n✓ ${termine.length} Termine gespeichert.`);
}

main().catch(err => {
  console.error('Fataler Fehler:', err);
  process.exit(1);
});
