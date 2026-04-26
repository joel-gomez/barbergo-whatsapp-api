const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const cron = require('node-cron');

// ========================================
// FIREBASE ADMIN
// ========================================
const serviceAccount = require('./firebase-key.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const app = express();
app.use(cors());
app.use(express.json());

// ========================================
// VARIABLES DE ENTORNO
// ========================================
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const PORT = process.env.PORT || 10000;

// ========================================
// HELPERS
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
// 🤖 FUNCIÓN PARA RESPONDER POR WHATSAPP
// ========================================
async function enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta) {
  try {
    // 1. Obtener datos de la sucursal desde Firebase
    let shopName = 'la barbería';
    let mapLink = 'https://maps.app.goo.gl/tu-local';
    let shopUrl = 'https://app.barbergo.com.py';

    if (reserva.locationId) {
      const locSnap = await db.collection('locations').doc(reserva.locationId).get();
      if (locSnap.exists) {
        const locData = locSnap.data();
        shopName = locData.name || shopName;
        mapLink = locData.mapUrl || mapLink;
        
        if (locData.slug) shopUrl = `https://app.barbergo.com.py/${locData.slug}`;
      }
    }

    // 2. Formatear la fecha (Ej: mié, 15 nov)
    const dateObj = new Date(reserva.date + 'T00:00:00');
    const opcionesFecha = { weekday: 'short', day: 'numeric', month: 'short' };
    const formattedDate = dateObj.toLocaleDateString('es-ES', opcionesFecha).replace(',', '');

    // 3. Extraer el resto de las variables
    const clientName = reserva.client?.name || 'Cliente';
    const timeStr = reserva.startTime || reserva.time || '';
    const barberName = reserva.barber?.name || 'Barbero asignado';
    const groupId = reserva.bookingGroupId || reserva.id || '';
    const tId = groupId ? String(groupId).slice(-5) : '-----';

    // 👇 AQUÍ ESTÁ LA CORRECCIÓN: Leemos la lista de servicios (Array) y el Total 👇
    const serviceName = reserva.services && reserva.services.length > 0 
        ? reserva.services.map(s => s.name).join(', ') 
        : 'Servicio de barbería';
        
    const servicePrice = reserva.totalPrice || '0';
    // 👆 ========================================================================= 👆

    // 4. Elegir la plantilla correcta según el estado (USANDO LAS NUEVAS VERSIONES)
    const templateName = nuevoEstado === 'confirmed' ? 'reserva_confirmada_v2' : 'reserva_cancelada_v3';
    
    // El enlace final (Posición 9): Si confirma es el Mapa, si cancela es el Link de la web.
    const linkFinal = nuevoEstado === 'confirmed' ? mapLink : shopUrl;

    // El orden exacto: Nombre, Local, Fecha, Hora, Barbero, Servicio, Precio, Ticket, Link
    const variablesPlantilla = [clientName, shopName, formattedDate, timeStr, barberName, serviceName, servicePrice, tId, linkFinal];

    console.log(`📤 Enviando plantilla automática '${templateName}' al cliente...`);

    const payload = {
      messaging_product: 'whatsapp',
      to: String(numeroMeta).replace(/\D/g, ''),
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'es' },
        components: [{
          type: 'body',
          parameters: variablesPlantilla.map(v => ({ type: 'text', text: String(v) }))
        }]
      }
    };

    const response = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log(`✅ ¡Bot respondió con éxito usando '${templateName}'!`);
    } else {
      const errData = await response.json();
      console.error(`❌ Error de Meta al enviar la respuesta:`, errData);
    }
  } catch (error) {
    console.error('❌ Error interno en la función enviarRespuestaWhatsApp:', error);
  }
}

// ========================================
// RUTA DE PRUEBA
// ========================================
app.get('/', (req, res) => {
  res.status(200).json({ ok: true, message: 'BarberGo WhatsApp API activa' });
});

// ========================================
// ENVÍO MANUAL DE MENSAJES TEMPLATE
// ========================================
app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [] } = req.body;

    if (!phone || !templateName) {
      return res.status(400).json({ success: false, error: 'phone y templateName son obligatorios' });
    }

    const cleanPhone = normalizarNumeroPY(phone);
    const parametersObj = params.map(param => ({ type: 'text', text: String(param) }));

    const payload = {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'es' },
        components: [{ type: 'body', parameters: parametersObj }]
      }
    };

    const response = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ success: false, error: data });
    }

    return res.status(200).json({ success: true, messageId: data?.messages?.[0]?.id || null, data });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({ success: false, error: 'Error interno del servidor' });
  }
});

// ========================================
// VERIFICACIÓN DEL WEBHOOK (GET)
// ========================================
app.get('/webhook', (req, res) => {
  try {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
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
  // Responder rápido a Meta
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    const entries = body.entry || [];

    for (const entry of entries) {
      const changes = entry.changes || [];

      for (const change of changes) {
        const value = change.value || {};

        // Statuses (Mensaje entregado, leído, etc) ignorados en consola para no saturar
        
        // Mensajes entrantes
        if (value.messages && Array.isArray(value.messages)) {
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
                mensaje.interactive?.list_reply?.title?.toLowerCase()?.trim() ||
                '';
            }

            console.log(`📞 Número de Meta: ${numeroMeta}`);
            console.log(`💬 Texto interpretado: ${respuestaCliente}`);

            const palabrasMensaje = respuestaCliente.split(/[\s,.!?;:()]+/).filter(Boolean);

            const exactasConfirmar = ['si', 'sí', 'sii', 'siii', 'ok', 'okey', 'dale', 'voy', 'asisto', 'perfecto', 'excelente', 'seguro'];
            const exactasCancelar = ['no', 'imposible'];

            const tieneConfirmarExacta = palabrasMensaje.some(p => exactasConfirmar.includes(p));
            const tieneCancelarExacta = palabrasMensaje.some(p => exactasCancelar.includes(p));

            const esConfirmar = tieneConfirmarExacta || respuestaCliente.includes('confirm') || respuestaCliente.includes('de una') || respuestaCliente === '✅ confirmar';
            const esCancelar = tieneCancelarExacta || respuestaCliente.includes('cancel') || respuestaCliente.includes('anul') || respuestaCliente.includes('no voy') || respuestaCliente.includes('no podre') || respuestaCliente.includes('no podré') || respuestaCliente.includes('me complico') || respuestaCliente === '❌ cancelar turno';

            let nuevoEstado = null;

            // Prioridad a la cancelación
            if (esCancelar) {
              nuevoEstado = 'cancelled';
            } else if (esConfirmar) {
              nuevoEstado = 'confirmed';
            }

            if (!nuevoEstado) {
              console.log('ℹ️ Mensaje recibido pero no es confirmación ni cancelación.');
              continue;
            }

            console.log(`🔄 El cliente quiere cambiar su estado a: ${nuevoEstado}`);

            try {
              const reservasRef = db.collection('bookings');

              const snapshot = await reservasRef
                .where('client.phone', '==', telefonoLocal)
                .where('status', 'in', ['pending', 'confirmed']) 
                .orderBy('createdAt', 'desc')
                .limit(1)
                .get();

              if (snapshot.empty) {
                console.log(`⚠️ No se encontraron reservas 'pending' o 'confirmed' para el teléfono ${telefonoLocal}`);
                continue;
              }

              const reservaDoc = snapshot.docs[0];
              const reserva = reservaDoc.data();
              const docId = reservaDoc.id;
              const groupId = reserva.bookingGroupId;

              if (!groupId) {
                console.log('⚠️ Turno sin bookingGroupId. Actualizando documento individual...');
                await reservasRef.doc(docId).update({
                  status: nuevoEstado,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                console.log(`✅ ¡ÉXITO! Documento actualizado a '${nuevoEstado}'`);
              } else {
                console.log(`🎯 bookingGroupId encontrado: ${groupId}. Actualizando todos los bloques...`);
                const bloquesSnapshot = await reservasRef.where('bookingGroupId', '==', groupId).get();
                const batch = db.batch();

                bloquesSnapshot.forEach(doc => {
                  batch.update(doc.ref, {
                    status: nuevoEstado,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp()
                  });
                });

                await batch.commit();
                console.log(`✅ ¡ÉXITO! Ticket ${groupId} actualizado a '${nuevoEstado}'`);
              }

              // 🚀 AQUÍ OCURRE LA MAGIA: LLAMAMOS A LA NUEVA FUNCIÓN PARA ENVIAR EL MENSAJE DE VUELTA
              await enviarRespuestaWhatsApp(reserva, nuevoEstado, numeroMeta);

            } catch (dbError) {
              console.error('❌ Error interactuando con Firestore:', dbError);
            }
          }
        }
      }
    }
  } catch (error) {
    console.error('❌ Error procesando POST /webhook:', error);
  }
});

// ========================================
// ⏰ SISTEMA DE RECORDATORIOS AUTOMÁTICOS
// ========================================

// Función auxiliar para enviar el recordatorio vía Meta API (Adaptada a tu plantilla)
async function enviarRecordatorioWhatsApp(reserva) {
  try {
    // 1. Buscar datos del local
    let shopName = 'la barbería';
    let mapLink = 'https://maps.app.goo.gl/tu-local';

    if (reserva.locationId) {
      const locSnap = await db.collection('locations').doc(reserva.locationId).get();
      if (locSnap.exists) {
        const locData = locSnap.data();
        shopName = locData.name || shopName;
        mapLink = locData.mapUrl || mapLink;
      }
    }

    // 2. Formatear la fecha para que quede bonita (Ej: mié 15 nov)
    const dateObj = new Date(reserva.date + 'T00:00:00');
    const opcionesFecha = { weekday: 'short', day: 'numeric', month: 'short' };
    const formattedDate = dateObj.toLocaleDateString('es-ES', opcionesFecha).replace(',', '');

    // 3. Extraer todos los datos del cliente y turno
    const clientName = reserva.client?.name || 'Cliente';
    const timeStr = reserva.startTime || reserva.time || '';
    const barberName = reserva.barber?.name || 'tu barbero';
    
    // Servicios y Total
    const serviceName = reserva.services && reserva.services.length > 0 
        ? reserva.services.map(s => s.name).join(', ') 
        : 'Servicio de barbería';
    const servicePrice = reserva.totalPrice || '0';
    
    // Ticket
    const groupId = reserva.bookingGroupId || reserva.id || '';
    const tId = groupId ? String(groupId).slice(-5) : '-----';

    // Teléfono limpio
    const cleanPhone = normalizarNumeroPY(reserva.client?.phone);

    // 4. PREPARAMOS LAS 9 VARIABLES EN TU ORDEN EXACTO
    const templateName = 'recordatorio_turno_v3'; // 👈 Asegúrate de que coincida con Meta
    const variablesPlantilla = [
      clientName,    // {{1}} Nombre
      shopName,      // {{2}} Local
      formattedDate, // {{3}} Fecha
      timeStr,       // {{4}} Hora
      barberName,    // {{5}} Barbero
      serviceName,   // {{6}} Servicio
      servicePrice,  // {{7}} Precio
      tId,           // {{8}} Ticket
      mapLink        // {{9}} Ubicación
    ];

    console.log(`📤 Enviando recordatorio a ${cleanPhone}...`);

    const payload = {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'template',
      template: {
        name: templateName,
        language: { code: 'es' },
        components: [{
          type: 'body',
          parameters: variablesPlantilla.map(v => ({ type: 'text', text: String(v) }))
        }]
      }
    };

    const response = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      console.log(`✅ ¡Recordatorio enviado con éxito a ${clientName}!`);
    } else {
      const errData = await response.json();
      console.error(`❌ Error de Meta al enviar recordatorio:`, errData);
    }
  } catch (error) {
    console.error('❌ Error interno en enviarRecordatorioWhatsApp:', error);
  }
}

// ========================================
// ⏰ SISTEMA DE RECORDATORIOS AUTOMÁTICOS
// ========================================

// ⏱️ CRON JOB: Se ejecuta CADA 1 MINUTO (Ideal para testing)
// ⏱️ CRON JOB: Sugiero ejecutarlo cada 5 minutos para tener buena precisión
cron.schedule('*/5 * * * *', async () => {
  console.log('⏳ [CRON] Revisando reservas para recordatorios (45 minutos antes)...');
  
  try {
    const now = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Asuncion" }));
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

      const diffMs = bookingTime - now;
      const diffMinutes = Math.floor(diffMs / 60000);

      // 🎯 EL DISPARADOR: 45 MINUTOS ANTES
      // Usamos un rango de 40 a 50 minutos para asegurar que el Cron lo detecte
      if (diffMinutes >= 40 && diffMinutes <= 50) {
        
        console.log(`🎯 Recordatorio de 45 min para ${reserva.client.name} a las ${timeStr}`);

        const docRef = db.collection('bookings').doc(doc.id);
        
        // Marcamos como enviado para que no se repita en la siguiente vuelta del cron
        await docRef.update({
          reminderSent: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });

        await enviarRecordatorioWhatsApp(reserva);
        
        console.log(`✅ WhatsApp de 45 min enviado con éxito.`);
      }
    }
  } catch (error) {
    console.error("❌ Error en Cron Job:", error);
  }
});

// ========================================
// INICIAR SERVIDOR
// ========================================
app.listen(PORT, () => {
  console.log(`🚀 BarberGo Meta API activa en puerto ${PORT}`);
  console.log(`🌐 Webhook URL esperada: /webhook`);
});