const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const cron = require('node-cron');
const { Resend } = require('resend');


// ========================================
// FIREBASE ADMIN
// ========================================
const serviceAccount = require('/etc/secrets/firebase-key.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();
const auth = admin.auth();

const app = express();
app.use(cors());
app.use(express.json());

const facturacionRouter = require('./routes/facturacion');
app.use('/api/facturacion', facturacionRouter); 

// ========================================
// VARIABLES DE ENTORNO
// ========================================
const PORT = process.env.PORT || 10000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = new Resend(RESEND_API_KEY);

// URL de ESTE servidor. Sirve para decidir si enviar directo o reenviar.
// En el servidor principal: https://barbergo-whatsapp-api.onrender.com
// En el de Capelli:         https://barbergo-whatsapp-api-1.onrender.com
const SELF_URL = (process.env.SELF_URL || 'https://barbergo-whatsapp-api.onrender.com').trim();

// ¿Este servidor corre el escuchador FCM y el cron de recordatorios?
// Poné ENABLE_BACKGROUND_JOBS=true SOLO en el servidor principal para no duplicar.
const ENABLE_BACKGROUND_JOBS = String(process.env.ENABLE_BACKGROUND_JOBS || 'true') === 'true';

// Fallback (compatibilidad): si un bot no define token/phone, usa estos.
const DEFAULT_WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const DEFAULT_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Plantillas por defecto (las de BarberGo). Un bot puede sobrescribirlas.
const DEFAULT_TEMPLATES = {
  pending:      'solicitud_reserva_v3',
  confirmed:    'reserva_confirmada_v2',
  cancelled:    'reserva_cancelada_v3',
  reminder:     'recordatorio_turno_v4',
  rating:       'calificar_barbero_v2',
  thanks:       'agradecimiento_v1'
};

// =====================================================================
// 🤖 CONFIGURACIÓN DE BOTS DESDE FIRESTORE (colección: whatsapp_bots)
// Cada documento describe un bot. Estructura esperada:
//   name, isDefault, companyId, locationIds[], phoneNumberId,
//   whatsappToken, serverUrl, templates{ pending, confirmed, cancelled, reminder, rating, thanks }
// Se cachea en memoria 60s para no leer Firestore en cada mensaje.
// =====================================================================
let BOTS_CACHE = [];
let BOTS_CACHE_AT = 0;
const BOTS_TTL_MS = 60 * 1000;

async function cargarBots(force = false) {
  const ahora = Date.now();
  if (!force && BOTS_CACHE.length && (ahora - BOTS_CACHE_AT) < BOTS_TTL_MS) {
    return BOTS_CACHE;
  }
  try {
    const snap = await db.collection('whatsapp_bots').get();
    BOTS_CACHE = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    BOTS_CACHE_AT = ahora;
    console.log(`🤖 [Bots] Cargados ${BOTS_CACHE.length} bot(s) desde Firestore`);
  } catch (e) {
    console.error('⚠️ [Bots] Error cargando whatsapp_bots:', e.message);
  }
  return BOTS_CACHE;
}

// Bot por defecto: el marcado isDefault, o uno armado con las env vars.
function botPorDefecto(bots) {
  const def = bots.find(b => b.isDefault === true);
  if (def) return def;
  return {
    id: 'env_default',
    name: 'BarberGo (env)',
    isDefault: true,
    companyId: null,
    locationIds: [],
    phoneNumberId: DEFAULT_PHONE_NUMBER_ID,
    whatsappToken: DEFAULT_WHATSAPP_TOKEN,
    serverUrl: SELF_URL,
    templates: DEFAULT_TEMPLATES
  };
}

// Resolver el bot que corresponde a una reserva (por companyId o locationId).
async function resolverBot({ companyId, locationId } = {}) {
  const bots = await cargarBots();
  const comp = String(companyId || '').trim();
  const loc = String(locationId || '').trim();

  // 1. Match exacto por companyId
  if (comp) {
    const porComp = bots.find(b => String(b.companyId || '').trim() === comp);
    if (porComp) return normalizarBot(porComp);
  }
  // 2. Match por locationId dentro de locationIds[]
  if (loc) {
    const porLoc = bots.find(b => Array.isArray(b.locationIds) &&
      b.locationIds.map(x => String(x).trim()).includes(loc));
    if (porLoc) return normalizarBot(porLoc);
  }
  // 3. Si no hay companyId/locationId, intentar resolver companyId desde la location
  if (!comp && loc) {
    try {
      const locSnap = await db.collection('locations').doc(loc).get();
      if (locSnap.exists) {
        const cid = String(locSnap.data().companyId || '').trim();
        if (cid) {
          const porComp2 = bots.find(b => String(b.companyId || '').trim() === cid);
          if (porComp2) return normalizarBot(porComp2);
        }
      }
    } catch (e) { /* ignorar */ }
  }
  // 4. Default
  return normalizarBot(botPorDefecto(bots));
}

// Resolver el bot por el phone_number_id entrante (para el webhook).
async function resolverBotPorPhoneId(phoneNumberId) {
  const bots = await cargarBots();
  const pid = String(phoneNumberId || '').trim();
  const match = bots.find(b => String(b.phoneNumberId || '').trim() === pid);
  if (match) return normalizarBot(match);
  // Fallback: si coincide con la env var del servidor principal
  if (pid && pid === String(DEFAULT_PHONE_NUMBER_ID || '').trim()) {
    return normalizarBot(botPorDefecto(bots));
  }
  return null;
}

// Completa campos faltantes de un bot con los defaults.
function normalizarBot(bot) {
  return {
    id: bot.id || 'unknown',
    name: bot.name || 'Bot',
    isDefault: bot.isDefault === true,
    companyId: bot.companyId || null,
    locationIds: Array.isArray(bot.locationIds) ? bot.locationIds : [],
    phoneNumberId: (bot.phoneNumberId || DEFAULT_PHONE_NUMBER_ID || '').trim(),
    whatsappToken: (bot.whatsappToken || DEFAULT_WHATSAPP_TOKEN || '').trim(),
    serverUrl: (bot.serverUrl || SELF_URL).trim(),
    templates: { ...DEFAULT_TEMPLATES, ...(bot.templates || {}) }
  };
}

// ¿Este bot lo maneja OTRO servidor? (entonces hay que reenviar)
function esDeOtroServidor(bot) {
  return bot.serverUrl && bot.serverUrl.trim() !== SELF_URL;
}

// Reenviar una petición al servidor del bot y devolver su respuesta.
async function reenviar(bot, path, body, res) {
  console.log(`↪️  [Relay] Bot '${bot.name}' vive en ${bot.serverUrl}. Reenviando ${path}`);
  try {
    const r = await fetch(`${bot.serverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json({ ...data, relayedTo: bot.serverUrl });
  } catch (e) {
    console.error('❌ [Relay] No se pudo contactar al servidor del bot:', e.message);
    return res.status(502).json({ success: false, error: 'No se pudo contactar al servidor del bot', relayedTo: bot.serverUrl });
  }
}

// ========================================
// HELPERS DE TELÉFONO
// ========================================
function normalizarNumeroPY(phone) {
  let cleanPhone = String(phone || '').replace(/\D/g, '');
  if (cleanPhone.startsWith('0')) {
    cleanPhone = '595' + cleanPhone.substring(1);
  } else if (!cleanPhone.startsWith('595')) {
    cleanPhone = '595' + cleanPhone;
  }
  return cleanPhone;
}

function numeroMetaALocal(numeroMeta) {
  if (String(numeroMeta).startsWith('595')) {
    return '0' + String(numeroMeta).substring(3);
  }
  return String(numeroMeta || '');
}

// ========================================
// HELPER: VERIFICAR PLAN PREMIUM
// ========================================
async function esPremium(reserva) {
  try {
    const companyId = reserva.companyId;
    if (companyId) {
      const companySnap = await db.collection('companies').doc(companyId).get();
      if (companySnap.exists) {
        const plan = companySnap.data().plan || '';
        return plan.toLowerCase() === 'premium';
      }
    } else {
      const planSnap = await db.collection('config').doc('plan').get();
      if (planSnap.exists) {
        const plan = planSnap.data().level || '';
        return plan.toLowerCase() === 'premium';
      }
    }
  } catch (error) {
    console.error('❌ Error verificando plan premium:', error);
  }
  return false;
}

// ========================================
// HELPER: DATOS DE UBICACIÓN
// ========================================
async function obtenerDatosUbicacion(locationId) {
  const defaults = {
    shopName: 'la barbería',
    mapLink: 'https://maps.app.goo.gl/tu-local',
    shopUrl: 'https://app.barbergo.com.py'
  };
  if (!locationId) return defaults;
  try {
    const locSnap = await db.collection('locations').doc(locationId).get();
    if (locSnap.exists) {
      const locData = locSnap.data();
      return {
        shopName: (locData.name || defaults.shopName).trim(),
        mapLink: locData.mapUrl || defaults.mapLink,
        shopUrl: locData.slug
          ? `https://app.barbergo.com.py/${locData.slug}`
          : defaults.shopUrl
      };
    }
  } catch (error) {
    console.error('❌ Error obteniendo datos de ubicación:', error);
  }
  return defaults;
}

// ========================================
// HELPER: FORMATEAR DATOS DE RESERVA
// ========================================
function formatearReserva(reserva) {
  const dateObj = new Date(reserva.date + 'T00:00:00');
  const opcionesFecha = { weekday: 'short', day: 'numeric', month: 'short' };
  const formattedDate = dateObj.toLocaleDateString('es-ES', opcionesFecha).replace(',', '');

  const clientName = reserva.client?.name || 'Cliente';
  const timeStr = reserva.startTime || reserva.time || '';
  const barberName = reserva.barber?.name || 'Barbero asignado';
  const groupId = reserva.bookingGroupId || reserva.id || '';
  const tId = groupId ? String(groupId).slice(-5) : '-----';
  const serviceName = reserva.services && reserva.services.length > 0
    ? reserva.services.map(s => s.name).join(', ')
    : 'Servicio de barbería';
  const servicePrice = reserva.totalPrice || '0';

  return { clientName, timeStr, barberName, groupId, tId, serviceName, servicePrice, formattedDate };
}

// ========================================
// WHATSAPP: ENVIAR TEMPLATE (usa credenciales del BOT)
// ========================================
async function enviarTemplate(bot, to, templateName, variables = []) {
  const cleanPhone = String(to).replace(/\D/g, '');
  const payload = {
    messaging_product: 'whatsapp',
    to: cleanPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: 'es' },
      ...(variables.length > 0 && {
        components: [{
          type: 'body',
          parameters: variables.map(v => ({ type: 'text', text: String(v) }))
        }]
      })
    }
  };

  console.log(`📤 [${bot.name}] Enviando '${templateName}' a ${cleanPhone} (phoneNumberId: ${bot.phoneNumberId})`);

  const response = await fetch(`https://graph.facebook.com/v22.0/${bot.phoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bot.whatsappToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errData = await response.json();
    console.error(`❌ [${bot.name}] Error de Meta [${templateName}]:`, JSON.stringify(errData));
    return false;
  }
  console.log(`✅ [${bot.name}] Template '${templateName}' enviado a ${cleanPhone}`);
  return true;
}

// ========================================
// WHATSAPP: CONFIRMACIÓN / CANCELACIÓN
// ========================================
async function enviarRespuestaWhatsApp(bot, reserva, nuevoEstado, numeroMeta) {
  try {
    const { shopName, mapLink, shopUrl } = await obtenerDatosUbicacion(reserva.locationId);
    const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);

    const templateName = nuevoEstado === 'confirmed' ? bot.templates.confirmed : bot.templates.cancelled;
    const linkFinal = nuevoEstado === 'confirmed' ? mapLink : shopUrl;
    const variables = [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, linkFinal];

    await enviarTemplate(bot, numeroMeta, templateName, variables);
  } catch (error) {
    console.error('❌ Error en enviarRespuestaWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: RECORDATORIO
// ========================================
async function enviarRecordatorioWhatsApp(bot, reserva) {
  try {
    const { shopName, mapLink } = await obtenerDatosUbicacion(reserva.locationId);
    const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
    const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
    const variables = [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, mapLink];
    await enviarTemplate(bot, cleanPhone, bot.templates.reminder, variables);
  } catch (error) {
    console.error('❌ Error en enviarRecordatorioWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: SOLICITAR CALIFICACIÓN
// ========================================
async function enviarCalificacionWhatsApp(bot, reserva) {
  try {
    const clientName = reserva.client?.name || 'Cliente';
    const barberName = reserva.barber?.name || 'tu barbero';
    const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
    if (!cleanPhone) return;
    const { shopName } = await obtenerDatosUbicacion(reserva.locationId);
    const variables = [clientName, shopName, barberName];
    await enviarTemplate(bot, cleanPhone, bot.templates.rating, variables);
  } catch (error) {
    console.error('❌ Error en enviarCalificacionWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: AGRADECIMIENTO
// ========================================
async function enviarAgradecimientoWhatsApp(bot, reserva, telefonoLocal) {
  try {
    const premium = await esPremium(reserva);
    if (!premium) return;
    const cleanPhone = normalizarNumeroPY(telefonoLocal);
    await enviarTemplate(bot, cleanPhone, bot.templates.thanks, []);
  } catch (error) {
    console.error('❌ Error en enviarAgradecimientoWhatsApp:', error);
  }
}

// ========================================
// RUTAS DE LA API
// ========================================
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, message: 'BarberGo WhatsApp API multi-tenant', self: SELF_URL });
});

// Refrescar caché de bots manualmente (útil tras editar en SuperAdmin)
app.post('/api/recargar-bots', async (req, res) => {
  await cargarBots(true);
  res.json({ ok: true, bots: BOTS_CACHE.map(b => ({ id: b.id, name: b.name, phoneNumberId: b.phoneNumberId })) });
});

// --------------------------------------------------------------------------
// /api/enviar-mensaje
// --------------------------------------------------------------------------
app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [], locationId, companyId } = req.body;
    if (!phone || !templateName) return res.status(400).json({ success: false, error: 'Faltan datos' });

    let bot = await resolverBot({ companyId, locationId });

    // Fallback: si vino sin routing, intentar resolver por la última reserva del teléfono
    if (bot.isDefault && !companyId && !locationId) {
      try {
        const telefonoLocal = numeroMetaALocal(normalizarNumeroPY(phone));
        const snap = await db.collection('bookings')
          .where('client.phone', '==', telefonoLocal)
          .orderBy('createdAt', 'desc').limit(3).get();
        for (const d of snap.docs) {
          const b = d.data();
          const botB = await resolverBot({ companyId: b.companyId, locationId: b.locationId });
          if (!botB.isDefault) { bot = botB; break; }
        }
      } catch (e) {
        console.error('⚠️ [Fallback] Error resolviendo por teléfono:', e.message);
      }
    }

    // Si el bot lo maneja otro servidor, reenviar
    if (esDeOtroServidor(bot)) {
      return reenviar(bot, '/api/enviar-mensaje', req.body, res);
    }

    const cleanPhone = normalizarNumeroPY(phone);
    const ok = await enviarTemplate(bot, cleanPhone, templateName, params);
    return res.status(ok ? 200 : 500).json({ success: ok, sentBy: bot.name });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// --------------------------------------------------------------------------
// /api/admin-notificar-cancelacion
// --------------------------------------------------------------------------
app.post('/api/admin-notificar-cancelacion', async (req, res) => {
  try {
    const { reserva } = req.body;
    if (!reserva || !reserva.client || !reserva.client.phone) {
      return res.status(400).json({ success: false, error: 'Faltan datos de la reserva o del cliente' });
    }
    const bot = await resolverBot({ companyId: reserva.companyId, locationId: reserva.locationId });
    if (esDeOtroServidor(bot)) {
      return reenviar(bot, '/api/admin-notificar-cancelacion', req.body, res);
    }
    const numeroMeta = normalizarNumeroPY(reserva.client.phone);
    await enviarRespuestaWhatsApp(bot, reserva, 'cancelled', numeroMeta);
    return res.status(200).json({ success: true, message: 'Mensaje de cancelación enviado', sentBy: bot.name });
  } catch (error) {
    console.error('❌ Error en /api/admin-notificar-cancelacion:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// --------------------------------------------------------------------------
// /api/reserva-completada
// --------------------------------------------------------------------------
app.post('/api/reserva-completada', async (req, res) => {
  try {
    const { bookingId } = req.body;
    if (!bookingId) return res.status(400).json({ success: false, error: 'Falta bookingId' });

    const bookingRef = db.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists) return res.status(404).json({ success: false, error: 'Reserva no encontrada' });

    let bookingRef2 = bookingRef;
    let realBooking = bookingSnap.data();

    if (!realBooking.isPrimary && realBooking.bookingGroupId) {
      const groupSnap = await db.collection('bookings')
        .where('bookingGroupId', '==', realBooking.bookingGroupId)
        .where('isPrimary', '==', true).limit(1).get();
      if (!groupSnap.empty) {
        bookingRef2 = groupSnap.docs[0].ref;
        realBooking = groupSnap.docs[0].data();
      }
    }

    const bot = await resolverBot({ companyId: realBooking.companyId, locationId: realBooking.locationId });
    if (esDeOtroServidor(bot)) {
      return reenviar(bot, '/api/reserva-completada', req.body, res);
    }

    if (!realBooking.isPrimary) {
      return res.status(200).json({ success: true, message: 'No es reserva primaria, ignorado' });
    }
    if (realBooking.ratingTemplateSent) {
      return res.status(200).json({ success: true, message: 'Rating ya enviado previamente' });
    }

    const premium = await esPremium(realBooking);
    if (!premium) {
      await bookingRef2.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'No es cuenta Premium' });
    }

    await enviarCalificacionWhatsApp(bot, realBooking);
    await bookingRef2.update({ ratingTemplateSent: true, isReviewed: false });
    return res.status(200).json({ success: true, message: 'Solicitud de calificación enviada', sentBy: bot.name });
  } catch (error) {
    console.error('❌ Error en /api/reserva-completada:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// --------------------------------------------------------------------------
// /api/enviar-correo-recuperacion
// --------------------------------------------------------------------------
app.post('/api/enviar-correo-recuperacion', async (req, res) => {
  try {
    const { email, returnUrl } = req.body;
    if (!email) return res.status(400).json({ error: 'Falta el correo electrónico.' });

    const firebaseLink = await auth.generatePasswordResetLink(email);
    const urlObj = new URL(firebaseLink);
    const oobCode = urlObj.searchParams.get('oobCode');
    const rutaDestino = returnUrl || '/';
    const miLink = `https://app.barbergo.com.py/reset-password?oobCode=${oobCode}&return=${encodeURIComponent(rutaDestino)}`;

    const { error } = await resend.emails.send({
      from: 'Soporte Barber GO <soporte@barbergo.com.py>',
      to: email,
      subject: '💈 Recupera tu contraseña de Barber GO',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:auto">
                  <h2>Recuperá tu contraseña</h2>
                  <p>Hacé clic en el botón para restablecer tu contraseña:</p>
                  <a href="${miLink}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">
                    Restablecer contraseña
                  </a>
                  <p style="margin-top:16px;font-size:12px;color:#888">Este enlace expira en 1 hora.</p>
                </div>`
    });

    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error en /api/enviar-correo-recuperacion:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ========================================
// WEBHOOK META
// ========================================
app.get('/webhook', (req, res) => {
  const { 'hub.mode': mode, 'hub.verify_token': token, 'hub.challenge': challenge } = req.query;
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        if (!value.messages || !Array.isArray(value.messages)) continue;

        const phoneNumberId = value.metadata?.phone_number_id;

        // 🤖 Resolver el bot dueño de este número
        const bot = await resolverBotPorPhoneId(phoneNumberId);
        if (!bot) {
          console.log(`⚠️ [Webhook] phone_number_id ${phoneNumberId} no corresponde a ningún bot de este servidor. Ignorado.`);
          continue;
        }

        for (const mensaje of value.messages) {
          const numeroMeta = mensaje.from || '';
          const telefonoLocal = numeroMetaALocal(numeroMeta);
          const tipo = mensaje.type || '';
          let respuestaCliente = '';

          if (tipo === 'text') {
            respuestaCliente = mensaje.text?.body?.toLowerCase()?.trim() || '';
          } else if (tipo === 'button') {
            respuestaCliente = mensaje.button?.text?.toLowerCase()?.trim() || '';
          } else if (tipo === 'interactive') {
            respuestaCliente =
              mensaje.interactive?.button_reply?.title?.toLowerCase()?.trim() ||
              mensaje.interactive?.list_reply?.title?.toLowerCase()?.trim() || '';
          }

          console.log(`📞 [${bot.name}] Mensaje de: ${numeroMeta} | Texto: "${respuestaCliente}" | Tipo: ${tipo}`);

          // 1. CALIFICACIÓN (1-5)
          const ratingMatch = respuestaCliente.trim().match(/^[1-5]$/);
          if (ratingMatch) {
            const stars = parseInt(ratingMatch[0]);
            await db.collection('rating_sessions').doc(telefonoLocal).set({
              stars, phone: telefonoLocal,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              expiresAt: new Date(Date.now() + 10 * 60 * 1000)
            });
            continue;
          }

          // 2. COMENTARIO DE CALIFICACIÓN
          const sessionSnap = await db.collection('rating_sessions').doc(telefonoLocal).get();
          if (sessionSnap.exists) {
            const session = sessionSnap.data();
            const now = new Date();
            const expiresAt = session.expiresAt?.toDate ? session.expiresAt.toDate() : new Date(session.expiresAt);

            if (now < expiresAt) {
              const stars = session.stars;
              const comment = respuestaCliente.trim();
              await db.collection('rating_sessions').doc(telefonoLocal).delete();

              const snapshot = await db.collection('bookings')
                .where('client.phone', '==', telefonoLocal)
                .where('status', '==', 'completed')
                .orderBy('createdAt', 'desc').limit(5).get();

              // Solo reseñas de reservas que pertenecen a ESTE bot
              const bookingDoc = snapshot.docs.find(d => {
                if (d.data().isReviewed === true) return false;
                return botPerteneceAReserva(bot, d.data());
              });
              if (!bookingDoc) continue;

              const booking = bookingDoc.data();
              const locationId = booking.locationId ? String(booking.locationId).trim() : null;
              const barberId = booking.barber?.id ? String(booking.barber.id).trim() : null;
              if (!locationId || !barberId) {
                await bookingDoc.ref.update({ isReviewed: true, reviewComment: 'Error: Faltan datos' });
                continue;
              }

              let barberRef = null;
              const barberDirectSnap = await db.collection('locations').doc(locationId).collection('barbers').doc(barberId).get();
              if (barberDirectSnap.exists) {
                barberRef = barberDirectSnap.ref;
              } else {
                for (const idValue of [Number(barberId), barberId]) {
                  const q = await db.collection('locations').doc(locationId).collection('barbers').where('id', '==', idValue).limit(1).get();
                  if (!q.empty) { barberRef = q.docs[0].ref; break; }
                }
              }
              if (!barberRef) {
                await bookingDoc.ref.update({ isReviewed: true, reviewComment: 'Error: Barbero no encontrado' });
                continue;
              }

              let ratingGuardado = false;
              await db.runTransaction(async (t) => {
                const barberDoc = await t.get(barberRef);
                if (!barberDoc.exists) return;
                const currentRating = barberDoc.data().rating || 0;
                const currentReviewsCount = barberDoc.data().reviewsCount || 0;
                const newCount = currentReviewsCount + 1;
                const newRating = ((currentRating * currentReviewsCount) + stars) / newCount;
                t.update(barberRef, { rating: parseFloat(newRating.toFixed(1)), reviewsCount: newCount });
                t.update(bookingDoc.ref, { isReviewed: true, reviewStars: stars, reviewComment: comment });
                t.set(barberRef.collection('reviews').doc(bookingDoc.id), {
                  clientId: booking.userId || booking.client?.phone || 'whatsapp-user',
                  clientName: booking.client?.name || 'Cliente de WhatsApp',
                  stars: Number(stars), comment,
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                  bookingId: bookingDoc.id
                });
                ratingGuardado = true;
              });

              if (ratingGuardado) await enviarAgradecimientoWhatsApp(bot, booking, telefonoLocal);
              continue;
            } else {
              await db.collection('rating_sessions').doc(telefonoLocal).delete();
            }
          }

          // 3. CONFIRMACIÓN / CANCELACIÓN
          const palabrasMensaje = respuestaCliente.split(/[\s,.!?;:()]+/).filter(Boolean);
          const exactasConfirmar = ['si', 'sí', 'sii', 'siii', 'ok', 'okey', 'dale', 'voy', 'asisto', 'perfecto', 'excelente', 'seguro'];
          const exactasCancelar = ['no', 'imposible'];
          const esConfirmar = palabrasMensaje.some(p => exactasConfirmar.includes(p)) || respuestaCliente.includes('confirm') || respuestaCliente === '✅ confirmar';
          const esCancelar = palabrasMensaje.some(p => exactasCancelar.includes(p)) || respuestaCliente.includes('cancel') || respuestaCliente.includes('no voy') || respuestaCliente === '❌ cancelar turno';

          let nuevoEstado = null;
          if (esCancelar) nuevoEstado = 'cancelled';
          else if (esConfirmar) nuevoEstado = 'confirmed';
          if (!nuevoEstado) continue;

          try {
            const estadosValidos = nuevoEstado === 'confirmed' ? ['pending'] : ['pending', 'confirmed'];
            const snapshot = await db.collection('bookings')
              .where('client.phone', '==', telefonoLocal)
              .where('status', 'in', estadosValidos)
              .orderBy('createdAt', 'desc').get();

            // Solo reservas de ESTE bot
            const reservaDoc = snapshot.docs.find(d => botPerteneceAReserva(bot, d.data()));
            if (!reservaDoc) continue;

            const reserva = reservaDoc.data();
            const groupId = reserva.bookingGroupId;
            if (nuevoEstado === 'confirmed' && reserva.status === 'confirmed') continue;

            if (!groupId) {
              await db.collection('bookings').doc(reservaDoc.id).update({ status: nuevoEstado, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            } else {
              const bloquesSnapshot = await db.collection('bookings').where('bookingGroupId', '==', groupId).get();
              const batch = db.batch();
              bloquesSnapshot.forEach(doc => batch.update(doc.ref, { status: nuevoEstado, updatedAt: admin.firestore.FieldValue.serverTimestamp() }));
              await batch.commit();
            }

            await enviarRespuestaWhatsApp(bot, reserva, nuevoEstado, numeroMeta);
          } catch (dbError) {
            console.error('❌ Error interactuando con Firestore:', dbError);
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Error procesando POST /webhook:', error);
  }
});

// ¿La reserva pertenece a este bot? (por companyId o locationId del bot)
function botPerteneceAReserva(bot, reserva) {
  const comp = String(reserva.companyId || '').trim();
  const loc = String(reserva.locationId || '').trim();
  if (bot.companyId && comp === String(bot.companyId).trim()) return true;
  if (bot.locationIds.map(x => String(x).trim()).includes(loc)) return true;
  // El bot default acepta reservas que no matchean ningún bot específico
  if (bot.isDefault) return true;
  return false;
}

// ========================================
// CRON: RECORDATORIOS 3 HORAS ANTES
// (Solo en el servidor con ENABLE_BACKGROUND_JOBS=true)
// ========================================
if (ENABLE_BACKGROUND_JOBS) {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion' }));
      const todayStr = now.toISOString().split('T')[0];
      const snapshot = await db.collection('bookings')
        .where('date', '==', todayStr)
        .where('status', '==', 'confirmed')
        .where('reminderSent', '==', false).get();

      for (const doc of snapshot.docs) {
        const reserva = doc.data();
        const bot = await resolverBot({ companyId: reserva.companyId, locationId: reserva.locationId });

        // Si el recordatorio lo maneja otro servidor, lo dejamos para él
        if (esDeOtroServidor(bot)) continue;

        const timeStr = reserva.startTime || reserva.time;
        if (!timeStr) continue;
        const [bookHour, bookMin] = timeStr.split(':').map(Number);
        const bookingTime = new Date(now);
        bookingTime.setHours(bookHour, bookMin, 0, 0);
        const diffMinutes = Math.floor((bookingTime - now) / 60000);

        if (diffMinutes >= 165 && diffMinutes <= 195) {
          await db.collection('bookings').doc(doc.id).update({
            reminderSent: true,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await enviarRecordatorioWhatsApp(bot, reserva);
        }
      }
    } catch (error) {
      console.error('❌ Error en Cron Job de recordatorios:', error);
    }
  });
}

// ========================================
// NOTIFICACIONES PUSH FCM — ENDPOINT
// ========================================
app.post('/api/notificar-reserva', async (req, res) => {
  const { tokens, title, body, data } = req.body;
  if (!tokens || tokens.length === 0) return res.status(400).json({ error: 'Sin tokens' });
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      data: {
        title: title || '¡Nueva Reserva! 💈',
        body: body || 'Tienes un nuevo turno agendado',
        bookingId: data?.bookingId || '',
        locationId: data?.locationId || ''
      },
      android: { priority: 'high', ttl: 60000 },
      webpush: { headers: { Urgency: 'high' } }
    });
    console.log(`📡 FCM: ${response.successCount} enviados, ${response.failureCount} fallidos`);
    res.json({ success: true, enviados: response.successCount });
  } catch (error) {
    console.error('❌ Error FCM:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 BarberGo Meta API multi-tenant en puerto ${PORT}`);
  console.log(`🔗 SELF_URL: ${SELF_URL} | background jobs: ${ENABLE_BACKGROUND_JOBS}`);
  cargarBots(true);
});

// =====================================================================
// 🔔 ESCUCHADOR AUTOMÁTICO DE NUEVAS RESERVAS → PUSH FCM
// (Solo en el servidor con ENABLE_BACKGROUND_JOBS=true)
// Data-only: el SW muestra la notificación con logo. Sin duplicados.
// =====================================================================
if (ENABLE_BACKGROUND_JOBS) {
  let isListenerReady = false;
  setTimeout(() => {
    db.collection('bookings')
      .where('status', 'in', ['pending', 'confirmed'])
      .onSnapshot(async (snapshot) => {
        if (!isListenerReady) {
          isListenerReady = true;
          console.log('👂 Escuchador de reservas activo');
          return;
        }

        for (const change of snapshot.docChanges()) {
          if (change.type !== 'added') continue;
          const booking = change.doc.data();
          if (!booking.isPrimary) continue;

          const locationId = String(booking.locationId || '').trim();
          if (!locationId) continue;

          let bookingTime = 0;
          if (booking.createdAt?.toMillis) bookingTime = booking.createdAt.toMillis();
          else if (booking.createdAt?.seconds) bookingTime = booking.createdAt.seconds * 1000;
          if (Date.now() - bookingTime > 120000) continue;

          console.log(`🔔 Nueva reserva detectada: ${booking.client?.name} | loc: ${locationId}`);

          try {
            const tokensSnap = await db.collection('admin_tokens')
              .where('locationId', '==', locationId).get();
            if (tokensSnap.empty) {
              console.log('⚠️ Sin tokens para locationId:', locationId);
              continue;
            }
            const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
            if (tokens.length === 0) continue;

            console.log(`📲 Enviando push a ${tokens.length} dispositivo(s)...`);
            const response = await admin.messaging().sendEachForMulticast({
              tokens,
              data: {
                title: '¡Nueva Reserva! 💈',
                body: `${booking.client?.name || 'Cliente'} - ${booking.startTime || booking.time || ''}`,
                bookingId: booking.bookingGroupId || change.doc.id || '',
                locationId: locationId
              },
              android: { priority: 'high', ttl: 60000 },
              apns: {
                payload: { aps: { 'content-available': 1, sound: 'default', badge: 1 } },
                headers: { 'apns-priority': '10' }
              },
              webpush: { headers: { Urgency: 'high' } }
            });
            console.log(`📡 FCM servidor: ${response.successCount} enviados, ${response.failureCount} fallidos`);
            response.responses.forEach((r, i) => {
              if (!r.success) console.error(`❌ Token ${i} falló:`, r.error?.code, r.error?.message);
            });
          } catch (e) {
            console.error('❌ Error enviando push desde servidor:', e.message);
          }
        }
      });
  }, 3000);
}