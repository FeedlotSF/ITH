const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// La decisión (ITH, corrección, satélite, horarios) es la misma que usa la app.
let D;
try {
  D = require(path.join(__dirname, '..', 'decision.js'));
} catch (e) {
  D = require(path.join(__dirname, 'decision.js'));
}

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Claves VAPID para autenticarse ante los servicios Push de Google (FCM), Mozilla y Apple
const publicVapidKey = process.env.VAPID_PUBLIC_KEY || 'BCT2DednHhMsDVX_2VOWUNcWceQYdO27sAeH8BA6fwqqCKFmD0O6XT-BIWmR4VpTPmkdAYPXLV0mqRbgPT5qTZY';
const privateVapidKey = process.env.VAPID_PRIVATE_KEY || 'dEaFFapI3SlJH6_5jRLUjXZlkdIQeJsMf9mN9YGPNpc';
const contactEmail = process.env.VAPID_EMAIL || 'mailto:admin@estrescalorico.local';

webpush.setVapidDetails(contactEmail, publicVapidKey, privateVapidKey);

const DB_FILE = process.env.SUBS_FILE || path.join(__dirname, 'subscriptions.json');
const API_TOKEN = process.env.API_TOKEN || '';
const APP_URL = process.env.APP_URL || '';
const CHECK_INTERVAL_MS = 15 * 60 * 1000;

function loadSubscriptions() {
  try {
    if (!fs.existsSync(DB_FILE)) return [];
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data || '[]');
  } catch (e) {
    return [];
  }
}

function saveSubscriptions(subs) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(subs, null, 2), 'utf8');
  } catch (e) {
    console.error('Error guardando suscripciones:', e.message);
  }
}

// Token simple para que no cualquiera registre suscripciones ni dispare el chequeo.
// Si API_TOKEN está vacío, los endpoints quedan abiertos (útil para probar).
function tokenOk(req) {
  if (!API_TOKEN) return true;
  const got = req.get('x-api-token') || req.query.token || '';
  const a = Buffer.from(String(got));
  const b = Buffer.from(API_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireToken(req, res, next) {
  if (!tokenOk(req)) return res.status(401).json({ error: 'Token inválido' });
  next();
}

// Servir la clave pública al frontend
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: publicVapidKey });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, subscriptions: loadSubscriptions().length, uptime: process.uptime() });
});

// Guardar la suscripción de un celular
app.post('/api/subscribe', requireToken, (req, res) => {
  const { subscription, location } = req.body || {};
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }

  let subs = loadSubscriptions();
  // Filtrar si ya existía para actualizar ubicación
  subs = subs.filter(s => s.subscription.endpoint !== subscription.endpoint);
  subs.push({
    subscription,
    location: location || { lat: -34.6, lon: -58.4, name: 'Buenos Aires' },
    created: Date.now()
  });

  saveSubscriptions(subs);
  console.log('Dispositivo registrado. Total registrados:', subs.length);
  res.status(201).json({ success: true, count: subs.length });
});

// Desuscribir
app.post('/api/unsubscribe', requireToken, (req, res) => {
  const { endpoint } = req.body || {};
  let subs = loadSubscriptions();
  subs = subs.filter(s => s.subscription.endpoint !== endpoint);
  saveSubscriptions(subs);
  res.json({ success: true });
});

// El cron externo entra por acá cada 10 min y despierta al servidor si Render lo durmió.
app.all('/api/cron', requireToken, async (req, res) => {
  const report = await checkWeatherAndNotify();
  res.json({ ok: true, ...report });
});

function fetchJson(url, ms) {
  const ctl = new AbortController();
  const tmo = setTimeout(() => ctl.abort(), ms || 9000);
  return fetch(url, { signal: ctl.signal, cache: 'no-store' })
    .then((r) => {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .finally(() => clearTimeout(tmo));
}

function forecastUrl(lat, lon) {
  return 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(lat) +
    '&longitude=' + encodeURIComponent(lon) +
    '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation,precipitation' +
    '&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,shortwave_radiation' +
    '&wind_speed_unit=ms&timezone=auto&past_days=1&forecast_days=3';
}

function satHourlyUrl(lat, lon) {
  return 'https://satellite-api.open-meteo.com/v1/archive?latitude=' + encodeURIComponent(lat) +
    '&longitude=' + encodeURIComponent(lon) +
    '&hourly=shortwave_radiation&models=satellite_radiation_seamless&timezone=auto&past_days=1&forecast_days=1';
}

function satInstantUrl(lat, lon) {
  return 'https://satellite-api.open-meteo.com/v1/archive?latitude=' + encodeURIComponent(lat) +
    '&longitude=' + encodeURIComponent(lon) +
    '&hourly=shortwave_radiation_instant&models=satellite_radiation_seamless&timezone=auto' +
    '&temporal_resolution=native&past_hours=6&forecast_hours=1';
}

// Misma secuencia que la app: pronóstico, satélite horario y satélite instantáneo.
async function buildForecast(lat, lon) {
  const j = await fetchJson(forecastUrl(lat, lon));
  if (!j || !j.current || !j.hourly || !j.hourly.time || !j.hourly.time.length) {
    throw new Error('Pronóstico inválido');
  }
  try {
    D.applySatelliteHourly(j, await fetchJson(satHourlyUrl(lat, lon)));
  } catch (e) {
    console.warn('Satélite horario no disponible:', e.message);
  }
  try {
    D.applySatelliteInstant(j, await fetchJson(satInstantUrl(lat, lon)));
    D.finalizeSatellite(j);
  } catch (e) {
    console.warn('Satélite instantáneo no disponible:', e.message);
  }
  return j;
}

function hm(h) {
  return h >= 24 ? '24:00' : D.pad2(h) + ':00';
}

const ZONE_NAMES = ['confort', 'alerta', 'peligro', 'emergencia'];

function summaryMessage(r, name) {
  if (r.action === 'activate') {
    return {
      title: 'Hoy: activar aspersores',
      body: name + ' ya está en zona ' + ZONE_NAMES[r.now.z] + ' (ITH base ' + r.now.b.toFixed(1) + ').'
    };
  }
  if (r.action === 'prepare') {
    return {
      title: 'Hoy: activar ' + (r.activateHour < 0 ? 'lo antes posible' : 'a las ' + hm(r.activateHour)),
      body: 'Se espera alerta desde las ' + hm(+r.firstAlert.t.slice(11, 13)) + ' en ' + name +
        '. Conviene activar antes del pico.'
    };
  }
  if (r.vigilar) {
    const vg = r.vigilar;
    return {
      title: 'Hoy: vigilar ' + hm(vg.startHour) + ' a ' + hm(vg.endHour),
      body: 'El ITH base no pide riego, pero con ' + vg.causes + ' la carga corregida llegaría a ' +
        vg.peak.toFixed(1) + '. Si hay jadeo, activá.'
    };
  }
  return {
    title: 'Hoy no hace falta regar',
    body: 'En ' + name + ' el ITH máximo previsto es ' + r.bpeak.toFixed(1) +
      ', por debajo de ' + r.thresholds[0] + '.'
  };
}

function preMessage(r, name) {
  return {
    title: 'En 1 h: preparar aspersión',
    body: 'Se espera alerta a las ' + hm(+r.firstAlert.t.slice(11, 13)) + ' en ' + name +
      '. Activá a las ' + hm(r.activateHour) + ', antes del pico.'
  };
}

function changeMessage(r, name) {
  if (r.action === 'activate') {
    return {
      title: 'Cambió el pronóstico: activar ahora',
      body: name + ' ya superó el ITH base (' + r.now.b.toFixed(1) + ').'
    };
  }
  return {
    title: 'Cambió el pronóstico: activar ' + (r.activateHour < 0 ? 'lo antes posible' : 'a las ' + hm(r.activateHour)),
    body: 'Se espera alerta desde las ' + hm(+r.firstAlert.t.slice(11, 13)) + ' en ' + name + '.'
  };
}

async function sendTo(item, message, report) {
  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    url: APP_URL
  });
  try {
    await webpush.sendNotification(item.subscription, payload);
    report.sent++;
    console.log('[PUSH] ' + item.location.name + ': ' + message.title);
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.log('Suscripción expirada, eliminando...');
      item._remove = true;
      report.removed++;
    } else {
      console.error('Error enviando push:', err.message);
    }
  }
}

/*
 * Máximo 2 avisos por día por dispositivo:
 *  1) resumen de la mañana (7 a 12 h locales), incluso "hoy no hace falta";
 *  2) aviso previo al riego (1 h antes) o cambio de "no hace falta" a activar.
 * Nunca antes de las 6 h locales y sin repetir el mismo estado.
 */
async function maybeNotify(item, r, parts, report) {
  const date = parts.date;
  let n = item.notify;
  if (!n || n.date !== date) {
    n = item.notify = {
      date,
      count: 0,
      morning: false,
      pre: false,
      change: false,
      lastSummaryAction: 'none',
      lastStateKey: 'none'
    };
  }
  if (parts.hour < 6 || n.count >= 2) return;

  const sk = D.stateKey(r);
  let message = null;

  if (!n.morning && parts.hour >= 7 && parts.hour < 12) {
    message = summaryMessage(r, item.location.name || 'tu campo');
    n.morning = true;
    n.lastSummaryAction = r.action;
    n.lastStateKey = sk;
  } else if (!n.change && n.lastSummaryAction === 'none' && r.action !== 'none') {
    message = changeMessage(r, item.location.name || 'tu campo');
    n.change = true;
    n.lastSummaryAction = r.action;
    n.lastStateKey = sk;
  } else if (!n.pre && r.action === 'prepare' && r.activateHour >= 6) {
    const nowMin = parts.hour * 60 + parts.minute;
    const actMin = r.activateHour * 60;
    if (nowMin >= actMin - 60 && nowMin <= actMin + 15) {
      message = preMessage(r, item.location.name || 'tu campo');
      n.pre = true;
      n.lastStateKey = sk;
    }
  }

  if (!message) return;
  n.count++;
  await sendTo(item, message, report);
}

let checkRunning = false;

async function checkWeatherAndNotify() {
  if (checkRunning) return { checked: 0, sent: 0, removed: 0, skipped: true };
  checkRunning = true;
  try {
    return await runCheck();
  } finally {
    checkRunning = false;
  }
}

async function runCheck() {
  const subs = loadSubscriptions();
  const report = { checked: subs.length, sent: 0, removed: 0 };
  if (!subs.length) return report;

  const nowMs = Date.now();
  const groups = new Map();
  for (const item of subs) {
    const lat = D.num(item.location && item.location.lat, -34.6);
    const lon = D.num(item.location && item.location.lon, -58.4);
    const key = lat.toFixed(3) + ',' + lon.toFixed(3);
    if (!groups.has(key)) groups.set(key, { lat, lon, items: [] });
    groups.get(key).items.push(item);
  }

  for (const g of groups.values()) {
    let j;
    try {
      j = await buildForecast(g.lat, g.lon);
    } catch (e) {
      console.error('No se pudo obtener el pronóstico para ' + g.lat + ',' + g.lon + ': ' + e.message);
      continue;
    }
    const off = j.utc_offset_seconds != null ? j.utc_offset_seconds : 0;
    const parts = D.fieldLocalParts(off, nowMs);
    const r = D.compute(j, {
      nowKey: parts.key,
      offset: 0,
      adjust: true,
      windFactor: D.DEFAULT_WIND_FACTOR,
      useCurrent: true
    });
    for (const item of g.items) {
      try {
        await maybeNotify(item, r, parts, report);
      } catch (e) {
        console.error('Error evaluando aviso:', e.message);
      }
    }
  }

  const cleaned = subs.filter(s => !s._remove);
  saveSubscriptions(cleaned);
  return report;
}

if (require.main === module) {
  setInterval(checkWeatherAndNotify, CHECK_INTERVAL_MS);
  setTimeout(checkWeatherAndNotify, 10000);
  app.listen(PORT, () => {
    console.log('Servidor Web Push corriendo en el puerto ' + PORT);
    if (!API_TOKEN) console.warn('API_TOKEN vacío: /api/subscribe y /api/cron están abiertos.');
  });
}

module.exports = {
  app,
  checkWeatherAndNotify,
  buildForecast,
  loadSubscriptions,
  saveSubscriptions,
  summaryMessage,
  preMessage,
  changeMessage,
  maybeNotify
};
