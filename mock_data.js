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
 *   - % Magro         inversamente proporcional a la grasa dorsal.
 *   - IQ-Col (0-100)  dependiente del % magro y de un rango de peso óptimo.
 *   - SEUROP          derivada del % magro; puntaje 1-10 lineal sobre el magro.
 *
 * Se usa un generador pseudoaleatorio con semilla para que la "forma" de los
 * datos sea reproducible entre recargas. Las fechas cubren los últimos
 * 12 meses contados desde el día actual.
 *
 * Expone:  window.DASHBOARD_DATA = { meta, catalogos, registros }
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

  /** Muestra de una distribución normal (Box-Muller). */
  function normal(media, desviacion) {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
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
    const acumulado = [];
    let suma = 0;
    pesos.forEach((p) => {
      suma += p;
      acumulado.push(suma);
    });
    return function () {
      const r = rand() * suma;
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

  /** Clasificación SEUROP a partir del % de magro (umbrales de referencia). */
  function clasificarSeurop(magro) {
    if (magro >= 60) return 'Superior';
    if (magro >= 56) return 'Excelente';
    if (magro >= 52) return 'Muy bueno';
    if (magro >= 48) return 'Bueno';
    if (magro >= 45) return 'Menos bueno';
    return 'Baja';
  }

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
    const magro = redondear(clamp(normal(70.5 - 0.95 * grasa, 1.8), 42, 66), 2);
    const bonoPesoOptimo = peso >= 92 && peso <= 110 ? 6 : 0;
    const iqCol = redondear(clamp(normal(((magro - 42) / 24) * 82 + 6 + bonoPesoOptimo, 9), 0, 100), 1);
    const puntaje = redondear(clamp(1 + ((magro - 42) / 24) * 9, 1, 10), 1);

    registros[i] = {
      id: 0, // se asigna después de ordenar cronológicamente
      fecha: dia.fecha,
      planta: granja.planta,
      granja: granja.nombre,
      peso_kg: peso,
      grasa_dorsal_mm: grasa,
      porcentaje_magro: magro,
      iq_col: iqCol,
      clasificacion_seurop: clasificarSeurop(magro),
      puntaje_seurop: puntaje,
    };
  }

  // Orden cronológico (como un SELECT ... ORDER BY fecha) e IDs secuenciales
  registros.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  registros.forEach((r, i) => {
    r.id = i + 1;
  });

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
    },
    registros,
  };
})();
