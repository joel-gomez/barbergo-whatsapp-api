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

// ========================================
// VARIABLES DE ENTORNO (BARBERGO)
// ========================================
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const PORT            = process.env.PORT || 10000;

const resend = new Resend(RESEND_API_KEY);

// ==========================================================================
// 🚦 NUEVO: SISTEMA DE ENRUTAMIENTO (LA "ADUANA")
// El servidor verifica a quién pertenece cada petición. Si es de Capelli,
// la reenvía al servidor de Capelli en vez de enviarla con el número equivocado.
// ==========================================================================
const CAPELLI_COMPANY_ID   = 'nI6ilcu8qPbH3xiXXsM7';
const CAPELLI_LOCATION_IDS = ['20aikKXImqJbfPaqXfG6'];
const CAPELLI_SERVER_URL   = process.env.CAPELLI_SERVER_URL || 'https://barbergo-whatsapp-api-1.onrender.com';

// Plantillas que SOLO existen en el WABA de Capelli (red de seguridad extra)
const ES_PLANTILLA_CAPELLI = (t) => String(t || '').includes('_capelli_');

/**
 * Determina si una petición/reserva pertenece a Capelli.
 * Orden de verificación: companyId directo → locationId conocido → Firestore (location doc).
 */
async function perteneceACapelli({ companyId, locationId, booking } = {}) {
  const comp = String(companyId || booking?.companyId || '').trim();
  const loc  = String(locationId || booking?.locationId || '').trim();
console.log(`🔎 [Aduana] Evaluando: companyId='${comp}' | locationId='${loc}' | Esperado: comp='${CAPELLI_COMPANY_ID}' o loc en ${JSON.stringify(CAPELLI_LOCATION_IDS)}`);
  if (comp === CAPELLI_COMPANY_ID) return true;
  if (loc && CAPELLI_LOCATION_IDS.includes(loc)) return true;

  // Último recurso: mirar el documento de la location en Firestore
  // (cubre reservas viejas sin companyId guardado)
  if (loc) {
    try {
      const snap = await db.collection('locations').doc(loc).get();
      if (snap.exists && String(snap.data().companyId || '').trim() === CAPELLI_COMPANY_ID) {
        return true;
      }
    } catch (e) {
      console.error('⚠️ [Router] Error verificando location en Firestore:', e.message);
    }
  }
  return false;
}

/**
 * Reenvía la petición al servidor de Capelli y devuelve su respuesta tal cual.
 * Así el mensaje sale del NÚMERO CORRECTO aunque el frontend se haya equivocado.
 */
async function reenviarACapelli(path, body, res) {
  console.log(`↪️  [Relay] Petición de CAPELLI detectada en BarberGo. Reenviando a ${CAPELLI_SERVER_URL}${path}`);
  try {
    const r = await fetch(`${CAPELLI_SERVER_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json().catch(() => ({}));
    console.log(`↪️  [Relay] Capelli respondió ${r.status}:`, JSON.stringify(data));
    return res.status(r.status).json({ ...data, relayedTo: 'capelli' });
  } catch (e) {
    console.error('❌ [Relay] No se pudo contactar al servidor de Capelli:', e.message);
    return res.status(502).json({ success: false, error: 'No se pudo contactar al servidor de Capelli', relayedTo: 'capelli' });
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
        mapLink:  locData.mapUrl  || defaults.mapLink,
        shopUrl:  locData.slug
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
  const formattedDate = dateObj
    .toLocaleDateString('es-ES', opcionesFecha)
    .replace(',', '');

  const clientName  = reserva.client?.name  || 'Cliente';
  const timeStr     = reserva.startTime     || reserva.time || '';
  const barberName  = reserva.barber?.name  || 'Barbero asignado';
  const groupId     = reserva.bookingGroupId || reserva.id || '';
  const tId         = groupId ? String(groupId).slice(-5) : '-----';

  const serviceName = reserva.services && reserva.services.length > 0
    ? reserva.services.map(s => s.name).join(', ')
    : 'Servicio de barbería';

  const servicePrice = reserva.totalPrice || '0';

  return { clientName, timeStr, barberName, groupId, tId, serviceName, servicePrice, formattedDate };
}

// ========================================
// WHATSAPP: ENVIAR TEMPLATE GENÉRICO
// ========================================
async function enviarTemplate(to, templateName, variables = []) {
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

  console.log(`📤 [BarberGo] Enviando plantilla '${templateName}' a ${cleanPhone} (PHONE_NUMBER_ID: ${PHONE_NUMBER_ID})`);

  const response = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errData = await response.json();
    console.error(`❌ [BarberGo] Error de Meta [${templateName}]:`, JSON.stringify(errData));
    return false;
  }

  console.log(`✅ [BarberGo] Template '${templateName}' enviado a ${cleanPhone}`);
  return true;
}

// ========================================
// WHATSAPP: CONFIRMACIÓN / CANCELACIÓN
// ========================================
async function enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta) {
  try {
    const { shopName, mapLink, shopUrl } = await obtenerDatosUbicacion(reserva.locationId);
    const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);

    const templateName = nuevoEstado === 'confirmed' ? 'reserva_confirmada_v2' : 'reserva_cancelada_v3';
    const linkFinal    = nuevoEstado === 'confirmed' ? mapLink : shopUrl;

    const variables = [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, linkFinal];

    await enviarTemplate(numeroMeta, templateName, variables);
  } catch (error) {
    console.error('❌ Error en enviarRespuestaWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: RECORDATORIO 3HS ANTES
// ========================================
async function enviarRecordatorioWhatsApp(reserva) {
  try {
    const { shopName, mapLink } = await obtenerDatosUbicacion(reserva.locationId);
    const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
    const cleanPhone   = normalizarNumeroPY(reserva.client?.phone);
    const templateName = 'recordatorio_turno_v4';

    const variables = [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, mapLink];

    await enviarTemplate(cleanPhone, templateName, variables);
  } catch (error) {
    console.error('❌ Error en enviarRecordatorioWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: SOLICITAR CALIFICACIÓN (PREMIUM)
// ========================================
async function enviarCalificacionWhatsApp(reserva) {
  try {
    const clientName   = reserva.client?.name || 'Cliente';
    const barberName   = reserva.barber?.name || 'tu barbero';
    const cleanPhone   = normalizarNumeroPY(reserva.client?.phone);

    if (!cleanPhone) return;

    const { shopName } = await obtenerDatosUbicacion(reserva.locationId);
    const templateName = 'calificar_barbero_v2';
    const variables    = [clientName, shopName, barberName];

    await enviarTemplate(cleanPhone, templateName, variables);
  } catch (error) {
    console.error('❌ Error en enviarCalificacionWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: AGRADECIMIENTO (PREMIUM)
// ========================================
async function enviarAgradecimientoWhatsApp(reserva, telefonoLocal) {
  try {
    const premium = await esPremium(reserva);
    if (!premium) return;

    const cleanPhone   = normalizarNumeroPY(telefonoLocal);
    const templateName = 'agradecimiento_v1';

    await enviarTemplate(cleanPhone, templateName, []);
  } catch (error) {
    console.error('❌ Error en enviarAgradecimientoWhatsApp:', error);
  }
}

// ========================================
// RUTAS DE LA API
// ========================================
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, message: 'BarberGo WhatsApp API activa', role: 'barbergo-default' });
});

// --------------------------------------------------------------------------
// /api/enviar-mensaje — CON ADUANA
// --------------------------------------------------------------------------
app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [], locationId, companyId } = req.body;
    if (!phone || !templateName) return res.status(400).json({ success: false, error: 'Faltan datos' });

    let esCapelli = ES_PLANTILLA_CAPELLI(templateName) || await perteneceACapelli({ companyId, locationId });

    // 🕵️ FALLBACK ANTI-CLIENTES-VIEJOS: petición sin locationId/companyId
    // (frontend cacheado). Resolvemos al dueño por la última reserva del teléfono.
    if (!esCapelli && !companyId && !locationId) {
      try {
        const telefonoLocal = numeroMetaALocal(normalizarNumeroPY(phone));
        const snap = await db.collection('bookings')
          .where('client.phone', '==', telefonoLocal)
          .orderBy('createdAt', 'desc')
          .limit(3)
          .get();
       for (const d of snap.docs) {
  const b = d.data();
  console.log(`🕵️ [Fallback] Booking ${d.id}: locationId='${b.locationId || 'VACIO'}' | companyId='${b.companyId || 'VACIO'}' | status='${b.status}' | fecha='${b.date}'`);
  if (await perteneceACapelli({ booking: b })) { esCapelli = true; break; }
}
        console.log(`🕵️ [Fallback] Petición sin routing. Resuelto por teléfono ${telefonoLocal}: esCapelli=${esCapelli}`);
      } catch (e) {
        console.error('⚠️ [Fallback] Error resolviendo por teléfono:', e.message);
      }
    }

    if (esCapelli) {
      return reenviarACapelli('/api/enviar-mensaje', req.body, res);
    }

    const cleanPhone = normalizarNumeroPY(phone);
    const ok = await enviarTemplate(cleanPhone, templateName, params);

    return res.status(ok ? 200 : 500).json({ success: ok, sentBy: 'barbergo' });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});
// --------------------------------------------------------------------------
// /api/admin-notificar-cancelacion — CON ADUANA
// --------------------------------------------------------------------------
app.post('/api/admin-notificar-cancelacion', async (req, res) => {
  try {
    const { reserva } = req.body;

    if (!reserva || !reserva.client || !reserva.client.phone) {
      return res.status(400).json({ success: false, error: 'Faltan datos de la reserva o del cliente' });
    }

    // 🚦 ADUANA: si es de Capelli, reenviar en vez de ignorar
    if (await perteneceACapelli({ booking: reserva })) {
      return reenviarACapelli('/api/admin-notificar-cancelacion', req.body, res);
    }

    const numeroMeta = normalizarNumeroPY(reserva.client.phone);
    await enviarRespuestaWhatsApp(reserva, 'cancelled', numeroMeta);

    return res.status(200).json({ success: true, message: 'Mensaje de cancelación enviado', sentBy: 'barbergo' });
  } catch (error) {
    console.error('❌ Error en /api/admin-notificar-cancelacion:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// --------------------------------------------------------------------------
// /api/reserva-completada — CON ADUANA (ESTE ERA EL PUNTO DEL BUG)
// La decisión ya NO depende solo de lo que mande el frontend:
// se lee la reserva REAL desde Firestore y se decide con esos datos.
// --------------------------------------------------------------------------
app.post('/api/reserva-completada', async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) return res.status(400).json({ success: false, error: 'Falta bookingId' });

    const bookingRef  = db.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();

    if (!bookingSnap.exists) {
      return res.status(404).json({ success: false, error: 'Reserva no encontrada' });
    }

   let bookingRef2 = bookingRef;
    let realBooking = bookingSnap.data();

    // 🛡️ Si el doc que llegó NO es el primario (puede pasar desde BarberPortal
    // porque updateBookingStatus agarra el primer doc del grupo, no el primario),
    // buscamos el primario dentro del mismo grupo para tener client/phone/companyId.
    if (!realBooking.isPrimary && realBooking.bookingGroupId) {
      console.log(`🔍 [completada] Doc ${bookingId} no es primario → buscando primario en grupo ${realBooking.bookingGroupId}`);
      const groupSnap = await db.collection('bookings')
        .where('bookingGroupId', '==', realBooking.bookingGroupId)
        .where('isPrimary', '==', true)
        .limit(1).get();
      if (!groupSnap.empty) {
        bookingRef2 = groupSnap.docs[0].ref;
        realBooking = groupSnap.docs[0].data();
        console.log(`✅ [completada] Primario encontrado: ${groupSnap.docs[0].id}`);
      } else {
        console.log(`⚠️ [completada] Sin primario en grupo; usando doc original.`);
      }
    }

    // 🚦 ADUANA: verificamos contra la reserva REAL de Firestore.
    if (await perteneceACapelli({ booking: realBooking, companyId: req.body.companyId })) {
      return reenviarACapelli('/api/reserva-completada', req.body, res);
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

    console.log('💈 [BarberGo] Cuenta PREMIUM. Solicitando calificación con calificar_barbero_v2.');
    await enviarCalificacionWhatsApp(realBooking);
    await bookingRef2.update({ ratingTemplateSent: true, isReviewed: false });

    return res.status(200).json({ success: true, message: 'Solicitud de calificación enviada', sentBy: 'barbergo' });

  } catch (error) {
    console.error('❌ Error en /api/reserva-completada:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

app.post('/api/enviar-correo-recuperacion', async (req, res) => {
  try {
    const { email, returnUrl } = req.body;

    if (!email) return res.status(400).json({ error: 'Falta el correo electrónico.' });

    const firebaseLink  = await auth.generatePasswordResetLink(email);
    const urlObj        = new URL(firebaseLink);
    const oobCode       = urlObj.searchParams.get('oobCode');
    const rutaDestino   = returnUrl || '/';
    const miLink        = `https://app.barbergo.com.py/reset-password?oobCode=${oobCode}&return=${encodeURIComponent(rutaDestino)}`;

    const { error } = await resend.emails.send({
      from:    'Soporte Barber GO <soporte@barbergo.com.py>',
      to:      email,
      subject: '💈 Recupera tu contraseña de Barber GO',
      html:    `<div style="font-family:sans-serif;max-width:480px;margin:auto">
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
// WEBHOOK META (RECEPCIÓN DE EVENTOS)
// Cada número de Meta apunta a SU webhook, así que acá solo
// validamos por phone_number_id (filtro de oro, ya estaba bien).
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

        // 🛑 FILTRO DE ORO: solo procesar mensajes que llegaron al número de BarberGo
        if (value.metadata?.phone_number_id !== PHONE_NUMBER_ID) {
          continue;
        }

        for (const mensaje of value.messages) {
          const numeroMeta    = mensaje.from || '';
          const telefonoLocal = numeroMetaALocal(numeroMeta);
          const tipo          = mensaje.type || '';
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

          console.log(`📞 [BarberGo] Mensaje de: ${numeroMeta} | Texto: "${respuestaCliente}" | Tipo: ${tipo}`);

          // 1. CALIFICACIÓN (1-5)
          const ratingMatch = respuestaCliente.trim().match(/^[1-5]$/);
          if (ratingMatch) {
            const stars = parseInt(ratingMatch[0]);
            await db.collection('rating_sessions').doc(telefonoLocal).set({
              stars,
              phone: telefonoLocal,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              expiresAt: new Date(Date.now() + 10 * 60 * 1000)
            });
            continue;
          }

          // 2. COMENTARIO DE CALIFICACIÓN
          const sessionSnap = await db.collection('rating_sessions').doc(telefonoLocal).get();
          if (sessionSnap.exists) {
            const session   = sessionSnap.data();
            const now       = new Date();
            const expiresAt = session.expiresAt?.toDate ? session.expiresAt.toDate() : new Date(session.expiresAt);

            if (now < expiresAt) {
              const stars   = session.stars;
              const comment = respuestaCliente.trim();
              await db.collection('rating_sessions').doc(telefonoLocal).delete();

              const snapshot = await db.collection('bookings')
                .where('client.phone', '==', telefonoLocal)
                .where('status', '==', 'completed')
                .orderBy('createdAt', 'desc')
                .limit(5)
                .get();

              // 🛑 No tocar reservas de Capelli desde este webhook
              const bookingDoc = snapshot.docs.find(doc =>
                doc.data().isReviewed !== true &&
                !CAPELLI_LOCATION_IDS.includes(String(doc.data().locationId || '').trim()) &&
                String(doc.data().companyId || '').trim() !== CAPELLI_COMPANY_ID
              );

              if (!bookingDoc) continue;

              const booking    = bookingDoc.data();
              const locationId = booking.locationId ? String(booking.locationId).trim() : null;
              const barberId   = booking.barber?.id  ? String(booking.barber.id).trim()  : null;

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

                const currentRating       = barberDoc.data().rating       || 0;
                const currentReviewsCount = barberDoc.data().reviewsCount || 0;
                const newCount  = currentReviewsCount + 1;
                const newRating = ((currentRating * currentReviewsCount) + stars) / newCount;

                t.update(barberRef, { rating: parseFloat(newRating.toFixed(1)), reviewsCount: newCount });
                t.update(bookingDoc.ref, { isReviewed: true, reviewStars: stars, reviewComment: comment });
                t.set(barberRef.collection('reviews').doc(bookingDoc.id), {
                  clientId:   booking.userId || booking.client?.phone || 'whatsapp-user',
                  clientName: booking.client?.name || 'Cliente de WhatsApp',
                  stars:      Number(stars),
                  comment,
                  createdAt:  admin.firestore.FieldValue.serverTimestamp(),
                  bookingId:  bookingDoc.id
                });
                ratingGuardado = true;
              });

              if (ratingGuardado) {
                await enviarAgradecimientoWhatsApp(booking, telefonoLocal);
              }
              continue;
            } else {
              await db.collection('rating_sessions').doc(telefonoLocal).delete();
            }
          }

          // 3. CONFIRMACIÓN / CANCELACIÓN
          const palabrasMensaje = respuestaCliente.split(/[\s,.!?;:()]+/).filter(Boolean);
          const exactasConfirmar = ['si', 'sí', 'sii', 'siii', 'ok', 'okey', 'dale', 'voy', 'asisto', 'perfecto', 'excelente', 'seguro'];
          const exactasCancelar  = ['no', 'imposible'];

          const esConfirmar = palabrasMensaje.some(p => exactasConfirmar.includes(p)) || respuestaCliente.includes('confirm') || respuestaCliente === '✅ confirmar';
          const esCancelar = palabrasMensaje.some(p => exactasCancelar.includes(p)) || respuestaCliente.includes('cancel') || respuestaCliente.includes('no voy') || respuestaCliente === '❌ cancelar turno';

          let nuevoEstado = null;
          if (esCancelar)        nuevoEstado = 'cancelled';
          else if (esConfirmar)  nuevoEstado = 'confirmed';

          if (!nuevoEstado) continue;

          try {
            const estadosValidos = nuevoEstado === 'confirmed' ? ['pending'] : ['pending', 'confirmed'];
            const snapshot = await db.collection('bookings')
              .where('client.phone', '==', telefonoLocal)
              .where('status', 'in', estadosValidos)
              .orderBy('createdAt', 'desc')
              .get();

            // 🛑 No responder sobre reservas de Capelli desde este número
            const reservaDoc = snapshot.docs.find(doc =>
              !CAPELLI_LOCATION_IDS.includes(String(doc.data().locationId || '').trim()) &&
              String(doc.data().companyId || '').trim() !== CAPELLI_COMPANY_ID
            );

            if (!reservaDoc) continue;

            const reserva    = reservaDoc.data();
            const groupId    = reserva.bookingGroupId;

            if (nuevoEstado === 'confirmed' && reserva.status === 'confirmed') continue;

            if (!groupId) {
              await db.collection('bookings').doc(reservaDoc.id).update({ status: nuevoEstado, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            } else {
              const bloquesSnapshot = await db.collection('bookings').where('bookingGroupId', '==', groupId).get();
              const batch = db.batch();
              bloquesSnapshot.forEach(doc => {
                batch.update(doc.ref, { status: nuevoEstado, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
              });
              await batch.commit();
            }

            await enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta);
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

// ========================================
// CRON: RECORDATORIOS 3 HORAS ANTES
// ========================================
cron.schedule('*/15 * * * *', async () => {
  try {
    const now      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion' }));
    const todayStr = now.toISOString().split('T')[0];

    const snapshot = await db.collection('bookings')
      .where('date', '==', todayStr)
      .where('status', '==', 'confirmed')
      .where('reminderSent', '==', false)
      .get();

    for (const doc of snapshot.docs) {
      const reserva = doc.data();

      // 🛑 IGNORAR CAPELLI: su propio cron se encarga (verificación robusta)
      const locReserva = String(reserva.locationId || '').trim();
      const compReserva = String(reserva.companyId || '').trim();
      if (CAPELLI_LOCATION_IDS.includes(locReserva) || compReserva === CAPELLI_COMPANY_ID) continue;

      const timeStr = reserva.startTime || reserva.time;
      if (!timeStr) continue;

      const [bookHour, bookMin] = timeStr.split(':').map(Number);
      const bookingTime = new Date(now);
      bookingTime.setHours(bookHour, bookMin, 0, 0);

      const diffMinutes = Math.floor((bookingTime - now) / 60000);

      if (diffMinutes >= 165 && diffMinutes <= 195) {
        await db.collection('bookings').doc(doc.id).update({
          reminderSent: true,
          updatedAt:    admin.firestore.FieldValue.serverTimestamp()
        });

        await enviarRecordatorioWhatsApp(reserva);
      }
    }
  } catch (error) {
    console.error('❌ Error en Cron Job de recordatorios:', error);
  }
});

// ========================================
// NOTIFICACIONES PUSH FCM
// (FCM usa el mismo proyecto Firebase, así que no necesita aduana)
// ========================================
app.post('/api/notificar-reserva', async (req, res) => {
  const { tokens, title, body, data } = req.body;
  if (!tokens || tokens.length === 0) return res.status(400).json({ error: 'Sin tokens' });
  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens,
      // ✅ SIN campo 'notification' — data-only para que el SW controle el sonido
      data: {
        title: title || '¡Nueva Reserva! 💈',
        body:  body  || 'Tienes un nuevo turno agendado',
        bookingId:  data?.bookingId  || '',
        locationId: data?.locationId || ''
      },
      android: {
        priority: 'high',
        // Android necesita este campo para despertar la app aunque esté cerrada
        ttl: '60000'
      },
      apns: {
        // iPhone: necesita content-available para procesar en segundo plano
        payload: {
          aps: {
            'content-available': 1,
            sound: 'default',
            badge: 1
          }
        },
        headers: {
          'apns-priority': '10'
        }
      },
      webpush: {
        headers: { Urgency: 'high' }
      }
    });

    console.log(`📡 FCM: ${response.successCount} enviados, ${response.failureCount} fallidos`);
    res.json({ success: true, enviados: response.successCount });
  } catch (error) {
    console.error('❌ Error FCM:', error);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 BarberGo Meta API activa en puerto ${PORT}`);
  console.log(`🚦 Relay configurado hacia Capelli: ${CAPELLI_SERVER_URL}`);
});


// =====================================================================
// 🔔 ESCUCHADOR AUTOMÁTICO DE NUEVAS RESERVAS → PUSH FCM
// No depende del frontend para nada
// =====================================================================
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

        // No notificar reservas de más de 2 minutos (carga inicial tardía)
        let bookingTime = 0;
        if (booking.createdAt?.toMillis) bookingTime = booking.createdAt.toMillis();
        else if (booking.createdAt?.seconds) bookingTime = booking.createdAt.seconds * 1000;
        if (Date.now() - bookingTime > 120000) continue;

        console.log(`🔔 Nueva reserva detectada: ${booking.client?.name} | loc: ${locationId}`);

        try {
          // Buscar tokens de admins de este local
          const tokensSnap = await db.collection('admin_tokens')
            .where('locationId', '==', locationId)
            .get();

          if (tokensSnap.empty) {
            console.log('⚠️ Sin tokens para locationId:', locationId);
            continue;
          }

          const tokens = tokensSnap.docs
            .map(d => d.data().token)
            .filter(Boolean);

          if (tokens.length === 0) continue;

          console.log(`📲 Enviando push a ${tokens.length} dispositivo(s)...`);

         const response = await admin.messaging().sendEachForMulticast({
            tokens,
            notification: {
              title: '¡Nueva Reserva! 💈',
              body: `${booking.client?.name || 'Cliente'} - ${booking.startTime || booking.time || ''}`
            },
            data: {
              title: '¡Nueva Reserva! 💈',
              body: `${booking.client?.name || 'Cliente'} - ${booking.startTime || booking.time || ''}`,
              bookingId: booking.bookingGroupId || change.doc.id || '',
              locationId: locationId
            },
            android: { priority: 'high', ttl: 60000, notification: { sound: 'default', channelId: 'barbergo_reservas' } },
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