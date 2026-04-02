const express = require('express');
const cors = require('cors');
// ========================================
// 1. IMPORTAR E INICIALIZAR FIREBASE ADMIN
// ========================================
const admin = require('firebase-admin');

// ⚠️ Asegúrate de tener este archivo en la misma carpeta que tu server.js
const serviceAccount = require('./firebase-key.json'); 

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore(); // Conexión lista a tu BD

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
// RUTA DE PRUEBA
// ========================================
app.get('/', (req, res) => {
  res.status(200).json({
    ok: true,
    message: 'BarberGo WhatsApp API activa'
  });
});

// ========================================
// ENVÍO DE MENSAJES TEMPLATE
// ========================================
app.post('/api/enviar-mensaje', async (req, res) => {
  try {
    const { phone, templateName, params = [] } = req.body;

    if (!phone || !templateName) {
      return res.status(400).json({
        success: false,
        error: 'phone y templateName son obligatorios'
      });
    }

    if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID) {
      return res.status(500).json({
        success: false,
        error: 'Faltan variables de entorno WHATSAPP_TOKEN o PHONE_NUMBER_ID'
      });
    }

    let cleanPhone = String(phone).replace(/\D/g, '');

    if (cleanPhone.startsWith('0')) {
      cleanPhone = '595' + cleanPhone.substring(1);
    } else if (!cleanPhone.startsWith('595')) {
      cleanPhone = '595' + cleanPhone;
    }

    const parametersObj = params.map(param => ({
      type: 'text',
      text: String(param)
    }));

    const payload = {
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'template',
      template: {
        name: templateName,
        language: {
          code: 'es'
        },
        components: [
          {
            type: 'body',
            parameters: parametersObj
          }
        ]
      }
    };

    console.log('📤 Payload enviado a Meta:');
    console.log(JSON.stringify(payload, null, 2));

    const response = await fetch(`https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    console.log('📨 Respuesta de Meta:');
    console.log(JSON.stringify(data, null, 2));

    if (!response.ok) {
      return res.status(response.status).json({
        success: false,
        error: data
      });
    }

    return res.status(200).json({
      success: true,
      messageId: data?.messages?.[0]?.id || null,
      data
    });
  } catch (error) {
    console.error('❌ Error en /api/enviar-mensaje:', error);
    return res.status(500).json({
      success: false,
      error: 'Error interno del servidor'
    });
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

    console.log('🔎 Verificación webhook recibida:');
    console.log({
      mode,
      token,
      challenge
    });

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verificado correctamente por Meta');
      return res.status(200).send(challenge);
    }

    console.log('❌ Token inválido en verificación del webhook');
    return res.sendStatus(403);
  } catch (error) {
    console.error('❌ Error en GET /webhook:', error);
    return res.sendStatus(500);
  }
});

// ========================================
// RECEPCIÓN DE EVENTOS DEL WEBHOOK (POST)
// ========================================
app.post('/webhook', async (req, res) => {
  // Responder rápido a Meta para evitar Timeouts
  res.sendStatus(200);

  try {
    const body = req.body;

    console.log('📥 WEBHOOK COMPLETO RECIBIDO:');
    console.log(JSON.stringify(body, null, 2));

    if (body.object !== 'whatsapp_business_account') {
      console.log('⚠️ Evento ignorado: object distinto de whatsapp_business_account');
      return;
    }

    const entries = body.entry || [];

    for (const entry of entries) {
      const changes = entry.changes || [];

      for (const change of changes) {
        const value = change.value || {};

        // Mensajes entrantes
        if (value.messages && Array.isArray(value.messages)) {
          for (const mensaje of value.messages) {
            const numeroMeta = mensaje.from || ''; // Viene como "595971..."
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

            // ========================================
            // LÓGICA DE NEGOCIO EN FIREBASE
            // ========================================
            
            // 1. Transformar número de Meta (595...) al formato local de BarberGo (09...)
            let telefonoLocal = numeroMeta;
            if (numeroMeta.startsWith("595")) {
              telefonoLocal = "0" + numeroMeta.substring(3);
            }

            const esConfirmar = respuestaCliente.includes('confirmar') || respuestaCliente === '✅ confirmar';
            const esCancelar = respuestaCliente.includes('cancelar') || respuestaCliente === '❌ cancelar turno';

            if (esConfirmar || esCancelar) {
              const nuevoEstado = esConfirmar ? 'confirmed' : 'cancelled';
              console.log(`🔄 El cliente quiere cambiar su estado a: ${nuevoEstado}`);

              try {
                // 2. Buscar la última reserva pendiente de este número
                const reservasRef = db.collection('bookings');
                const snapshot = await reservasRef
                  .where('client.phone', '==', telefonoLocal)
                  .where('status', '==', 'pending')
                  .orderBy('createdAt', 'desc')
                  .limit(1)
                  .get();

                if (snapshot.empty) {
                  console.log(`⚠️ No se encontraron reservas 'pending' para el teléfono ${telefonoLocal}`);
                } else {
                  // 3. Extraer el Ticket ID (bookingGroupId)
                  const reserva = snapshot.docs[0].data();
                  const groupId = reserva.bookingGroupId;

                  console.log(`🎯 Ticket encontrado: ${groupId}. Actualizando todos los bloques...`);

                  // 4. Actualizar TODOS los bloques de 30 mins que comparten ese Ticket ID
                  const bloquesSnapshot = await reservasRef.where('bookingGroupId', '==', groupId).get();
                  const batch = db.batch();

                  bloquesSnapshot.forEach(doc => {
                    batch.update(doc.ref, { 
                      status: nuevoEstado,
                      updatedAt: admin.firestore.FieldValue.serverTimestamp()
                    });
                  });

                  await batch.commit();
                  console.log(`✅ ¡ÉXITO! Base de datos actualizada a '${nuevoEstado}' para el Ticket ${groupId}`);
                }
              } catch (dbError) {
                console.error('❌ Error interactuando con Firestore:', dbError);
              }
            } else {
              console.log('ℹ️ Mensaje recibido pero no es confirmación ni cancelación.');
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
// INICIAR SERVIDOR
// ========================================
app.listen(PORT, () => {
  console.log(`🚀 BarberGo Meta API activa en puerto ${PORT}`);
  console.log(`🌐 Webhook URL esperada: /webhook`);
});