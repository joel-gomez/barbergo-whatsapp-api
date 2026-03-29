const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Variables desde Render
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

app.post('/api/enviar-mensaje', async (req, res) => {
    const { phone, message } = req.body;

    // 1. Formatear número para Paraguay (Meta pide: 5959XXXXXXXX)
    let cleanPhone = phone.replace(/\D/g, '');
    if (cleanPhone.startsWith('0')) {
        cleanPhone = '595' + cleanPhone.substring(1);
    } else if (!cleanPhone.startsWith('595')) {
        cleanPhone = '595' + cleanPhone;
    }

    try {
        const response = await fetch(`https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                messaging_product: "whatsapp",
                to: cleanPhone,
                type: "text",
                text: { body: message }
            })
        });

        const data = await response.json();

        if (response.ok) {
            console.log(`✅ Mensaje enviado vía Meta a ${cleanPhone}`);
            res.status(200).json({ success: true, messageId: data.messages[0].id });
        } else {
            console.error("❌ Error de Meta API:", data);
            res.status(response.status).json({ success: false, error: data });
        }
    } catch (error) {
        console.error("❌ Error de conexión:", error);
        res.status(500).json({ success: false, error: "Error al conectar con Meta" });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`🚀 BarberGo Meta API activa en puerto ${PORT}`);
});