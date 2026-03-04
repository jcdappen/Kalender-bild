#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://gemeindekonkordia.church.tools';
const API_BASE = `${BASE_URL}/api`;
const TOKEN = process.env.CHURCHTOOLS_TOKEN;

if (!TOKEN) {
  console.error('Fehler: CHURCHTOOLS_TOKEN ist nicht gesetzt.');
  process.exit(1);
}

const IMAGES_DIR = path.resolve(__dirname, '..', 'assets', 'images');
const TERMINE_FILE = path.resolve(__dirname, '..', 'data', 'termine.json');

// Kategorie-Schlüsselwörter → Farbe
const CATEGORY_COLORS = {
  gottesdienst: '#f39c12',
  kinder:       '#3498db',
  senioren:     '#9b59b6',
  jugend:       '#e74c3c',
};
const DEFAULT_COLOR = '#27ae60'; // Sonstige Veranstaltungen

function getCategoryColor(name) {
  if (!name) return DEFAULT_COLOR;
  const lower = name.toLowerCase();
  for (const [key, color] of Object.entries(CATEGORY_COLORS)) {
    if (lower.includes(key)) return color;
  }
  return DEFAULT_COLOR;
}

async function apiGet(endpoint) {
  const url = `${API_BASE}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Login ${TOKEN}`,
      Accept: 'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API ${res.status} ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function downloadFile(url, destPath) {
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Login ${TOKEN}` },
    });
    if (!res.ok) return false;
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length < 500) return false; // Wahrscheinlich kein echtes Bild
    fs.writeFileSync(destPath, buffer);
    return true;
  } catch {
    return false;
  }
}

async function fetchAllEvents(from, to) {
  let page = 1;
  let allEvents = [];

  while (true) {
    const params = new URLSearchParams({ from, to, limit: '100', page: String(page) });
    const data = await apiGet(`/events?${params}`);
    const events = data.data || [];
    allEvents = allEvents.concat(events);

    const pagination = data.meta?.pagination;
    if (!pagination || page >= (pagination.lastPage || 1)) break;
    page++;
  }

  return allEvents;
}

async function tryGetImage(event, destPath) {
  // 1. Direktes imageUrl-Feld im Event
  const directUrl = event.imageUrl || event.image_url || event.picture || event.image;
  if (directUrl) {
    const full = directUrl.startsWith('http') ? directUrl : `${BASE_URL}${directUrl}`;
    if (await downloadFile(full, destPath)) return true;
  }

  // 2. Dateianhänge des Events
  try {
    const filesData = await apiGet(`/events/${event.id}/files`);
    const files = (filesData.data || []).filter(f =>
      /\.(jpg|jpeg|png|gif|webp)$/i.test(f.name || f.filename || '')
    );
    if (files.length > 0) {
      const fileUrl = files[0].fileUrl || files[0].file_url || files[0].url;
      if (fileUrl) {
        const full = fileUrl.startsWith('http') ? fileUrl : `${BASE_URL}${fileUrl}`;
        if (await downloadFile(full, destPath)) return true;
      }
    }
  } catch {
    // Kein Dateiendpunkt oder keine Dateien für dieses Event
  }

  // 3. Kalender-Bild-Endpunkt (alternative ChurchTools-Variante)
  try {
    const imgData = await apiGet(`/calendars/${event.calendarId}/images`);
    const imgs = imgData.data || [];
    if (imgs.length > 0) {
      const imgUrl = imgs[0].url || imgs[0].fileUrl;
      if (imgUrl) {
        const full = imgUrl.startsWith('http') ? imgUrl : `${BASE_URL}${imgUrl}`;
        if (await downloadFile(full, destPath)) return true;
      }
    }
  } catch {
    // Kein Bild-Endpunkt vorhanden
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

  // Kalender-IDs → Kategorie-Namen holen
  const calendarMap = {};
  try {
    const calData = await apiGet('/calendars');
    const calendars = calData.data || [];
    calendars.forEach(cal => {
      calendarMap[cal.id] = cal.name || cal.nameTranslated || 'Sonstige Veranstaltungen';
    });
    console.log(`${calendars.length} Kalender gefunden.`);
  } catch (e) {
    console.warn('Kalender konnten nicht geladen werden:', e.message);
  }

  // Events laden
  let events = [];
  try {
    events = await fetchAllEvents(from, to);
    console.log(`${events.length} Termine gefunden.`);
  } catch (e) {
    console.error('Fehler beim Laden der Termine:', e.message);
    fs.writeFileSync(TERMINE_FILE, JSON.stringify([], null, 2));
    return;
  }

  const termine = [];

  for (const event of events) {
    const id = event.id;
    const title = event.caption || event.title || event.name || 'Termin';
    const startDate = event.startDate || event.start_date;
    const endDate = event.endDate || event.end_date || startDate;
    const calendarId = event.calendarId || event.calendar_id;
    const categoryName = calendarMap[calendarId] || 'Sonstige Veranstaltungen';
    const color = getCategoryColor(categoryName);
    const location = event.location || '';
    const description = event.description || '';

    // Vergangene Termine überspringen
    if (startDate && new Date(startDate) < now) continue;

    // Bild herunterladen
    let imagePath = 'assets/images/placeholder.jpg';
    const destPath = path.join(IMAGES_DIR, `${id}.jpg`);

    const got = await tryGetImage(event, destPath);
    if (got) {
      imagePath = `assets/images/${id}.jpg`;
      console.log(`  Bild gespeichert: ${id}.jpg`);
    }

    termine.push({
      id,
      title,
      startDate,
      endDate,
      category: categoryName,
      color,
      image: imagePath,
      location,
      description,
    });
  }

  // Nach Startdatum sortieren
  termine.sort((a, b) => new Date(a.startDate) - new Date(b.startDate));

  fs.writeFileSync(TERMINE_FILE, JSON.stringify(termine, null, 2));
  console.log(`\n✓ ${termine.length} Termine in termine.json gespeichert.`);
}

main().catch(err => {
  console.error('Fataler Fehler:', err);
  process.exit(1);
});
