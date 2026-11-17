const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Claves VAPID para autenticarse ante los servicios Push de Google (FCM), Mozilla y Apple
const publicVapidKey = process.env.VAPID_PUBLIC_KEY || 'BCT2DednHhMsDVX_2VOWUNcWceQYdO27sAeH8BA6fwqqCKFmD0O6XT-BIWmR4VpTPmkdAYPXLV0mqRbgPT5qTZY';
const privateVapidKey = process.env.VAPID_PRIVATE_KEY || 'dEaFFapI3SlJH6_5jRLUjXZlkdIQeJsMf9mN9YGPNpc';
const contactEmail = process.env.VAPID_EMAIL || 'mailto:admin@estrescalorico.local';

webpush.setVapidDetails(contactEmail, publicVapidKey, privateVapidKey);

const DB_FILE = path.join(__dirname, 'subscriptions.json');

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
    console.error('Error guardando suscripciones:', e);
  }
}

// Servir la clave pública al frontend
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: publicVapidKey });
});

// Guardar la suscripción de un celular
app.post('/api/subscribe', (req, res) => {
  const { subscription, location } = req.body;
  if (!subscription || !subscription.endpoint) {
    return res.status(400).json({ error: 'Suscripción inválida' });
  }

  let subs = loadSubscriptions();
  // Filtrar si ya existía para actualizar ubicación
  subs = subs.filter(s => s.subscription.endpoint !== subscription.endpoint);
  subs.push({
    subscription,
    location: location || { lat: -34.6, lon: -58.4, name: 'Buenos Aires' },
    lastNotified: 0,
    created: Date.now()
  });

  saveSubscriptions(subs);
  console.log('Dispositivo registrado. Total registrados:', subs.length);
  res.status(201).json({ success: true, count: subs.length });
});

// Desuscribir
app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  let subs = loadSubscriptions();
  subs = subs.filter(s => s.subscription.endpoint !== endpoint);
  saveSubscriptions(subs);
  res.json({ success: true });
});

// Función de cálculo de ITH Ganadero
function calcITH(t, rh) {
  return 0.8 * t + (rh / 100) * (t - 14.4) + 46.4;
}

// Chequeo periódico de clima e ITH (cada 15 minutos)
async function checkWeatherAndNotify() {
  const subs = loadSubscriptions();
  if (!subs.length) return;

  const now = Date.now();
  for (const item of subs) {
    // Evitar enviar más de 1 alerta cada 3 horas por dispositivo salvo cambio grave
    if (now - (item.lastNotified || 0) < 3 * 3600 * 1000) {
      continue;
    }

    const { lat, lon, name } = item.location;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m&hourly=temperature_2m,relative_humidity_2m&timezone=auto&forecast_days=1`;

    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();

      const temp = data.current.temperature_2m;
      const rh = data.current.relative_humidity_2m;
      const ith = Math.round(calcITH(temp, rh));

      let level = null;
      let bodyMsg = '';

      if (ith >= 84) {
        level = 'EMERGENCIA';
        bodyMsg = `¡EMERGENCIA TÉRMICA (ITH ${ith}) en ${name}! Temp: ${temp}°C, HR: ${rh}%. Activar aspersión continua e hidratación extrema.`;
      } else if (ith >= 79) {
        level = 'PELIGRO';
        bodyMsg = `¡PELIGRO de estrés calórico (ITH ${ith}) en ${name}! Se aconseja mojar animales y revisar sombras.`;
      } else if (ith >= 75) {
        level = 'ALERTA';
        bodyMsg = `ALERTA de ITH (${ith}) en ${name}. Condiciones de estrés térmico temprano. Preparar ciclo de riego.`;
      }

      if (level) {
        const payload = JSON.stringify({
          title: `⚠️ ${level} ITH: ${ith} · ${name}`,
          body: bodyMsg,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          url: '/'
        });

        await webpush.sendNotification(item.subscription, payload);
        item.lastNotified = now;
        console.log(`[ALERTA ENVIADA] a ${name} (${level} ITH ${ith})`);
      }
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Suscripción expirada en el celular, limpiar
        console.log('Suscripción expirada, eliminando...');
        item._remove = true;
      } else {
        console.error('Error enviando push:', err.message);
      }
    }
  }

  const cleaned = subs.filter(s => !s._remove);
  if (cleaned.length !== subs.length) {
    saveSubscriptions(cleaned);
  }
}

// Iniciar chequeo automático cada 15 minutos
setInterval(checkWeatherAndNotify, 15 * 60 * 1000);
// Chequeo inicial a los 10 segundos del arranque
setTimeout(checkWeatherAndNotify, 10000);

app.listen(PORT, () => {
  console.log(`Servidor Web Push corriendo en el puerto ${PORT}`);
});

