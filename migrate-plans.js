// =====================================================================
// migrate-plans.js — BarberGo Plan Migration
// Correr UNA sola vez después del deploy.
//
// Migración:
//   basic       → premium      (limits: 1 local, 6 barberos)
//   premium     → empresarial  (limits: 10 locales, 20 barberos)
//   empresarial → sin cambios  (plan nuevo, no debería existir aún)
//
// Uso:
//   1. Copiá tu firebase-key.json en la misma carpeta que este script
//   2. npm install firebase-admin   (si no lo tenés)
//   3. node migrate-plans.js
//   4. Guardá el output — incluye qué empresa pasó a qué plan
// =====================================================================

const admin = require('firebase-admin');
const serviceAccount = require('./firebase-key.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const NUEVOS_LIMITES = {
  premium:     { maxLocations: 1,  maxBarbers: 6  },
  empresarial: { maxLocations: 10, maxBarbers: 20 },
};

async function migrarPlanes() {
  console.log('');
  console.log('🚀 BarberGo — Migración de Planes');
  console.log('===================================');
  console.log('');

  const snap = await db.collection('companies').get();

  if (snap.empty) {
    console.log('⚠️  No se encontraron empresas en Firestore.');
    process.exit(0);
  }

  // Procesar en lotes de 500 (límite de Firestore)
  const docs = snap.docs.filter(d => {
    const plan = (d.data().plan || '').toLowerCase();
    const status = d.data().status || '';
    // Ignorar empresas eliminadas
    return status !== 'deleted' && (plan === 'basic' || plan === 'premium');
  });

  if (docs.length === 0) {
    console.log('✅ No hay empresas para migrar (ninguna en basic o premium).');
    process.exit(0);
  }

  console.log(`📋 Empresas a migrar: ${docs.length}`);
  console.log('');

  let basicCount = 0;
  let premiumCount = 0;
  let errorCount = 0;

  // Procesar en lotes de 500
  const BATCH_SIZE = 500;
  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const lote = docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (const docSnap of lote) {
      const data = docSnap.data();
      const planActual = (data.plan || '').toLowerCase();
      const nombre = data.name || 'Sin nombre';
      const email = data.ownerEmail || 'Sin email';

      try {
        if (planActual === 'basic') {
          batch.update(docSnap.ref, {
            plan: 'premium',
            limits: NUEVOS_LIMITES.premium,
            planAnterior: 'basic',
            migratedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          basicCount++;
          console.log(`  📦 basic → premium     | ${nombre} (${email})`);

        } else if (planActual === 'premium') {
          batch.update(docSnap.ref, {
            plan: 'empresarial',
            limits: NUEVOS_LIMITES.empresarial,
            planAnterior: 'premium',
            migratedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          premiumCount++;
          console.log(`  🏢 premium → empresarial | ${nombre} (${email})`);
        }
      } catch (e) {
        errorCount++;
        console.error(`  ❌ Error preparando ${nombre}:`, e.message);
      }
    }

    try {
      await batch.commit();
      console.log('');
      console.log(`  ✅ Lote ${Math.floor(i / BATCH_SIZE) + 1} guardado (${lote.length} empresas)`);
    } catch (e) {
      errorCount++;
      console.error('  ❌ Error guardando lote:', e.message);
    }
  }

  console.log('');
  console.log('===================================');
  console.log('✅ Migración completada');
  console.log(`   basic → premium:       ${basicCount} empresa(s)`);
  console.log(`   premium → empresarial: ${premiumCount} empresa(s)`);
  if (errorCount > 0) {
    console.log(`   ❌ Errores:            ${errorCount}`);
  }
  console.log('');
  console.log('💡 El campo "planAnterior" quedó guardado en cada doc por si necesitás revertir.');
  console.log('');

  process.exit(0);
}

migrarPlanes().catch(err => {
  console.error('');
  console.error('❌ Error fatal en la migración:', err);
  console.error('');
  process.exit(1);
});