/* ==========================================================================
 * mock_data.js
 * --------------------------------------------------------------------------
 * Simula la tabla `canales` de la base PostgreSQL (AWS Aurora) que alimentará
 * el tablero en producción. Genera ~16.000 registros sintéticos con
 * correlaciones realistas entre variables:
 *
 *   - Peso del canal  ~ N(100, 8.5) kg, con estacionalidad y sesgo por granja.
 *   - Grasa dorsal    correlacionada con el peso y la genética de cada granja,
 *                     con una leve mejora a lo largo del año.
 *   - % Magro         inversamente proporcional a la grasa dorsal, calibrado
 *                     con los cuartiles reales de Colombia (~63-67 %).
 *   - Puntaje SEUROP  0-1 lineal sobre el magro.
 *
 * El IQ-Col y la clasificación SEUROP NO vienen en la tabla: app.js los
 * calcula con los cuartiles de seurop_quartiles.js (peso, magro, país, año).
 *
 * Se usa un generador pseudoaleatorio con semilla para que la "forma" de los
 * datos sea reproducible entre recargas. Las fechas cubren los últimos
 * 12 meses contados desde el día actual.
 *
 * Atributos operacionales y trazabilidad (generados con un PRNG independiente
 * para NO alterar la secuencia de los campos originales):
 *   comercializador, color, variacion_color, sistema_medicion   (nullable ~5 %)
 *   fecha_ingreso_planta  → fecha_pesaje_pie (+15-45 min)
 *                         → fecha_sacrificio (+1.5-20 h)
 *                             → fecha_canal_caliente (+20-50 min)
 *                             → fecha_canal_fria     (+2-24 h)
 *   peso_canal_caliente_kg, peso_canal_fria_kg                   (nullable)
 *   tiempo_espera_sacrificio_min / _horas  (calculados: sacrificio - ingreso)
 * Timestamps en hora local con formato 'YYYY-MM-DD HH:mm:ss'.
 *
 * Expone:  window.DASHBOARD_DATA = { meta, catalogos, registros, helpers }
 *          window.calcularTiempoEsperaSacrificio(registro)
 * ========================================================================== */
(function () {
  'use strict';

  const TOTAL_REGISTROS = 16000;
  const SEMILLA = 20261105;

  /* ---------- Utilidades aleatorias ---------------------------------------- */

  /** PRNG mulberry32: rápido, determinista y suficiente para datos mock. */
  function mulberry32(a) {
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = mulberry32(SEMILLA);

  /** Muestra de una distribución normal (Box-Muller). `rng` permite usar otro PRNG. */
  function normal(media, desviacion, rng = rand) {
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return media + desviacion * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const redondear = (v, decimales) => {
    const f = 10 ** decimales;
    return Math.round(v * f) / f;
  };
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  /** Selector ponderado O(log n) mediante búsqueda binaria sobre pesos acumulados. */
  function crearSelectorPonderado(items, pesos) {
    return crearSelectorPonderadoCon(rand, items, pesos);
  }

  /** Igual que crearSelectorPonderado pero con un PRNG explícito. */
  function crearSelectorPonderadoCon(rng, items, pesos) {
    const acumulado = [];
    let suma = 0;
    pesos.forEach((p) => {
      suma += p;
      acumulado.push(suma);
    });
    return function () {
      const r = rng() * suma;
      let lo = 0;
      let hi = acumulado.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (acumulado[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      return items[lo];
    };
  }

  /* ---------- Catálogos ---------------------------------------------------- */

  const PLANTAS = ['Planta Antioquia', 'Planta Valle del Cauca', 'Planta Cundinamarca', 'Planta Eje Cafetero'];

  /**
   * Granjas vinculadas a plantas.
   *  - sesgoGrasa: desplazamiento genético/nutricional de la grasa dorsal (mm)
   *  - sesgoPeso:  desplazamiento del peso de sacrificio (kg)
   *  - volumen:    participación relativa en la producción
   */
  const GRANJAS = [
    { nombre: 'Granja La Esperanza', planta: 'Planta Antioquia',       sesgoGrasa: -2.2, sesgoPeso:  1.5, volumen: 1.35 },
    { nombre: 'Granja El Porvenir',  planta: 'Planta Antioquia',       sesgoGrasa:  0.8, sesgoPeso: -1.0, volumen: 1.05 },
    { nombre: 'Granja Santa Rita',   planta: 'Planta Antioquia',       sesgoGrasa:  1.9, sesgoPeso:  2.5, volumen: 0.80 },
    { nombre: 'Granja San José',     planta: 'Planta Valle del Cauca', sesgoGrasa: -1.0, sesgoPeso:  0.5, volumen: 1.20 },
    { nombre: 'Granja La Primavera', planta: 'Planta Valle del Cauca', sesgoGrasa:  2.6, sesgoPeso: -2.0, volumen: 0.90 },
    { nombre: 'Granja El Recreo',    planta: 'Planta Cundinamarca',    sesgoGrasa: -0.4, sesgoPeso:  1.0, volumen: 1.10 },
    { nombre: 'Granja Villa Nueva',  planta: 'Planta Cundinamarca',    sesgoGrasa:  1.2, sesgoPeso:  3.0, volumen: 0.90 },
    { nombre: 'Granja Buenavista',   planta: 'Planta Cundinamarca',    sesgoGrasa: -3.0, sesgoPeso: -1.5, volumen: 0.70 },
    { nombre: 'Granja La Palma',     planta: 'Planta Eje Cafetero',    sesgoGrasa:  0.3, sesgoPeso:  0.0, volumen: 1.00 },
    { nombre: 'Granja El Rosal',     planta: 'Planta Eje Cafetero',    sesgoGrasa: -1.6, sesgoPeso: -0.5, volumen: 0.80 },
  ];

  /* ---------- Calendario: últimos 12 meses --------------------------------- */

  const hoy = new Date();
  hoy.setHours(0, 0, 0, 0);
  const inicio = new Date(hoy);
  inicio.setFullYear(inicio.getFullYear() - 1);
  inicio.setDate(inicio.getDate() + 1);

  const dias = [];
  for (let d = new Date(inicio); d <= hoy; d.setDate(d.getDate() + 1)) {
    const diaSemana = d.getDay();
    // Menor actividad de beneficio los fines de semana
    const factorSemana = diaSemana === 0 ? 0.25 : diaSemana === 6 ? 0.6 : 1;
    // Mayor demanda en temporada de fin de año
    const factorMes = d.getMonth() === 11 ? 1.25 : d.getMonth() === 10 ? 1.1 : 1;
    dias.push({ fecha: isoDate(d), mes: d.getMonth(), indice: dias.length, peso: factorSemana * factorMes });
  }

  const elegirDia = crearSelectorPonderado(dias, dias.map((d) => d.peso));
  const elegirGranja = crearSelectorPonderado(GRANJAS, GRANJAS.map((g) => g.volumen));

  /* ---------- Generación de registros -------------------------------------- */

  const registros = new Array(TOTAL_REGISTROS);
  for (let i = 0; i < TOTAL_REGISTROS; i++) {
    const dia = elegirDia();
    const granja = elegirGranja();
    const avanceAnual = dia.indice / (dias.length - 1); // 0 → 1 a lo largo del periodo
    const estacional = Math.sin(((dia.mes - 2) / 12) * 2 * Math.PI);

    const peso = redondear(clamp(normal(100 + granja.sesgoPeso + 2.2 * estacional, 8.5), 75, 125), 1);
    // Estacionalidad propia de la grasa (época fría → mayor deposición) y
    // mejora genética progresiva a lo largo del periodo.
    const estacionalGrasa = Math.cos(((dia.mes - 6) / 12) * 2 * Math.PI);
    const grasa = redondear(
      clamp(normal(17.2 + granja.sesgoGrasa + (peso - 100) * 0.12 + 1.4 * estacionalGrasa - 2.2 * avanceAnual, 3.6), 8, 28),
      1
    );
    const magro = redondear(clamp(normal(74.5 - 0.6 * grasa, 1.2), 52, 74), 2);
    const puntaje = redondear(clamp((magro - 52) / 22, 0, 1), 2);

    registros[i] = {
      id: 0, // se asigna después de ordenar cronológicamente
      fecha: dia.fecha,
      pais: 'Colombia',
      planta: granja.planta,
      granja: granja.nombre,
      peso_kg: peso,
      grasa_dorsal_mm: grasa,
      porcentaje_magro: magro,
      puntaje_seurop: puntaje,
    };
  }

  // Orden cronológico (como un SELECT ... ORDER BY fecha) e IDs secuenciales
  registros.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  registros.forEach((r, i) => {
    r.id = i + 1;
  });

  /* ---------- Atributos operacionales y trazabilidad temporal -------------- */

  // PRNG independiente: añadir estos campos no cambia los valores originales.
  const randOp = mulberry32(SEMILLA + 1);
  const uniforme = (min, max) => min + (max - min) * randOp();
  const conNulos = (valor, probNulo) => (randOp() < probNulo ? null : valor);

  const COMERCIALIZADORES = [
    'Distribuidora Central',
    'Carnes del Valle',
    'Alimentos Norte',
    'Cárnicos La Sabana',
    'Proteínas del Café',
  ];
  const SISTEMAS_MEDICION = ['Equipo1', 'Equipo2', 'Equipo3'];
  const elegirComercializador = crearSelectorPonderadoCon(randOp, COMERCIALIZADORES, [1.4, 1.2, 1.0, 0.8, 0.6]);
  const elegirSistema = crearSelectorPonderadoCon(randOp, SISTEMAS_MEDICION, [1.0, 0.8, 0.5]);

  const MIN_MS = 60 * 1000;

  /** Formatea epoch-ms como 'YYYY-MM-DD HH:mm:ss' (hora local). */
  function formatearTimestamp(ms) {
    const d = new Date(ms);
    return `${isoDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  /** Parsea 'YYYY-MM-DD HH:mm:ss' (hora local) a epoch-ms; null si no es válido. */
  function parsearTimestamp(valor) {
    if (valor == null || valor === '') return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(String(valor));
    if (!m) return null;
    const ms = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)).getTime();
    return Number.isNaN(ms) ? null : ms;
  }

  /**
   * Diferencia entre ingreso a planta y sacrificio de un registro.
   * Devuelve { tiempo_espera_sacrificio_min (int), tiempo_espera_sacrificio_horas (float 2 dec.) };
   * ambos null si falta (o es inválida) cualquiera de las dos fechas.
   */
  function calcularTiempoEsperaSacrificio(registro) {
    const ingreso = parsearTimestamp(registro && registro.fecha_ingreso_planta);
    const sacrificio = parsearTimestamp(registro && registro.fecha_sacrificio);
    if (ingreso === null || sacrificio === null) {
      return { tiempo_espera_sacrificio_min: null, tiempo_espera_sacrificio_horas: null };
    }
    const minutos = Math.round((sacrificio - ingreso) / MIN_MS);
    return {
      tiempo_espera_sacrificio_min: minutos,
      tiempo_espera_sacrificio_horas: redondear(minutos / 60, 2),
    };
  }

  /** Recalcula y escribe en el propio registro los campos de tiempo de espera. */
  function aplicarTiempoEsperaSacrificio(registro) {
    return Object.assign(registro, calcularTiempoEsperaSacrificio(registro));
  }

  for (const r of registros) {
    // Línea de tiempo coherente: ingreso (día del registro) → pesaje en pie → sacrificio → canal caliente / fría
    const [y, mo, d] = r.fecha.split('-').map(Number);
    const horaIngreso = clamp(normal(7.5, 2.0, randOp), 3, 15);
    const tIngreso = new Date(y, mo - 1, d).getTime() + Math.round(horaIngreso * 60) * MIN_MS + Math.floor(randOp() * 60) * 1000;
    const tPesajePie = tIngreso + Math.round(uniforme(15, 45)) * MIN_MS + Math.floor(randOp() * 60) * 1000;
    const tSacrificio = tIngreso + Math.round(clamp(normal(8, 3.5, randOp), 1.5, 20) * 60) * MIN_MS + Math.floor(randOp() * 60) * 1000;
    const tCaliente = tSacrificio + Math.round(uniforme(20, 50)) * MIN_MS + Math.floor(randOp() * 60) * 1000;
    const tFria = tSacrificio + Math.round(uniforme(2, 24) * 60) * MIN_MS + Math.floor(randOp() * 60) * 1000;

    // Pesos: canal fría = caliente menos la merma por oreo (2-6 %)
    const pesoCaliente = redondear(clamp(normal(107.5, 3.5, randOp), 100, 115), 1);
    const pesoFria = redondear(clamp(pesoCaliente * (1 - uniforme(0.02, 0.06)), 90, 108), 1);

    r.comercializador = conNulos(elegirComercializador(), 0.05);
    r.color = conNulos(Math.round(clamp(normal(42, 5.5, randOp), 30, 55)), 0.05);
    r.variacion_color = conNulos(Math.round(clamp(normal(27, 5, randOp), 15, 40)), 0.05);
    r.sistema_medicion = conNulos(elegirSistema(), 0.05);
    r.fecha_ingreso_planta = formatearTimestamp(tIngreso);
    r.fecha_pesaje_pie = conNulos(formatearTimestamp(tPesajePie), 0.03);
    r.fecha_sacrificio = conNulos(formatearTimestamp(tSacrificio), 0.03);
    r.peso_canal_caliente_kg = conNulos(pesoCaliente, 0.03);
    r.fecha_canal_caliente = conNulos(formatearTimestamp(tCaliente), 0.03);
    r.fecha_canal_fria = conNulos(formatearTimestamp(tFria), 0.03);
    r.peso_canal_fria_kg = conNulos(pesoFria, 0.03);
    aplicarTiempoEsperaSacrificio(r);
  }

  const helpers = {
    parsearTimestamp,
    formatearTimestamp,
    calcularTiempoEsperaSacrificio,
    aplicarTiempoEsperaSacrificio,
  };
  window.calcularTiempoEsperaSacrificio = calcularTiempoEsperaSacrificio;

  window.DASHBOARD_DATA = {
    meta: {
      tabla: 'canales',
      generado: new Date().toISOString(),
      desde: dias[0].fecha,
      hasta: dias[dias.length - 1].fecha,
      total: registros.length,
    },
    catalogos: {
      plantas: PLANTAS.slice(),
      granjas: GRANJAS.map((g) => ({ nombre: g.nombre, planta: g.planta })),
      comercializadores: COMERCIALIZADORES.slice(),
      sistemas_medicion: SISTEMAS_MEDICION.slice(),
    },
    registros,
    helpers,
  };
})();
