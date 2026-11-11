/* ==========================================================================
 * data_utils.js
 * --------------------------------------------------------------------------
 * Helpers de datos compartidos por el pipeline de carga (data_loader.js) y
 * app.js. Timestamps en hora local con formato 'YYYY-MM-DD HH:mm:ss'.
 *
 * Expone:  window.DataUtils
 *          window.calcularTiempoEsperaSacrificio(registro)
 * ========================================================================== */
(function () {
  'use strict';

  const MIN_MS = 60 * 1000;
  const pad = (n) => String(n).padStart(2, '0');
  const redondear = (v, decimales) => {
    const f = 10 ** decimales;
    return Math.round(v * f) / f;
  };

  /** Formatea epoch-ms como 'YYYY-MM-DD HH:mm:ss' (hora local). */
  function formatearTimestamp(ms) {
    const d = new Date(ms);
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
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

  window.DataUtils = Object.freeze({
    parsearTimestamp,
    formatearTimestamp,
    calcularTiempoEsperaSacrificio,
    aplicarTiempoEsperaSacrificio,
  });
  window.calcularTiempoEsperaSacrificio = calcularTiempoEsperaSacrificio;
})();
