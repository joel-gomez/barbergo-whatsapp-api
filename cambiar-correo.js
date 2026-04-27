const admin = require('firebase-admin');
const serviceAccount = require('./firebase-key.json'); // Asegúrate de que el nombre sea correcto

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Reemplaza estos dos valores:
const UID_DEL_USUARIO = "GELO4ZFBrLZmhxasDkOgipIL0wf1"; 
const NUEVO_CORREO = "edu@gmail.com";

admin.auth().updateUser(UID_DEL_USUARIO, {
  email: NUEVO_CORREO
})
  .then((userRecord) => {
    console.log("✅ ¡Éxito! El correo se actualizó a:", userRecord.email);
    process.exit();
  })
  .catch((error) => {
    console.log("❌ Error actualizando el correo:", error);
    process.exit();
  });