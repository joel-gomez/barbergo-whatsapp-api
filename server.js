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
// 🆕 OVERRIDES POR LOCAL (en vez de por companyId)
// ========================================
const LOCATION_OVERRIDES = {
  '2OaikKXImqJbfPaqXfG6': { // ID del documento locations/ de Capelli
    token: WHATSAPP_TOKEN_CAPELLI,
    phoneNumberId: PHONE_NUMBER_ID_CAPELLI,
    serverUrl: 'https://barbergo-whatsapp-api-1.onrender.com',
    templateSuffix: '_capelli_v1',
    companyId: 'nI6ilcu8qPbH3xiXXsM7' // solo para chequear el plan premium
  }
};

const DEFAULT_CONFIG = {
  token: WHATSAPP_TOKEN_BARBERGO,
  phoneNumberId: PHONE_NUMBER_ID_BARBERGO,
  serverUrl: null,
  templateSuffix: '',
  companyId: null
};

function getConfigPorLocation(locationId) {
  if (!locationId) return DEFAULT_CONFIG;
  return LOCATION_OVERRIDES[locationId] || DEFAULT_CONFIG;
}

// 🆕 Resolver plantilla según el sufijo del local (reemplaza CAPELLI_TEMPLATE_MAP)
function resolverPlantilla(templateName, templateSuffix) {
  if (!templateSuffix) return templateName;
  // "reserva_confirmada_v2" -> "reserva_confirmada" + "_capelli_v1"
  const base = templateName.replace(/_v\d+$/, '');
  return base + templateSuffix;
}

// ========================================
// MAPA DE NÚMEROS → CONFIG (para mensajes ENTRANTES del webhook)
// ========================================
const PHONE_CONFIG = {
  [PHONE_NUMBER_ID_BARBERGO]: DEFAULT_CONFIG,
  [PHONE_NUMBER_ID_CAPELLI]: LOCATION_OVERRIDES['2OaikKXImqJbfPaqXfG6']
};

function getPhoneConfig(phoneNumberId) {
  return PHONE_CONFIG[phoneNumberId] || DEFAULT_CONFIG;
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
// 🆕 HELPER: VERIFICAR PLAN PREMIUM (usa companyId del override si existe)
// ========================================
async function esPremium(reserva, config) {
  try {
    const companyId = config?.companyId || reserva.companyId;

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
async function enviarTemplate(to, templateName, variables = [], token, phoneNumberId) {
  const cleanPhone = String(to).replace(/\D/g, '');

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

    const templateBase = nuevoEstado === 'confirmed' ? 'reserva_confirmada_v2' : 'reserva_cancelada_v3';
    const templateName = resolverPlantilla(templateBase, config?.templateSuffix);
    const linkFinal    = nuevoEstado === 'confirmed' ? mapLink : shopUrl;

    const variables = [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, linkFinal];

    console.log(`📤 Enviando '${templateName}' al cliente...`);
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
    const cleanPhone   = normalizarNumeroPY(reserva.client?.phone);
    const templateName = resolverPlantilla('recordatorio_turno_v4', config?.templateSuffix);

    const variables = [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, mapLink];

    console.log(`📤 Enviando '${templateName}' a ${cleanPhone}...`);
    await enviarTemplate(cleanPhone, templateName, variables, config?.token, config?.phoneNumberId);
  } catch (error) {
    console.error('❌ Error en enviarRecordatorioWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: SOLICITAR CALIFICACIÓN (PREMIUM)
// ========================================
async function enviarCalificacionWhatsApp(reserva, config) {
  try {
    const clientName   = reserva.client?.name || 'Cliente';
    const barberName   = reserva.barber?.name || 'tu barbero';
    const cleanPhone   = normalizarNumeroPY(reserva.client?.phone);

    if (!cleanPhone) {
      console.log('⚠️ No hay teléfono válido para enviar calificación.');
      return;
    }

    const { shopName } = await obtenerDatosUbicacion(reserva.locationId);
    const templateName = resolverPlantilla('calificar_barbero_v2', config?.templateSuffix);
    const variables    = [clientName, shopName, barberName];

    console.log(`📤 Enviando '${templateName}' a ${clientName}...`);
    await enviarTemplate(cleanPhone, templateName, variables, config?.token, config?.phoneNumberId);
  } catch (error) {
    console.error('❌ Error en enviarCalificacionWhatsApp:', error);
  }
}

// ========================================
// WHATSAPP: AGRADECIMIENTO (PREMIUM)
// ========================================
async function enviarAgradecimientoWhatsApp(reserva, telefonoLocal, config) {
  try {
    const premium = await esPremium(reserva, config);
    if (!premium) {
      console.log('⚠️ Agradecimiento no enviado. La cuenta no es Premium.');
      return;
    }

    const cleanPhone   = normalizarNumeroPY(telefonoLocal);
    const templateName = resolverPlantilla('agradecimiento_v1', config?.templateSuffix);

    console.log(`📤 Enviando '${templateName}' a ${cleanPhone}...`);
    await enviarTemplate(cleanPhone, templateName, [], config?.token, config?.phoneNumberId);
  } catch (error) {
    console.error('❌ Error en enviarAgradecimientoWhatsApp:', error);
  }
}

// ========================================
// RUTA DE PRUEBA
// ========================================
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, message: 'BarberGo WhatsApp API activa' });
});

// ========================================
// 🆕 ENVIAR MENSAJE (ahora basado en locationId)
// ========================================
app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [], locationId, companyId } = req.body;
    if (!phone || !templateName) return res.status(400).json({ success: false, error: 'Faltan datos' });

    const config = getConfigPorLocation(locationId);

    // 🔀 DELEGAR si el local tiene su propio servidor
    if (config.serverUrl) {
      console.log(`🔀 Delegando enviar-mensaje a ${config.serverUrl}: ${templateName}`);
      try {
        const r = await fetch(`${config.serverUrl}/api/enviar-mensaje`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(req.body)
        });
        const data = await r.json();
        return res.status(r.ok ? 200 : 500).json(data);
      } catch (err) {
        console.error('❌ Error delegando:', err);
        return res.status(500).json({ success: false, error: 'Error delegando' });
      }
    }

    // BarberGo normal
    const cleanPhone = normalizarNumeroPY(phone);
    const finalTemplate = resolverPlantilla(templateName, config.templateSuffix);
    const ok = await enviarTemplate(cleanPhone, finalTemplate, params, config.token, config.phoneNumberId);
    return res.status(ok ? 200 : 500).json({ success: ok });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// ========================================
// 🆕 NOTIFICAR CANCELACIÓN DESDE EL PANEL ADMIN
// ========================================
app.post('/api/admin-notificar-cancelacion', async (req, res) => {
  try {
    const { reserva } = req.body;

    if (!reserva || !reserva.client || !reserva.client.phone) {
      return res.status(400).json({ success: false, error: 'Faltan datos de la reserva o del cliente' });
    }

    const numeroMeta = normalizarNumeroPY(reserva.client.phone);
    const config = getConfigPorLocation(reserva.locationId);
    await enviarRespuestaWhatsApp(reserva, 'cancelled', numeroMeta, config);

    return res.status(200).json({ success: true, message: 'Mensaje de cancelación enviado' });
  } catch (error) {
    console.error('❌ Error en /api/admin-notificar-cancelacion:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ========================================
// 🆕 NOTIFICAR RESERVA COMPLETADA (Búsqueda en Firestore)
// ========================================
app.post('/api/reserva-completada', async (req, res) => {
  try {
    const { bookingId } = req.body;

    if (!bookingId) {
      return res.status(400).json({ success: false, error: 'Falta bookingId' });
    }

    const realBooking = bookingSnap.data();
    const trueCompanyId = realBooking.companyId;
    const trueLocationId = realBooking.locationId;

    console.log(`📦 [Verificación BD] bookingId: ${bookingId} | company: ${trueCompanyId} | location: ${trueLocationId}`);

    // ==============================================
    // 🛡️ REDIRECCIÓN ESTRICTA PARA CAPELLI
    // ==============================================
    const esCapelli = trueCompanyId === 'nI6ilcu8qPbH3xiXXsM7' || trueLocationId === '2OaikKXImqJbfPaqXfG6';

    if (esCapelli) {
      console.log(`🔀 [DELEGANDO] Reserva de Capelli detectada. Enviando a barbergo-whatsapp-api-1...`);
      try {
        // Le pasamos el realBooking para que Capelli tenga todos los datos correctos
        const r = await fetch('https://barbergo-whatsapp-api-1.onrender.com/api/reserva-completada', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reserva: realBooking, bookingId: bookingId })
        });
        const data = await r.json();
        return res.status(r.ok ? 200 : 500).json(data);
      } catch (err) {
        console.error('❌ Error delegando al servidor de Capelli:', err);
        return res.status(500).json({ success: false, error: 'Error de red hacia Capelli' });
      }
    }

    // ==============================================
    // FLUJO NORMAL PARA BARBERGO (Si no es Capelli)
    // ==============================================
    if (!realBooking.isPrimary) {
      return res.status(200).json({ success: true, message: 'No es reserva primaria, ignorado' });
    }

    if (realBooking.ratingTemplateSent) {
      return res.status(200).json({ success: true, message: 'Rating ya enviado previamente' });
    }

    // Usamos el config por defecto (BarberGo)
    const config = DEFAULT_CONFIG; 
    const premium = await esPremium(realBooking, config);

    if (!premium) {
      console.log(`⚠️ Reserva ${bookingId} completada. No es cuenta Premium (BarberGo).`);
      await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });
      return res.status(200).json({ success: true, message: 'No es cuenta Premium' });
    }

    console.log(`💈 Cuenta PREMIUM de BarberGo. Solicitando calificación...`);
    await enviarCalificacionWhatsApp(realBooking, config);
    await bookingRef.update({ ratingTemplateSent: true, isReviewed: false });

    return res.status(200).json({ success: true, message: 'Solicitud de calificación enviada por BarberGo' });

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
// 🆕 RECEPCIÓN DE EVENTOS DEL WEBHOOK (POST)
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

        const phoneNumberId = value.metadata?.phone_number_id;
        const phoneConfig = getPhoneConfig(phoneNumberId); // config "default" para este número

        console.log(`📱 Mensaje entrante via phoneNumberId: ${phoneNumberId} | templateSuffix: ${phoneConfig.templateSuffix || '(BarberGo)'}`);

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

              // 🆕 Ya no filtramos por companyId acá, filtramos por el teléfono
              // y abajo resolvemos la config en base al locationId de la reserva
              const snapshot = await db.collection('bookings')
                .where('client.phone', '==', telefonoLocal)
                .where('status', '==', 'completed')
                .orderBy('createdAt', 'desc')
                .limit(5)
                .get();

              const bookingDoc = snapshot.docs.find(doc => doc.data().isReviewed !== true);

              if (!bookingDoc) {
                console.log(`⚠️ No hay reservas sin reseñar para ${telefonoLocal}`);
                continue;
              }

              const booking    = bookingDoc.data();
              const locationId = booking.locationId ? String(booking.locationId).trim() : null;
              const barberId   = booking.barber?.id  ? String(booking.barber.id).trim()  : null;
              const config     = getConfigPorLocation(locationId); // 🆕

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
            const estadosValidos = nuevoEstado === 'confirmed'
              ? ['pending']
              : ['pending', 'confirmed'];

            // 🆕 Ya no filtramos por companyId acá
            const snapshot = await db.collection('bookings')
              .where('client.phone', '==', telefonoLocal)
              .where('status', 'in', estadosValidos)
              .orderBy('createdAt', 'desc')
              .limit(1)
              .get();

            if (snapshot.empty) {
              console.log(`⚠️ No se encontraron reservas válidas para ${telefonoLocal}`);
              continue;
            }

            const reservaDoc = snapshot.docs[0];
            const reserva    = reservaDoc.data();
            const groupId    = reserva.bookingGroupId;
            const config     = getConfigPorLocation(reserva.locationId); // 🆕

            if (nuevoEstado === 'confirmed' && reserva.status === 'confirmed') {
              console.log('ℹ️ El turno ya estaba confirmado, se ignora.');
              continue;
            }

            if (!groupId) {
              await db.collection('bookings').doc(reservaDoc.id).update({
                status:    nuevoEstado,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
              });
              console.log(`✅ Documento individual actualizado a '${nuevoEstado}'`);
            } else {
              const bloquesSnapshot = await db.collection('bookings')
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
// 🆕 CRON: RECORDATORIOS 3 HORAS ANTES
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

        const config = getConfigPorLocation(reserva.locationId); // 🆕
        await enviarRecordatorioWhatsApp(reserva, config);
      }
    }
  } catch (error) {
    console.error('❌ Error en Cron Job de recordatorios:', error);
  }
});

// ========================================
// NOTIFICACIONES PUSH FCM
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
        title: title || '¡Nueva Reserva! 💈',
        body: body || 'Tienes un nuevo turno agendado'
      },
      data: {
        title: title || '¡Nueva Reserva! 💈',
        body: body || 'Tienes un nuevo turno agendado',
        bookingId: data?.bookingId || '',
        locationId: data?.locationId || ''
      },
      android: {
        priority: 'high',
        notification: {
          sound: 'default',
          channelId: 'barbergo_reservas',
          tag: data?.bookingId || 'nueva-reserva'
        }
      },
      webpush: {
        headers: { Urgency: 'high' },
        notification: {
          tag: data?.bookingId || 'nueva-reserva',
          renotify: false
        }
      }
    });

    response.responses.forEach((resp, idx) => {
      if (resp.success) {
        console.log(`✅ Token [${idx}] OK`);
      } else {
        console.error(`❌ Token [${idx}] FALLÓ — ${resp.error?.code}`);
      }
    });

    const invalidTokens = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code;
        if (
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/registration-token-not-registered'
        ) {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    if (invalidTokens.length > 0) {
      const batch = db.batch();
      const snap = await db.collection('admin_tokens')
        .where('token', 'in', invalidTokens).get();
      snap.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }

    res.json({ success: true, enviados: response.successCount });
  } catch (error) {
    console.error('❌ Error FCM:', error);
    res.status(500).json({ error: error.message });
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