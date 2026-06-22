/**
 * routes/facturacion.js
 * Facturación Electrónica SIFEN via Sifende — BarberGo
 * Cada empresa usa sus propias credenciales guardadas en Firestore
 */

const express = require('express');
const axios   = require('axios');
const admin   = require('firebase-admin');

const router = express.Router();

const db = admin.firestore();
const { FieldValue } = admin.firestore;

const SIFENDE_BASE    = 'https://api.sifende.com.py/api/v1';
const SIFENDE_KEY_ENV = process.env.SIFENDE_API_KEY; // fallback global
const MOCK_MODE       = process.env.SIFENDE_MOCK === 'true';

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

function generarCDC(rucEmisor, est, pto, numeroInterno) {
  const r      = (rucEmisor || '47009810').replace(/[^0-9]/g, '').slice(0, 8).padStart(8, '0');
  const tip    = '01';
  const tim    = '00000000';
  const estPad = String(est || '001').padStart(3, '0');
  const ptoPad = String(pto || '001').padStart(3, '0');
  const num    = String(numeroInterno).padStart(7, '0');
  const fec    = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const cod    = String(Math.floor(Math.random() * 99999999)).padStart(8, '0');
  return `${r}${tip}${tim}${estPad}${ptoPad}${num}${fec}${cod}`.slice(0, 44);
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

// ── Cargar credenciales SIFEN de la empresa desde Firestore ──────────────────
async function obtenerCredencialesSifen(companyId) {
  if (!companyId) return { apiKey: SIFENDE_KEY_ENV };

  try {
    const compSnap = await db.collection('companies').doc(companyId).get();
    if (!compSnap.exists) return { apiKey: SIFENDE_KEY_ENV };

    const sifen = compSnap.data().sifen || {};

    return {
      apiKey:          sifen.apiKey          || SIFENDE_KEY_ENV,
      establecimiento: sifen.establecimiento || '001',
      punto:           sifen.punto           || '001',
      ruc:             sifen.ruc             || '',
      razonSocial:     sifen.razonSocial     || '',
      timbrado:        sifen.timbrado        || '',
      fechaTimbrado:   sifen.fechaTimbrado   || '',
      habilitado:      sifen.habilitado      || false,
    };
  } catch (err) {
    console.error('[SIFEN] Error cargando credenciales:', err.message);
    return { apiKey: SIFENDE_KEY_ENV };
  }
}

// ── Mock ──────────────────────────────────────────────────────────────────────
const mockEstados = {};

function mockEmitir(numeroInterno, est, pto) {
  const estStr = String(est || '001').padStart(3, '0');
  const ptoStr = String(pto || '001').padStart(3, '0');
  const cdc    = generarCDC('47009810', estStr, ptoStr, numeroInterno);
  const numeroFormateado = `${estStr}-${ptoStr}-${String(numeroInterno).padStart(7, '0')}`;
  mockEstados[cdc] = { creadoAt: Date.now() };
  return {
    id: `mock-${Date.now()}`, cdc, estado: 'PENDIENTE',
    tipoDocumento: 'FACTURA_ELECTRONICA', iTiDe: 1,
    numeroDocumento: numeroInterno, numeroFormateado,
    fechaCreacion: fechaISO(),
    qrUrl:     `https://ekuatia.set.gov.py/consultas-test/qr?Id=${cdc}`,
    statusUrl: `MOCK://status/${cdc}`,
    kudeUrl:   null,
  };
}

function mockConsultarEstado(cdc) {
  const info     = mockEstados[cdc] || { creadoAt: Date.now() - 20000 };
  const segundos = (Date.now() - info.creadoAt) / 1000;
  return {
    cdc,
    estado:        segundos >= 10 ? 'APROBADO' : 'PENDIENTE',
    fechaEmision:  fechaISO(),
    tipoDocumento: 'FACTURA_ELECTRONICA',
    mensajeRechazo: null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// POST /api/facturacion/emitir
// ═══════════════════════════════════════════════════════════════════════════
router.post('/emitir', async (req, res) => {
  const { bookingId, companyId, rucCliente: rucClienteBody } = req.body;
  if (!bookingId || !companyId)
    return res.status(400).json({ ok: false, error: 'bookingId y companyId son requeridos' });

  try {
    // 1. Cargar reserva
    const bookingRef  = db.collection('bookings').doc(bookingId);
    const bookingSnap = await bookingRef.get();
    if (!bookingSnap.exists)
      return res.status(404).json({ ok: false, error: 'Reserva no encontrada' });

    const booking = bookingSnap.data();

    if (booking.status !== 'completed')
      return res.status(400).json({ ok: false, error: 'Solo se pueden facturar reservas completadas' });
    if (booking.factura?.cdc)
      return res.status(409).json({
        ok: false, error: 'Ya tiene factura emitida',
        cdc: booking.factura.cdc, numeroFormateado: booking.factura.numeroFormateado,
      });
    if (!booking.services?.length)
      return res.status(400).json({ ok: false, error: 'La reserva no tiene servicios' });

    // 2. Credenciales de la empresa
    const creds = await obtenerCredencialesSifen(companyId);
    console.log(`[SIFEN] Empresa: ${companyId} | RUC emisor: ${creds.ruc || 'N/A'} | Token: ${creds.apiKey ? '✅' : '❌'}`);

    if (!creds.apiKey && !MOCK_MODE)
      return res.status(400).json({ ok: false, error: 'Esta empresa no tiene credenciales SIFEN configuradas.' });

    // 3. Preparar datos
    const numeroInterno = await obtenerSiguienteNumero(companyId);
    const total         = calcularTotal(booking.services);
    const codigoCliente = `BG-${companyId.slice(0, 6)}-${numeroInterno}`;
    const rucCliente    = rucClienteBody || booking.client?.ruc || null;

    const payload = {
      codigoCliente,
      tipoDocumento:         'FACTURA_ELECTRONICA',
      fechaEmision:          fechaISO(),
      tipoEmision:           'NORMAL',
      numeroEstablecimiento: Number(creds.establecimiento || 1),
      puntoExpedicion:       Number(creds.punto || 1),
      monedaOperacion:       'PYG',
      tipoTransaccion:       'PRESTACION_SERVICIOS',
      condicionOperacion:    'CONTADO',

      // Emisor con datos reales de la empresa
      ...(creds.ruc && {
        emisor: {
          ruc:         creds.ruc,
          razonSocial: creds.razonSocial || '',
          timbrado:    creds.timbrado    || '',
        },
      }),

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

    // 4. Emitir
    let sfData;
    if (MOCK_MODE) {
      console.log(`[MOCK] Emitiendo booking=${bookingId} empresa=${companyId} numero=${numeroInterno}`);
      sfData = mockEmitir(numeroInterno, creds.establecimiento, creds.punto);
    } else {
      const sfRes = await axios.post(
        `${SIFENDE_BASE}/documento-electronico`, payload,
        {
          headers: { Authorization: `Bearer ${creds.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 30000,
        }
      );
      sfData = sfRes.data;
    }

    const { id, cdc, estado, numeroDocumento, numeroFormateado, qrUrl, statusUrl, kudeUrl } = sfData;

    // 5. Guardar en Firestore
    await bookingRef.update({
      factura: {
        sifendeId:          id,
        cdc,
        estado,
        numeroDocumento,
        numeroFormateado,
        numeroInterno,
        qrUrl:              qrUrl     || null,
        statusUrl:          statusUrl || null,
        kudeUrl:            kudeUrl   || null,
        total,
        isMock:             MOCK_MODE,
        emitidaAt:          FieldValue.serverTimestamp(),
        paymentMethod:      booking.paymentMethod || 'local',
        rucCliente:         rucCliente  || null,
        rucEmisor:          creds.ruc   || null,
        razonSocialEmisor:  creds.razonSocial || null,
      },
    });

    console.log(`[${MOCK_MODE ? 'MOCK' : 'SIFENDE'}] Factura emitida | empresa=${companyId} | cdc=${cdc}`);
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
    return res.status(500).json({
      ok:      false,
      error:   sfError?.message || 'Error al emitir factura',
      detalle: sfError || null,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/facturacion/estado/:cdc?bookingId=xxx&companyId=xxx
// ═══════════════════════════════════════════════════════════════════════════
router.get('/estado/:cdc', async (req, res) => {
  const { cdc }                  = req.params;
  const { bookingId, companyId } = req.query;

  try {
    const creds = await obtenerCredencialesSifen(companyId);

    let estadoData;
    if (MOCK_MODE || cdc.startsWith('MOCK')) {
      estadoData = mockConsultarEstado(cdc);
    } else {
      const sfRes = await axios.get(
        `${SIFENDE_BASE}/documento-electronico/status/${cdc}`,
        { headers: { Authorization: `Bearer ${creds.apiKey}` }, timeout: 15000 }
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
  const { cdc, motivo, bookingId, companyId } = req.body;
  if (!cdc || !motivo)
    return res.status(400).json({ ok: false, error: 'cdc y motivo son requeridos' });

  try {
    const creds = await obtenerCredencialesSifen(companyId);

    if (!MOCK_MODE) {
      await axios.post(
        `${SIFENDE_BASE}/documento-electronico/${cdc}/cancelar`, { motivo },
        {
          headers: { Authorization: `Bearer ${creds.apiKey}`, 'Content-Type': 'application/json' },
          timeout: 15000,
        }
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
// GET /api/facturacion/buscar-ruc/:ruc?companyId=xxx
// ═══════════════════════════════════════════════════════════════════════════
router.get('/buscar-ruc/:ruc', async (req, res) => {
  const { ruc }       = req.params;
  const { companyId } = req.query;
  if (!ruc) return res.status(400).json({ ok: false, error: 'RUC requerido' });

  if (MOCK_MODE) {
    const mockRucs = {
      '4700981-0': 'Joel Gomez',
      '80069174-1': 'BARBERGO TECH S.R.L.',
    };
    const nombre = mockRucs[ruc] || `CONTRIBUYENTE MOCK (${ruc})`;
    return res.json({ ok: true, ruc, nombre, tipoContribuyente: 'CONTRIBUYENTE' });
  }

  try {
    const creds  = await obtenerCredencialesSifen(companyId);
    const apiKey = creds.apiKey || SIFENDE_KEY_ENV;

    const sfRes = await axios.get(
      `${SIFENDE_BASE}/contribuyente/${encodeURIComponent(ruc)}`,
      { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 10000 }
    );
    const data = sfRes.data;
    return res.json({
      ok:                true,
      ruc:               data.ruc              || ruc,
      nombre:            data.razonSocial       || data.nombre || '',
      tipoContribuyente: data.tipoContribuyente || 'CONTRIBUYENTE',
    });
  } catch (error) {
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

// ═══════════════════════════════════════════════════════════════════════════
// GET /api/facturacion/credenciales/:companyId — verificar estado de config
// ═══════════════════════════════════════════════════════════════════════════
router.get('/credenciales/:companyId', async (req, res) => {
  try {
    const creds = await obtenerCredencialesSifen(req.params.companyId);
    return res.json({
      ok:              true,
      habilitado:      creds.habilitado      || false,
      tieneApiKey:     !!creds.apiKey,
      tieneRuc:        !!creds.ruc,
      tieneTimbrado:   !!creds.timbrado,
      establecimiento: creds.establecimiento || '001',
      punto:           creds.punto           || '001',
      razonSocial:     creds.razonSocial     || '',
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// En facturacion.js
router.get('/kude/:cdc', async (req, res) => {
  const { cdc }       = req.params;
  const { companyId } = req.query;

  try {
    const creds = await obtenerCredencialesSifen(companyId);
    const sfRes = await axios.get(
      `${SIFENDE_BASE}/documento-electronico/${cdc}/kude`,
      {
        headers:      { Authorization: `Bearer ${creds.apiKey}` },
        responseType: 'arraybuffer',
        timeout:      15000,
      }
    );

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="factura-${cdc}.pdf"`);
    res.send(Buffer.from(sfRes.data));
  } catch (err) {
    res.status(500).json({ ok: false, error: 'No se pudo obtener el KuDE' });
  }
});


module.exports = router;