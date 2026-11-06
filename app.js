/* ==========================================================================
 * app.js — Tablero a la medida
 * --------------------------------------------------------------------------
 * Toda la lógica de la SPA en un solo archivo, organizada en módulos:
 *
 *   1. App.tokens      Tokens de diseño en JS (espejo del @theme de index.html)
 *   2. App.utils       Dominio (SEUROP, IQ-Col), formato es-CO, fechas/periodos
 *   3. App.data        Enriquecimiento, filtrado y agregación en una pasada
 *   4. App.charts      Helpers de ECharts (instancias, tooltip, zoom, vacío)
 *   5. App.components  MultiSelect · DateRange · DataTable
 *   6. App.filters     Estado global de filtros (fuente única) + suscripción
 *   7. App.views       Tablero a la medida · Despacho · Scores
 *   8. Shell + Router  Barra superior de filtros, sidebar y navegación por hash
 *
 * Requiere: mock_data.js (window.DASHBOARD_DATA), ECharts 5 y Lucide (CDN).
 * ========================================================================== */
window.App = window.App || {};

/* ==========================================================================
 * 1. TOKENS DE DISEÑO
 * ECharts dibuja en <canvas> y no lee variables CSS: los colores del
 * sistema se replican aquí con los mismos nombres del @theme.
 * ========================================================================== */
App.tokens = Object.freeze({
  primary: '#993935',
  primaryD: '#7c2c29',
  primarySoft: '#f5e9e8',
  accent: '#eb5852',
  accentD: '#d9433d',
  coralSoft: '#fcebea',
  ink: '#2a211f',
  greyStrong: '#6e6660',
  greyMid: '#8b8b8d',
  greyLight: '#cccccc',
  line: '#ece7e3',
  surface: '#fbfaf9',
  bg: '#f7f5f3',
  good: '#2f8f6b',
  goodSoft: '#e4f1eb',
  warn: '#c9821f',
  warnSoft: '#f8ecd8',
  crit: '#c0392b',
  critSoft: '#fbe7e4',
  font: 'Inter, system-ui, sans-serif',
});

/* ==========================================================================
 * 2. UTILIDADES Y DOMINIO
 * ========================================================================== */
App.utils = (function () {
  'use strict';
  const T = App.tokens;

  /**
   * Clasificación SEUROP de mejor a peor calidad (S·E·U·R·O·P).
   *  letter: letra de la clase · color: sólido para gráficos y badge de KPI
   *  text: etiqueta sobre el sólido · soft/ink: fondo y texto de badges.
   */
  const SEUROP = [
    { key: 'Superior',    letter: 'S', color: '#2f8f6b', text: '#ffffff', soft: '#dcebe4',     ink: '#164d3a' },
    { key: 'Excelente',   letter: 'E', color: '#48a982', text: '#ffffff', soft: T.goodSoft,    ink: '#1f6b50' },
    { key: 'Muy bueno',   letter: 'U', color: '#c9821f', text: '#ffffff', soft: T.warnSoft,    ink: '#8a5a12' },
    { key: 'Bueno',       letter: 'R', color: '#eb5852', text: '#ffffff', soft: T.coralSoft,   ink: '#b2352f' },
    { key: 'Menos bueno', letter: 'O', color: '#993935', text: '#ffffff', soft: T.primarySoft, ink: T.primaryD },
    { key: 'Baja',        letter: 'P', color: '#7c2c29', text: '#ffffff', soft: '#efe2e1',     ink: '#5e211f' },
  ];
  const SEUROP_INDEX = Object.fromEntries(SEUROP.map((s, i) => [s.key, i]));

  /** IQ-Col (0-100) agrupado en 5 bandas de 20 puntos para hallar la predominante. */
  const IQ_COL = [
    { key: 'S', min: 80, rango: '≥ 80',    color: T.primaryD },
    { key: 'E', min: 60, rango: '60 – 80', color: T.primary },
    { key: 'U', min: 40, rango: '40 – 60', color: '#c98a86' },
    { key: 'R', min: 20, rango: '20 – 40', color: '#e6c9c6' },
    { key: 'O', min: 0,  rango: '< 20',    color: T.greyLight },
  ];
  function iqColIndex(v) {
    for (let i = 0; i < IQ_COL.length; i++) if (v >= IQ_COL[i].min) return i;
    return IQ_COL.length - 1;
  }

  const GRANULARIDADES = [
    { key: 'dia', label: 'Día' },
    { key: 'semana', label: 'Semana' },
    { key: 'mes', label: 'Mes' },
    { key: 'trimestre', label: 'Trimestre' },
    { key: 'anio', label: 'Año' },
  ];
  const granLabel = (key) => (GRANULARIDADES.find((g) => g.key === key) || {}).label || key;
  const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  /* ---------- Formato numérico es-CO (punto de miles, coma decimal) ------- */
  function fmt(v, dec = 0) {
    if (v === null || v === undefined || !Number.isFinite(v)) return '—';
    const [ent, decs] = Math.abs(v).toFixed(dec).split('.');
    const signo = v < 0 && Number(Math.abs(v).toFixed(dec)) !== 0 ? '-' : '';
    return signo + ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (decs ? ',' + decs : '');
  }
  const fmtPct = (v, dec = 1) => (Number.isFinite(v) ? fmt(v, dec) + '%' : '—');
  const fmtId = (id) => 'CN-' + String(id).padStart(5, '0');

  /* ---------- Fechas y periodos ------------------------------------------ */
  const pad = (n) => String(n).padStart(2, '0');
  const toISODate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function parseISODate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(s, n) {
    const d = parseISODate(s);
    d.setDate(d.getDate() + n);
    return toISODate(d);
  }
  function formatDate(s) {
    const [y, m, d] = s.split('-');
    return `${d} ${MESES[+m - 1].toLowerCase()} ${y}`;
  }

  /** Semana ISO-8601 (inicia el lunes; el año ISO puede diferir del calendario). */
  function isoWeek(y, m, d) {
    const date = new Date(Date.UTC(y, m - 1, d));
    const dia = date.getUTCDay() || 7;
    date.setUTCDate(date.getUTCDate() + 4 - dia);
    const inicio = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
    return { year: date.getUTCFullYear(), week: Math.ceil(((date - inicio) / 86400000 + 1) / 7) };
  }

  /** Claves ordenables lexicográficamente por granularidad (se precalculan una vez). */
  function periodKeys(fecha) {
    const y = +fecha.slice(0, 4);
    const m = +fecha.slice(5, 7);
    const w = isoWeek(y, m, +fecha.slice(8, 10));
    return {
      dia: fecha,
      semana: `${w.year}-W${pad(w.week)}`,
      mes: fecha.slice(0, 7),
      trimestre: `${y}-T${Math.ceil(m / 3)}`,
      anio: String(y),
    };
  }

  function periodLabel(gran, key) {
    switch (gran) {
      case 'dia': {
        const [y, m, d] = key.split('-');
        return `${d} ${MESES[+m - 1]} ${y.slice(2)}`;
      }
      case 'semana': {
        const [y, w] = key.split('-W');
        return `Sem ${w} · ${y}`;
      }
      case 'mes': {
        const [y, m] = key.split('-');
        return `${MESES[+m - 1]} ${y}`;
      }
      case 'trimestre': {
        const [y, q] = key.split('-T');
        return `T${q} ${y}`;
      }
      default:
        return key;
    }
  }

  /* ---------- HTML ------------------------------------------------------- */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const escapeHtml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

  function seuropBadge(i) {
    const s = SEUROP[i];
    return `<span class="badge" style="background:${s.soft};color:${s.ink}"><span class="dot" style="background:${s.color}"></span>${s.key}</span>`;
  }
  function iqBadge(i) {
    const c = IQ_COL[i];
    return `<span class="badge badge-neutral"><span class="dot" style="background:${c.color}"></span>${c.key}</span>`;
  }

  /** Convierte <i data-lucide="..."> en SVG. */
  function icons() {
    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
  }

  function argmax(arr) {
    let b = 0;
    for (let i = 1; i < arr.length; i++) if (arr[i] > arr[b]) b = i;
    return b;
  }

  return {
    SEUROP, SEUROP_INDEX, IQ_COL, iqColIndex, GRANULARIDADES, granLabel,
    fmt, fmtPct, fmtId, addDays, formatDate, periodKeys, periodLabel,
    escapeHtml, seuropBadge, iqBadge, icons, argmax,
  };
})();

/* ==========================================================================
 * 3. DATOS — enriquecimiento, filtrado y agregación
 * Estrategia: (1) claves de periodo e índices de categoría se calculan una
 * sola vez al cargar; (2) el filtrado es una pasada con comparación de
 * strings ISO; (3) una única pasada de agregación produce totales, métricas
 * por granja y por periodo.
 * ========================================================================== */
App.data = (function () {
  'use strict';
  const U = App.utils;
  const source = window.DASHBOARD_DATA;
  if (!source || !Array.isArray(source.registros)) {
    throw new Error('window.DASHBOARD_DATA no está disponible: mock_data.js debe cargarse antes que app.js.');
  }

  const records = source.registros;
  let minDate = '9999-12-31';
  let maxDate = '0000-01-01';
  for (const r of records) {
    const k = U.periodKeys(r.fecha);
    r._dia = k.dia;
    r._semana = k.semana;
    r._mes = k.mes;
    r._trimestre = k.trimestre;
    r._anio = k.anio;
    r._seu = U.SEUROP_INDEX[r.clasificacion_seurop];
    r._iq = U.iqColIndex(r.iq_col);
    if (r.fecha < minDate) minDate = r.fecha;
    if (r.fecha > maxDate) maxDate = r.fecha;
  }

  const plantas = source.catalogos.plantas.slice();
  const granjas = source.catalogos.granjas.slice(); // [{ nombre, planta }]

  /** plantas/granjas undefined ⇒ sin restricción; arreglo vacío ⇒ sin registros. */
  function filter(f) {
    const pSet = f.plantas ? new Set(f.plantas) : null;
    const gSet = f.granjas ? new Set(f.granjas) : null;
    if ((pSet && !pSet.size) || (gSet && !gSet.size)) return [];
    const out = [];
    for (const r of records) {
      if (r.fecha < f.desde || r.fecha > f.hasta) continue;
      if (pSet && !pSet.has(r.planta)) continue;
      if (gSet && !gSet.has(r.granja)) continue;
      out.push(r);
    }
    return out;
  }

  const createAcc = (key) => ({ key, n: 0, peso: 0, magro: 0, grasa: 0, iq: 0, seu: [0, 0, 0, 0, 0, 0], iqc: [0, 0, 0, 0, 0] });

  function accumulate(a, r) {
    a.n++;
    a.peso += r.peso_kg;
    a.magro += r.porcentaje_magro;
    a.grasa += r.grasa_dorsal_mm;
    a.iq += r.iq_col;
    a.seu[r._seu]++;
    a.iqc[r._iq]++;
  }

  function finalize(a) {
    const n = a.n;
    return {
      key: a.key,
      count: n,
      pesoProm: n ? a.peso / n : NaN,
      magroProm: n ? a.magro / n : NaN,
      grasaProm: n ? a.grasa / n : NaN,
      iqProm: n ? a.iq / n : NaN,
      seu: a.seu,
      iqc: a.iqc,
      iqTop: U.argmax(a.iqc),
      seuTop: U.argmax(a.seu), // índice de la categoría SEUROP predominante
    };
  }

  /** Agregación completa de la vista Inicio en una sola pasada. */
  function aggregate(rows, gran) {
    const field = '_' + gran;
    const total = createAcc('total');
    const byGranja = new Map();
    const byPeriodo = new Map();

    for (const r of rows) {
      accumulate(total, r);
      let g = byGranja.get(r.granja);
      if (!g) {
        g = createAcc(r.granja);
        g.planta = r.planta;
        byGranja.set(r.granja, g);
      }
      accumulate(g, r);
      let p = byPeriodo.get(r[field]);
      if (!p) {
        p = createAcc(r[field]);
        byPeriodo.set(r[field], p);
      }
      accumulate(p, r);
    }

    return {
      total: finalize(total),
      granjas: [...byGranja.values()].map((a) => Object.assign(finalize(a), { planta: a.planta })),
      periodos: [...byPeriodo.values()]
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
        .map((a, idx) => Object.assign(finalize(a), { idx })),
    };
  }

  function seuropCounts(rows) {
    const c = [0, 0, 0, 0, 0, 0];
    for (const r of rows) c[r._seu]++;
    return c;
  }

  return { records, plantas, granjas, minDate, maxDate, meta: source.meta, filter, aggregate, seuropCounts };
})();

/* ==========================================================================
 * 4. GRÁFICOS — helpers comunes de Apache ECharts
 * ========================================================================== */
App.charts = (function () {
  'use strict';
  const T = App.tokens;

  const AXIS = { line: '#e3ddd8', label: T.greyMid, split: '#f1ece8', name: T.greyStrong };
  const textStyle = { fontFamily: T.font, color: T.greyStrong };

  const tooltip = {
    backgroundColor: T.ink,
    borderWidth: 0,
    padding: [10, 12],
    textStyle: { color: '#e9e4e1', fontSize: 12, fontFamily: T.font },
    extraCssText: 'border-radius:12px;box-shadow:0 14px 30px rgba(42,33,31,.28);',
  };

  const legend = {
    top: 0,
    left: 0,
    icon: 'roundRect',
    itemWidth: 10,
    itemHeight: 10,
    itemGap: 16,
    textStyle: { color: T.greyStrong, fontSize: 12, fontFamily: T.font, fontWeight: 600 },
    inactiveColor: T.greyLight,
  };

  /** Instancia ECharts que se redimensiona sola con su contenedor. */
  function create(el) {
    const chart = echarts.init(el, null, { renderer: 'canvas' });
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => {
        if (el.offsetWidth > 0 && el.offsetHeight > 0) chart.resize();
      }).observe(el);
    } else {
      window.addEventListener('resize', () => chart.resize());
    }
    return chart;
  }

  function setEmpty(chart, msg = 'Sin datos para los filtros seleccionados') {
    chart.setOption(
      { graphic: [{ type: 'text', left: 'center', top: 'middle', style: { text: msg, fill: T.greyMid, font: `600 13px ${T.font}` } }] },
      true
    );
  }

  /** dataZoom cuando hay más periodos de los que caben con claridad. */
  function zoomFor(n, visible = 31) {
    if (n <= visible) return null;
    const start = Math.max(0, (1 - visible / n) * 100);
    return [
      {
        type: 'slider',
        start,
        end: 100,
        height: 18,
        bottom: 8,
        brushSelect: false,
        borderColor: 'transparent',
        backgroundColor: T.bg,
        fillerColor: 'rgba(153,57,53,.14)',
        dataBackground: { lineStyle: { color: T.greyLight }, areaStyle: { color: '#ece7e3' } },
        selectedDataBackground: { lineStyle: { color: T.primary }, areaStyle: { color: 'rgba(153,57,53,.18)' } },
        handleStyle: { color: T.primary, borderColor: T.primary },
        moveHandleStyle: { color: '#c98a86' },
        emphasis: { handleStyle: { color: T.primaryD }, moveHandleStyle: { color: T.primary } },
        textStyle: { color: T.greyMid, fontSize: 11 },
      },
      { type: 'inside', start, end: 100 },
    ];
  }

  function tipHeader(title, sub) {
    return `<div style="font-weight:700;color:#fff;margin-bottom:6px">${title}${
      sub ? `<span style="font-weight:400;color:#b9b0ab;margin-left:8px">${sub}</span>` : ''
    }</div>`;
  }

  function tipRow(color, label, value) {
    return `<div style="display:flex;align-items:center;justify-content:space-between;gap:18px;min-width:190px;line-height:1.75">
      <span style="display:inline-flex;align-items:center;gap:7px"><span style="width:8px;height:8px;border-radius:2px;background:${color}"></span>${label}</span>
      <b style="color:#fff;font-weight:700">${value}</b></div>`;
  }

  const categoryAxis = (data) => ({
    type: 'category',
    data,
    axisTick: { show: false },
    axisLine: { lineStyle: { color: AXIS.line } },
    axisLabel: { color: AXIS.label, hideOverlap: true },
  });

  return { AXIS, textStyle, tooltip, legend, create, setEmpty, zoomFor, tipHeader, tipRow, categoryAxis };
})();

/* ==========================================================================
 * 5. COMPONENTES
 * ========================================================================== */
App.components = {};

/* --------------------------------------------------------------------------
 * 5.1 MultiSelect — desplegable compacto con checkboxes, búsqueda, agrupación,
 *     "Seleccionar todo"/"Limpiar", cierre con clic externo o Escape.
 *     El panel se monta en <body> con posición fija: así no lo recorta el
 *     contenedor con scroll horizontal de la barra superior.
 *     new MultiSelect(el, { label, options:[{value,label,group?}], selected, onChange })
 * ------------------------------------------------------------------------ */
App.components.MultiSelect = class MultiSelect {
  constructor(root, opts) {
    this.root = root;
    this.label = opts.label;
    this.onChange = opts.onChange || (() => {});
    this.options = [];
    this.selected = new Set();
    this.query = '';
    this.isOpen = false;
    this._build();
    this.setOptions(opts.options || [], opts.selected);
  }

  setOptions(options, selected) {
    this.options = options;
    const valid = new Set(options.map((o) => o.value));
    this.selected = new Set((selected ?? options.map((o) => o.value)).filter((v) => valid.has(v)));
    this._renderList();
    this._renderSummary();
  }

  getSelected() {
    return this.options.filter((o) => this.selected.has(o.value)).map((o) => o.value);
  }

  _build() {
    const esc = App.utils.escapeHtml;
    this.root.classList.add('relative', 'shrink-0');
    this.root.innerHTML = `
      <button type="button" class="ms-trigger" aria-haspopup="listbox" aria-expanded="false">
        <span class="ms-prefix">${esc(this.label)}</span>
        <span class="ms-summary truncate"></span>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>
      </button>`;

    this.panel = document.createElement('div');
    this.panel.className = 'ms-panel';
    this.panel.hidden = true;
    this.panel.innerHTML = `
      <div class="border-b border-line p-2">
        <input type="search" class="input" placeholder="Buscar ${esc(this.label.toLowerCase())}…" aria-label="Buscar ${esc(this.label.toLowerCase())}" />
      </div>
      <div class="ms-actions">
        <button type="button" data-act="all">Seleccionar todo</button>
        <button type="button" data-act="none">Limpiar</button>
      </div>
      <div class="ms-list" role="listbox" aria-multiselectable="true" aria-label="${esc(this.label)}"></div>`;
    document.body.appendChild(this.panel);

    this.trigger = this.root.querySelector('.ms-trigger');
    this.summary = this.root.querySelector('.ms-summary');
    this.list = this.panel.querySelector('.ms-list');
    this.search = this.panel.querySelector('input[type="search"]');

    // Sigue al disparador si la página o la barra de filtros se desplazan
    const reposition = () => this.isOpen && this._place();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);

    this.trigger.addEventListener('click', () => this._toggle(!this.isOpen));
    this.search.addEventListener('input', () => {
      this.query = this.search.value.trim().toLowerCase();
      this._renderList();
    });
    this.list.addEventListener('change', (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      if (cb.checked) this.selected.add(cb.value);
      else this.selected.delete(cb.value);
      this._emit();
    });
    // Acciones masivas sobre las opciones visibles según la búsqueda
    this.panel.querySelector('.ms-actions').addEventListener('click', (e) => {
      const act = e.target.closest('button[data-act]')?.dataset.act;
      if (!act) return;
      this._visibleOptions().forEach((o) => (act === 'all' ? this.selected.add(o.value) : this.selected.delete(o.value)));
      this._renderList();
      this._emit();
    });
    document.addEventListener('click', (e) => {
      if (this.isOpen && !this.root.contains(e.target) && !this.panel.contains(e.target)) this._toggle(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this._toggle(false);
        this.trigger.focus();
      }
    });
  }

  _toggle(open) {
    this.isOpen = open;
    this.panel.hidden = !open;
    this.trigger.setAttribute('aria-expanded', String(open));
    if (open) {
      this.search.value = '';
      this.query = '';
      this._renderList();
      this._place();
      this.search.focus();
    }
  }

  /** Ubica el panel flotante bajo el disparador, sin salirse del viewport. */
  _place() {
    const r = this.trigger.getBoundingClientRect();
    const w = Math.max(r.width, 260);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    Object.assign(this.panel.style, { top: `${r.bottom + 6}px`, left: `${left}px`, width: `${w}px` });
  }

  _visibleOptions() {
    return this.query ? this.options.filter((o) => o.label.toLowerCase().includes(this.query)) : this.options;
  }

  _renderList() {
    const esc = App.utils.escapeHtml;
    const visibles = this._visibleOptions();
    if (!visibles.length) {
      this.list.innerHTML = '<p class="px-4 py-3 text-sm text-grey-mid">Sin coincidencias</p>';
      return;
    }
    let html = '';
    let grupo = null;
    for (const o of visibles) {
      if (o.group && o.group !== grupo) {
        grupo = o.group;
        html += `<div class="ms-group">${esc(o.group)}</div>`;
      }
      const sel = this.selected.has(o.value);
      html += `<label class="ms-option" role="option" aria-selected="${sel}">
          <input type="checkbox" value="${esc(o.value)}" ${sel ? 'checked' : ''} /><span class="truncate">${esc(o.label)}</span>
        </label>`;
    }
    this.list.innerHTML = html;
  }

  _renderSummary() {
    const n = this.selected.size;
    const total = this.options.length;
    let text;
    if (!total) text = 'Sin opciones disponibles';
    else if (!n) text = 'Ninguna';
    else if (n === total) text = `Todas (${total})`;
    else if (n === 1) text = this.options.find((o) => this.selected.has(o.value)).label;
    else text = `${n} de ${total}`;
    this.summary.textContent = text;
    this.summary.classList.toggle('text-grey-mid', n === 0);
  }

  _emit() {
    this._renderSummary();
    this.onChange(this.getSelected());
  }
};

/* --------------------------------------------------------------------------
 * 5.2 DateRange — rango de fechas compacto en línea (atajo + desde → hasta);
 *     valida límites e invierte rangos al revés.
 *     new DateRange(el, { min, max, desde, hasta, onChange })
 * ------------------------------------------------------------------------ */
App.components.DateRange = class DateRange {
  static PRESETS = [
    { key: '30', label: '30 días', days: 30 },
    { key: '90', label: '90 días', days: 90 },
    { key: '180', label: '6 meses', days: 182 },
    { key: 'all', label: '12 meses', days: null },
  ];

  constructor(root, opts) {
    this.root = root;
    this.min = opts.min;
    this.max = opts.max;
    this.onChange = opts.onChange || (() => {});
    this.desde = opts.desde || opts.min;
    this.hasta = opts.hasta || opts.max;
    this._build(opts.label || 'Rango de fechas');
    this._sync();
  }

  get() {
    return { desde: this.desde, hasta: this.hasta };
  }

  set(desde, hasta, silent = true) {
    this.desde = desde;
    this.hasta = hasta;
    this._sync();
    if (!silent) this.onChange(this.get());
  }

  _build(label) {
    this.root.classList.add('flex', 'shrink-0', 'items-center', 'gap-1.5');
    this.root.setAttribute('role', 'group');
    this.root.setAttribute('aria-label', label);
    this.root.innerHTML = `
      <select class="input w-[7.6rem]" data-role="preset" aria-label="Periodo predefinido">
        <option value="custom" hidden>Personalizado</option>
        ${DateRange.PRESETS.map((p) => `<option value="${p.key}">${p.label}</option>`).join('')}
      </select>
      <input type="date" class="input num w-[8rem]" data-role="desde" min="${this.min}" max="${this.max}" aria-label="Fecha inicial" />
      <span class="text-xs text-grey-light" aria-hidden="true">→</span>
      <input type="date" class="input num w-[8rem]" data-role="hasta" min="${this.min}" max="${this.max}" aria-label="Fecha final" />`;

    this.inPreset = this.root.querySelector('[data-role="preset"]');
    this.inDesde = this.root.querySelector('[data-role="desde"]');
    this.inHasta = this.root.querySelector('[data-role="hasta"]');

    const clampDate = (d) => (d < this.min ? this.min : d > this.max ? this.max : d);
    const onInput = () => {
      let d = clampDate(this.inDesde.value || this.min);
      let h = clampDate(this.inHasta.value || this.max);
      if (d > h) [d, h] = [h, d];
      this.set(d, h, false);
    };
    this.inDesde.addEventListener('change', onInput);
    this.inHasta.addEventListener('change', onInput);

    this.inPreset.addEventListener('change', () => {
      const p = DateRange.PRESETS.find((x) => x.key === this.inPreset.value);
      if (p) this.set(this._presetStart(p), this.max, false);
    });
  }

  _presetStart(p) {
    if (!p.days) return this.min;
    const d = App.utils.addDays(this.max, -(p.days - 1));
    return d < this.min ? this.min : d;
  }

  _sync() {
    this.inDesde.value = this.desde;
    this.inHasta.value = this.hasta;
    const match = DateRange.PRESETS.find((p) => this.hasta === this.max && this.desde === this._presetStart(p));
    this.inPreset.value = match ? match.key : 'custom';
  }
};

/* --------------------------------------------------------------------------
 * 5.3 DataTable — orden por columna (clic/teclado), paginación opcional,
 *     encabezado fijo y hover sincronizable. Solo renderiza la página
 *     visible, por lo que es fluida con 16.000 filas.
 *     columns: [{ key, label, align?, type?: 'text', render?(row), sortValue?(row), defaultDir? }]
 * ------------------------------------------------------------------------ */
App.components.DataTable = class DataTable {
  static collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

  static ICONS = {
    none: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>',
    asc: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg>',
    desc: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>',
  };

  constructor(root, cfg) {
    this.root = root;
    this.columns = cfg.columns;
    this.sortKey = cfg.sortKey || null;
    this.sortDir = cfg.sortDir || 'desc';
    this.pageSize = cfg.pageSize || 0;
    this.emptyText = cfg.emptyText || 'No hay registros para los filtros seleccionados.';
    this.onRowHover = cfg.onRowHover || null;
    this.compact = !!cfg.compact;
    this.page = 1;
    this.rows = [];
    this.sorted = [];
    this.visible = [];

    root.innerHTML = `
      <div class="table-scroll" ${cfg.maxHeight ? `style="max-height:${cfg.maxHeight}px"` : ''}>
        <table class="data-table${this.compact ? ' data-table--compact' : ''}"><thead></thead><tbody></tbody></table>
      </div>
      ${this.pageSize ? '<nav class="pager" aria-label="Paginación"></nav>' : ''}`;

    this.scroll = root.querySelector('.table-scroll');
    this.thead = root.querySelector('thead');
    this.tbody = root.querySelector('tbody');
    this.pager = root.querySelector('.pager');

    this.thead.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-key]');
      if (th) this.sortBy(th.dataset.key);
    });
    this.thead.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('th[data-key]')) {
        e.preventDefault();
        this.sortBy(e.target.dataset.key);
      }
    });
    if (this.pager) {
      this.pager.addEventListener('click', (e) => {
        const b = e.target.closest('button[data-page]');
        if (b && !b.disabled) this.goTo(Number(b.dataset.page));
      });
    }
    if (this.onRowHover) {
      this.tbody.addEventListener('mouseover', (e) => {
        const tr = e.target.closest('tr[data-i]');
        if (tr && tr !== this._hoverTr) {
          this._hoverTr = tr;
          this.onRowHover(this.visible[Number(tr.dataset.i)]);
        }
      });
      this.tbody.addEventListener('mouseleave', () => {
        this._hoverTr = null;
        this.onRowHover(null);
      });
    }
  }

  setColumns(columns) {
    this.columns = columns;
    this._renderHead();
  }

  setRows(rows) {
    this.rows = rows || [];
    this.page = 1;
    this._sort();
    this.render();
  }

  sortBy(key) {
    const col = this.columns.find((c) => c.key === key);
    if (!col) return;
    if (this.sortKey === key) this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
    else {
      this.sortKey = key;
      this.sortDir = col.defaultDir || (col.type === 'text' ? 'asc' : 'desc');
    }
    this.page = 1;
    this._sort();
    this.render();
  }

  goTo(page) {
    this.page = Math.min(Math.max(1, page), this.pageCount());
    this.render();
    this.scroll.scrollTop = 0;
  }

  pageCount() {
    return this.pageSize ? Math.max(1, Math.ceil(this.sorted.length / this.pageSize)) : 1;
  }

  /** Decorate-sort-undecorate: clave evaluada una vez por fila, orden estable. */
  _sort() {
    const col = this.columns.find((c) => c.key === this.sortKey);
    if (!col) {
      this.sorted = this.rows.slice();
      return;
    }
    const get = col.sortValue || ((r) => r[col.key]);
    const dir = this.sortDir === 'asc' ? 1 : -1;
    const isText = col.type === 'text';
    const coll = DataTable.collator;
    const dec = this.rows.map((r, i) => ({ r, v: get(r), i }));
    dec.sort((a, b) => {
      let c;
      if (isText) c = coll.compare(String(a.v), String(b.v));
      else {
        const va = Number.isFinite(a.v) ? a.v : -Infinity;
        const vb = Number.isFinite(b.v) ? b.v : -Infinity;
        c = va < vb ? -1 : va > vb ? 1 : 0;
      }
      return c !== 0 ? c * dir : a.i - b.i;
    });
    this.sorted = dec.map((d) => d.r);
  }

  render() {
    this._renderHead();
    const start = this.pageSize ? (this.page - 1) * this.pageSize : 0;
    this.visible = this.pageSize ? this.sorted.slice(start, start + this.pageSize) : this.sorted;

    if (!this.visible.length) {
      this.tbody.innerHTML = `<tr><td colspan="${this.columns.length}" class="empty-cell">${this.emptyText}</td></tr>`;
    } else {
      const esc = App.utils.escapeHtml;
      let html = '';
      for (let i = 0; i < this.visible.length; i++) {
        const row = this.visible[i];
        html += `<tr data-i="${i}">`;
        for (const c of this.columns) {
          html += `<td class="${DataTable.alignClass(c)}">${c.render ? c.render(row) : esc(row[c.key])}</td>`;
        }
        html += '</tr>';
      }
      this.tbody.innerHTML = html;
    }
    if (this.pager) this._renderPager(start);
  }

  _renderHead() {
    this.thead.innerHTML =
      '<tr>' +
      this.columns
        .map((c) => {
          const active = c.key === this.sortKey;
          const aria = active ? (this.sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
          const cls = [DataTable.alignClass(c), active ? 'is-sorted' : ''].join(' ');
          return `<th data-key="${c.key}" tabindex="0" aria-sort="${aria}" class="${cls}" scope="col">
              <span class="th-inner">${c.label}<span class="sort-icon">${DataTable.ICONS[active ? this.sortDir : 'none']}</span></span></th>`;
        })
        .join('') +
      '</tr>';
  }

  _renderPager(start) {
    const fmt = App.utils.fmt;
    const total = this.sorted.length;
    const pages = this.pageCount();
    const p = this.page;
    const to = Math.min(start + this.pageSize, total);

    const btn = (page, label, disabled, title, current = false) =>
      `<button type="button" data-page="${page}" ${disabled ? 'disabled' : ''} title="${title}" aria-label="${title}" class="${current ? 'is-current' : ''}" ${current ? 'aria-current="page"' : ''}>${label}</button>`;

    let nums = '';
    let last = 0;
    for (const n of DataTable.pageWindow(p, pages)) {
      if (n - last > 1) nums += '<span class="ellipsis">…</span>';
      nums += btn(n, fmt(n), false, `Página ${n}`, n === p);
      last = n;
    }

    this.pager.innerHTML = `
      <p class="pager-info">${
        total ? `Mostrando <b class="num">${fmt(start + 1)}–${fmt(to)}</b> de <b class="num">${fmt(total)}</b> registros · ${this.pageSize} por página` : 'Sin registros'
      }</p>
      <div class="pager-controls">
        ${btn(1, '«', p === 1, 'Primera página')}
        ${btn(p - 1, '‹', p === 1, 'Página anterior')}
        ${nums}
        ${btn(p + 1, '›', p === pages, 'Página siguiente')}
        ${btn(pages, '»', p === pages, 'Última página')}
      </div>`;
  }

  /** Clase de alineación de una columna: 'right' | 'center' | izquierda (por defecto). */
  static alignClass(c) {
    return c.align === 'right' ? 'is-right' : c.align === 'center' ? 'is-center' : '';
  }

  /** Primera, última y vecinas de la página actual. */
  static pageWindow(current, total) {
    const set = new Set([1, total, current - 1, current, current + 1]);
    if (current <= 3) [2, 3, 4].forEach((n) => set.add(n));
    if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((n) => set.add(n));
    return [...set].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  }
};

/* ==========================================================================
 * 6. FILTROS GLOBALES — fuente única de verdad para todas las vistas.
 * Los controles viven en la barra superior; las vistas se suscriben.
 * Cambios consecutivos se agrupan en una sola notificación, y el filtrado
 * de registros se memoriza hasta que cambie un filtro de datos (cambiar
 * solo la granularidad no vuelve a filtrar).
 * ========================================================================== */
App.filters = (function () {
  'use strict';
  const D = App.data;

  const defaults = () => ({
    gran: 'mes',
    desde: D.minDate,
    hasta: D.maxDate,
    plantas: D.plantas.slice(),
    granjas: D.granjas.map((g) => g.nombre),
  });

  const state = defaults();
  const listeners = new Set();
  let dataVersion = 0;
  let cacheVersion = -1;
  let cache = [];
  let pending = 0;
  let dataChanged = false;

  /** Registros filtrados por fechas, plantas y granjas (memorizado). */
  function rows() {
    if (cacheVersion !== dataVersion) {
      cache = D.filter(state);
      cacheVersion = dataVersion;
    }
    return cache;
  }

  function set(patch) {
    Object.assign(state, patch);
    if (Object.keys(patch).some((k) => k !== 'gran')) {
      dataVersion++;
      dataChanged = true;
    }
    clearTimeout(pending);
    pending = setTimeout(emit, 0);
  }

  function emit() {
    const info = { dataChanged };
    dataChanged = false;
    listeners.forEach((fn) => fn(state, info));
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { state, defaults, rows, set, reset: () => set(defaults()), subscribe };
})();

/* ==========================================================================
 * 7. VISTAS
 * Cada vista se suscribe a App.filters. Si está oculta al cambiar un filtro
 * se marca como pendiente y se recalcula al volver a mostrarse.
 * ========================================================================== */
App.views = {};

/* --------------------------------------------------------------------------
 * 7.1 TABLERO A LA MEDIDA — KPIs + distribución SEUROP en la misma fila,
 *     ranking por granja, SEUROP en el tiempo con tabla sincronizada y
 *     variables físicas con doble eje.
 * ------------------------------------------------------------------------ */
App.views.inicio = (function () {
  'use strict';
  const T = App.tokens;
  const U = App.utils;
  const D = App.data;
  const C = App.charts;
  const F = App.filters;
  const { DataTable } = App.components;

  // Estado propio de la vista (solo visual); los filtros viven en App.filters
  const state = { lines: { peso: true, magro: true, grasa: true } };
  let dirty = false;

  const SERIES = {
    peso: { name: 'Peso promedio (kg)', color: '#dcb3b0', hover: T.primary, unit: 'kg', dec: 1 },
    magro: { name: '% Magro promedio', color: T.good, unit: '%', dec: 2 },
    grasa: { name: 'Grasa dorsal promedio (mm)', color: T.accent, unit: 'mm', dec: 1 },
  };

  const ui = {};
  const charts = {};
  const tables = {};

  /* ---------- Plantilla ---------------------------------------------------- */

  const kpiTemplate = (id, icon, label) => `
    <article class="card flex h-full min-w-0 flex-col p-4">
      <div class="flex items-center justify-between gap-2">
        <p class="kpi-label">${label}</p>
        <span class="kpi-icon"><i data-lucide="${icon}"></i></span>
      </div>
      <p class="kpi-value mt-auto truncate pt-3" data-ref="kpi-${id}">—</p>
      <p class="kpi-sub" data-ref="kpi-${id}-sub">&nbsp;</p>
    </article>`;

  /** Scorecard IQ-Col: valor promedio a la izquierda + badge con la letra SEUROP predominante. */
  const kpiIqTemplate = () => `
    <article class="card flex h-full min-w-0 flex-col p-4">
      <p class="kpi-label">IQ-Col predominante</p>
      <div class="mt-auto flex items-center justify-between gap-3 pt-3">
        <div class="min-w-0">
          <p class="num truncate font-display text-[2rem] font-extrabold leading-none text-primary" data-ref="kpi-iq">—</p>
          <p class="mt-1.5 text-[0.72rem] text-grey-mid">IQ-Col promedio</p>
        </div>
        <span class="flex h-12 w-12 shrink-0 items-center justify-center rounded-[12px] font-display text-xl font-black text-white shadow-sm"
              style="background:${T.greyLight}" data-ref="kpi-iq-badge" role="img" aria-label="Sin categoría">—</span>
      </div>
      <p class="kpi-sub" data-ref="kpi-iq-sub">&nbsp;</p>
    </article>`;

  const cardHeader = (title, sub, extra = '') => `
    <div class="card-header flex-wrap">
      <div><h2 class="card-title">${title}</h2><p class="card-subtitle"${sub === null ? ' data-ref="timelineSub"' : ''}>${sub || ''}</p></div>${extra}
    </div>`;

  function template() {
    return `
      <div class="mb-6 grid grid-cols-1 items-stretch gap-4 lg:grid-cols-12">
        <section class="grid h-full grid-cols-1 gap-3 sm:grid-cols-3 lg:col-span-7" aria-label="Indicadores clave">
          ${kpiTemplate('granjas', 'tractor', 'Granjas activas')}
          ${kpiTemplate('canales', 'package', 'Canales evaluados')}
          ${kpiIqTemplate()}
        </section>

        <section class="card flex h-full min-w-0 flex-col lg:col-span-5">
          <div class="card-header pb-1"><div>
            <h2 class="card-title">Distribución general por clasificación SEUROP</h2>
            <p class="card-subtitle">Participación sobre el total de canales filtrados</p>
          </div></div>
          <div class="flex flex-1 flex-col justify-center gap-3 px-5 pb-4">
            <div data-ref="chartSeurop" style="height:44px"></div>
            <ul class="grid grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-2" data-ref="seuropLegend"></ul>
          </div>
        </section>
      </div>

      <section class="card mb-6">
        ${cardHeader('Ranking por granja', 'Ordenado por cantidad de canales · haga clic en un encabezado para reordenar')}
        <div class="px-2 pb-2 md:px-3" data-ref="tableRanking"></div>
      </section>

      <section class="card mb-6">
        ${cardHeader('Distribución SEUROP en el tiempo', null)}
        <div class="px-3 md:px-5"><div data-ref="chartTimeline" style="height:380px"></div></div>
        <div class="mt-3 border-t border-line px-2 pb-2 md:px-3" data-ref="tablePeriodos"></div>
      </section>

      <section class="card">
        ${cardHeader(
          'Evolución de variables físicas',
          'Peso promedio en barras (eje izquierdo) · % magro y grasa dorsal en líneas (eje derecho)',
          `<div class="flex flex-wrap items-center gap-2" data-ref="lineToggles" role="group" aria-label="Mostrar u ocultar líneas">
            <label class="toggle-pill" style="--c:${SERIES.magro.color}"><input type="checkbox" data-line="magro" checked /><span class="dot"></span>% Magro</label>
            <label class="toggle-pill" style="--c:${SERIES.grasa.color}"><input type="checkbox" data-line="grasa" checked /><span class="dot"></span>Grasa dorsal</label>
          </div>`
        )}
        <div class="px-3 pb-3 md:px-5"><div data-ref="chartFisicas" style="height:380px"></div></div>
      </section>`;
  }

  /* ---------- Montaje ------------------------------------------------------ */

  function mount(container) {
    container.innerHTML = template();
    container.querySelectorAll('[data-ref]').forEach((n) => (ui[n.dataset.ref] = n));

    // Filtros globales → recálculo inmediato si está visible, diferido si no
    F.subscribe(() => {
      if (container.hidden) dirty = true;
      else update();
    });

    // Toggles visuales de líneas → leyenda del gráfico (sin recargar datos)
    ui.lineToggles.addEventListener('change', (e) => {
      const key = e.target.dataset.line;
      if (!key) return;
      state.lines[key] = e.target.checked;
      charts.fisicas.dispatchAction({ type: e.target.checked ? 'legendSelect' : 'legendUnSelect', name: SERIES[key].name });
    });

    charts.seurop = C.create(ui.chartSeurop);
    charts.timeline = C.create(ui.chartTimeline);
    charts.fisicas = C.create(ui.chartFisicas);

    // La leyenda del gráfico también oculta series: se sincroniza con los toggles
    charts.fisicas.on('legendselectchanged', (e) => {
      Object.keys(SERIES).forEach((k) => (state.lines[k] = e.selected[SERIES[k].name] !== false));
      ui.lineToggles.querySelectorAll('input[data-line]').forEach((cb) => (cb.checked = state.lines[cb.dataset.line]));
    });

    tables.ranking = new DataTable(ui.tableRanking, { columns: rankingColumns(), sortKey: 'count', sortDir: 'desc' });
    tables.periodos = new DataTable(ui.tablePeriodos, {
      columns: periodColumns(),
      sortKey: 'key',
      sortDir: 'asc',
      maxHeight: 340,
      onRowHover: highlightPeriod,
    });

    update();
  }

  /* ---------- Recalculo (1 filtrado memorizado + 1 agregación) ----------- */

  function update() {
    dirty = false;
    const agg = D.aggregate(F.rows(), F.state.gran);

    renderKpis(agg);
    renderSeuropBar(agg.total);

    const maxCount = agg.granjas.reduce((m, g) => Math.max(m, g.count), 0);
    agg.granjas.forEach((g) => (g.share = maxCount ? g.count / maxCount : 0));
    tables.ranking.setRows(agg.granjas);

    renderTimeline(agg);
    tables.periodos.setColumns(periodColumns());
    tables.periodos.setRows(agg.periodos);

    renderFisicas(agg);
  }

  /* ---------- KPIs --------------------------------------------------------- */

  function renderKpis(agg) {
    const t = agg.total;
    const { desde, hasta } = F.state;
    ui['kpi-granjas'].textContent = U.fmt(agg.granjas.length);
    ui['kpi-granjas-sub'].textContent = `de ${D.granjas.length} granjas registradas`;
    ui['kpi-canales'].textContent = U.fmt(t.count);
    ui['kpi-canales-sub'].textContent = `${U.formatDate(desde)} – ${U.formatDate(hasta)}`;

    // IQ-Col: promedio numérico + letra SEUROP predominante con su color de la paleta
    const badge = ui['kpi-iq-badge'];
    if (t.count) {
      const top = U.argmax(t.seu);
      const cat = U.SEUROP[top];
      ui['kpi-iq'].textContent = U.fmt(t.iqProm, 1);
      badge.textContent = cat.letter;
      badge.style.background = cat.color;
      badge.title = `${cat.letter} · ${cat.key}`;
      badge.setAttribute('aria-label', `Clase SEUROP predominante: ${cat.letter} (${cat.key})`);
      ui['kpi-iq-sub'].textContent = `${cat.key} · ${U.fmtPct((t.seu[top] / t.count) * 100)} de los canales`;
    } else {
      ui['kpi-iq'].textContent = '—';
      badge.textContent = '—';
      badge.style.background = T.greyLight;
      badge.title = '';
      badge.setAttribute('aria-label', 'Sin categoría');
      ui['kpi-iq-sub'].textContent = 'Sin datos en la selección';
    }
  }

  /* ---------- Barra horizontal 100% SEUROP -------------------------------- */

  /** Leyenda HTML (se adapta al ancho de la columna sin desbordar el gráfico). */
  function renderSeuropLegend(t) {
    ui.seuropLegend.innerHTML = U.SEUROP.map((s, i) => {
      const value = t.count ? U.fmtPct((t.seu[i] / t.count) * 100) : '—';
      return `<li class="flex min-w-0 items-center gap-1.5 text-[0.75rem]">
          <span class="h-2.5 w-2.5 shrink-0 rounded-[3px]" style="background:${s.color}"></span>
          <span class="truncate font-semibold text-grey-strong"><b class="text-ink">${s.letter}</b> · ${s.key}</span>
          <span class="num ml-auto font-extrabold text-ink">${value}</span>
        </li>`;
    }).join('');
  }

  function renderSeuropBar(t) {
    renderSeuropLegend(t);
    if (!t.count) return C.setEmpty(charts.seurop);
    const pct = t.seu.map((n) => (n / t.count) * 100);

    charts.seurop.setOption(
      {
        textStyle: C.textStyle,
        animationDuration: 500,
        grid: { left: 0, right: 0, top: 0, bottom: 0 },
        xAxis: { type: 'value', max: 100, show: false },
        yAxis: { type: 'category', data: ['Empresa'], show: false },
        tooltip: {
          ...C.tooltip,
          trigger: 'item',
          formatter: (p) =>
            C.tipHeader(p.seriesName) +
            C.tipRow(p.color, 'Canales', U.fmt(t.seu[p.seriesIndex])) +
            C.tipRow(p.color, 'Participación', U.fmtPct(p.value, 2)),
        },
        series: U.SEUROP.map((s, i) => ({
          name: s.key,
          type: 'bar',
          stack: 'total',
          barWidth: 40,
          data: [pct[i]],
          itemStyle: {
            color: s.color,
            borderColor: '#fff',
            borderWidth: 1,
            borderRadius: i === 0 ? [10, 0, 0, 10] : i === U.SEUROP.length - 1 ? [0, 10, 10, 0] : 0,
          },
          label: {
            show: true,
            position: 'inside',
            color: s.text,
            fontWeight: 700,
            fontSize: 12,
            formatter: (p) => (p.value >= 7 ? U.fmtPct(p.value) : ''),
          },
          emphasis: { focus: 'series' },
        })),
      },
      true
    );
  }

  /* ---------- Tablas ------------------------------------------------------- */

  function rankingColumns() {
    return [
      {
        key: 'key',
        label: 'Granja',
        type: 'text',
        render: (r) => `<div class="font-semibold text-ink">${U.escapeHtml(r.key)}</div><div class="text-xs text-grey-mid">${U.escapeHtml(r.planta)}</div>`,
      },
      {
        key: 'count',
        label: 'Cantidad de canales',
        align: 'right',
        render: (r) =>
          `<div class="bar-cell"><div class="bar-track"><div class="bar-fill" style="width:${(r.share * 100).toFixed(1)}%"></div></div><span class="font-bold">${U.fmt(r.count)}</span></div>`,
      },
      { key: 'pesoProm', label: 'Peso promedio (kg)', align: 'right', render: (r) => U.fmt(r.pesoProm, 1) },
      { key: 'magroProm', label: 'Promedio % magro', align: 'right', render: (r) => U.fmtPct(r.magroProm, 2) },
      { key: 'grasaProm', label: 'Promedio grasa dorsal (mm)', align: 'right', render: (r) => U.fmt(r.grasaProm, 1) },
      { key: 'iqProm', label: 'IQ-Col promedio', align: 'right', render: (r) => U.fmt(r.iqProm, 1) },
      // Orden por jerarquía de calidad (S → P), no alfabético
      { key: 'seuTop', label: 'Cat. SEUROP', align: 'center', defaultDir: 'asc', render: (r) => seuropLetterBox(r.seuTop) },
    ];
  }

  /** Recuadro con la letra SEUROP y su color exacto de la paleta. */
  function seuropLetterBox(i) {
    const s = U.SEUROP[i];
    return `<span class="num inline-flex h-7 w-7 items-center justify-center rounded-[7px] font-display text-[0.75rem] font-bold text-white"
      style="background-color:${s.color}" title="${s.letter} · ${s.key}" aria-label="Categoría ${s.letter} (${s.key})">${s.letter}</span>`;
  }

  function periodColumns() {
    return [
      { key: 'key', label: `Periodo (${U.granLabel(F.state.gran)})`, type: 'text', render: (r) => `<span class="font-semibold">${U.periodLabel(F.state.gran, r.key)}</span>` },
      { key: 'count', label: 'Cantidad de canales', align: 'right', render: (r) => U.fmt(r.count) },
      { key: 'pesoProm', label: 'Promedio peso (kg)', align: 'right', render: (r) => U.fmt(r.pesoProm, 1) },
      { key: 'magroProm', label: 'Promedio % magro', align: 'right', render: (r) => U.fmtPct(r.magroProm, 2) },
      { key: 'grasaProm', label: 'Promedio grasa dorsal (mm)', align: 'right', render: (r) => U.fmt(r.grasaProm, 1) },
      { key: 'iqProm', label: 'IQ-Col promedio', align: 'right', render: (r) => U.fmt(r.iqProm, 1) },
      { key: 'iqTop', label: 'Categoría IQ-Col mayoritaria', defaultDir: 'asc', render: (r) => U.iqBadge(r.iqTop) },
    ];
  }

  /** Hover en la tabla de periodos → tooltip del mismo periodo en el gráfico. */
  function highlightPeriod(row) {
    if (!row) return charts.timeline.dispatchAction({ type: 'hideTip' });
    charts.timeline.dispatchAction({ type: 'showTip', seriesIndex: 0, dataIndex: row.idx });
  }

  /* ---------- SEUROP en el tiempo (barras apiladas 100%) ------------------ */

  function renderTimeline(agg) {
    const P = agg.periodos;
    const gran = F.state.gran;
    ui.timelineSub.textContent = `Composición porcentual por ${U.granLabel(gran).toLowerCase()} · las categorías de mayor volumen se ubican en la base de cada barra`;
    if (!P.length) return C.setEmpty(charts.timeline);

    // La primera serie del stack queda en la base → orden por volumen total desc
    const order = U.SEUROP.map((_, i) => i).sort((a, b) => agg.total.seu[b] - agg.total.seu[a]);
    const labels = P.map((p) => U.periodLabel(gran, p.key));
    const zoom = C.zoomFor(P.length);

    charts.timeline.setOption(
      {
        textStyle: C.textStyle,
        animationDuration: 450,
        legend: { ...C.legend, data: U.SEUROP.map((s) => s.key) },
        grid: { left: 4, right: 8, top: 40, bottom: zoom ? 44 : 4, containLabel: true },
        tooltip: {
          ...C.tooltip,
          trigger: 'axis',
          axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(153,57,53,.06)' } },
          formatter: (params) => {
            const i = params[0].dataIndex;
            const p = P[i];
            let html = C.tipHeader(labels[i], `${U.fmt(p.count)} canales`);
            U.SEUROP.forEach((s, k) => {
              if (p.seu[k]) html += C.tipRow(s.color, s.key, `${U.fmtPct((p.seu[k] / p.count) * 100)} · ${U.fmt(p.seu[k])}`);
            });
            return html;
          },
        },
        xAxis: C.categoryAxis(labels),
        yAxis: {
          type: 'value',
          min: 0,
          max: 100,
          interval: 25,
          axisLabel: { color: C.AXIS.label, formatter: '{value}%' },
          splitLine: { lineStyle: { color: C.AXIS.split } },
        },
        dataZoom: zoom || [],
        series: order.map((i) => ({
          name: U.SEUROP[i].key,
          type: 'bar',
          stack: 'pct',
          barMaxWidth: 48,
          barCategoryGap: '28%',
          itemStyle: { color: U.SEUROP[i].color },
          emphasis: { focus: 'series' },
          data: P.map((p) => (p.count ? (p.seu[i] / p.count) * 100 : 0)),
        })),
      },
      true
    );
  }

  /* ---------- Variables físicas (barras + líneas, doble eje Y) ------------ */

  function renderFisicas(agg) {
    const P = agg.periodos;
    if (!P.length) return C.setEmpty(charts.fisicas);

    const labels = P.map((p) => U.periodLabel(F.state.gran, p.key));
    const zoom = C.zoomFor(P.length);
    const showSymbol = P.length <= 60;

    const line = (key, field) => ({
      name: SERIES[key].name,
      type: 'line',
      yAxisIndex: 1,
      smooth: 0.3,
      symbol: 'circle',
      symbolSize: 7,
      showSymbol,
      lineStyle: { width: 2.5 },
      itemStyle: { color: SERIES[key].color, borderColor: '#fff', borderWidth: 1.5 },
      emphasis: { focus: 'series' },
      data: P.map((p) => +p[field].toFixed(2)),
    });

    charts.fisicas.setOption(
      {
        textStyle: C.textStyle,
        animationDuration: 450,
        legend: {
          ...C.legend,
          data: Object.values(SERIES).map((s) => s.name),
          selected: Object.fromEntries(Object.keys(SERIES).map((k) => [SERIES[k].name, state.lines[k]])),
        },
        grid: { left: 4, right: 4, top: 58, bottom: zoom ? 44 : 4, containLabel: true },
        tooltip: {
          ...C.tooltip,
          trigger: 'axis',
          axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(153,57,53,.06)' } },
          formatter: (params) => {
            const i = params[0].dataIndex;
            let html = C.tipHeader(labels[i], `${U.fmt(P[i].count)} canales`);
            params.forEach((p) => {
              const s = Object.values(SERIES).find((x) => x.name === p.seriesName);
              html += C.tipRow(s.color, p.seriesName.replace(/ \(.*\)$/, ''), `${U.fmt(p.value, s.dec)} ${s.unit}`);
            });
            return html;
          },
        },
        xAxis: C.categoryAxis(labels),
        yAxis: [
          {
            type: 'value',
            name: 'Peso (kg)',
            nameTextStyle: { color: C.AXIS.name, align: 'left', fontWeight: 600 },
            // Eje ajustado al rango para que la variación del peso sea legible
            min: (v) => (Number.isFinite(v.min) ? Math.max(0, Math.floor((v.min - 6) / 5) * 5) : 0),
            max: (v) => (Number.isFinite(v.max) ? Math.ceil((v.max + 2) / 5) * 5 : 130),
            axisLabel: { color: C.AXIS.label },
            splitLine: { lineStyle: { color: C.AXIS.split } },
          },
          {
            type: 'value',
            name: '% magro / mm',
            nameTextStyle: { color: C.AXIS.name, align: 'right', fontWeight: 600 },
            position: 'right',
            min: 0,
            max: (v) => (Number.isFinite(v.max) ? Math.ceil((v.max + 5) / 10) * 10 : 70),
            axisLabel: { color: C.AXIS.label },
            splitLine: { show: false },
          },
        ],
        dataZoom: zoom || [],
        series: [
          {
            name: SERIES.peso.name,
            type: 'bar',
            yAxisIndex: 0,
            barMaxWidth: 34,
            itemStyle: { color: SERIES.peso.color, borderRadius: [5, 5, 0, 0] },
            emphasis: { itemStyle: { color: SERIES.peso.hover } },
            data: P.map((p) => +p.pesoProm.toFixed(2)),
          },
          line('magro', 'magroProm'),
          line('grasa', 'grasaProm'),
        ],
      },
      true
    );
  }

  return {
    mount,
    onShow() {
      if (dirty) update();
      Object.values(charts).forEach((c) => c.resize());
    },
  };
})();

/* --------------------------------------------------------------------------
 * 7.2 DESPACHO — usa los filtros globales (fechas, planta, granja): scatter
 *     peso / % magro optimizado (modo large), resumen SEUROP y detalle
 *     paginado (50 filas). La granularidad temporal no aplica aquí.
 * ------------------------------------------------------------------------ */
App.views.despacho = (function () {
  'use strict';
  const T = App.tokens;
  const U = App.utils;
  const D = App.data;
  const C = App.charts;
  const F = App.filters;
  const { DataTable } = App.components;

  const PAGE_SIZE = 50;
  const state = { legend: {} }; // visibilidad de categorías en el scatter
  let dirty = false;

  const ui = {};
  let scatter;
  let detalle;

  function template() {
    return `
      <section class="mb-6 grid gap-6 xl:grid-cols-3">
        <article class="card min-w-0 xl:col-span-2">
          <div class="card-header"><div>
            <h2 class="card-title">Dispersión y calidad</h2>
            <p class="card-subtitle">Peso del canal vs. % magro por clasificación SEUROP · rueda del ratón para zoom, clic en la leyenda para filtrar</p>
          </div></div>
          <div class="px-3 pb-3 md:px-4"><div data-ref="chartScatter" style="height:460px"></div></div>
        </article>

        <article class="card flex min-w-0 flex-col">
          <div class="card-header"><div>
            <h2 class="card-title">Resumen SEUROP</h2>
            <p class="card-subtitle">Cantidad y participación por categoría</p>
          </div></div>
          <div class="px-2 pb-3 md:px-3" data-ref="summary"></div>
        </article>
      </section>

      <section class="card">
        <div class="card-header"><div>
          <h2 class="card-title">Detalle por individuo</h2>
          <p class="card-subtitle">Registro individual de canales · clic en cualquier encabezado para ordenar ascendente / descendente</p>
        </div></div>
        <div class="px-2 pb-2 md:px-3" data-ref="tableDetalle"></div>
      </section>`;
  }

  function mount(container) {
    container.innerHTML = template();
    container.querySelectorAll('[data-ref]').forEach((n) => (ui[n.dataset.ref] = n));

    // Solo los filtros de datos afectan esta vista (no la granularidad)
    F.subscribe((_, { dataChanged }) => {
      if (!dataChanged) return;
      if (container.hidden) dirty = true;
      else update();
    });

    scatter = C.create(ui.chartScatter);
    scatter.on('legendselectchanged', (e) => (state.legend = { ...e.selected }));

    detalle = new DataTable(ui.tableDetalle, { columns: detalleColumns(), sortKey: 'id', sortDir: 'asc', pageSize: PAGE_SIZE });

    update();
  }

  function update() {
    dirty = false;
    const rows = F.rows();
    renderScatter(rows);
    renderSummary(rows);
    detalle.setRows(rows);
  }

  /* ---------- Scatter ------------------------------------------------------ */

  function renderScatter(rows) {
    if (!rows.length) return C.setEmpty(scatter);

    // Una serie por categoría → leyenda interactiva nativa
    const groups = U.SEUROP.map(() => []);
    for (const r of rows) groups[r._seu].push([r.peso_kg, r.porcentaje_magro, r.id]);

    const axisBase = {
      type: 'value',
      nameLocation: 'middle',
      nameTextStyle: { color: C.AXIS.name, fontWeight: 600 },
      axisLine: { show: true, lineStyle: { color: C.AXIS.line } },
      axisTick: { show: false },
      axisLabel: { color: C.AXIS.label },
      splitLine: { lineStyle: { color: C.AXIS.split } },
    };

    scatter.setOption(
      {
        textStyle: C.textStyle,
        animation: false, // render inmediato con miles de puntos
        legend: { ...C.legend, icon: 'circle', data: U.SEUROP.map((s) => s.key), selected: state.legend },
        toolbox: {
          right: 4,
          top: -6,
          itemSize: 14,
          iconStyle: { borderColor: T.greyMid },
          emphasis: { iconStyle: { borderColor: T.primary } },
          feature: {
            dataZoom: { title: { zoom: 'Zoom por área', back: 'Deshacer zoom' } },
            restore: { title: 'Restablecer vista' },
          },
        },
        grid: { left: 36, right: 16, top: 44, bottom: 36, containLabel: true },
        tooltip: {
          ...C.tooltip,
          trigger: 'item',
          formatter: (p) => {
            const [peso, magro, id] = p.value;
            return (
              C.tipHeader(U.fmtId(id)) +
              C.tipRow(T.greyMid, 'Peso', `${U.fmt(peso, 1)} kg`) +
              C.tipRow(T.greyMid, '% Magro', U.fmtPct(magro, 2)) +
              C.tipRow(p.color, 'Categoría', p.seriesName)
            );
          },
        },
        xAxis: { ...axisBase, name: 'Peso del canal (kg)', nameGap: 30, min: 75, max: 125, interval: 5 },
        yAxis: { ...axisBase, name: '% Magro', nameGap: 42, min: 40, max: 68, interval: 4 },
        dataZoom: [
          { type: 'inside', xAxisIndex: 0, filterMode: 'none' },
          { type: 'inside', yAxisIndex: 0, filterMode: 'none' },
        ],
        series: U.SEUROP.map((s, i) => ({
          name: s.key,
          type: 'scatter',
          data: groups[i],
          symbolSize: 5,
          large: true, // render por lotes para miles de puntos
          largeThreshold: 1500,
          itemStyle: { color: s.color, opacity: 0.6 },
          emphasis: { focus: 'series' },
        })),
      },
      true
    );
  }

  /* ---------- Resumen SEUROP ---------------------------------------------- */

  function renderSummary(rows) {
    const counts = D.seuropCounts(rows);
    const total = rows.length;
    const body = U.SEUROP.map((s, i) => {
      const pct = total ? (counts[i] / total) * 100 : 0;
      return `<tr>
          <td>${U.seuropBadge(i)}</td>
          <td class="is-right font-bold">${U.fmt(counts[i])}</td>
          <td class="is-right">
            <div class="bar-cell">
              <div class="bar-track" style="width:40px"><div class="bar-fill" style="width:${pct.toFixed(1)}%;background:${s.color}"></div></div>
              <span class="w-12 text-right">${total ? U.fmtPct(pct) : '—'}</span>
            </div>
          </td>
        </tr>`;
    }).join('');

    ui.summary.innerHTML = `
      <div class="table-scroll">
        <table class="data-table data-table--compact">
          <thead><tr><th scope="col">Categoría</th><th scope="col" class="is-right">Cantidad de canales</th><th scope="col" class="is-right">% de distribución</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><td>Total</td><td class="is-right">${U.fmt(total)}</td><td class="is-right">${total ? '100,0%' : '—'}</td></tr></tfoot>
        </table>
      </div>`;
  }

  /* ---------- Detalle ------------------------------------------------------ */

  function detalleColumns() {
    return [
      { key: 'id', label: 'ID / Canal', defaultDir: 'asc', render: (r) => `<span class="font-mono text-xs font-semibold text-grey-strong">${U.fmtId(r.id)}</span>` },
      { key: 'peso_kg', label: 'Peso (kg)', align: 'right', render: (r) => U.fmt(r.peso_kg, 1) },
      { key: 'grasa_dorsal_mm', label: 'Grasa dorsal (mm)', align: 'right', render: (r) => U.fmt(r.grasa_dorsal_mm, 1) },
      { key: 'porcentaje_magro', label: '% Magro', align: 'right', render: (r) => U.fmtPct(r.porcentaje_magro, 2) },
      // Orden por jerarquía de calidad (Superior → Baja), no alfabético
      { key: 'clasificacion_seurop', label: 'Clasificación SEUROP', defaultDir: 'asc', sortValue: (r) => r._seu, render: (r) => U.seuropBadge(r._seu) },
      { key: 'puntaje_seurop', label: 'Puntaje SEUROP', align: 'right', render: (r) => `<span class="font-bold">${U.fmt(r.puntaje_seurop, 1)}</span>` },
    ];
  }

  return {
    mount,
    onShow() {
      if (dirty) update();
      if (scatter) scatter.resize();
    },
  };
})();

/* --------------------------------------------------------------------------
 * 7.3 SCORES — pantalla en construcción
 * ------------------------------------------------------------------------ */
App.views.scores = {
  mount(container) {
    container.innerHTML = `
      <div class="grid min-h-[70vh] place-items-center">
        <div class="card w-full max-w-lg px-8 py-12 text-center">
          <div class="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-warn-soft text-warn ring-1 ring-warn/25">
            <i data-lucide="construction" class="h-8 w-8"></i>
          </div>
          <span class="badge mt-6 bg-primary-soft text-primary">En desarrollo</span>
          <h1 class="mt-3 font-display text-2xl font-extrabold tracking-tight text-ink">Módulo de Scores</h1>
          <p class="mx-auto mt-2 max-w-sm text-grey-strong">Esta sección se encuentra actualmente en desarrollo y estará disponible en una próxima iteración.</p>
          <a href="#inicio" class="btn-primary mt-8"><i data-lucide="arrow-left" class="h-4 w-4"></i>Volver al tablero</a>
        </div>
      </div>`;
  },
};

/* ==========================================================================
 * 8. SHELL + ROUTER
 * Barra superior con los filtros globales (se montan una sola vez y
 * escriben en App.filters), estado activo del sidebar y navegación por hash
 * con montaje diferido. La vista se hace visible ANTES de montarse para
 * que ECharts mida bien.
 * ========================================================================== */
(function () {
  'use strict';
  const U = App.utils;
  const D = App.data;
  const F = App.filters;
  const { MultiSelect, DateRange } = App.components;

  const ROUTES = { inicio: 'Tablero a la medida', despacho: 'Despacho', scores: 'Scores' };
  const DEFAULT_ROUTE = 'inicio';
  const mounted = new Set();

  // Clases del menú lateral (también se aplican a la navegación móvil)
  const NAV_ACTIVE = ['bg-primary-soft', 'text-primary', 'font-bold'];
  const NAV_INACTIVE = ['text-grey-strong', 'hover:bg-surface', 'hover:text-ink', 'font-semibold'];

  const shell = {
    title: document.querySelector('[data-shell="title"]'),
    count: document.querySelector('[data-shell="count"]'),
    filters: document.querySelector('[data-shell="filters"]'),
    filtersScroll: document.querySelector('[data-shell="filters-scroll"]'),
  };
  const ctl = {};

  /* ---------- Filtros globales de la barra superior ----------------------- */

  const plantaOptions = () => D.plantas.map((p) => ({ value: p, label: p }));
  function granjaOptions(plantas) {
    const set = new Set(plantas);
    return D.granjas.filter((g) => set.has(g.planta)).map((g) => ({ value: g.nombre, label: g.nombre, group: g.planta }));
  }

  function mountFilters() {
    shell.filters.innerHTML = `
      <div class="segmented shrink-0" role="group" aria-label="Agrupación temporal" data-ref="gran">
        ${U.GRANULARIDADES.map((g) => `<button type="button" data-gran="${g.key}">${g.label}</button>`).join('')}
      </div>
      <div data-ref="range"></div>
      <div class="w-[10rem]" data-ref="plantas"></div>
      <div class="w-[11.5rem]" data-ref="granjas"></div>
      <button type="button" class="btn-ghost shrink-0" data-ref="reset" title="Restablecer filtros" aria-label="Restablecer filtros">
        <i data-lucide="rotate-ccw" class="h-3.5 w-3.5"></i>
      </button>`;
    const ref = (k) => shell.filters.querySelector(`[data-ref="${k}"]`);
    const granGroup = ref('gran');
    const s = F.state;

    granGroup.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-gran]');
      if (!b || b.dataset.gran === F.state.gran) return;
      F.set({ gran: b.dataset.gran });
      syncGranButtons(granGroup);
    });
    syncGranButtons(granGroup);

    ctl.range = new DateRange(ref('range'), {
      min: D.minDate,
      max: D.maxDate,
      desde: s.desde,
      hasta: s.hasta,
      onChange: ({ desde, hasta }) => F.set({ desde, hasta }),
    });

    ctl.plantas = new MultiSelect(ref('plantas'), {
      label: 'Planta',
      options: plantaOptions(),
      selected: s.plantas,
      onChange: (plantas) => F.set({ plantas, granjas: cascadeGranjas(plantas) }),
    });

    ctl.granjas = new MultiSelect(ref('granjas'), {
      label: 'Granja',
      options: granjaOptions(s.plantas),
      selected: s.granjas,
      onChange: (granjas) => F.set({ granjas }),
    });

    ref('reset').addEventListener('click', () => {
      F.reset();
      const d = F.state;
      ctl.range.set(d.desde, d.hasta);
      ctl.plantas.setOptions(plantaOptions(), d.plantas);
      ctl.granjas.setOptions(granjaOptions(d.plantas), d.granjas);
      syncGranButtons(granGroup);
    });

    // Contador global de canales en la selección
    const renderCount = () => (shell.count.textContent = U.fmt(F.rows().length));
    F.subscribe(renderCount);
    renderCount();

    watchOverflow(shell.filtersScroll);
  }

  /** Marca los bordes con contenido oculto para mostrar el desvanecido (ver .scroll-fade). */
  function watchOverflow(el) {
    const sync = () => {
      const left = el.scrollLeft > 1;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
      const fade = left && right ? 'both' : left ? 'left' : right ? 'right' : '';
      if (fade) el.dataset.fade = fade;
      else delete el.dataset.fade;
    };
    el.addEventListener('scroll', sync, { passive: true });
    if ('ResizeObserver' in window) new ResizeObserver(sync).observe(el);
    window.addEventListener('resize', sync);
    sync();
  }

  /** Cambio de plantas: conserva granjas elegidas y auto-selecciona las que aparecen. */
  function cascadeGranjas(plantas) {
    const prevOptions = new Set(ctl.granjas.options.map((o) => o.value));
    const prevSelected = new Set(F.state.granjas);
    const opts = granjaOptions(plantas);
    const selected = opts.filter((o) => prevSelected.has(o.value) || !prevOptions.has(o.value)).map((o) => o.value);
    ctl.granjas.setOptions(opts, selected);
    return selected;
  }

  function syncGranButtons(group) {
    group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.gran === F.state.gran)));
  }

  /* ---------- Sidebar colapsable ------------------------------------------ */

  const SIDEBAR_KEY = 'pigbox.sidebar';

  /**
   * Oculta / muestra el sidebar desde el botón de la barra superior. El
   * estado se recuerda en este navegador. Los gráficos se reajustan solos
   * (ResizeObserver en cada contenedor) al cambiar el ancho del área principal.
   */
  function setupSidebar() {
    const aside = document.querySelector('[data-shell="sidebar"]');
    const btn = document.querySelector('[data-shell="sidebar-toggle"]');
    if (!aside || !btn) return;

    let collapsed = false;
    try {
      collapsed = localStorage.getItem(SIDEBAR_KEY) === 'collapsed';
    } catch (_) {
      /* almacenamiento no disponible: se inicia expandido */
    }

    const apply = () => {
      document.body.dataset.sidebar = collapsed ? 'collapsed' : 'expanded';
      aside.inert = collapsed; // sin foco de teclado en enlaces ocultos
      const label = collapsed ? 'Mostrar menú lateral' : 'Ocultar menú lateral';
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.setAttribute('aria-label', label);
      btn.title = label;
    };
    apply();

    btn.addEventListener('click', () => {
      collapsed = !collapsed;
      apply();
      try {
        localStorage.setItem(SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded');
      } catch (_) {
        /* sin persistencia */
      }
    });
  }

  /* ---------- Router ------------------------------------------------------- */

  const currentRoute = () => {
    const name = location.hash.replace(/^#\/?/, '');
    return ROUTES[name] ? name : DEFAULT_ROUTE;
  };

  function navigate() {
    const name = currentRoute();
    const view = App.views[name];

    document.querySelectorAll('[data-view]').forEach((sec) => (sec.hidden = sec.dataset.view !== name));

    if (!mounted.has(name)) {
      view.mount(document.querySelector(`[data-view="${name}"]`));
      mounted.add(name);
      App.utils.icons();
    }
    if (typeof view.onShow === 'function') view.onShow();

    document.querySelectorAll('[data-nav]').forEach((a) => {
      const active = a.dataset.nav === name;
      a.classList.remove(...(active ? NAV_INACTIVE : NAV_ACTIVE));
      a.classList.add(...(active ? NAV_ACTIVE : NAV_INACTIVE));
      if (active) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    shell.title.textContent = ROUTES[name];
    document.title = `Pigbox · ${ROUTES[name]}`;
    window.scrollTo({ top: 0 });
  }

  function init() {
    const meta = D.meta;
    const fuente = meta.fuente || `Tabla ${meta.tabla}`;
    document.querySelectorAll('[data-meta="fuente"]').forEach((n) => (n.textContent = fuente));
    document.querySelectorAll('[data-meta="total"]').forEach((n) => (n.textContent = U.fmt(meta.total)));
    setupSidebar();
    mountFilters();
    U.icons();
    window.addEventListener('hashchange', navigate);
    navigate();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
