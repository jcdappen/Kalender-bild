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

// Nur diese 5 öffentlichen Gemeinde-Kalender anzeigen
const ALLOWED_CALENDAR_IDS = new Set([1, 2, 3, 10, 33]);

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
  try {
    const res = await fetch(url, { headers: { Authorization: `Login ${TOKEN}` } });
    if (!res.ok) return false;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 500) return false;
    fs.writeFileSync(destPath, buffer);
    return true;
  } catch {
    return false;
  }
}

// Endpunkt 1: /api/events – Gottesdienste & formale Veranstaltungen
async function fetchEvents(from, to, calendarIds) {
  let page = 1, all = [];
  while (true) {
    const params = new URLSearchParams({ from, to, limit: '100', page: String(page) });
    calendarIds.forEach(id => params.append('calendarIds[]', String(id)));
    let data;
    try { data = await apiGet(`/events?${params}`); }
    catch (e) { console.warn('  /api/events Fehler:', e.message); break; }
    const items = (data.data || []).map(e => ({ ...e, _source: 'events' }));
    all = all.concat(items);
    const pg = data.meta?.pagination;
    if (!pg || page >= (pg.lastPage || 1)) break;
    page++;
  }
  console.log(`  /api/events → ${all.length} Einträge`);
  return all;
}

// Endpunkt 2: /api/calendars/{id}/appointments – Kalender-Termine pro Kalender
// Jeder Listeneintrag = eine Occurrence: { appointment, calculated: {startDate, endDate}, ... }
async function fetchAppointments(from, to, calendarIds) {
  let all = [];
  for (const calId of calendarIds) {
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
        const appt = item.appointment || item;
        // Jeder Listeneintrag ist bereits EINE Occurrence.
        // item.calculated = { startDate: "...", endDate: "..." }
        const startDate = item.calculated?.startDate || appt.startDate;
        const endDate   = item.calculated?.endDate   || appt.endDate;
        all.push({
          ...appt,
          _source: 'appointments',
          id: `${appt.id}_${startDate}`,
          startDate,
          endDate,
        });
        countForCal++;
      }

      const pg = data.meta?.pagination;
      if (!pg || page >= (pg.lastPage || 1)) break;
      page++;
    }
    console.log(`  Kalender ${calId}: ${countForCal} Termine`);
  }
  console.log(`  /api/calendars/.../appointments → ${all.length} gesamt`);
  return all;
}

// Fallback: Bildsuche über Dateianhänge
async function tryGetImage(event, destPath) {
  const baseId = String(event.id).split('_')[0]; // bei recurring: nur die Basis-ID
  for (const ep of [`/events/${baseId}/files`, `/appointments/${baseId}/files`]) {
    try {
      const { data: files = [] } = await apiGet(ep);
      const img = files.find(f => /\.(jpg|jpeg|png|gif|webp)$/i.test(f.name || f.filename || ''));
      if (img) {
        const fileUrl = img.fileUrl || img.file_url || img.url;
        if (fileUrl) {
          const full = fileUrl.startsWith('http') ? fileUrl : `${BASE_URL}${fileUrl}`;
          if (await downloadFile(full, destPath)) return true;
        }
      }
    } catch { /* kein Dateiendpunkt */ }
  }
  return false;
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

  // Kalender laden – nur erlaubte IDs behalten, Farbe aus API übernehmen
  // calendarMap: id → { name, color }
  const calendarMap = {};
  try {
    const { data: calendars = [] } = await apiGet('/calendars');
    for (const cal of calendars) {
      if (!ALLOWED_CALENDAR_IDS.has(cal.id)) continue;
      calendarMap[cal.id] = {
        name:  cal.nameTranslated || cal.name || 'Sonstige Veranstaltungen',
        color: cal.color || '#27ae60',
      };
    }
    const names = Object.values(calendarMap).map(c => c.name).join(', ');
    console.log(`Kalender (${Object.keys(calendarMap).length}): ${names}`);
    console.log(`  IDs: [${Object.keys(calendarMap).join(', ')}]`);
  } catch (e) {
    console.warn('Kalender konnten nicht geladen werden:', e.message);
  }

  const calendarIds = Object.keys(calendarMap).map(Number);

  // Beide Endpunkte parallel abfragen
  console.log('Lade Veranstaltungen …');
  const [eventsRaw, appointmentsRaw] = await Promise.all([
    fetchEvents(from, to, calendarIds),
    fetchAppointments(from, to, calendarIds),
  ]);

  // Zusammenführen & deduplizieren (Events haben Vorrang bei gleicher ID)
  const seenIds = new Set();
  const allItems = [];
  for (const e of [...eventsRaw, ...appointmentsRaw]) {
    const key = String(e.id);
    if (!seenIds.has(key)) { seenIds.add(key); allItems.push(e); }
  }
  console.log(`Gesamt: ${eventsRaw.length} Events + ${appointmentsRaw.length} Appointments = ${eventsRaw.length + appointmentsRaw.length}, nach Deduplizierung: ${allItems.length}`);

  const termine = [];

  for (const event of allItems) {
    const startDate = event.startDate || event.start_date || event.calculatedStartDate;
    if (!startDate || new Date(startDate) < now) continue; // vergangene überspringen

    const id          = event.id;
    const title       = event.title || event.caption || event.name || 'Termin';
    const endDate     = event.endDate || event.end_date || event.calculatedEndDate || startDate;
    const calendarId  = event.calendar?.id || event.calendarId || event.calendar_id;
    const cal         = calendarMap[calendarId] || { name: 'Sonstige Veranstaltungen', color: '#27ae60' };
    const description = event.description || event.note || '';

    // Adresse: Objekt oder String
    const addr = event.address;
    const location = addr && typeof addr === 'object'
      ? [addr.name, addr.street, addr.city].filter(Boolean).join(', ')
      : (event.location || '');

    // Bild: direkt aus appointment.image.imageUrl oder fallback
    const imageObj    = event.image;
    const directImgUrl = (imageObj && (imageObj.imageUrl || imageObj.fileUrl))
                      || event.imageUrl || event.image_url;

    // Dateiname aus ID ableiten (Strings durch Unterstrich ersetzen)
    const fileId   = String(id).replace(/[^a-zA-Z0-9]/g, '_');
    const destPath = path.join(IMAGES_DIR, `${fileId}.jpg`);
    let imagePath  = 'assets/images/placeholder.jpg';

    if (directImgUrl) {
      const full = directImgUrl.startsWith('http') ? directImgUrl : `${BASE_URL}${directImgUrl}`;
      if (await downloadFile(full, destPath)) {
        imagePath = `assets/images/${fileId}.jpg`;
        console.log(`  Bild: ${fileId}.jpg`);
      }
    } else if (await tryGetImage(event, destPath)) {
      imagePath = `assets/images/${fileId}.jpg`;
      console.log(`  Bild: ${fileId}.jpg`);
    }

    termine.push({ id, title, startDate, endDate, category: cal.name, color: cal.color, image: imagePath, location, description });
  }

  termine.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));
  fs.writeFileSync(TERMINE_FILE, JSON.stringify(termine, null, 2));
  console.log(`\n✓ ${termine.length} Termine gespeichert.`);
}

main().catch(err => {
  console.error('Fataler Fehler:', err);
  process.exit(1);
});
