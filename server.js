const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Iniciamos el "WhatsApp Web" invisible. LocalAuth guarda tu sesión para no escanear el QR a cada rato.
// Reemplaza la inicialización del cliente por esta:
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { 
        headless: true,
        // ESTO ES CLAVE PARA RENDER Y SERVIDORES LINUX
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('📱 ESCANEA ESTE CÓDIGO QR:');
    // Usamos small: false para que los bloques sean más grandes y definidos
    qrcode.generate(qr, { small: false }); 
});

client.on('ready', () => {
    console.log('✅ ¡WhatsApp conectado y listo para enviar mensajes!');
});

client.initialize();

// --- 🚀 ESTA ES LA RUTA QUE TU APP DE REACT VA A LLAMAR ---
app.post('/api/enviar-mensaje', async (req, res) => {
    try {
        const { phone, message } = req.body;
        
        if (!phone || !message) {
            return res.status(400).json({ error: 'Falta el número o el mensaje' });
        }

        // Formato para Paraguay (Ej: de 0981123456 a 595981123456@c.us)
        // whatsapp-web.js requiere que el número termine en @c.us
        let numeroLimpio = phone.replace(/\D/g, ''); 
        if (numeroLimpio.startsWith('0')) {
            numeroLimpio = '595' + numeroLimpio.substring(1);
        } else if (!numeroLimpio.startsWith('595')) {
            numeroLimpio = '595' + numeroLimpio;
        }

        const chatId = `${numeroLimpio}@c.us`;

        // Enviamos el mensaje
        await client.sendMessage(chatId, message);
        console.log(`📩 Mensaje enviado exitosamente a ${numeroLimpio}`);
        
        res.status(200).json({ success: true, message: 'Mensaje enviado' });

    } catch (error) {
        console.error('❌ Error enviando mensaje:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Servidor de WhatsApp corriendo en el puerto ${PORT}`);
});