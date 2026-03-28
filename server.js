const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode'); // Cambiamos a esta librería para generar imagen
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

let ultimoQr = "";

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

client.on('qr', (qr) => {
    console.log('📱 NUEVO QR GENERADO. Velo en: /ver-qr');
    ultimoQr = qr;
});

client.on('ready', () => {
    console.log('✅ ¡WhatsApp conectado!');
    ultimoQr = "CONECTADO";
});

client.initialize();

// --- 🌐 RUTA PARA VER EL QR PERFECTO ---
app.get('/ver-qr', async (req, res) => {
    if (!ultimoQr) return res.send("Esperando el QR... recarga en 5 segundos.");
    if (ultimoQr === "CONECTADO") return res.send("✅ Ya estás conectado.");

    // Generamos una página HTML con el QR en formato imagen
    const qrImage = await qrcode.toDataURL(ultimoQr);
    res.send(`
        <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
            <h1>Escanea este QR con WhatsApp</h1>
            <img src="${qrImage}" style="border: 20px solid white; box-shadow: 0 0 20px rgba(0,0,0,0.1);" />
            <p>Si el QR expira, simplemente recarga esta página.</p>
        </div>
    `);
});

app.post('/api/enviar-mensaje', async (req, res) => {
    try {
        const { phone, message } = req.body;

        // 1. Verificamos si el cliente existe y está listo
        if (!client || !client.info) {
            console.log("❌ Error: El cliente de WhatsApp no está vinculado.");
            return res.status(400).json({ 
                success: false, 
                error: "WhatsApp no está vinculado. Escanea el QR en /ver-qr" 
            });
        }

        // 2. Limpiamos el número
        let numeroLimpio = phone.replace(/\D/g, ''); 
        if (numeroLimpio.startsWith('0')) {
            numeroLimpio = '595' + numeroLimpio.substring(1);
        }

        // 3. Formato correcto para WhatsApp
        const chatId = `${numeroLimpio}@c.us`;
        
        console.log(`Sending message to: ${chatId}`);

        // 4. Enviamos el mensaje directamente (más seguro que getChat)
        await client.sendMessage(chatId, message);
        
        res.status(200).json({ success: true });
        console.log("✅ Mensaje enviado con éxito!");

    } catch (error) {
        console.error("❌ ERROR AL ENVIAR:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));