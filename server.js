const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Variables desde Render
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

app.post('/api/enviar-mensaje', async (req, res) => {
    // AHORA RECIBIMOS EL NOMBRE DE LA PLANTILLA Y LOS PARÁMETROS
    const { phone, templateName, params } = req.body;

    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '595' + cleanPhone.substring(1);
    } else if (!cleanPhone.startsWith('595')) {
        cleanPhone = '595' + cleanPhone;
    }

    try {
        // Convertimos tu lista de palabras al formato que Meta exige
        const parametersObj = params.map(param => ({
            type: "text",
            text: String(param)
        }));

        const response = await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: cleanPhone,
                type: "template", // <-- ¡MAGIA! Le decimos que es una plantilla
                template: {
                    name: templateName, // Ej: "confirmacion_reserva"
                    language: {
                        code: "es" // El idioma que elegiste al crearla
                    },
                    components: [
                        {
                            type: "body",
                            parameters: parametersObj
                        }
                    ]
                }
            })
        });

        const data = await response.json();

        if (response.ok) {
            console.log(`✅ Plantilla enviada a ${cleanPhone}`);
            res.status(200).json({ success: true, messageId: data.messages[0].id });
        } else {
            console.error("❌ Error de Meta API:", data);
            res.status(response.status).json({ success: false, error: data });
        }
    } catch (error) {
        console.error("❌ Error de red:", error);
        res.status(500).json({ success: false, error: "Error de servidor" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 BarberGo Meta API activa en puerto ${PORT}`));

// --- CONFIGURACIÓN DEL WEBHOOK DE WHATSAPP ---

const VERIFY_TOKEN = "barbergo_token_seguro"; // Puedes inventar el texto que quieras

// 1. Ruta GET para que Meta verifique tu Webhook (Solo ocurre una vez)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ Webhook verificado correctamente por Meta');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

// 2. Ruta POST para recibir los mensajes de los clientes
app.post('/webhook', async (req, res) => {
  console.log("🔔 ALERTA DE WEBHOOK CRUDO:", JSON.stringify(req.body, null, 2));
  const body = req.body;

  if (body.object) {
    if (body.entry && body.entry[0].changes && body.entry[0].changes[0].value.messages && body.entry[0].changes[0].value.messages[0]) {
      
      const mensaje = body.entry[0].changes[0].value.messages[0];
      const numeroCliente = mensaje.from; // Número del cliente que responde
      
      let respuestaCliente = "";

      // Si el cliente responde con un botón (lo más recomendado)
      if (mensaje.type === "button") {
        respuestaCliente = mensaje.button.text.toLowerCase();
      } 
      // Si el cliente responde escribiendo texto
      else if (mensaje.type === "text") {
        respuestaCliente = mensaje.text.body.toLowerCase();
      }

      console.log(`📩 Mensaje recibido de ${numeroCliente}: ${respuestaCliente}`);

      // --- AQUÍ VA TU LÓGICA DE BASE DE DATOS ---
      if (respuestaCliente.includes("cancelar") || respuestaCliente === "❌ cancelar turno") {
        console.log("El cliente quiere CANCELAR.");
        // Buscar reserva por número y cambiar estado a "Cancelado"
        // await db.reservas.update(...) 
      } else if (respuestaCliente.includes("confirmar") || respuestaCliente === "✅ confirmar") {
        console.log("El cliente quiere CONFIRMAR.");
        // Buscar reserva por número y cambiar estado a "Confirmado"
      }
    }
    res.sendStatus(200); // Siempre debes responder 200 a Meta
  } else {
    res.sendStatus(404);
  }
});