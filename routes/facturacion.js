/**
 * routes/facturacion.js
 * Facturación Electrónica SIFEN via Sifende — BarberGo
 * Usa firebase-admin directamente (igual que el resto del servidor)
 */

const express  = require('express');
const axios    = require('axios');
const admin    = require('firebase-admin');

const router = express.Router();

// db viene de admin ya inicializado en server.js
const db = admin.firestore();
const { FieldValue } = admin.firestore;

const SIFENDE_BASE = 'https://api.sifende.com.py/api/v1';
const SIFENDE_KEY  = process.env.SIFENDE_API_KEY;
const MOCK_MODE    = process.env.SIFENDE_MOCK === 'true';

// ── Helpers ──────────────────────────────────────────────────────────────────

function fechaISO() {
  return new Date().toISOString().slice(0, 19);
}

function mapearTipoPago(paymentMethod) {
  const mapa = { card: 'TARJETA_CREDITO_DEBITO', transfer: 'TRANSFERENCIA', check: 'CHEQUE' };
  return mapa[paymentMethod] || 'EFECTIVO';
}

function calcularTotal(services = []) {
  return services.reduce((acc, s) => acc + (s.price || 0), 0);
}

function generarCDC(numeroInterno) {
  const r   = '47009810';
  const tip = '01';
  const tim = '00000000';
  const est = '001';
  const pto = '001';
  const num = String(numeroInterno).padStart(7, '0');
  const fec = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cod = String(Math.floor(Math.random() * 99999999)).padStart(8, '0');
  return `${r}${tip}${tim}${est}${pto}${num}${fec}${cod}`.slice(0, 44);
}

async function obtenerSiguienteNumero(companyId) {
  const ref = db
    .collection('counters').doc('facturacion')
    .collection(companyId).doc('correlativo');

  return db.runTransaction(async (t) => {
    const snap      = await t.get(ref);
    const actual    = snap.exists ? snap.data().ultimoNumero : 0;
    const siguiente = actual + 1;
    t.set(ref, { ultimoNumero: siguiente, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return siguiente;
  });
}

// ── Mock ──────────────────────────────────────────────────────────────────────
const mockEstados = {};

function mockEmitir(numeroInterno) {
  const cdc              = generarCDC(numeroInterno);
  const numeroFormateado = `001-001-${String(numeroInterno).padStart(7, '0')}`;
  mockEstados[cdc]       = { creadoAt: Date.now() };
  return {
    id: `mock-${Date.now()}`, cdc, estado: 'PENDIENTE',
    tipoDocumento: 'FACTURA_ELECTRONICA', iTiDe: 1,
    numeroDocumento: numeroInterno, numeroFormateado,
    fechaCreacion: fechaISO(),
    qrUrl: `https://ekuatia.set.gov.py/consultas-test/qr?Id=${cdc}`,
    statusUrl: `MOCK://status/${cdc}`, kudeUrl: null,
  };
}

function mockConsultarEstado(cdc) {
  const info    = mockEstados[cdc] || { creadoAt: Date.now() - 20000 };
  const segundos = (Date.now() - info.creadoAt) / 1000;
  return {
    cdc,
    estado: segundos >= 10 ? 'APROBADO' : 'PENDIENTE',
    fechaEmision: fechaISO(),
    tipoDocumento: 'FACTURA_ELECTRONICA',
    mensajeRechazo: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/facturacion/emitir
// ═══════════════════════════════════════════════════════════════════════════
router.post('/emitir', async (req, res) => {
  const { bookingId, companyId } = req.body;
  if (!bookingId || !companyId)
    return res.status(400).json({ ok: false, error: 'bookingId y companyId son requeridos' });

  try {
    const bookingRef  = db.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists)
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada' });

    const booking = bookingSnap.data();

    if (booking.status !== 'completed')
      return res.status(400).json({ ok: false, error: 'Solo se pueden facturar reservas completadas' });
    if (booking.factura?.cdc)
      return res.status(409).json({ ok: false, error: 'Ya tiene factura emitida', cdc: booking.factura.cdc, numeroFormateado: booking.factura.numeroFormateado });
    if (!booking.services?.length)
      return res.status(400).json({ ok: false, error: 'La reserva no tiene servicios' });

    const numeroInterno = await obtenerSiguienteNumero(companyId);
    const total         = calcularTotal(booking.services);
    const codigoCliente = `BG-${companyId.slice(0, 6)}-${numeroInterno}`;

    const companySnap = await db.collection('companies').doc(companyId).get();
    const sifen       = companySnap.exists ? (companySnap.data().sifen || {}) : {};
    const rucCliente = req.body.rucCliente || booking.client?.ruc || null;

    const payload = {
      codigoCliente,
      tipoDocumento:         'FACTURA_ELECTRONICA',
      fechaEmision:          fechaISO(),
      tipoEmision:           'NORMAL',
      numeroEstablecimiento: Number(sifen.establecimiento || 1),
      puntoExpedicion:       Number(sifen.punto || 1),
      monedaOperacion:       'PYG',
      tipoTransaccion:       'PRESTACION_SERVICIOS',
      condicionOperacion:    'CONTADO',
receptor: {
  tipoContribuyente: rucCliente ? 'CONTRIBUYENTE' : 'NO_CONTRIBUYENTE',
  tipoOperacion:     'B2C',
  tipoDocumento:     rucCliente ? 'RUC' : 'INNOMINADO',
  numeroDocumento:   rucCliente || '0',
  nombreRazonSocial: booking.client?.name || 'Consumidor Final',
  ...(booking.client?.email && { email: booking.client.email }),
},
      condicionPago: {
        tipo:       'CONTADO',
        tipoPago:   mapearTipoPago(booking.paymentMethod),
        monedaPago: 'PYG',
        montoPago:  total,
      },
      items: booking.services.map((srv, idx) => ({
        codigo:               srv.id || `SVC-${idx + 1}`,
        descripcion:          srv.name || 'Servicio de Barbería',
        cantidad:             1,
        unidadMedida:         'UNI',
        precioUnitario:       srv.price || 0,
        afectacionTributaria: 'GRAVADO',
        tasaIVA:              10,
      })),
    };

    let sfData;
    if (MOCK_MODE) {
      console.log(`[MOCK] Emitiendo booking=${bookingId} numero=${numeroInterno}`);
      sfData = mockEmitir(numeroInterno);
    } else {
      const sfRes = await axios.post(
        `${SIFENDE_BASE}/documento-electronico`, payload,
        { headers: { Authorization: `Bearer ${SIFENDE_KEY}`, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      sfData = sfRes.data;
    }

    const { id, cdc, estado, numeroDocumento, numeroFormateado, qrUrl, statusUrl, kudeUrl } = sfData;

await bookingRef.update({
  factura: {
    sifendeId: id, cdc, estado,
    numeroDocumento, numeroFormateado, numeroInterno,
    qrUrl: qrUrl || null, statusUrl: statusUrl || null, kudeUrl: kudeUrl || null,
    total, isMock: MOCK_MODE,
    emitidaAt: FieldValue.serverTimestamp(),
    paymentMethod: booking.paymentMethod || 'local',
    rucCliente: rucCliente || null,  // 👈 AGREGAR ESTA LÍNEA
  },
});

    console.log(`[${MOCK_MODE ? 'MOCK' : 'SIFENDE'}] Factura emitida cdc=${cdc}`);
    return res.json({ ok: true, cdc, estado, numeroFormateado, statusUrl, kudeUrl, total, isMock: MOCK_MODE });

  } catch (error) {
    const sfError = error.response?.data;
    console.error('[SIFENDE] Error al emitir:', sfError || error.message);
    try {
      await db.collection('bookings').doc(bookingId).update({
        'factura.ultimoError':     sfError?.message || error.message,
        'factura.ultimoIntentoAt': FieldValue.serverTimestamp(),
        'factura.estado':          'ERROR',
      });
    } catch (_) {}
    return res.status(500).json({ ok: false, error: sfError?.message || 'Error al emitir factura', detalle: sfError || null });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/facturacion/estado/:cdc?bookingId=xxx
// ═══════════════════════════════════════════════════════════════════════════
router.get('/estado/:cdc', async (req, res) => {
  const { cdc }       = req.params;
  const { bookingId } = req.query;

  try {
    let estadoData;
    if (MOCK_MODE || cdc.startsWith('MOCK')) {
      estadoData = mockConsultarEstado(cdc);
    } else {
      const sfRes = await axios.get(
        `${SIFENDE_BASE}/documento-electronico/status/${cdc}`,
        { headers: { Authorization: `Bearer ${SIFENDE_KEY}` }, timeout: 15000 }
      );
      estadoData = sfRes.data;
    }

    const { estado, mensajeRechazo } = estadoData;

    if (bookingId && ['APROBADO', 'RECHAZADO', 'CANCELADO', 'APROBADO_OBSERVACION'].includes(estado)) {
      const bookingRef  = db.collection('bookings').doc(bookingId);
      const bookingSnap = await bookingRef.get();
      if (bookingSnap.exists) {
        const updates = { 'factura.estado': estado };
        if (estado === 'APROBADO' || estado === 'APROBADO_OBSERVACION') {
          updates['factura.kudeUrl']    = MOCK_MODE
            ? `https://ekuatia.set.gov.py/consultas-test/qr?Id=${cdc}`
            : `${SIFENDE_BASE}/documento-electronico/${cdc}/kude`;
          updates['factura.aprobadaAt'] = FieldValue.serverTimestamp();
        }
        if (estado === 'RECHAZADO') updates['factura.mensajeRechazo'] = mensajeRechazo || null;
        await bookingRef.update(updates);
      }
    }

    return res.json({ ok: true, data: estadoData });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.response?.data?.message || 'Error al consultar estado' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/facturacion/cancelar
// ═══════════════════════════════════════════════════════════════════════════
router.post('/cancelar', async (req, res) => {
  const { cdc, motivo, bookingId } = req.body;
  if (!cdc || !motivo)
    return res.status(400).json({ ok: false, error: 'cdc y motivo son requeridos' });

  try {
    if (!MOCK_MODE) {
      await axios.post(
        `${SIFENDE_BASE}/documento-electronico/${cdc}/cancelar`, { motivo },
        { headers: { Authorization: `Bearer ${SIFENDE_KEY}`, 'Content-Type': 'application/json' }, timeout: 15000 }
      );
    } else {
      console.log(`[MOCK] Cancelando cdc=${cdc}`);
    }

    if (bookingId) {
      await db.collection('bookings').doc(bookingId).update({
        'factura.estado':            'CANCELADO',
        'factura.canceladaAt':       FieldValue.serverTimestamp(),
        'factura.motivoCancelacion': motivo,
      });
    }
    return res.json({ ok: true, mensaje: 'Documento cancelado correctamente' });
  } catch (error) {
    return res.status(error.response?.status || 500).json({
      ok: false, error: error.response?.data?.message || 'Error al cancelar',
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/facturacion/buscar-ruc/:ruc
// ═══════════════════════════════════════════════════════════════════════════
router.get('/buscar-ruc/:ruc', async (req, res) => {
  const { ruc } = req.params;
  if (!ruc) return res.status(400).json({ ok: false, error: 'RUC requerido' });

  // 🟡 MOCK: Siempre activo hasta tener PKI configurado
  if (MOCK_MODE) {
    const mockRucs = {
      '4700981-0': 'ANTHROPIC PARAGUAY S.A.',
      '80069174-1': 'BARBERGO TECH S.R.L.',
    };
    const nombre = mockRucs[ruc] || `CONTRIBUYENTE MOCK (${ruc})`;
    return res.json({ ok: true, ruc, nombre, tipoContribuyente: 'CONTRIBUYENTE' });
  }

  // 🔴 Sin mock: capturamos el error de Sifende y devolvemos 404 limpio
  try {
    const sfRes = await axios.get(
      `${SIFENDE_BASE}/contribuyente/${encodeURIComponent(ruc)}`,
      { headers: { Authorization: `Bearer ${SIFENDE_KEY}` }, timeout: 10000 }
    );
    const data = sfRes.data;
    return res.json({
      ok: true,
      ruc:               data.ruc        || ruc,
      nombre:            data.razonSocial || data.nombre || '',
      tipoContribuyente: data.tipoContribuyente || 'CONTRIBUYENTE',
    });
  } catch (error) {
    // PKI no configurado u otro error de Sifende → devolvemos 404 limpio
    // El frontend lo maneja mostrando "RUC no encontrado" en badge rojo
    return res.status(404).json({ ok: false, error: 'RUC no encontrado o servicio no disponible' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/facturacion/correlativo/:companyId
// ═══════════════════════════════════════════════════════════════════════════
router.get('/correlativo/:companyId', async (req, res) => {
  try {
    const ref  = db.collection('counters').doc('facturacion').collection(req.params.companyId).doc('correlativo');
    const snap = await ref.get();
    const ultimo = snap.exists ? snap.data().ultimoNumero : 0;
    return res.json({ ok: true, ultimoNumero: ultimo, siguiente: ultimo + 1 });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;