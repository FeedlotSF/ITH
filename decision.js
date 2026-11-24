/*
 * Lógica única de decisión de estrés calórico.
 * La usan tanto la app (navegador) como el servidor de notificaciones (Node),
 * para que el aviso push nunca contradiga lo que muestra la pantalla.
 *
 * UMD: en el navegador expone window.ECDecision; en Node module.exports.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.ECDecision = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_WIND_FACTOR = 0.75;
  var BASE_THRESHOLDS = [75, 79, 84];

  function num(x, d) {
    var v = parseFloat(x);
    return isFinite(v) ? v : (d || 0);
  }

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function thi(T, H) {
    return 0.8 * T + (H / 100) * (T - 14.4) + 46.4;
  }

  // Mader (2006) amortiguada: mitad de la ecuación, tope ±2 y sin subir más que
  // la mitad del aporte de la radiación. El viento del pronóstico (10 m) se reduce.
  function corr(T, H, W, R, windFactor) {
    var wf = windFactor == null ? DEFAULT_WIND_FACTOR : windFactor;
    var b = thi(T, H);
    R = Math.max(0, num(R));
    var a = 4.51 - 1.992 * num(W) * wf + 0.0068 * R, d = 0.5 * a;
    d = Math.min(d, 0.5 * 0.0068 * R, 2);
    d = Math.max(d, -2);
    return b + d;
  }

  function threshold(i, offset) {
    return BASE_THRESHOLDS[i || 0] + num(offset, 0);
  }

  function zone(v, offset) {
    return v >= threshold(2, offset) ? 3 : v >= threshold(1, offset) ? 2 : v >= threshold(0, offset) ? 1 : 0;
  }

  function prevDay(ds) {
    var dt = new Date(Date.UTC(+ds.slice(0, 4), +ds.slice(5, 7) - 1, +ds.slice(8, 10)));
    dt.setUTCDate(dt.getUTCDate() - 1);
    return dt.toISOString().slice(0, 10);
  }

  function causes(a) {
    var cs = [];
    if (a.R >= 500) cs.push('sol fuerte');
    if (a.W <= 2.5) cs.push('poco viento');
    return cs.length ? cs.join(' y ') : 'la carga de sol y viento';
  }

  // Hora local del campo a partir del desfase guardado, sin usar la zona del celular.
  function fieldNowKey(offsetSeconds, nowMs) {
    var d = new Date(num(nowMs, Date.now()) + num(offsetSeconds, 0) * 1000);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()) + 'T' + pad2(d.getUTCHours());
  }

  function fieldLocalParts(offsetSeconds, nowMs) {
    var d = new Date(num(nowMs, Date.now()) + num(offsetSeconds, 0) * 1000);
    return {
      date: d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate()),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      key: fieldNowKey(offsetSeconds, nowMs)
    };
  }

  function keyAgeHours(a, b) {
    function u(s) {
      return Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +s.slice(11, 13), +(s.slice(14, 16) || 0));
    }
    return (u(b) - u(a)) / 3600000;
  }

  // Promedio horario satelital: historial, franja y relación satélite/modelo.
  // Muta el pronóstico j y devuelve true si pudo aplicar datos satelitales.
  function applySatelliteHourly(j, sat) {
    var st = sat && sat.hourly && sat.hourly.time;
    var sv = sat && sat.hourly && sat.hourly.shortwave_radiation;
    if (!st || !sv || !j || !j.hourly || !j.current) return false;
    var map = {};
    for (var i = 0; i < st.length; i++) {
      var v = sv[i];
      if (v !== null && v !== undefined && isFinite(v)) map[st[i]] = +v;
    }
    var nowH = j.current.time.slice(0, 13), last = null, iNow = 0;
    var rad = j.hourly.shortwave_radiation, orig = rad.slice(), ss = 0, sm = 0, cnt = 0;
    for (var k = 0; k < j.hourly.time.length; k++) {
      var t = j.hourly.time[k];
      if (t.slice(0, 13) <= nowH) {
        iNow = k;
        if (map[t] !== undefined) { rad[k] = map[t]; last = t; }
      }
    }
    if (!last) return false;
    j.current.shortwave_radiation = map[last];
    j._sat = last;
    j._iNow = iNow;
    j._origRad = orig;
    for (var q = iNow; q >= 0 && cnt < 3; q--) {
      var tq = j.hourly.time[q];
      if (map[tq] !== undefined && num(orig[q]) > 100) {
        ss += map[tq];
        sm += num(orig[q]);
        cnt++;
      }
    }
    if (cnt && sm > 0) {
      var r = Math.max(0.1, Math.min(1.3, ss / sm));
      j._r = r;
      for (var f = iNow + 1; f < rad.length; f++) {
        var hf = f - iNow, w = hf <= 3 ? 1 : Math.max(0, 1 - (hf - 3) / 9);
        rad[f] = Math.max(0, num(orig[f]) * (1 + (r - 1) * w));
      }
    }
    return true;
  }

  // Radiación instantánea nativa (pasos de ~10 min). Se guarda el último dato
  // disponible, con un máximo de 3 h de demora.
  function applySatelliteInstant(j, sat) {
    var st = sat && sat.hourly && sat.hourly.time;
    var sv = sat && sat.hourly && sat.hourly.shortwave_radiation_instant;
    if (!st || !sv || !j || !j.current) return false;
    var nowT = j.current.time ? j.current.time.slice(0, 16) : '', last = null, val = null;
    for (var i = 0; i < st.length; i++) {
      var v = sv[i];
      if (v === null || v === undefined || !isFinite(v)) continue;
      var t = st[i].slice(0, 16);
      if (nowT && t > nowT) continue;
      if (last === null || t > last) { last = t; val = +v; }
    }
    if (last === null) return false;
    if (nowT && keyAgeHours(last, nowT) > 3) return false;
    j._satInstant = last;
    j._satInstantVal = Math.max(0, val);
    return true;
  }

  function finalizeSatellite(j) {
    if (j && j._satInstantVal != null) {
      j.current.shortwave_radiation = j._satInstantVal;
      j._sat = j._satInstant;
      j._satIsInstant = true;
    }
  }

  // Sin conexión la persistencia de nubes pierde validez con las horas desde la
  // descarga. Se recalcula desde el modelo original con peso anclado a la descarga.
  function applyOfflineRadiation(j, nowKey) {
    if (!j || !j.hourly) return;
    var rad = j.hourly.shortwave_radiation, orig = j._origRad, r = j._r, iNow = j._iNow;
    if (!rad || !orig || iNow == null || !isFinite(r)) return;
    for (var k = 0; k < rad.length; k++) {
      if (j.hourly.time[k].slice(0, 13) < nowKey) continue;
      var hf = k - iNow;
      if (hf < 0) continue;
      var w = hf <= 3 ? 1 : Math.max(0, 1 - (hf - 3) / 9);
      rad[k] = Math.max(0, num(orig[k]) * (1 + (r - 1) * w));
    }
  }

  /*
   * Decisión. Devuelve la misma información que usa la app para recomendar.
   * opts: { nowKey, offset, adjust, windFactor, useCurrent }
   *  - nowKey: hora local del campo "YYYY-MM-DDTHH"
   *  - useCurrent: usar j.current para el valor actual (online) o la fila horaria (offline)
   */
  function compute(j, opts) {
    opts = opts || {};
    var h = j.hourly, n = h.time.length;
    var wf = opts.windFactor == null ? DEFAULT_WIND_FACTOR : opts.windFactor;
    var offset = num(opts.offset, 0);
    var adjust = opts.adjust !== false;
    var useCurrent = opts.useCurrent !== false && j.current && j.current.time;
    var nowKey = opts.nowKey || (useCurrent ? j.current.time.slice(0, 13) : (n ? h.time[0].slice(0, 13) : ''));

    var idx = 0;
    for (var i = 0; i < n; i++) {
      if (h.time[i].slice(0, 13) <= nowKey) idx = i;
    }

    function at(k) {
      return {
        t: h.time[k],
        T: num(h.temperature_2m[k]),
        H: num(h.relative_humidity_2m[k]),
        W: num(h.wind_speed_10m[k]),
        R: num(h.shortwave_radiation[k])
      };
    }

    var now;
    if (useCurrent) {
      now = {
        t: j.current.time,
        T: num(j.current.temperature_2m),
        H: num(j.current.relative_humidity_2m),
        W: num(j.current.wind_speed_10m),
        R: num(j.current.shortwave_radiation)
      };
    } else {
      now = at(idx);
    }
    now.b = thi(now.T, now.H);
    now.c = corr(now.T, now.H, now.W, now.R, wf);
    now.v = adjust ? now.c : now.b;
    now.z = zone(now.v, offset);

    var win = [];
    for (var k = idx + 1; k <= idx + 12 && k < n; k++) {
      var a = at(k);
      a.b = thi(a.T, a.H);
      a.c = corr(a.T, a.H, a.W, a.R, wf);
      a.v = adjust ? a.c : a.b;
      a.z = zone(a.v, offset);
      win.push(a);
    }

    var bpeak = win.reduce(function (m, a) { return a.b > m ? a.b : m; }, now.b);
    var firstAl = null;
    for (var k2 = 0; k2 < win.length; k2++) {
      if (win[k2].b >= threshold(0, offset)) { firstAl = win[k2]; break; }
    }

    var adjL = [];
    if (now.c >= threshold(0, offset)) adjL.push(now);
    win.forEach(function (a) { if (a.c >= threshold(0, offset)) adjL.push(a); });
    var adjPk = adjL.reduce(function (m, a) { return a.c > m.c ? a : m; }, { c: -99 });

    var date = now.t.slice(0, 10), pd = prevDay(date), tn = [];
    for (var q = 0; q < n; q++) {
      var tt = h.time[q], d = tt.slice(0, 10), hr = +tt.slice(11, 13);
      if ((d === pd && hr >= 21) || (d === date && hr <= 6)) tn.push(num(h.temperature_2m[q]));
    }
    var tmin = tn.length ? Math.min.apply(null, tn) : null;
    var rain = !!(useCurrent && num(j.current.precipitation) > 0.2);

    var blocks = [], curB = null;
    for (var b = 0; b < n; b++) {
      if (h.time[b].slice(0, 10) !== date) continue;
      var ab = at(b), vb = thi(ab.T, ab.H), hb = +ab.t.slice(11, 13);
      if (vb >= threshold(0, offset)) {
        if (!curB) curB = { s: hb, e: hb + 1 };
        else curB.e = hb + 1;
      } else if (curB) {
        blocks.push(curB);
        curB = null;
      }
    }
    if (curB) blocks.push(curB);

    var rangeTxt = blocks.map(function (bk) {
      return pad2(bk.s) + ':00 a ' + (bk.e >= 24 ? '24:00' : pad2(bk.e) + ':00');
    }).join(' y ');
    var rangeH = blocks.reduce(function (s, bk) { return s + (bk.e - bk.s); }, 0);

    var th0 = threshold(0, offset);
    var action, activateHour = null;
    if (now.b >= th0) {
      action = 'activate';
      activateHour = +now.t.slice(11, 13);
    } else if (firstAl) {
      action = 'prepare';
      activateHour = +firstAl.t.slice(11, 13) - 1;
    } else {
      action = 'none';
    }

    var vigilar = null;
    if (now.b < th0 && !firstAl && adjL.length) {
      var f0 = adjL[0], l0 = adjL[adjL.length - 1];
      vigilar = {
        startHour: +f0.t.slice(11, 13),
        endHour: +l0.t.slice(11, 13) + 1,
        peak: adjPk.c,
        causes: causes(adjPk)
      };
    }

    return {
      idx: idx,
      nowKey: nowKey,
      date: date,
      now: now,
      window: win,
      bpeak: bpeak,
      firstAlert: firstAl,
      adjList: adjL,
      adjPeak: adjPk,
      blocks: blocks,
      rangeTxt: rangeTxt,
      rangeHours: rangeH,
      tmin: tmin,
      rain: rain,
      action: action,
      activateHour: activateHour,
      vigilar: vigilar,
      thresholds: [threshold(0, offset), threshold(1, offset), threshold(2, offset)]
    };
  }

  // Clave estable del estado para no repetir el mismo aviso.
  function stateKey(r) {
    if (!r) return 'none';
    if (r.action === 'activate') return 'activate:' + r.activateHour;
    if (r.action === 'prepare') return 'prepare:' + r.activateHour;
    if (r.vigilar) return 'vigilar:' + r.vigilar.startHour + '-' + r.vigilar.endHour;
    return 'none';
  }

  return {
    BASE_THRESHOLDS: BASE_THRESHOLDS,
    DEFAULT_WIND_FACTOR: DEFAULT_WIND_FACTOR,
    num: num,
    pad2: pad2,
    thi: thi,
    corr: corr,
    threshold: threshold,
    zone: zone,
    prevDay: prevDay,
    fieldNowKey: fieldNowKey,
    fieldLocalParts: fieldLocalParts,
    keyAgeHours: keyAgeHours,
    applySatelliteHourly: applySatelliteHourly,
    applySatelliteInstant: applySatelliteInstant,
    finalizeSatellite: finalizeSatellite,
    applyOfflineRadiation: applyOfflineRadiation,
    compute: compute,
    stateKey: stateKey
  };
});
