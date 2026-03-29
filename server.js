const { Client, RemoteAuth } = require('whatsapp-web.js');
const { FirebaseStore } = require('whatsapp-web.js-firebase');
const admin = require('firebase-admin');
const qrcode = require('qrcode');
const express = require('express');
const cors = require('cors');

// 1. IMPORTANTE: El archivo que descargaste de Firebase debe llamarse así
const serviceAccount = require('./firebase-key.json');

const app = express();
app.use(cors());
app.use(express.json());

let ultimoQr = "";

// 2. Inicializar Firebase Admin con tu Bucket
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    storageBucket: "barberia-reserva.appspot.com" // Tu bucket según la captura
});

const bucket = admin.storage().bucket();
const store = new FirebaseStore({ bucket: bucket });

// 3. Configuración del Cliente con RemoteAuth
const client = new Client({
    authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000 // Sincroniza cada 5 min
    }),
    puppeteer: { 
        headless: true,
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

// --- EVENTOS DEL CLIENTE ---

client.on('qr', (qr) => {
    console.log('📱 NUEVO QR GENERADO. Velo en: /ver-qr');
    ultimoQr = qr;
});

client.on('ready', () => {
    console.log('✅ ¡WhatsApp conectado y listo para enviar mensajes!');
    ultimoQr = "CONECTADO";
});

client.on('authenticated', () => {
    console.log('✅ Autenticado correctamente');
});

client.on('auth_failure', msg => {
    console.error('❌ FALLO DE AUTENTICACIÓN:', msg);
    ultimoQr = ""; 
});

// Este evento es clave: nos avisa cuando la sesión ya está segura en Firebase
client.on('remote_session_saved', () => {
    console.log('✅ SESIÓN GUARDADA EN FIREBASE: Ya no necesitarás el QR al reiniciar.');
});

client.initialize();

// --- RUTAS API ---

app.get('/ver-qr', async (req, res) => {
    if (ultimoQr === "CONECTADO") return res.send("✅ Ya estás conectado.");
    if (!ultimoQr) return res.send("Esperando el QR... recarga en 5 segundos.");

    const qrImage = await qrcode.toDataURL(ultimoQr);
    res.send(`
        <div style="text-align:center; font-family:sans-serif; margin-top:50px;">
            <h1>Escanea este QR con WhatsApp</h1>
            <img src="${qrImage}" style="border: 20px solid white; box-shadow: 0 0 20px rgba(0,0,0,0.1);" />
            <p>Una vez escaneado, la sesión se guardará en Firebase.</p>
        </div>
    `);
});

app.post('/api/enviar-mensaje', async (req, res) => {
    try {
        const { phone, message } = req.body;

        if (!client || !client.info) {
            return res.status(400).json({ 
                success: false, 
                error: "WhatsApp no está vinculado. Escanea el QR en /ver-qr" 
            });
        }

        let numeroLimpio = phone.replace(/\D/g, ''); 
        if (numeroLimpio.startsWith('0')) {
            numeroLimpio = '595' + numeroLimpio.substring(1);
        }

        const chatId = `${numeroLimpio}@c.us`;
        await client.sendMessage(chatId, message);
        
        res.status(200).json({ success: true });
        console.log(`✅ Mensaje enviado a ${numeroLimpio}`);

    } catch (error) {
        console.error("❌ ERROR AL ENVIAR:", error);
        res.status(500).json({ success: false, error: error.message });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`🚀 Servidor BarberGo corriendo en puerto ${PORT}`));