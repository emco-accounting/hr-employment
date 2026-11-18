/**
 * ContaCore EMCO - Motor Contable de Partida Doble y Estados Financieros
 * Base de Datos: emco-accounting
 * Empresas soportadas: "cesar_gonzalez" | "hr_employment"
 */

import {
  collection,
  addDoc,
  getDocs,
  query,
  where,
  orderBy,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// ============================================================================
// 1. CATÁLOGO DE CUENTAS MAESTRO (NIF / SAT MÉXICO)
// ============================================================================
export const CATALOGO_CUENTAS = {
  // ACTIVO CIRCULANTE (Naturaleza Deudora: Aumenta con Debe, Disminuye con Haber)
  "101.01": { codigo: "101.01", nombre: "Caja Chica (Fondo Fijo)", tipo: "ACTIVO", subtipo: "CIRCULANTE", naturaleza: "DEUDORA" },
  "102.01": { codigo: "102.01", nombre: "Bancos Nacionales", tipo: "ACTIVO", subtipo: "CIRCULANTE", naturaleza: "DEUDORA" },
  "105.01": { codigo: "105.01", nombre: "Clientes (Cuentas por Cobrar)", tipo: "ACTIVO", subtipo: "CIRCULANTE", naturaleza: "DEUDORA" },
  "118.01": { codigo: "118.01", nombre: "IVA Acreditable Pagado", tipo: "ACTIVO", subtipo: "CIRCULANTE", naturaleza: "DEUDORA" },
  "119.01": { codigo: "119.01", nombre: "IVA Pendiente de Acreditar", tipo: "ACTIVO", subtipo: "CIRCULANTE", naturaleza: "DEUDORA" },

  // ACTIVO NO CIRCULANTE / FIJO
  "156.01": { codigo: "156.01", nombre: "Equipo de Cómputo y Activos Fijos", tipo: "ACTIVO", subtipo: "NO_CIRCULANTE", naturaleza: "DEUDORA" },
  "171.01": { codigo: "171.01", nombre: "Depreciación Acumulada de Activos", tipo: "ACTIVO", subtipo: "NO_CIRCULANTE", naturaleza: "ACREEDORA" }, // Cuenta complementaria (resta al activo)

  // PASIVO CIRCULANTE (Naturaleza Acreedora: Aumenta con Haber, Disminuye con Debe)
  "201.01": { codigo: "201.01", nombre: "Proveedores y Acreedores Diversos", tipo: "PASIVO", subtipo: "CIRCULANTE", naturaleza: "ACREEDORA" },
  "201.02": { codigo: "201.02", nombre: "Comisiones por Pagar a Ejecutivos", tipo: "PASIVO", subtipo: "CIRCULANTE", naturaleza: "ACREEDORA" },
  "205.01": { codigo: "205.01", nombre: "Tarjetas de Crédito Corporativas", tipo: "PASIVO", subtipo: "CIRCULANTE", naturaleza: "ACREEDORA" },
  "208.01": { codigo: "208.01", nombre: "IVA Trasladado Cobrado", tipo: "PASIVO", subtipo: "CIRCULANTE", naturaleza: "ACREEDORA" },
  "209.01": { codigo: "209.01", nombre: "IVA Trasladado No Cobrado", tipo: "PASIVO", subtipo: "CIRCULANTE", naturaleza: "ACREEDORA" },

  // CAPITAL CONTABLE (Naturaleza Acreedora)
  "301.01": { codigo: "301.01", nombre: "Capital Social / Patrimonio", tipo: "CAPITAL", subtipo: "CONTRIBUIDO", naturaleza: "ACREEDORA" },
  "305.01": { codigo: "305.01", nombre: "Resultados de Ejercicios Anteriores", tipo: "CAPITAL", subtipo: "GANADO", naturaleza: "ACREEDORA" },

  // INGRESOS - ESTADO DE RESULTADOS (Naturaleza Acreedora)
  "401.01": { codigo: "401.01", nombre: "Ingresos por Servicios Facturados", tipo: "INGRESO", subtipo: "OPERATIVO", naturaleza: "ACREEDORA" },

  // COSTOS - ESTADO DE RESULTADOS (Naturaleza Deudora)
  "501.01": { codigo: "501.01", nombre: "Costo Directo de Operación y Servicio", tipo: "COSTO", subtipo: "DIRECTO", naturaleza: "DEUDORA" },

  // GASTOS DE OPERACIÓN - ESTADO DE RESULTADOS (Naturaleza Deudora)
  "601.01": { codigo: "601.01", nombre: "Gastos de Venta - Comisiones Clientes", tipo: "GASTO", subtipo: "VENTA", naturaleza: "DEUDORA" },
  "601.02": { codigo: "601.02", nombre: "Gastos de Venta - Publicidad (Facebook Ads)", tipo: "GASTO", subtipo: "VENTA", naturaleza: "DEUDORA" },
  "601.03": { codigo: "601.03", nombre: "Gastos Generales - Movilidad (DiDi) y Viáticos", tipo: "GASTO", subtipo: "ADMINISTRACION", naturaleza: "DEUDORA" },
  "601.04": { codigo: "601.04", nombre: "Gastos Generales - Papelería y Caja Chica", tipo: "GASTO", subtipo: "ADMINISTRACION", naturaleza: "DEUDORA" },
  "601.05": { codigo: "601.05", nombre: "Gasto por Depreciación Contable", tipo: "GASTO", subtipo: "ADMINISTRACION", naturaleza: "DEUDORA" }
};

// Redondeo bancario exacto a 2 decimales para evitar errores de punto flotante en JS
const r2 = (num) => Math.round((Number(num || 0) + Number.EPSILON) * 100) / 100;

// ============================================================================
// 2. NÚCLEO DE PARTIDA DOBLE (EMISOR DE PÓLIZAS BLINDADO)
// ============================================================================
/**
 * Registra una póliza contable en Firestore validando partida doble exacta.
 * @param {Object} db - Instancia de Firestore (emco-accounting)
 * @param {Object} params - Datos de la póliza
 */
export async function emitirPolizaContable(db, {
  company_id,
  fecha,           // "YYYY-MM-DD"
  origen_modulo,   // "CXC" | "CXP" | "CAJA_CHICA" | "ACTIVOS" | "APERTURA"
  origen_doc_id = "",
  concepto,
  movimientos,     // Array de { cuenta: "105.01", debe: 100, haber: 0, referencia?: "" }
  user_uid = "SYSTEM"
}) {
  if (!company_id || !["cesar_gonzalez", "hr_employment"].includes(company_id)) {
    throw new Error(`Empresa inválida para póliza contable: ${company_id}`);
  }
  if (!Array.isArray(movimientos) || movimientos.length < 2) {
    throw new Error("Toda póliza contable requiere al menos 2 movimientos (Cargo y Abono).");
  }

  let totalDebe = 0;
  let totalHaber = 0;

  const asientosValidados = movimientos.map((m) => {
    const cuentaInfo = CATALOGO_CUENTAS[m.cuenta];
    if (!cuentaInfo) {
      throw new Error(`Código de cuenta inexistente en catálogo: ${m.cuenta}`);
    }
    const debe = r2(m.debe);
    const haber = r2(m.haber);

    if (debe < 0 || haber < 0 || (debe === 0 && haber === 0)) {
      throw new Error(`Importes inválidos en cuenta ${m.cuenta}: Debe=${debe}, Haber=${haber}`);
    }

    totalDebe = r2(totalDebe + debe);
    totalHaber = r2(totalHaber + haber);

    return {
      cuenta: cuentaInfo.codigo,
      nombre: cuentaInfo.nombre,
      tipo: cuentaInfo.tipo,
      debe,
      haber,
      referencia: m.referencia || ""
    };
  });

  // VALIDACIÓN SUPREMA DE PARTIDA DOBLE
  if (totalDebe !== totalHaber) {
    throw new Error(
      `DESCUADRE CONTABLE DETECTADO: Total Debe ($${totalDebe}) != Total Haber ($${totalHaber}). Póliza rechazada.`
    );
  }

  const fechaStr = fecha || new Date().toISOString().split("T")[0];
  const periodo = fechaStr.substring(0, 7); // "YYYY-MM"
  const folio = `POL-${periodo.replace("-", "")}-${Date.now().toString().slice(-5)}`;

  const polizaDoc = {
    company_id,
    poliza_folio: folio,
    fecha: fechaStr,
    periodo,
    origen_modulo,
    origen_doc_id,
    concepto,
    movimientos: asientosValidados,
    total_debe: totalDebe,
    total_haber: totalHaber,
    estatus: "VIGENTE",
    created_by: user_uid,
    created_at: serverTimestamp()
  };

  const docRef = await addDoc(collection(db, "accounting_ledger"), polizaDoc);
  return { id: docRef.id, ...polizaDoc };
}

// ============================================================================
// 3. DISPARADORES AUTOMÁTICOS POR EVENTO OPERATIVO
// ============================================================================

/**
 * A) FACTURACIÓN A CLIENTE + PROVISIÓN AUTOMÁTICA DE COMISIÓN (Módulo CxC)
 */
export async function polizaFacturaCliente(db, {
  company_id,
  fecha,
  factura_id,
  folio_factura,
  cliente_nombre,
  subtotal,
  iva,
  total,
  comision_monto = 0,
  ejecutivo_nombre = "",
  user_uid
}) {
  const resultados = [];

  // 1. Póliza del Ingreso Facturado
  const polIngreso = await emitirPolizaContable(db, {
    company_id,
    fecha,
    origen_modulo: "CXC",
    origen_doc_id: factura_id,
    concepto: `Facturación Cliente ${cliente_nombre} | Folio ${folio_factura}`,
    user_uid,
    movimientos: [
      { cuenta: "105.01", debe: total, haber: 0, referencia: folio_factura },
      { cuenta: "401.01", debe: 0, haber: subtotal, referencia: cliente_nombre },
      ...(r2(iva) > 0 ? [{ cuenta: "209.01", debe: 0, haber: iva, referencia: folio_factura }] : [])
    ]
  });
  resultados.push(polIngreso);

  // 2. Póliza Automática de Comisión Devengada (si aplica)
  if (r2(comision_monto) > 0) {
    const polComision = await emitirPolizaContable(db, {
      company_id,
      fecha,
      origen_modulo: "CXC_COMISION",
      origen_doc_id: factura_id,
      concepto: `Provisión Comisión (${ejecutivo_nombre || "Ejecutivo"}) por Factura ${folio_factura}`,
      user_uid,
      movimientos: [
        { cuenta: "601.01", debe: comision_monto, haber: 0, referencia: folio_factura },
        { cuenta: "201.02", debe: 0, haber: comision_monto, referencia: ejecutivo_nombre }
      ]
    });
    resultados.push(polComision);
  }

  return resultados;
}

/**
 * B) COBRO DE FACTURA DE CLIENTE EN BANCO (Módulo CxC)
 */
export async function polizaCobroCliente(db, {
  company_id,
  fecha,
  factura_id,
  folio_factura,
  cliente_nombre,
  monto_cobrado,
  iva_proporcional = 0,
  user_uid
}) {
  const movimientos = [
    { cuenta: "102.01", debe: monto_cobrado, haber: 0, referencia: folio_factura },
    { cuenta: "105.01", debe: 0, haber: monto_cobrado, referencia: cliente_nombre }
  ];

  // Reclasificación de IVA No Cobrado -> IVA Cobrado (Efectivamente causado)
  if (r2(iva_proporcional) > 0) {
    movimientos.push({ cuenta: "209.01", debe: iva_proporcional, haber: 0, referencia: folio_factura });
    movimientos.push({ cuenta: "208.01", debe: 0, haber: iva_proporcional, referencia: folio_factura });
  }

  return await emitirPolizaContable(db, {
    company_id,
    fecha,
    origen_modulo: "CXC_COBRO",
    origen_doc_id: factura_id,
    concepto: `Cobro Factura ${folio_factura} - ${cliente_nombre}`,
    user_uid,
    movimientos
  });
}

/**
 * C) REGISTRO DE GASTOS OPERATIVOS: FACEBOOK ADS, DIDI, PROVEEDORES (CxP / Caja Chica)
 * @param {string} cuenta_gasto - Ej: "601.02" (Facebook), "601.03" (DiDi), "601.04" (Caja Chica)
 * @param {string} fuente_pago - "BANCO" ("102.01") | "TDC" ("205.01") | "CAJA_CHICA" ("101.01") | "CREDITO" ("201.01")
 */
export async function polizaGastoOperativo(db, {
  company_id,
  fecha,
  gasto_id,
  proveedor,
  concepto_gasto,
  cuenta_gasto = "601.03",
  subtotal,
  iva = 0,
  total,
  fuente_pago = "BANCO", // BANCO | TDC | CAJA_CHICA | CREDITO
  user_uid
}) {
  const mapaFuente = {
    BANCO: { cuenta: "102.01", esPagado: true },
    TDC: { cuenta: "205.01", esPagado: true },         // Con TDC el gasto ya está liquidado al proveedor
    CAJA_CHICA: { cuenta: "101.01", esPagado: true },
    CREDITO: { cuenta: "201.01", esPagado: false }     // Queda a deber a Proveedores
  };

  const destino = mapaFuente[fuente_pago] || mapaFuente.BANCO;
  const cuentaIva = destino.esPagado ? "118.01" : "119.01";

  const movimientos = [
    { cuenta: cuenta_gasto, debe: subtotal, haber: 0, referencia: proveedor },
    ...(r2(iva) > 0 ? [{ cuenta: cuentaIva, debe: iva, haber: 0, referencia: proveedor }] : []),
    { cuenta: destino.cuenta, debe: 0, haber: total, referencia: proveedor }
  ];

  return await emitirPolizaContable(db, {
    company_id,
    fecha,
    origen_modulo: fuente_pago === "CAJA_CHICA" ? "CAJA_CHICA" : "CXP",
    origen_doc_id: gasto_id,
    concepto: `${concepto_gasto} (${proveedor})`,
    user_uid,
    movimientos
  });
}

/**
 * D) FONDEO O REPOSICIÓN DE CAJA CHICA DESDE BANCOS
 */
export async function polizaFondeoCajaChica(db, {
  company_id,
  fecha,
  movimiento_id,
  monto,
  concepto = "Fondeo / Reposición de Caja Chica",
  user_uid
}) {
  return await emitirPolizaContable(db, {
    company_id,
    fecha,
    origen_modulo: "CAJA_CHICA",
    origen_doc_id: movimiento_id,
    concepto,
    user_uid,
    movimientos: [
      { cuenta: "101.01", debe: monto, haber: 0, referencia: "FONDEO" },
      { cuenta: "102.01", debe: 0, haber: monto, referencia: "TRASPASO_CAJA" }
    ]
  });
}

/**
 * E) PAGO DE COMISIONES A EJECUTIVOS (Liquida el Pasivo 201.02 contra Bancos)
 */
export async function polizaPagoComision(db, {
  company_id,
  fecha,
  pago_id,
  ejecutivo_nombre,
  monto,
  user_uid
}) {
  return await emitirPolizaContable(db, {
    company_id,
    fecha,
    origen_modulo: "CXP_COMISION",
    origen_doc_id: pago_id,
    concepto: `Liquidación de Comisiones a ${ejecutivo_nombre}`,
    user_uid,
    movimientos: [
      { cuenta: "201.02", debe: monto, haber: 0, referencia: ejecutivo_nombre },
      { cuenta: "102.01", debe: 0, haber: monto, referencia: ejecutivo_nombre }
    ]
  });
}

// ============================================================================
// 4. MOTOR DE ESTADOS FINANCIEROS (BALANCE GENERAL & ESTADO DE RESULTADOS)
// ============================================================================
/**
 * Genera el Estado de Resultados (por rango de fechas) y el Balance General (a fecha de corte)
 * @param {Object} db - Instancia Firestore
 * @param {string} company_id - "cesar_gonzalez" | "hr_employment" | "CONSOLIDADO"
 * @param {string} fechaInicio - "YYYY-MM-DD" (para Estado de Resultados)
 * @param {string} fechaCorte - "YYYY-MM-DD" (para ambos estados)
 */
export async function generarEstadosFinancieros(db, company_id, fechaInicio, fechaCorte) {
  const colRef = collection(db, "accounting_ledger");
  const q = company_id === "CONSOLIDADO"
    ? query(colRef, where("estatus", "==", "VIGENTE"), orderBy("fecha", "asc"))
    : query(colRef, where("company_id", "==", company_id), where("estatus", "==", "VIGENTE"), orderBy("fecha", "asc"));

  const snap = await getDocs(q);

  // Acumuladores por cuenta
  const saldosBalance = {};     // Acumulado histórico hasta fechaCorte
  const saldosResultados = {};  // Acumulado del periodo [fechaInicio .. fechaCorte]

  Object.keys(CATALOGO_CUENTAS).forEach((cod) => {
    saldosBalance[cod] = { ...CATALOGO_CUENTAS[cod], debe: 0, haber: 0, saldo: 0 };
    saldosResultados[cod] = { ...CATALOGO_CUENTAS[cod], debe: 0, haber: 0, saldo: 0 };
  });

  snap.forEach((docSnap) => {
    const poliza = docSnap.data();
    if (fechaCorte && poliza.fecha > fechaCorte) return; // Ignorar movimientos posteriores al corte

    const enPeriodoPL = (!fechaInicio || poliza.fecha >= fechaInicio) && (!fechaCorte || poliza.fecha <= fechaCorte);

    (poliza.movimientos || []).forEach((mov) => {
      const cta = saldosBalance[mov.cuenta];
      if (!cta) return;

      // Acumulado histórico (para Balance General y Utilidad Acumulada)
      cta.debe = r2(cta.debe + mov.debe);
      cta.haber = r2(cta.haber + mov.haber);

      // Acumulado del periodo (para Estado de Resultados)
      if (enPeriodoPL && ["INGRESO", "COSTO", "GASTO"].includes(cta.tipo)) {
        saldosResultados[mov.cuenta].debe = r2(saldosResultados[mov.cuenta].debe + mov.debe);
        saldosResultados[mov.cuenta].haber = r2(saldosResultados[mov.cuenta].haber + mov.haber);
      }
    });
  });

  // Calcular saldos netos según naturaleza contable
  const calcularSaldoNeto = (item) => {
    return item.naturaleza === "DEUDORA"
      ? r2(item.debe - item.haber)
      : r2(item.haber - item.debe);
  };

  Object.values(saldosBalance).forEach((c) => { c.saldo = calcularSaldoNeto(c); });
  Object.values(saldosResultados).forEach((c) => { c.saldo = calcularSaldoNeto(c); });

  // --------------------------------------------------------------------------
  // A) CONSTRUCCIÓN DEL ESTADO DE RESULTADOS (P&L DEL PERIODO)
  // --------------------------------------------------------------------------
  const ingresos = Object.values(saldosResultados).filter((c) => c.tipo === "INGRESO");
  const costos = Object.values(saldosResultados).filter((c) => c.tipo === "COSTO");
  const gastos = Object.values(saldosResultados).filter((c) => c.tipo === "GASTO");

  const totalIngresos = r2(ingresos.reduce((acc, c) => acc + c.saldo, 0));
  const totalCostos = r2(costos.reduce((acc, c) => acc + c.saldo, 0));
  const utilidadBruta = r2(totalIngresos - totalCostos);
  const totalGastos = r2(gastos.reduce((acc, c) => acc + c.saldo, 0));
  const utilidadNetaPeriodo = r2(utilidadBruta - totalGastos);

  // --------------------------------------------------------------------------
  // B) CONSTRUCCIÓN DEL BALANCE GENERAL (A FECHA DE CORTE)
  // --------------------------------------------------------------------------
  const activoCirculante = Object.values(saldosBalance).filter((c) => c.tipo === "ACTIVO" && c.subtipo === "CIRCULANTE");
  const activoNoCirculante = Object.values(saldosBalance).filter((c) => c.tipo === "ACTIVO" && c.subtipo === "NO_CIRCULANTE");

  const totalActivoCirculante = r2(activoCirculante.reduce((acc, c) => acc + c.saldo, 0));
  // Nota: Depreciación acumulada (171.01) tiene naturaleza ACREEDORA, por eso resta al activo fijo
  const totalActivoNoCirculante = r2(
    activoNoCirculante.reduce((acc, c) => (c.naturaleza === "DEUDORA" ? acc + c.saldo : acc - c.saldo), 0)
  );
  const totalActivo = r2(totalActivoCirculante + totalActivoNoCirculante);

  const pasivoCirculante = Object.values(saldosBalance).filter((c) => c.tipo === "PASIVO");
  const totalPasivo = r2(pasivoCirculante.reduce((acc, c) => acc + c.saldo, 0));

  const cuentasCapital = Object.values(saldosBalance).filter((c) => c.tipo === "CAPITAL");
  const capitalContribuidoYGanado = r2(cuentasCapital.reduce((acc, c) => acc + c.saldo, 0));

  // Utilidad Neta Acumulada Histórica hasta fechaCorte (para cuadrar el Balance General al 100%)
  const ingHist = Object.values(saldosBalance).filter((c) => c.tipo === "INGRESO").reduce((a, c) => a + c.saldo, 0);
  const cosHist = Object.values(saldosBalance).filter((c) => c.tipo === "COSTO").reduce((a, c) => a + c.saldo, 0);
  const gasHist = Object.values(saldosBalance).filter((c) => c.tipo === "GASTO").reduce((a, c) => a + c.saldo, 0);
  const utilidadEjercicioBalance = r2(ingHist - cosHist - gasHist);

  const totalCapitalContable = r2(capitalContribuidoYGanado + utilidadEjercicioBalance);
  const totalPasivoMasCapital = r2(totalPasivo + totalCapitalContable);
  const diferenciaCuadre = r2(totalActivo - totalPasivoMasCapital);

  return {
    meta: {
      company_id,
      fechaInicio,
      fechaCorte,
      polizasProcesadas: snap.size
    },
    estadoResultados: {
      ingresos,
      totalIngresos,
      costos,
      totalCostos,
      utilidadBruta,
      gastos,
      totalGastos,
      utilidadNeta: utilidadNetaPeriodo
    },
    balanceGeneral: {
      activo: {
        circulante: activoCirculante,
        totalCirculante: totalActivoCirculante,
        noCirculante: activoNoCirculante,
        totalNoCirculante: totalActivoNoCirculante,
        totalActivo
      },
      pasivo: {
        circulante: pasivoCirculante,
        totalPasivo
      },
      capital: {
        cuentas: cuentasCapital,
        utilidadEjercicio: utilidadEjercicioBalance,
        totalCapital: totalCapitalContable
      },
      totalPasivoMasCapital,
      estaCuadrado: diferenciaCuadre === 0,
      diferenciaCuadre
    }
  };
}