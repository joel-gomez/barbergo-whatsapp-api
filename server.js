const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const cron = require('node-cron');
const { Resend } = require('resend');

// ========================================
// FIREBASE ADMIN
// ========================================
// ✅ ESTO apunta a donde Render guarda los Secret Files
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
// VARIABLES DE ENTORNO
// ========================================
const WHATSAPP_TOKEN_BARBERGO  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID_BARBERGO = process.env.PHONE_NUMBER_ID;
const WHATSAPP_TOKEN_CAPELLI   = process.env.WHATSAPP_TOKEN_CAPELLI;
const PHONE_NUMBER_ID_CAPELLI  = process.env.PHONE_NUMBER_ID_CAPELLI;
const VERIFY_TOKEN             = process.env.VERIFY_TOKEN;
const RESEND_API_KEY           = process.env.RESEND_API_KEY;
const PORT                     = process.env.PORT || 10000;

const resend = new Resend(RESEND_API_KEY);

// ========================================
// MAPA DE NÚMEROS → EMPRESA
// Cada número de WhatsApp sabe a qué companyId pertenece
// y qué token usar para enviar mensajes
// ========================================
const PHONE_CONFIG = {
  [PHONE_NUMBER_ID_BARBERGO]: {
    companyId: null, // BarberGo default (sin filtro de empresa)
    token: WHATSAPP_TOKEN_BARBERGO,
    phoneNumberId: PHONE_NUMBER_ID_BARBERGO
  },
  [PHONE_NUMBER_ID_CAPELLI]: {
    companyId: 'nI6ilcu8qPbH3xiXXsM7',
    token: WHATSAPP_TOKEN_CAPELLI,
    phoneNumberId: PHONE_NUMBER_ID_CAPELLI
  }
};

function getPhoneConfig(phoneNumberId) {
  return PHONE_CONFIG[phoneNumberId] || {
    companyId: null,
    token: WHATSAPP_TOKEN_BARBERGO,
    phoneNumberId: PHONE_NUMBER_ID_BARBERGO
  };
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
    if (reserva.companyId) {
      const companySnap = await db.collection('companies').doc(reserva.companyId).get();
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
        shopName: locData.name    || defaults.shopName,
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
// Ahora recibe token y phoneNumberId del cliente correcto
// ========================================
async function enviarTemplate(to, templateName, variables = [], token, phoneNumberId) {
  const cleanPhone = String(to).replace(/\D/g, '');

  // Fallback a BarberGo si no se pasan credenciales
  const useToken         = token         || WHATSAPP_TOKEN_BARBERGO;
  const usePhoneNumberId = phoneNumberId || PHONE_NUMBER_ID_BARBERGO;

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

  const response = await fetch(`https://graph.facebook.com/v22.0/${usePhoneNumberId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${useToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errData = await response.json();
    console.error(`❌ Error de Meta [${templateName}]:`, errData);
    return false;
  }

  console.log(`✅ Template '${templateName}' enviado a ${cleanPhone} via ${usePhoneNumberId}`);
  return true;
}

// ========================================
// WHATSAPP: CONFIRMACIÓN / CANCELACIÓN
// ========================================
async function enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta, config) {
  try {
    const { shopName, mapLink, shopUrl } = await obtenerDatosUbicacion(reserva.locationId);
    const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);

    const templateName = nuevoEstado === 'confirmed'
      ? 'reserva_confirmada_v2'
      : 'reserva_cancelada_v3';

    const linkFinal = nuevoEstado === 'confirmed' ? mapLink : shopUrl;

    const variables = [
      clientName, shopName, formattedDate, timeStr,
      barberName, serviceName, servicePrice, tId, linkFinal
    ];

    console.log(`📤 Enviando plantilla '${templateName}' al cliente...`);
    await enviarTemplate(numeroMeta, templateName, variables, config?.token, config?.phoneNumberId);
  } catch (error) {
    console.error('❌ Error en enviarRespuestaWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: RECORDATORIO 3HS ANTES
// ========================================
async function enviarRecordatorioWhatsApp(reserva, config) {
  try {
    const { shopName, mapLink } = await obtenerDatosUbicacion(reserva.locationId);
    const { clientName, timeStr, barberName, tId, serviceName, servicePrice, formattedDate } = formatearReserva(reserva);
    const cleanPhone = normalizarNumeroPY(reserva.client?.phone);

    const variables = [
      clientName, shopName, formattedDate, timeStr,
      barberName, serviceName, servicePrice, tId, mapLink
    ];

    console.log(`📤 Enviando recordatorio a ${cleanPhone}...`);
    await enviarTemplate(cleanPhone, 'recordatorio_turno_v3', variables, config?.token, config?.phoneNumberId);
  } catch (error) {
    console.error('❌ Error en enviarRecordatorioWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: SOLICITAR CALIFICACIÓN (PREMIUM)
// ========================================
async function enviarCalificacionWhatsApp(reserva, config) {
  try {
    const clientName = reserva.client?.name || 'Cliente';
    const barberName = reserva.barber?.name || 'tu barbero';
    const cleanPhone = normalizarNumeroPY(reserva.client?.phone);

    if (!cleanPhone) {
      console.log('⚠️ No hay teléfono válido para enviar calificación.');
      return;
    }

    const { shopName } = await obtenerDatosUbicacion(reserva.locationId);
    const variables = [clientName, shopName, barberName];

    console.log(`📤 Enviando solicitud de calificación a ${clientName}...`);
    await enviarTemplate(cleanPhone, 'calificar_barbero_v2', variables, config?.token, config?.phoneNumberId);
  } catch (error) {
    console.error('❌ Error en enviarCalificacionWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: AGRADECIMIENTO (PREMIUM)
// ========================================
async function enviarAgradecimientoWhatsApp(reserva, telefonoLocal, config) {
  try {
    const premium = await esPremium(reserva);
    if (!premium) {
      console.log('⚠️ Agradecimiento no enviado. La cuenta no es Premium.');
      return;
    }

    const cleanPhone = normalizarNumeroPY(telefonoLocal);
    const clientName = reserva.client?.name || 'Cliente';

    console.log(`📤 Enviando agradecimiento a ${clientName}...`);
    await enviarTemplate(cleanPhone, 'agradecimiento_v1', [], config?.token, config?.phoneNumberId);
  } catch (error) {
    console.error('❌ Error en enviarAgradecimientoWhatsApp:', error);
  }
}

// ========================================
// HELPER: OBTENER CONFIG POR RESERVA
// Busca qué número/token corresponde según el companyId de la reserva
// ========================================
function getConfigPorCompany(companyId) {
  if (!companyId) {
    return { token: WHATSAPP_TOKEN_BARBERGO, phoneNumberId: PHONE_NUMBER_ID_BARBERGO };
  }
  const entry = Object.values(PHONE_CONFIG).find(c => c.companyId === companyId);
  return entry || { token: WHATSAPP_TOKEN_BARBERGO, phoneNumberId: PHONE_NUMBER_ID_BARBERGO };
}

// ========================================
// RUTA DE PRUEBA
// ========================================
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, message: 'BarberGo WhatsApp API activa' });
});

app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [], companyId } = req.body;

    if (!phone || !templateName) {
      return res.status(400).json({ success: false, error: 'phone y templateName son obligatorios' });
    }

    const cleanPhone = normalizarNumeroPY(phone);
    const config = getConfigPorCompany(companyId);

    // 👇 PARCHE: Capelli tiene los templates con nombre distinto
    let resolvedTemplate = templateName;
    if (companyId === 'nI6ilcu8qPbH3xiXXsM7') {
      const capelliTemplates = {
        'solicitud_reserva_v3': 'solicitud_reserva_v3_'
      };
      resolvedTemplate = capelliTemplates[templateName] || templateName;
    }

    const ok = await enviarTemplate(cleanPhone, resolvedTemplate, params, config.token, config.phoneNumberId);

    return res.status(ok ? 200 : 500).json({ success: ok });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// NOTIFICAR CANCELACIÓN DESDE EL PANEL ADMIN
// ========================================
app.post('/api/admin-notificar-cancelacion', async (req, res) => {
  try {
    const { reserva } = req.body;

    if (!reserva || !reserva.client || !reserva.client.phone) {
      return res.status(400).json({ success: false, error: 'Faltan datos de la reserva o del cliente' });
    }

    const numeroMeta = normalizarNumeroPY(reserva.client.phone);
    const config = getConfigPorCompany(reserva.companyId);
    await enviarRespuestaWhatsApp(reserva, 'cancelled', numeroMeta, config);

    return res.status(200).json({ success: true, message: 'Mensaje de cancelación enviado' });
  } catch (error) {
    console.error('❌ Error en /api/admin-notificar-cancelacion:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ========================================
// NOTIFICAR RESERVA COMPLETADA
// ========================================
app.post('/api/reserva-completada', async (req, res) => {
  try {
    const { reserva, bookingId } = req.body;

    if (!reserva || !bookingId) {
      return res.status(400).json({ success: false, error: 'Faltan reserva o bookingId' });
    }

    if (!reserva.isPrimary) {
      return res.status(200).json({ success: true, message: 'No es reserva primaria, ignorado' });
    }

    if (reserva.ratingTemplateSent) {
      return res.status(200).json({ success: true, message: 'Rating ya enviado previamente' });
    }

    const bookingRef = db.collection('bookings').doc(bookingId);
    const premium = await esPremium(reserva);
    const config = getConfigPorCompany(reserva.companyId);

    if (!premium) {
      console.log(`⚠️ Reserva ${bookingId} completada. Envío cancelado: no es cuenta Premium.`);
      await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'No es cuenta Premium, no se envió rating' });
    }

    console.log(`💈 Cuenta PREMIUM confirmada. Solicitando calificación...`);
    await enviarCalificacionWhatsApp(reserva, config);
    await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });

    return res.status(200).json({ success: true, message: 'Solicitud de calificación enviada' });
  } catch (error) {
    console.error('❌ Error en /api/reserva-completada:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ========================================
// RECUPERACIÓN DE CONTRASEÑA POR EMAIL
// ========================================
app.post('/api/enviar-correo-recuperacion', async (req, res) => {
  try {
    const { email, returnUrl } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Falta el correo electrónico.' });
    }

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

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('❌ Error en /api/enviar-correo-recuperacion:', error);
    return res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// ========================================
// VERIFICACIÓN DEL WEBHOOK (GET)
// Acepta tanto el VERIFY_TOKEN de BarberGo como el de Capelli
// ========================================
app.get('/webhook', (req, res) => {
  try {
    const mode      = req.query['hub.mode'];
    const token     = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    const validTokens = [
      process.env.VERIFY_TOKEN,
      process.env.VERIFY_TOKEN_CAPELLI
    ].filter(Boolean);

    if (mode === 'subscribe' && validTokens.includes(token)) {
      console.log('✅ Webhook verificado correctamente por Meta');
      return res.status(200).send(challenge);
    }

    return res.sendStatus(403);
  } catch (error) {
    return res.sendStatus(500);
  }
});

// ========================================
// RECEPCIÓN DE EVENTOS DEL WEBHOOK (POST)
// ========================================
app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};

        if (!value.messages || !Array.isArray(value.messages)) continue;

        // ← NUEVO: detectar qué número recibió el mensaje y obtener su config
        const phoneNumberId = value.metadata?.phone_number_id;
        const config = getPhoneConfig(phoneNumberId);
        const { companyId } = config;

        console.log(`📱 Mensaje entrante via phoneNumberId: ${phoneNumberId} | companyId: ${companyId || 'BarberGo default'}`);

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
              mensaje.interactive?.list_reply?.title?.toLowerCase()?.trim() ||
              '';
          }

          console.log(`📞 Número Meta: ${numeroMeta} | Texto: "${respuestaCliente}" | Tipo: ${tipo}`);

          // ======================================
          // LÓGICA 1: CALIFICACIÓN CON NÚMERO 1-5
          // ======================================
          const ratingMatch = respuestaCliente.trim().match(/^[1-5]$/);

          if (ratingMatch) {
            const stars = parseInt(ratingMatch[0]);
            console.log(`⭐ Recibida calificación de ${stars} estrellas de ${telefonoLocal}`);

            await db.collection('rating_sessions').doc(telefonoLocal).set({
              stars,
              phone: telefonoLocal,
              companyId: companyId || null,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              expiresAt: new Date(Date.now() + 10 * 60 * 1000)
            });
            continue;
          }

          // ======================================
          // LÓGICA 2: RECIBIR COMENTARIO DE CALIFICACIÓN
          // ======================================
          const sessionSnap = await db.collection('rating_sessions').doc(telefonoLocal).get();

          if (sessionSnap.exists) {
            const session   = sessionSnap.data();
            const now       = new Date();
            const expiresAt = session.expiresAt?.toDate
              ? session.expiresAt.toDate()
              : new Date(session.expiresAt);

            if (now < expiresAt) {
              const stars   = session.stars;
              const comment = respuestaCliente.trim();

              console.log(`💬 Comentario de ${telefonoLocal}: "${comment}" (${stars} estrellas)`);

              await db.collection('rating_sessions').doc(telefonoLocal).delete();

              const bookingsRef = db.collection('bookings');
              let query = bookingsRef
                .where('client.phone', '==', telefonoLocal)
                .where('status', '==', 'completed')
                .orderBy('createdAt', 'desc')
                .limit(3);

              const snapshot = await query.get();
              const bookingDoc = snapshot.docs.find(doc => doc.data().isReviewed !== true);

              if (!bookingDoc) {
                console.log(`⚠️ No hay reservas sin reseñar para ${telefonoLocal}`);
                continue;
              }

              const booking    = bookingDoc.data();
              const locationId = booking.locationId ? String(booking.locationId).trim() : null;
              const barberId   = booking.barber?.id  ? String(booking.barber.id).trim()  : null;

              if (!locationId || !barberId) {
                await bookingDoc.ref.update({ isReviewed: true, reviewComment: 'Error: Faltan datos' });
                continue;
              }

              let barberRef = null;

              const barberDirectSnap = await db
                .collection('locations').doc(locationId)
                .collection('barbers').doc(barberId)
                .get();

              if (barberDirectSnap.exists) {
                barberRef = barberDirectSnap.ref;
              } else {
                for (const idValue of [Number(barberId), barberId]) {
                  const q = await db
                    .collection('locations').doc(locationId)
                    .collection('barbers')
                    .where('id', '==', idValue)
                    .limit(1)
                    .get();
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
                if (!barberDoc.exists) {
                  t.update(bookingDoc.ref, { isReviewed: true, reviewComment: 'Error: Barbero no encontrado' });
                  return;
                }

                const currentRating       = barberDoc.data().rating       || 0;
                const currentReviewsCount = barberDoc.data().reviewsCount || 0;
                const newCount  = currentReviewsCount + 1;
                const newRating = ((currentRating * currentReviewsCount) + stars) / newCount;

                t.update(barberRef, {
                  rating:       parseFloat(newRating.toFixed(1)),
                  reviewsCount: newCount
                });

                t.update(bookingDoc.ref, {
                  isReviewed:    true,
                  reviewStars:   stars,
                  reviewComment: comment
                });

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
                console.log(`✅ Calificación de ${stars}⭐ guardada para ${booking.barber?.name}`);
                await enviarAgradecimientoWhatsApp(booking, telefonoLocal, config);
              }

              continue;
            } else {
              await db.collection('rating_sessions').doc(telefonoLocal).delete();
              console.log(`⏰ Sesión de calificación expirada para ${telefonoLocal}`);
            }
          }

          // ======================================
          // LÓGICA 3: CONFIRMACIÓN / CANCELACIÓN
          // ======================================
          const palabrasMensaje = respuestaCliente.split(/[\s,.!?;:()]+/).filter(Boolean);

          const exactasConfirmar = ['si', 'sí', 'sii', 'siii', 'ok', 'okey', 'dale', 'voy', 'asisto', 'perfecto', 'excelente', 'seguro'];
          const exactasCancelar  = ['no', 'imposible'];

          const esConfirmar =
            palabrasMensaje.some(p => exactasConfirmar.includes(p)) ||
            respuestaCliente.includes('confirm') ||
            respuestaCliente.includes('de una')  ||
            respuestaCliente === '✅ confirmar';

          const esCancelar =
            palabrasMensaje.some(p => exactasCancelar.includes(p)) ||
            respuestaCliente.includes('cancel')    ||
            respuestaCliente.includes('anul')      ||
            respuestaCliente.includes('no voy')    ||
            respuestaCliente.includes('no podre')  ||
            respuestaCliente.includes('no podré')  ||
            respuestaCliente.includes('me complico') ||
            respuestaCliente === '❌ cancelar turno';

          let nuevoEstado = null;
          if (esCancelar)        nuevoEstado = 'cancelled';
          else if (esConfirmar)  nuevoEstado = 'confirmed';

          if (!nuevoEstado) {
            console.log('ℹ️ Mensaje recibido pero no es confirmación, cancelación ni calificación.');
            continue;
          }

          console.log(`🔄 El cliente quiere cambiar su estado a: ${nuevoEstado}`);

          try {
            const reservasRef    = db.collection('bookings');
            const estadosValidos = nuevoEstado === 'confirmed'
              ? ['pending']
              : ['pending', 'confirmed'];

            // ← NUEVO: filtrar por companyId si aplica
            let query = reservasRef
              .where('client.phone', '==', telefonoLocal)
              .where('status', 'in', estadosValidos);

            if (companyId) {
              query = query.where('companyId', '==', companyId);
            }

            const snapshot = await query.orderBy('createdAt', 'desc').limit(1).get();

            if (snapshot.empty) {
              console.log(`⚠️ No se encontraron reservas válidas para ${telefonoLocal}`);
              continue;
            }

            const reservaDoc = snapshot.docs[0];
            const reserva    = reservaDoc.data();
            const groupId    = reserva.bookingGroupId;

            if (nuevoEstado === 'confirmed' && reserva.status === 'confirmed') {
              console.log('ℹ️ El turno ya estaba confirmado, se ignora.');
              continue;
            }

            if (!groupId) {
              await reservasRef.doc(reservaDoc.id).update({
                status:    nuevoEstado,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              console.log(`✅ Documento individual actualizado a '${nuevoEstado}'`);
            } else {
              const bloquesSnapshot = await reservasRef
                .where('bookingGroupId', '==', groupId)
                .get();
              const batch = db.batch();
              bloquesSnapshot.forEach(doc => {
                batch.update(doc.ref, {
                  status:    nuevoEstado,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
              });
              await batch.commit();
              console.log(`✅ Grupo ${groupId} actualizado a '${nuevoEstado}'`);
            }

            await enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta, config);
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
// ⏰ CRON: RECORDATORIOS 3 HORAS ANTES
// Se ejecuta cada 15 minutos
// Envía por el número correcto según el companyId de cada reserva
// ========================================
cron.schedule('*/15 * * * *', async () => {
  console.log('⏳ [CRON] Revisando reservas para recordatorios (3 horas antes)...');

  try {
    const now      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Asuncion' }));
    const todayStr = now.toISOString().split('T')[0];

    const snapshot = await db.collection('bookings')
      .where('date', '==', todayStr)
      .where('status', '==', 'confirmed')
      .where('reminderSent', '==', false)
      .get();

    if (snapshot.empty) return;

    for (const doc of snapshot.docs) {
      const reserva = doc.data();
      const timeStr = reserva.startTime || reserva.time;
      if (!timeStr) continue;

      const [bookHour, bookMin] = timeStr.split(':').map(Number);
      const bookingTime = new Date(now);
      bookingTime.setHours(bookHour, bookMin, 0, 0);

      const diffMinutes = Math.floor((bookingTime - now) / 60000);

      if (diffMinutes >= 165 && diffMinutes <= 195) {
        console.log(`🎯 Recordatorio 3hs → ${reserva.client?.name} (Turno: ${timeStr})`);

        await db.collection('bookings').doc(doc.id).update({
          reminderSent: true,
          updatedAt:    admin.firestore.FieldValue.serverTimestamp()
        });

        // ← NUEVO: usar el número correcto según la empresa
        const config = getConfigPorCompany(reserva.companyId);
        await enviarRecordatorioWhatsApp(reserva, config);
      }
    }
  } catch (error) {
    console.error('❌ Error en Cron Job de recordatorios:', error);
  }
});

// ========================================
// 🔔 NOTIFICACIONES PUSH - FCM
// ========================================
app.post('/api/notificar-reserva', async (req, res) => {
  const { tokens, title, body, data } = req.body;
  
  if (!tokens || tokens.length === 0) {
    return res.status(400).json({ error: 'Sin tokens' });
  }

  try {
    const response = await admin.messaging().sendEachForMulticast({
      tokens: tokens,
      notification: { 
        title: title || '¡Nueva Reserva!', 
        body: body || 'Tienes un nuevo turno agendado' 
      },
      android: { 
        priority: 'high',
        notification: { sound: 'default', channelId: 'reservas' }
      },
      apns: { 
        payload: { aps: { sound: 'default', badge: 1 } } 
      },
      data: data || {}
    });

    res.json({ success: true, enviados: response.successCount });
  } catch (error) {
    console.error('Error FCM:', error);
    res.status(500).json({ error: error.message });
  }
});

// ========================================
// 🔔 NOTIFICACIONES PUSH (FCM)
// ========================================
app.post('/api/notificar-reserva', async (req, res) => {
  try {
    const { tokens, title, body, data } = req.body;

    if (!tokens || tokens.length === 0) {
      return res.status(400).json({ success: false, error: 'No hay tokens' });
    }

    const admin = require('firebase-admin'); // ya está inicializado arriba

    const message = {
      notification: { title, body },
      data: data || {},
      tokens: tokens
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    
    console.log(`🔔 Notificaciones enviadas: ${response.successCount} ok, ${response.failureCount} fallidas`);
    
    return res.status(200).json({ 
      success: true, 
      successCount: response.successCount,
      failureCount: response.failureCount
    });
  } catch (error) {
    console.error('❌ Error enviando notificaciones:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// INICIAR SERVIDOR
// ========================================
app.listen(PORT, () => {
  console.log(`🚀 BarberGo Meta API activa en puerto ${PORT}`);
  console.log(`🌐 Webhook: /webhook`);
  console.log(`📧 Recuperación de contraseña: /api/enviar-correo-recuperacion`);
  console.log(`💈 Reserva completada: /api/reserva-completada`);
});


