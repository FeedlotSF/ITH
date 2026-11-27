# Aviso automático para estrés calórico

La aplicación web (`index.html`) y el servidor (`server/server.js`) comparten **la misma lógica de decisión** en `decision.js`. Así el aviso que llega al celular no contradice lo que muestra la pantalla.

---

## 1. Qué avisos envía

Máximo **2 por día** por dispositivo, sin avisar antes de las 6 h locales del campo.

1. **Resumen de la mañana** (entre las 7:00 y las 9:59 h locales): se envía siempre, incluso si hoy no hace falta regar.
   - `Hoy no hace falta regar`
   - `Hoy: activar a las 8:00` (hora de activación)
   - `Hoy: vigilar 12:00 a 13:00` (el ITH base no pide riego, pero el sol o el viento elevan la carga corregida)

2. **Segundo aviso**, siempre entre las 10:00 y las 11:59 h locales:
   - Confirma el pronóstico actualizado (si a la mañana decía “no hace falta” y ahora pasa a preparar/activar).
   - Si no hubo aviso previo ese día, este es el segundo aviso.

No se repite el mismo estado y no se avisa de madrugada.

### Datos que usa
- Pronóstico horario de Open-Meteo (ITH base, viento, lluvia).
- Radiación satelital horaria (GOES-19 vía Open-Meteo Satellite API) para el historial y la proyección de nubes.
- Radiación instantánea nativa (~10 min, ~20 min de demora) para el valor “actual”.
- La hora local se calcula con el `utc_offset_seconds` del campo, no con la zona del celular.

---

## 2. Probar localmente

```powershell
cd "C:\Users\Usuario\.gemini\antigravity\scratch\Estres calorico"
npm --prefix server install
node server/server.js
```

El servidor queda en `http://localhost:3000`. Requiere Node 18 o superior (usa `fetch`).

Endpoints:

| Método | Ruta | Token | Uso |
|---|---|---|---|
| GET | `/api/vapid-public-key` | no | Clave pública para el navegador |
| GET | `/api/health` | no | Estado y cantidad de suscripciones |
| POST | `/api/subscribe` | sí* | Alta de suscripción |
| POST | `/api/unsubscribe` | sí* | Baja |
| GET/POST | `/api/cron` | sí* | Ejecuta el chequeo (lo llama el cron externo) |

*Solo si se define `API_TOKEN`. Si está vacío, quedan abiertos para pruebas.

Variables de entorno:

- `API_TOKEN`: token simple anti-abuso. Poné el mismo valor en `API_TOKEN` dentro de `index.html`.
- `APP_URL`: URL de la app que se abre al tocar la notificación (si falta, el service worker abre la app desde su propio ámbito).
- `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL`: claves push (hay valores por defecto para probar).
- `SUBS_FILE`: ruta alternativa del JSON de suscripciones.
- `PORT`: puerto (Render lo define solo).

---

## 3. Desplegar en Render (gratis)

1. Subí el repo a GitHub.
2. Creá un **Web Service** en Render.
3. Render puede desplegarse de dos formas:
   - **Root Directory vacío** (raíz del repo): Build `npm --prefix server install`, Start `node server/server.js`.
   - **Root Directory `server`**: Build `npm install`, Start `node server.js`. El archivo `server/decision.js` reexporta la lógica compartida de la raíz.
4. Configurá `API_TOKEN` y, si querés, `APP_URL`.
5. En `index.html`, poné la URL de Render en `PUSH_SERVER_URL` y el mismo token en `API_TOKEN`.

### Render gratis se duerme

El plan free suspende el servicio tras unos minutos sin tráfico, y con él se detiene el `setInterval`. Para que el chequeo corra igual:

- Creá un cron externo (por ejemplo **cron-job.org** o **UptimeRobot**) que haga `GET` cada 10 minutos a:
  ```
  https://TU-SERVICIO.onrender.com/api/cron?token=TU_TOKEN
  ```
- Ese pedido despierta el servidor y ejecuta la misma lógica de avisos.
- Alternativa: plan pago de Render (sin suspensión).

### Persistencia

`server/subscriptions.json` vive en el disco efímero de Render: se puede perder al redeploy o al reiniciar. Si necesitás que las suscripciones sobrevivan, usá un disco persistente o una base externa. Las suscripciones push expiradas (404/410) se eliminan solas.

---

## 4. Instalar en el celular

1. Abrí la URL de la app en Chrome (HTTPS).
2. Tocá **"Instalar aplicación"**.
3. En *Notificaciones y Alertas al celular*, tocá **"Activar Alertas al Celular"** y aceptá el permiso.
4. Probá el cron manualmente:
   ```
   https://TU-SERVICIO.onrender.com/api/cron?token=TU_TOKEN
   ```

---

## 5. Lanzamiento automático del servidor (GitHub Actions)

Para que el servidor no se duerma cuando Render lo suspende, se añadió un workflow gratuito en GitHub Actions que dispara cada 10 minutos una petición a `/api/cron`.

- `on.schedule.cron: '*/10 * * * *'`
- `workflow_dispatch` para probar manualmente.

Esto despierta el servidor y ejecuta la lógica de avisos.

---

## 6. Licencia de Open-Meteo

Open-Meteo es gratis para uso **no comercial**. Si la app se usa en una explotación comercial, revisá su licencia y contratá el plan correspondiente: https://open-meteo.com/en/license
