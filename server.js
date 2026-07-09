const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const cron = require('node-cron');
const { Resend } = require('resend');

const serviceAccount = JSON.parse(process.env.FIREBASE_KEY_JSON);
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();
const auth = admin.auth();
const app = express();
app.use(cors());
app.use(express.json());

const facturacionRouter = require('./routes/facturacion');
app.use('/api/facturacion', facturacionRouter);

const PORT = process.env.PORT || 10000;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = new Resend(RESEND_API_KEY);

const SELF_URL = (process.env.SELF_URL || 'https://barbergo-whatsapp-api-production.up.railway.app').trim();
const ENABLE_BACKGROUND_JOBS = String(process.env.ENABLE_BACKGROUND_JOBS || 'true') === 'true';

const DEFAULT_WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const DEFAULT_PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const DEFAULT_TEMPLATES = {
  pending:   'solicitud_reserva_v3',
  confirmed: 'reserva_confirmada_v2',
  cancelled: 'reserva_cancelada_v3',
  reminder:  'recordatorio_turno_v4',
  rating:    'calificar_barbero_v2',
  thanks:    'agradecimiento_v1'
};

// =====================================================================
// 📋 PLANES Y LÍMITES
// basic       → Gs. 99.000  → 150 msgs/mes  | 1 local | 1 barbero
// premium     → Gs. 149.000 → 250 msgs/mes  | 1 local | 3 barberos
// empresarial → Gs. 499.000 → 750 msgs/mes  | 3 locales | 20 barberos
// trial       → 5 msgs/día (solo durante los 14 días de prueba)
//
// LÓGICA PLAN BÁSICO:
// - NO envía solicitud de reserva ni confirmación
// - SOLO envía recordatorio_confirmacion (24hs antes si es mañana, 3hs antes si es hoy)
// - El cliente confirma/cancela desde esa plantilla — se identifica por teléfono exacto
// =====================================================================
const PLANES = {
  basic:       { whatsapp: true, mensualLimit: 150 },
  premium:     { whatsapp: true, mensualLimit: 250 },
  empresarial: { whatsapp: true, mensualLimit: 750 },
};

const PLAN_CACHE = new Map();
const PLAN_TTL_MS = 60 * 1000;

async function obtenerDatosEmpresa(companyId) {
  if (!companyId) return null;
  const ahora = Date.now();
  const cached = PLAN_CACHE.get(companyId);
  if (cached && (ahora - cached.cachedAt) < PLAN_TTL_MS) return cached;
  try {
    const snap = await db.collection('companies').doc(companyId).get();
    if (!snap.exists) return null;
    const data = snap.data();
    const result = {
      plan: (data.plan || 'basic').toLowerCase(),
      subscriptionStatus: data.subscriptionStatus || 'trial',
      createdAt: data.createdAt,
      cachedAt: ahora
    };
    PLAN_CACHE.set(companyId, result);
    return result;
  } catch (e) {
    console.error('❌ Error obteniendo datos de empresa:', e.message);
    return null;
  }
}

async function verificarSesion(telefono, companyId) {
  if (!companyId) return { esNueva: true, permitido: true };
  const docId = `sesion_${companyId}_${telefono}`;
  const ref = db.collection('sesiones_bot').doc(docId);
  const ahora = Date.now();
  try {
    const snap = await ref.get();
    if (snap.exists) {
      const data = snap.data();
      const ultima = data.ultimaInteraccion?.toMillis ? data.ultimaInteraccion.toMillis() : 0;
      const esActiva = (ahora - ultima) < 24 * 60 * 60 * 1000;
      if (esActiva) {
        const contador = data.contadorSpam || 0;
        if (contador >= 20) {
          console.log(`🚫 [Spam] ${telefono} bloqueado`);
          return { esNueva: false, bloqueadoPorSpam: true };
        }
        await ref.update({ contadorSpam: contador + 1, ultimaInteraccion: admin.firestore.FieldValue.serverTimestamp() });
        return { esNueva: false, bloqueadoPorSpam: false };
      }
    }
    const { permitido, motivo } = await verificarPermisoWhatsApp(companyId);
    if (!permitido) return { esNueva: true, permitido: false, motivo };
    await ref.set({
      telefono, companyId, contadorSpam: 1,
      ultimaInteraccion: admin.firestore.FieldValue.serverTimestamp(),
      creadoEn: admin.firestore.FieldValue.serverTimestamp()
    });
    return { esNueva: true, permitido: true };
  } catch (e) {
    console.error('❌ Error verificando sesión:', e.message);
    return { esNueva: true, permitido: true };
  }
}

async function verificarPermisoWhatsApp(companyId) {
  if (!companyId) return { permitido: true, motivo: 'sin_empresa' };
  const empresa = await obtenerDatosEmpresa(companyId);
  if (!empresa) return { permitido: true, motivo: 'empresa_no_encontrada' };
  const { plan, subscriptionStatus, createdAt } = empresa;

  if (subscriptionStatus === 'trial') {
    if (createdAt) {
      const created = createdAt.toMillis ? createdAt.toMillis() : createdAt.seconds * 1000;
      if (Math.floor((Date.now() - created) / 86400000) > 14)
        return { permitido: false, motivo: 'trial_expirado' };
    }
    const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' });
    const ref = db.collection('usage_daily').doc(`trial_${companyId}_${hoy}`);
    try {
      const resultado = await db.runTransaction(async (t) => {
        const snap = await t.get(ref);
        const actual = snap.exists ? (snap.data().count || 0) : 0;
        if (actual >= 5) return { permitido: false, count: actual };
        t.set(ref, { companyId, date: hoy, count: actual + 1, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        return { permitido: true, count: actual + 1 };
      });
      if (!resultado.permitido) {
        console.log(`🚫 [Trial] ${companyId} topó 5 mensajes hoy.`);
        return { permitido: false, motivo: 'trial_limite_diario' };
      }
      console.log(`📊 [Trial] ${companyId} usa ${resultado.count}/5 hoy.`);
      return { permitido: true, motivo: 'trial_ok' };
    } catch (e) {
      return { permitido: true, motivo: 'error_trial' };
    }
  }

  const configPlan = PLANES[plan] || PLANES['basic'];
  const mesActual = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' }).slice(0, 7);
  const ref = db.collection('usage_monthly').doc(`monthly_${companyId}_${mesActual}`);
  try {
    const resultado = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      const actual = snap.exists ? (snap.data().count || 0) : 0;
      if (actual >= configPlan.mensualLimit) return { permitido: false, count: actual };
      t.set(ref, { companyId, plan, mes: mesActual, count: actual + 1, limit: configPlan.mensualLimit, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { permitido: true, count: actual + 1 };
    });
    if (!resultado.permitido) {
      console.log(`🚫 [${plan}] ${companyId} topó ${configPlan.mensualLimit} msgs este mes.`);
      try {
        await db.collection('companies').doc(companyId).set({
          whatsappAlert: { type: 'limite_100', count: resultado.count, limit: configPlan.mensualLimit, mes: mesActual, updatedAt: admin.firestore.FieldValue.serverTimestamp() }
        }, { merge: true });
      } catch (e) { /* ignorar */ }
      return { permitido: false, motivo: `limite_mensual_${plan}` };
    }
    if (resultado.count >= Math.floor(configPlan.mensualLimit * 0.8)) {
      try {
        await db.collection('companies').doc(companyId).set({
          whatsappAlert: { type: 'limite_80', count: resultado.count, limit: configPlan.mensualLimit, mes: mesActual, updatedAt: admin.firestore.FieldValue.serverTimestamp() }
        }, { merge: true });
      } catch (e) { /* ignorar */ }
    }
    console.log(`📊 [${plan}] ${companyId} usa ${resultado.count}/${configPlan.mensualLimit} msgs este mes.`);
    return { permitido: true, motivo: `${plan}_ok` };
  } catch (e) {
    return { permitido: true, motivo: 'error_mensual' };
  }
}

let BOTS_CACHE = [];
let BOTS_CACHE_AT = 0;
const BOTS_TTL_MS = 60 * 1000;

async function cargarBots(force = false) {
  const ahora = Date.now();
  if (!force && BOTS_CACHE.length && (ahora - BOTS_CACHE_AT) < BOTS_TTL_MS) return BOTS_CACHE;
  try {
    const snap = await db.collection('whatsapp_bots').get();
    BOTS_CACHE = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    BOTS_CACHE_AT = ahora;
    console.log(`🤖 [Bots] Cargados ${BOTS_CACHE.length} bot(s) desde Firestore`);
  } catch (e) { console.error('⚠️ [Bots] Error:', e.message); }
  return BOTS_CACHE;
}

function botPorDefecto(bots) {
  const def = bots.find(b => b.isDefault === true);
  if (def) return def;
  return { id: 'env_default', name: 'BarberGo (env)', isDefault: true, companyId: null, locationIds: [], phoneNumberId: DEFAULT_PHONE_NUMBER_ID, whatsappToken: DEFAULT_WHATSAPP_TOKEN, serverUrl: SELF_URL, templates: DEFAULT_TEMPLATES };
}

async function resolverBot({ companyId, locationId } = {}) {
  const bots = await cargarBots();
  const comp = String(companyId || '').trim();
  const loc = String(locationId || '').trim();
  if (comp) { const b = bots.find(b => String(b.companyId || '').trim() === comp); if (b) return normalizarBot(b); }
  if (loc) { const b = bots.find(b => Array.isArray(b.locationIds) && b.locationIds.map(x => String(x).trim()).includes(loc)); if (b) return normalizarBot(b); }
  if (!comp && loc) {
    try {
      const snap = await db.collection('locations').doc(loc).get();
      if (snap.exists) { const cid = String(snap.data().companyId || '').trim(); if (cid) { const b = bots.find(b => String(b.companyId || '').trim() === cid); if (b) return normalizarBot(b); } }
    } catch (e) { /* ignorar */ }
  }
  return normalizarBot(botPorDefecto(bots));
}

async function resolverBotPorPhoneId(phoneNumberId) {
  const bots = await cargarBots();
  const pid = String(phoneNumberId || '').trim();
  const match = bots.find(b => String(b.phoneNumberId || '').trim() === pid);
  if (match) return normalizarBot(match);
  if (pid && pid === String(DEFAULT_PHONE_NUMBER_ID || '').trim()) return normalizarBot(botPorDefecto(bots));
  return null;
}

function normalizarBot(bot) {
  return {
    id: bot.id || 'unknown', name: bot.name || 'Bot', isDefault: bot.isDefault === true,
    companyId: bot.companyId || null, locationIds: Array.isArray(bot.locationIds) ? bot.locationIds : [],
    phoneNumberId: (bot.phoneNumberId || DEFAULT_PHONE_NUMBER_ID || '').trim(),
    whatsappToken: (bot.whatsappToken || DEFAULT_WHATSAPP_TOKEN || '').trim(),
    serverUrl: (bot.serverUrl || SELF_URL).trim(),
    templates: { ...DEFAULT_TEMPLATES, ...(bot.templates || {}) }
  };
}

function esDeOtroServidor(bot) { return bot.serverUrl && bot.serverUrl.trim() !== SELF_URL; }

async function reenviar(bot, path, body, res) {
  console.log(`↪️  [Relay] Bot '${bot.name}' → ${bot.serverUrl}${path}`);
  try {
    const r = await fetch(`${bot.serverUrl}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json().catch(() => ({}));
    return res.status(r.status).json({ ...data, relayedTo: bot.serverUrl });
  } catch (e) {
    return res.status(502).json({ success: false, error: 'No se pudo contactar al servidor del bot', relayedTo: bot.serverUrl });
  }
}

function normalizarNumeroPY(phone) {
  let c = String(phone || '').replace(/\D/g, '');
  if (c.startsWith('0')) c = '595' + c.substring(1);
  else if (!c.startsWith('595')) c = '595' + c;
  return c;
}

function numeroMetaALocal(n) {
  if (String(n).startsWith('595')) return '0' + String(n).substring(3);
  return String(n || '');
}

async function esEmpresarial(reserva) {
  try {
    if (!reserva.companyId) return false;
    const e = await obtenerDatosEmpresa(reserva.companyId);
    return e?.plan === 'empresarial';
  } catch { return false; }
}

async function obtenerDatosUbicacion(locationId) {
  const d = { shopName: 'la barbería', mapLink: 'https://maps.app.goo.gl/tu-local', shopUrl: 'https://app.barbergo.com.py' };
  if (!locationId) return d;
  try {
    const snap = await db.collection('locations').doc(locationId).get();
    if (snap.exists) {
      const loc = snap.data();
      return { shopName: (loc.name || d.shopName).trim(), mapLink: loc.mapUrl || d.mapLink, shopUrl: loc.slug ? `https://app.barbergo.com.py/${loc.slug}` : d.shopUrl };
    }
  } catch { }
  return d;
}

function formatearReserva(reserva) {
  const dateObj = new Date(reserva.date + 'T00:00:00');
  const formattedDate = dateObj.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' }).replace(',', '');
  const clientName = reserva.client?.name || 'Cliente';
  const timeStr = reserva.startTime || reserva.time || '';
  const barberName = reserva.barber?.name || 'Barbero asignado';
  const groupId = reserva.bookingGroupId || reserva.id || '';
  const tId = groupId ? String(groupId).slice(-5) : '-----';
  const serviceName = reserva.services?.length > 0 ? reserva.services.map(s => s.name).join(', ') : 'Servicio de barbería';
  const servicePrice = reserva.totalPrice || '0';
  return { clientName, timeStr, barberName, groupId, tId, serviceName, servicePrice, formattedDate };
}

// =====================================================================
// 📤 ENVIAR TEMPLATE
// =====================================================================
async function enviarTemplate(bot, to, templateName, variables = [], companyIdParaLimite = null, skipLimitCheck = false) {
  const cleanPhone = String(to).replace(/\D/g, '');
  if (!skipLimitCheck) {
    const cid = companyIdParaLimite || bot.companyId || null;
    const { permitido, motivo } = await verificarPermisoWhatsApp(cid);
    if (!permitido) { console.log(`🚫 [${bot.name}] Bloqueado (${motivo})`); return false; }
  }
  const payload = {
    messaging_product: 'whatsapp', to: cleanPhone, type: 'template',
    template: {
      name: templateName, language: { code: 'es' },
      ...(variables.length > 0 && { components: [{ type: 'body', parameters: variables.map(v => ({ type: 'text', text: String(v) })) }] })
    }
  };
  console.log(`📤 [${bot.name}] Enviando '${templateName}' a ${cleanPhone}`);
  const response = await fetch(`https://graph.facebook.com/v22.0/${bot.phoneNumberId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bot.whatsappToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const errData = await response.json();
    console.error(`❌ [${bot.name}] Error Meta [${templateName}]:`, JSON.stringify(errData));
    return false;
  }
  console.log(`✅ [${bot.name}] Template '${templateName}' enviado a ${cleanPhone}`);
  return true;
}

async function enviarRespuestaWhatsApp(bot, reserva, nuevoEstado, numeroMeta) {
  try {
    const { shopName, mapLink, shopUrl } = await obtenerDatosUbicacion(reserva.locationId);
    const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
    const templateName = nuevoEstado === 'confirmed' ? bot.templates.confirmed : bot.templates.cancelled;
    const linkFinal = nuevoEstado === 'confirmed' ? mapLink : shopUrl;
    await enviarTemplate(bot, numeroMeta, templateName, [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, linkFinal], reserva.companyId);
  } catch (error) { console.error('❌ Error en enviarRespuestaWhatsApp:', error); }
}

async function enviarCalificacionWhatsApp(bot, reserva) {
  try {
    const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
    if (!cleanPhone) return;
    const { shopName } = await obtenerDatosUbicacion(reserva.locationId);
    await enviarTemplate(bot, cleanPhone, bot.templates.rating, [reserva.client?.name || 'Cliente', shopName, reserva.barber?.name || 'tu barbero'], reserva.companyId);
  } catch (error) { console.error('❌ Error en enviarCalificacionWhatsApp:', error); }
}

async function enviarAgradecimientoWhatsApp(bot, reserva, telefonoLocal) {
  try {
    const esEmp = await esEmpresarial(reserva);
    if (!esEmp) return;
    await enviarTemplate(bot, normalizarNumeroPY(telefonoLocal), bot.templates.thanks, [], reserva.companyId);
  } catch (error) { console.error('❌ Error en enviarAgradecimientoWhatsApp:', error); }
}

// ========================================
// RUTAS DE LA API
// ========================================
app.get('/', (req, res) => res.status(200).json({ ok: true, message: 'BarberGo WhatsApp API multi-tenant', self: SELF_URL }));

app.post('/api/recargar-bots', async (req, res) => {
  await cargarBots(true);
  PLAN_CACHE.clear();
  res.json({ ok: true, bots: BOTS_CACHE.map(b => ({ id: b.id, name: b.name, phoneNumberId: b.phoneNumberId })) });
});

app.get('/api/uso-whatsapp', async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) return res.status(400).json({ error: 'Falta companyId' });
    const empresa = await obtenerDatosEmpresa(companyId);
    if (!empresa) return res.status(404).json({ error: 'Empresa no encontrada' });
    const plan = empresa.plan || 'basic';
    const configPlan = PLANES[plan] || PLANES['basic'];
    const mesActual = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' }).slice(0, 7);
    const snap = await db.collection('usage_monthly').doc(`monthly_${companyId}_${mesActual}`).get();
    const count = snap.exists ? (snap.data().count || 0) : 0;
    const limit = configPlan.mensualLimit;
    const porcentaje = Math.round((count / limit) * 100);
    res.json({ plan, mes: mesActual, count, limit, porcentaje, disponibles: Math.max(0, limit - count), alerta: porcentaje >= 100 ? 'limite_100' : porcentaje >= 80 ? 'limite_80' : null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [], locationId, companyId } = req.body;
    if (!phone || !templateName) return res.status(400).json({ success: false, error: 'Faltan datos' });
    let bot = await resolverBot({ companyId, locationId });
    if (bot.isDefault && !companyId && !locationId) {
      try {
        const telefonoLocal = numeroMetaALocal(normalizarNumeroPY(phone));
        const snap = await db.collection('bookings').where('client.phone', '==', telefonoLocal).orderBy('createdAt', 'desc').limit(3).get();
        for (const d of snap.docs) { const b = d.data(); const botB = await resolverBot({ companyId: b.companyId, locationId: b.locationId }); if (!botB.isDefault) { bot = botB; break; } }
      } catch (e) { console.error('⚠️ [Fallback]:', e.message); }
    }
    if (esDeOtroServidor(bot)) return reenviar(bot, '/api/enviar-mensaje', req.body, res);
    const companyIdParaLimite = bot.companyId || companyId || null;
    const { permitido, motivo } = await verificarPermisoWhatsApp(companyIdParaLimite);
    if (!permitido) return res.status(200).json({ success: false, blocked: motivo, sentBy: bot.name });
    const empresa = await obtenerDatosEmpresa(companyIdParaLimite);
    if (empresa?.plan === 'basic' && ['solicitud_reserva_v3', 'reserva_confirmada_v2'].includes(templateName)) {
      console.log(`⏭️ [Basic] Plantilla '${templateName}' omitida`);
      return res.status(200).json({ success: true, skipped: true, reason: 'basic_solo_recordatorio' });
    }
    const ok = await enviarTemplate(bot, normalizarNumeroPY(phone), templateName, params, companyIdParaLimite, true);
    return res.status(ok ? 200 : 500).json({ success: !!ok, sentBy: bot.name });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/admin-notificar-cancelacion', async (req, res) => {
  try {
    const { reserva } = req.body;
    if (!reserva?.client?.phone) return res.status(400).json({ success: false, error: 'Faltan datos' });
    const bot = await resolverBot({ companyId: reserva.companyId, locationId: reserva.locationId });
    if (esDeOtroServidor(bot)) return reenviar(bot, '/api/admin-notificar-cancelacion', req.body, res);
    await enviarRespuestaWhatsApp(bot, reserva, 'cancelled', normalizarNumeroPY(reserva.client.phone));
    return res.status(200).json({ success: true, sentBy: bot.name });
  } catch (error) {
    console.error('❌ Error en /api/admin-notificar-cancelacion:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

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
      const groupSnap = await db.collection('bookings').where('bookingGroupId', '==', realBooking.bookingGroupId).where('isPrimary', '==', true).limit(1).get();
      if (!groupSnap.empty) { bookingRef2 = groupSnap.docs[0].ref; realBooking = groupSnap.docs[0].data(); }
    }
    const bot = await resolverBot({ companyId: realBooking.companyId, locationId: realBooking.locationId });
    if (esDeOtroServidor(bot)) return reenviar(bot, '/api/reserva-completada', req.body, res);
    if (!realBooking.isPrimary) return res.status(200).json({ success: true, message: 'No es reserva primaria' });
    if (realBooking.ratingTemplateSent) return res.status(200).json({ success: true, message: 'Rating ya enviado' });
    const empresarial = await esEmpresarial(realBooking);
    if (!empresarial) {
      await bookingRef2.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'Plan sin calificaciones' });
    }
    const hoyAsuncion = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' });
    const ayerAsuncion = new Date(Date.now() - 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' });
    if (realBooking.date !== hoyAsuncion && realBooking.date !== ayerAsuncion) {
      await bookingRef2.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'Fuera de ventana 24hs' });
    }
    await enviarCalificacionWhatsApp(bot, realBooking);
    await bookingRef2.update({ ratingTemplateSent: true, isReviewed: false });
    return res.status(200).json({ success: true, message: 'Calificación enviada', sentBy: bot.name });
  } catch (error) {
    console.error('❌ Error en /api/reserva-completada:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/enviar-correo-recuperacion', async (req, res) => {
  try {
    const { email, returnUrl } = req.body;
    if (!email) return res.status(400).json({ error: 'Falta email.' });
    const firebaseLink = await auth.generatePasswordResetLink(email);
    const oobCode = new URL(firebaseLink).searchParams.get('oobCode');
    const miLink = `https://app.barbergo.com.py/reset-password?oobCode=${oobCode}&return=${encodeURIComponent(returnUrl || '/')}`;
    const { error } = await resend.emails.send({
      from: 'Soporte Barber GO <soporte@barbergo.com.py>', to: email,
      subject: '💈 Recupera tu contraseña de Barber GO',
      html: `<div style="font-family:sans-serif;max-width:480px;margin:auto"><h2>Recuperá tu contraseña</h2><p>Hacé clic en el botón para restablecer tu contraseña:</p><a href="${miLink}" style="display:inline-block;padding:12px 24px;background:#111;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">Restablecer contraseña</a><p style="margin-top:16px;font-size:12px;color:#888">Este enlace expira en 1 hora.</p></div>`
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error en /api/enviar-correo-recuperacion:', error);
    return res.status(500).json({ error: error.message });
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
        const bot = await resolverBotPorPhoneId(phoneNumberId);
        if (!bot) { console.log(`⚠️ [Webhook] phoneNumberId ${phoneNumberId} ignorado.`); continue; }

        for (const mensaje of value.messages) {
          const numeroMeta = mensaje.from || '';
          const telefonoLocal = numeroMetaALocal(numeroMeta);
          const tipo = mensaje.type || '';
          let respuestaCliente = '';

          if (tipo === 'text') respuestaCliente = mensaje.text?.body?.toLowerCase()?.trim() || '';
          else if (tipo === 'button') respuestaCliente = mensaje.button?.text?.toLowerCase()?.trim() || '';
          else if (tipo === 'interactive') {
            respuestaCliente = mensaje.interactive?.button_reply?.title?.toLowerCase()?.trim() ||
              mensaje.interactive?.list_reply?.title?.toLowerCase()?.trim() || '';
          }

          console.log(`📞 [${bot.name}] Mensaje de: ${numeroMeta} | Texto: "${respuestaCliente}" | Tipo: ${tipo}`);

          const palabrasMensajeCheck = respuestaCliente.split(/[\s,.!?;:()]+/).filter(Boolean);
          const esRespuestaBot = respuestaCliente.trim().match(/^[1-5]$/) ||
            palabrasMensajeCheck.some(p => ['si','sí','sii','siii','ok','okey','dale','voy','asisto','perfecto','excelente','seguro','no','imposible'].includes(p)) ||
            respuestaCliente.includes('confirm') || respuestaCliente.includes('cancel') ||
            respuestaCliente === '✅ confirmar' || respuestaCliente === '❌ cancelar turno';

          if (!esRespuestaBot) {
            const sesion = await verificarSesion(telefonoLocal, bot.companyId);
            if (sesion.bloqueadoPorSpam) { console.log(`🚫 [Spam] ${telefonoLocal}`); continue; }
            if (sesion.esNueva && !sesion.permitido) {
              const { shopUrl } = await obtenerDatosUbicacion(bot.locationIds?.[0]);
              try {
                await fetch(`https://graph.facebook.com/v22.0/${bot.phoneNumberId}/messages`, {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${bot.whatsappToken}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ messaging_product: 'whatsapp', to: numeroMeta, type: 'text', text: { body: `La atención automática está pausada. Podés agendar en: ${shopUrl}` } })
                });
              } catch (e) { console.error('❌ Error enviando límite:', e.message); }
              continue;
            }
          }

          // 1. CALIFICACIÓN (1-5)
          const ratingMatch = respuestaCliente.trim().match(/^[1-5]$/);
          if (ratingMatch) {
            await db.collection('rating_sessions').doc(telefonoLocal).set({
              stars: parseInt(ratingMatch[0]), phone: telefonoLocal,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              expiresAt: new Date(Date.now() + 10 * 60 * 1000)
            });
            continue;
          }

          // 2. COMENTARIO DE CALIFICACIÓN
          const sessionSnap = await db.collection('rating_sessions').doc(telefonoLocal).get();
          if (sessionSnap.exists) {
            const session = sessionSnap.data();
            const expiresAt = session.expiresAt?.toDate ? session.expiresAt.toDate() : new Date(session.expiresAt);
            if (new Date() < expiresAt) {
              const stars = session.stars;
              const comment = respuestaCliente.trim();
              await db.collection('rating_sessions').doc(telefonoLocal).delete();
              const snapshot = await db.collection('bookings').where('client.phone', '==', telefonoLocal).where('status', '==', 'completed').orderBy('createdAt', 'desc').limit(5).get();
              const bookingDoc = snapshot.docs.find(d => !d.data().isReviewed && botPerteneceAReserva(bot, d.data()));
              if (!bookingDoc) continue;
              const booking = bookingDoc.data();
              const locationId = booking.locationId ? String(booking.locationId).trim() : null;
              const barberId = booking.barber?.id ? String(booking.barber.id).trim() : null;
              if (!locationId || !barberId) { await bookingDoc.ref.update({ isReviewed: true }); continue; }
              let barberRef = null;
              const directSnap = await db.collection('locations').doc(locationId).collection('barbers').doc(barberId).get();
              if (directSnap.exists) { barberRef = directSnap.ref; }
              else {
                for (const idValue of [Number(barberId), barberId]) {
                  const q = await db.collection('locations').doc(locationId).collection('barbers').where('id', '==', idValue).limit(1).get();
                  if (!q.empty) { barberRef = q.docs[0].ref; break; }
                }
              }
              if (!barberRef) { await bookingDoc.ref.update({ isReviewed: true }); continue; }
              let ratingGuardado = false;
              await db.runTransaction(async (t) => {
                const barberDoc = await t.get(barberRef);
                if (!barberDoc.exists) return;
                const curr = barberDoc.data().rating || 0;
                const count = barberDoc.data().reviewsCount || 0;
                const newCount = count + 1;
                t.update(barberRef, { rating: parseFloat(((curr * count + stars) / newCount).toFixed(1)), reviewsCount: newCount });
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
          const esConfirmar = palabrasMensaje.some(p => ['si','sí','sii','siii','ok','okey','dale','voy','asisto','perfecto','excelente','seguro'].includes(p)) || respuestaCliente.includes('confirm') || respuestaCliente === '✅ confirmar';
          const esCancelar = palabrasMensaje.some(p => ['no','imposible'].includes(p)) || respuestaCliente.includes('cancel') || respuestaCliente.includes('no voy') || respuestaCliente === '❌ cancelar turno';

          let nuevoEstado = null;
          if (esCancelar) nuevoEstado = 'cancelled';
          else if (esConfirmar) nuevoEstado = 'confirmed';
          if (!nuevoEstado) continue;

          try {
            // =====================================================================
            // ✅ IDENTIFICACIÓN EXACTA POR TELÉFONO → pending_confirmations
            // Cuando el CRON envía el recordatorio, guarda el bookingGroupId exacto
            // asociado al teléfono del cliente. Acá lo recuperamos para confirmar
            // la reserva correcta sin depender de Meta ni del context.id
            // =====================================================================
            // Buscar con formato Meta (595...) porque el CRON guarda con normalizarNumeroPY
            const telefonoMeta = normalizarNumeroPY(telefonoLocal);
            const pendingRef = db.collection('pending_confirmations').doc(telefonoMeta);
            const pendingSnap = await pendingRef.get();

            if (pendingSnap.exists) {
              const pendingData = pendingSnap.data();
              const exp = pendingData.expiresAt?.toDate ? pendingData.expiresAt.toDate() : new Date(pendingData.expiresAt);

              if (new Date() < exp) {
                const { bookingGroupId, bookingId } = pendingData;
                console.log(`🎯 [Webhook] Reserva exacta por teléfono | groupId: ${bookingGroupId} | ${pendingData.date} ${pendingData.startTime} | Estado: ${nuevoEstado}`);

                // Buscar todos los bloques de esta reserva
                const bloquesSnapshot = bookingGroupId
                  ? await db.collection('bookings').where('bookingGroupId', '==', bookingGroupId).get()
                  : await db.collection('bookings').doc(bookingId).get().then(d => ({ docs: d.exists ? [d] : [], empty: !d.exists }));

                if (!bloquesSnapshot.empty) {
                  const primaryDoc = bloquesSnapshot.docs.find(d => d.data().isPrimary) || bloquesSnapshot.docs[0];
                  const reserva = primaryDoc.data();

                  if (nuevoEstado === 'confirmed' && reserva.status === 'confirmed') {
                    await pendingRef.delete();
                    continue;
                  }

                  const batch = db.batch();
                  bloquesSnapshot.docs.forEach(d => batch.update(d.ref, {
                    status: nuevoEstado,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                  }));
                  await batch.commit();

                  await enviarRespuestaWhatsApp(bot, reserva, nuevoEstado, numeroMeta);
                  await pendingRef.delete();
                  console.log(`✅ [Webhook] Reserva ${nuevoEstado} correctamente | Ticket: ${bookingGroupId?.slice(-5)}`);
                  continue;
                }
              }

              // Expiró o no se encontró — limpiar y usar fallback
              await pendingRef.delete();
              console.log(`⚠️ [Webhook] pending_confirmation expirado para ${telefonoLocal}, usando fallback`);
            }

            // =====================================================================
            // FALLBACK: Sin pending_confirmation → buscar reserva futura más próxima
            // Solo para casos donde el cliente escribe manualmente sin haber
            // recibido el recordatorio (ej: premium/empresarial)
            // =====================================================================
            console.log(`⚠️ [Webhook] Sin pending_confirmation para ${telefonoLocal}, usando fallback`);
            const estadosValidos = nuevoEstado === 'confirmed' ? ['pending'] : ['pending', 'confirmed'];
            const hoyStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Asuncion' });

            const snapshot = await db.collection('bookings')
              .where('client.phone', '==', telefonoLocal)
              .where('isPrimary', '==', true)
              .where('status', 'in', estadosValidos)
              .where('date', '>=', hoyStr)
              .orderBy('date', 'asc')
              .orderBy('startTime', 'asc')
              .get();

            const reservaDoc = snapshot.docs.find(d => botPerteneceAReserva(bot, d.data()));
            if (!reservaDoc) {
              console.log(`⚠️ [Webhook] No se encontró reserva futura para ${telefonoLocal}`);
              continue;
            }

            const reserva = reservaDoc.data();
            const groupId = reserva.bookingGroupId;
            if (nuevoEstado === 'confirmed' && reserva.status === 'confirmed') continue;

            console.log(`✅ [Webhook] Fallback: ${nuevoEstado} reserva del ${reserva.date} ${reserva.startTime} — Ticket: ${groupId?.slice(-5)}`);

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

function botPerteneceAReserva(bot, reserva) {
  const comp = String(reserva.companyId || '').trim();
  const loc = String(reserva.locationId || '').trim();
  if (bot.companyId && comp === String(bot.companyId).trim()) return true;
  if (bot.locationIds.map(x => String(x).trim()).includes(loc)) return true;
  if (bot.isDefault) return true;
  return false;
}

// ========================================
// CRON: RECORDATORIOS
// Guarda pending_confirmation por teléfono para identificar reserva exacta al confirmar
// ========================================
if (ENABLE_BACKGROUND_JOBS) {
  cron.schedule('*/15 * * * *', async () => {
    try {
      const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion' }));
      const todayStr = now.toISOString().split('T')[0];
      const mananaDate = new Date(now);
      mananaDate.setDate(mananaDate.getDate() + 1);
      const mananaStr = mananaDate.toISOString().split('T')[0];

      console.log(`🕐 [Cron] Corriendo ${now.toTimeString().slice(0,5)} | Hoy: ${todayStr} | Mañana: ${mananaStr}`);

      const [sHoyC, sHoyP, sManC, sManP] = await Promise.all([
        db.collection('bookings').where('date', '==', todayStr).where('status', '==', 'confirmed').where('reminderSent', '==', false).get(),
        db.collection('bookings').where('date', '==', todayStr).where('status', '==', 'pending').where('reminderSent', '==', false).get(),
        db.collection('bookings').where('date', '==', mananaStr).where('status', '==', 'confirmed').where('reminderSent', '==', false).get(),
        db.collection('bookings').where('date', '==', mananaStr).where('status', '==', 'pending').where('reminderSent', '==', false).get(),
      ]);

      const todosLosDocs = [...sHoyC.docs, ...sHoyP.docs, ...sManC.docs, ...sManP.docs];

      for (const doc of todosLosDocs) {
        const reserva = doc.data();
        if (!reserva.isPrimary) continue; // Solo procesar reservas primarias

        const bot = await resolverBot({ companyId: reserva.companyId, locationId: reserva.locationId });
        if (esDeOtroServidor(bot)) continue;

        const timeStr = reserva.startTime || reserva.time;
        if (!timeStr) continue;

        const [bookHour, bookMin] = timeStr.split(':').map(Number);
        const esHoy = reserva.date === todayStr;
        const esManana = reserva.date === mananaStr;

        const companyId = reserva.companyId || bot.companyId || null;
        const empresa = await obtenerDatosEmpresa(companyId);
        const esBasico = empresa?.plan === 'basic';

        let debeEnviar = false;
        if (esHoy) {
          const bookingTime = new Date(now);
          bookingTime.setHours(bookHour, bookMin, 0, 0);
          const diff = Math.floor((bookingTime - now) / 60000);
          debeEnviar = diff >= 165 && diff <= 195;
        } else if (esManana && esBasico) {
          const bookingTime = new Date(now);
          bookingTime.setDate(bookingTime.getDate() + 1);
          bookingTime.setHours(bookHour, bookMin, 0, 0);
          const diff = Math.floor((bookingTime - now) / 60000);
          debeEnviar = diff >= 1380 && diff <= 1500;
        }

        if (!debeEnviar) continue;

        const { permitido, motivo } = await verificarPermisoWhatsApp(companyId);
        if (!permitido) {
          console.log(`🚫 [Cron] Bloqueado para ${companyId} — ${motivo}`);
          await db.collection('bookings').doc(doc.id).update({ reminderSent: true, reminderBlocked: motivo, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          continue;
        }

        await db.collection('bookings').doc(doc.id).update({ reminderSent: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

        const cleanPhone = normalizarNumeroPY(reserva.client?.phone);
        const { shopName, mapLink } = await obtenerDatosUbicacion(reserva.locationId);
        const { clientName, timeStr: tStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
        const variables = [clientName, shopName, formattedDate, tStr, barberName, serviceName, servicePrice, tId, mapLink];
        const templateAEnviar = esBasico ? 'recordatorio_confirmacion' : bot.templates.reminder;

        console.log(`📅 [Cron] ${esBasico ? '[Basic 🔘]' : ''} Enviando '${templateAEnviar}' → ${cleanPhone} | ${reserva.date} ${tStr}`);

        await enviarTemplate(bot, cleanPhone, templateAEnviar, variables, companyId, true);

        // ✅ Guardar qué reserva está esperando confirmación de este teléfono
        // Clave: teléfono del cliente — siempre disponible, no depende de Meta
        const bookingGroupId = reserva.bookingGroupId || doc.id;
        await db.collection('pending_confirmations').doc(cleanPhone).set({
          bookingGroupId,
          bookingId: doc.id,
          companyId,
          date: reserva.date,
          startTime: tStr,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000) // 48hs de vida
        });
        console.log(`📌 [Cron] Confirmación pendiente guardada: ${cleanPhone} → ${bookingGroupId} (${reserva.date} ${tStr})`);
      }
    } catch (error) {
      console.error('❌ Error en Cron Job de recordatorios:', error);
    }
  });

  cron.schedule('0 0 1 * *', async () => {
    console.log('🔄 Limpiando sesiones viejas...');
    try {
      const hace30Dias = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const snap = await db.collection('sesiones_bot').where('ultimaInteraccion', '<', hace30Dias).get();
      if (snap.empty) { console.log('✅ Nada que limpiar'); return; }
      const batch = db.batch();
      snap.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
      console.log(`✅ ${snap.size} sesiones eliminadas`);
    } catch (e) { console.error('❌ Error limpiando sesiones:', e.message); }
  });
}

app.post('/api/notificar-reserva', async (req, res) => {
  const { tokens, title, body, data } = req.body;
  if (!tokens || tokens.length === 0) return res.status(400).json({ error: 'Sin tokens' });
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      data: { title: title || '¡Nueva Reserva! 💈', body: body || 'Tienes un nuevo turno agendado', bookingId: data?.bookingId || '', locationId: data?.locationId || '' },
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

if (ENABLE_BACKGROUND_JOBS) {
  let isListenerReady = false;
  setTimeout(() => {
    db.collection('bookings').where('status', 'in', ['pending', 'confirmed']).onSnapshot(async (snapshot) => {
      if (!isListenerReady) { isListenerReady = true; console.log('👂 Escuchador de reservas activo'); return; }
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
        console.log(`🔔 Nueva reserva: ${booking.client?.name} | loc: ${locationId}`);
        try {
          const tokensSnap = await db.collection('admin_tokens').where('locationId', '==', locationId).get();
          if (tokensSnap.empty) { console.log('⚠️ Sin tokens para:', locationId); continue; }
          const tokens = tokensSnap.docs.map(d => d.data().token).filter(Boolean);
          if (tokens.length === 0) continue;
          const response = await admin.messaging().sendEachForMulticast({
            tokens,
            data: { title: '¡Nueva Reserva! 💈', body: `${booking.client?.name || 'Cliente'} - ${booking.startTime || booking.time || ''}`, bookingId: booking.bookingGroupId || change.doc.id || '', locationId },
            android: { priority: 'high', ttl: 60000 },
            apns: { payload: { aps: { 'content-available': 1, sound: 'default', badge: 1 } }, headers: { 'apns-priority': '10' } },
            webpush: { headers: { Urgency: 'high' } }
          });
          console.log(`📡 FCM: ${response.successCount} enviados`);
          response.responses.forEach((r, i) => { if (!r.success) console.error(`❌ Token ${i}:`, r.error?.code); });
        } catch (e) { console.error('❌ Error push:', e.message); }
      }
    });
  }, 3000);
}