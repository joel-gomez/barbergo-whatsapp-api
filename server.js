const express = require('express');
const cors = require('cors');

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
  // Responder rápido a Meta
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

        // Metadata
        if (value.metadata) {
          console.log('📱 Metadata:');
          console.log(JSON.stringify(value.metadata, null, 2));
        }

        // Contactos
        if (value.contacts && Array.isArray(value.contacts)) {
          console.log('👤 Contactos:');
          console.log(JSON.stringify(value.contacts, null, 2));
        }

        // Mensajes entrantes
        if (value.messages && Array.isArray(value.messages)) {
          for (const mensaje of value.messages) {
            const numeroCliente = mensaje.from || '';
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

            console.log('📩 Mensaje entrante detectado:');
            console.log(JSON.stringify(mensaje, null, 2));

            console.log(`📞 Número cliente: ${numeroCliente}`);
            console.log(`🧾 Tipo mensaje: ${tipo}`);
            console.log(`💬 Texto interpretado: ${respuestaCliente}`);

            // ========================================
            // LÓGICA DE NEGOCIO
            // ========================================
            if (
              respuestaCliente.includes('cancelar') ||
              respuestaCliente === '❌ cancelar turno'
            ) {
              console.log('🛑 El cliente quiere CANCELAR');

              // Ejemplo:
              // await db.reservas.update({
              //   where: { telefono: numeroCliente },
              //   data: { estado: 'cancelado' }
              // });

            } else if (
              respuestaCliente.includes('confirmar') ||
              respuestaCliente === '✅ confirmar'
            ) {
              console.log('✅ El cliente quiere CONFIRMAR');

              // Ejemplo:
              // await db.reservas.update({
              //   where: { telefono: numeroCliente },
              //   data: { estado: 'confirmado' }
              // });

            } else {
              console.log('ℹ️ Mensaje recibido pero no coincide con confirmar/cancelar');
            }
          }
        }

        // Estados de mensajes
        if (value.statuses && Array.isArray(value.statuses)) {
          for (const status of value.statuses) {
            console.log('📬 Status recibido:');
            console.log(JSON.stringify(status, null, 2));
          }
        }

        // Errores enviados por Meta
        if (value.errors) {
          console.log('❌ Errores en webhook:');
          console.log(JSON.stringify(value.errors, null, 2));
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