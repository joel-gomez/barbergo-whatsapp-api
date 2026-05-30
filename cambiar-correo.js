const admin = require('firebase-admin');
const serviceAccount = require('./firebase-key.json'); // Asegúrate de que el nombre sea correcto

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Reemplaza estos dos valores:
const UID_DEL_USUARIO = "izRnLC3XXsYzHDBcqxBxGjafCNC3"; 
const NUEVA_CONTRASENA = "felipe123"; // Debe tener al menos 6 caracteres

admin.auth().updateUser(UID_DEL_USUARIO, {
  password: NUEVA_CONTRASENA
})
  .then((userRecord) => {
    console.log("✅ ¡Éxito! La contraseña se actualizó correctamente para:", userRecord.uid);
    process.exit();
  })
  .catch((error) => {
    console.log("❌ Error actualizando la contraseña:", error);
    process.exit();
  });