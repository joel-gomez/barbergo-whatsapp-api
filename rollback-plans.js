// =====================================================================
// rollback-plans.js — BarberGo Plan Rollback
// Revertir la migración usando el campo "planAnterior" guardado.
//
// Solo correr si algo salió mal con migrate-plans.js.
//
// Uso:
//   node rollback-plans.js
// =====================================================================

const admin = require('firebase-admin');
const serviceAccount = require('./firebase-key.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

const LIMITES_ORIGINALES = {
  basic:   { maxLocations: 1, maxBarbers: 3 },
  premium: { maxLocations: 1, maxBarbers: 6 },
};

async function rollbackPlanes() {
  console.log('');
  console.log('⏪ BarberGo — Rollback de Planes');
  console.log('===================================');
  console.log('');

  // Solo empresas que tienen el campo planAnterior (las que migramos)
  const snap = await db.collection('companies')
    .where('planAnterior', 'in', ['basic', 'premium'])
    .get();

  if (snap.empty) {
    console.log('✅ No hay empresas para revertir (ninguna tiene campo "planAnterior").');
    process.exit(0);
  }

  console.log(`📋 Empresas a revertir: ${snap.docs.length}`);
  console.log('');

  let revertidoCount = 0;
  let errorCount = 0;

  const BATCH_SIZE = 500;
  const docs = snap.docs;

  for (let i = 0; i < docs.length; i += BATCH_SIZE) {
    const lote = docs.slice(i, i + BATCH_SIZE);
    const batch = db.batch();

    for (const docSnap of lote) {
      const data = docSnap.data();
      const planActual = data.plan || '';
      const planAnterior = data.planAnterior || '';
      const nombre = data.name || 'Sin nombre';
      const email = data.ownerEmail || 'Sin email';

      if (!planAnterior) {
        console.log(`  ⏭️  Sin planAnterior: ${nombre} — omitido`);
        continue;
      }

      const limitesOriginales = LIMITES_ORIGINALES[planAnterior];
      if (!limitesOriginales) {
        console.log(`  ⚠️  planAnterior desconocido "${planAnterior}" para ${nombre} — omitido`);
        continue;
      }

      try {
        batch.update(docSnap.ref, {
          plan: planAnterior,
          limits: limitesOriginales,
          planAnterior: admin.firestore.FieldValue.delete(),
          migratedAt: admin.firestore.FieldValue.delete(),
          rollbackAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        revertidoCount++;
        console.log(`  ↩️  ${planActual} → ${planAnterior}  | ${nombre} (${email})`);
      } catch (e) {
        errorCount++;
        console.error(`  ❌ Error preparando rollback de ${nombre}:`, e.message);
      }
    }

    try {
      await batch.commit();
      console.log('');
      console.log(`  ✅ Lote ${Math.floor(i / BATCH_SIZE) + 1} revertido (${lote.length} empresas)`);
    } catch (e) {
      errorCount++;
      console.error('  ❌ Error guardando lote:', e.message);
    }
  }

  console.log('');
  console.log('===================================');
  console.log('✅ Rollback completado');
  console.log(`   Empresas revertidas: ${revertidoCount}`);
  if (errorCount > 0) {
    console.log(`   ❌ Errores:          ${errorCount}`);
  }
  console.log('');
  console.log('💡 Los campos "planAnterior" y "migratedAt" fueron eliminados.');
  console.log('   Podés correr migrate-plans.js de nuevo cuando estés listo.');
  console.log('');

  process.exit(0);
}

rollbackPlanes().catch(err => {
  console.error('');
  console.error('❌ Error fatal en el rollback:', err);
  console.error('');
  process.exit(1);
});