/* ==========================================================================
 * data_loader.js  (ES module)
 * --------------------------------------------------------------------------
 * Pipeline de datos del tablero:
 *
 *   1. Espera la sesión (window.Auth.whenAuthenticated()).
 *   2. loadDataFromS3(): pide a APP_CONFIG.DATA_API_URL la versión vigente del
 *      Parquet (ETag + URLs firmadas), descarga cada archivo y lo parsea.
 *      Los archivos se guardan en IndexedDB y solo se vuelven a descargar
 *      cuando cambia el ETag. Si S3 falla pero hay copia guardada, se usa.
 *   3. sanitizeRecords(): valida tipos, descarta registros sin campos
 *      obligatorios y normaliza números y fechas.
 *   4. Publica window.DASHBOARD_DATA y carga app.js (una sola vez).
 *
 * Estados de UI (marcado en index.html): [data-status="loading"],
 * [data-status="error"] con "Reintentar conexión" y [data-shell="notice"].
 *
 * Pruebas locales sin S3: ?archivo=data/canales.parquet lee un Parquet
 * servido junto al sitio (data/ no se versiona).
 *
 * Requiere (cargados antes): config.js, auth.js, data_utils.js, seurop_quartiles.js.
 * ========================================================================== */

const HYPARQUET = 'https://cdn.jsdelivr.net/npm/hyparquet@1.31.5/+esm';
const HYPARQUET_COMPRESSORS = 'https://cdn.jsdelivr.net/npm/hyparquet-compressors@1.1.2/+esm';

const CFG = Object.assign(
  {
    S3_DATA_URL: '',
    DATA_API_URL: '/api/canales',
    REQUEST_TIMEOUT_MS: 30000,
    TIMEZONE: 'UTC',
    DEFAULT_COUNTRY: 'Colombia',
    COLUMN_MAP: {},
  },
  window.APP_CONFIG
);

const IDB = { nombre: 'tablero-canales', store: 'archivos', clave: 'canales-v2', limiteMs: 4000 };

/* ---------- Esquema esperado ------------------------------------------------ */

const REQUIRED_COLUMNS = ['peso_kg', 'porcentaje_magro'];
const DATE_COLUMNS = ['fecha', 'fecha_ingreso_planta']; // al menos una
const TIMESTAMP_FIELDS = ['fecha_ingreso_planta', 'fecha_pesaje_pie', 'fecha_sacrificio', 'fecha_canal_caliente', 'fecha_canal_fria'];
const FLOAT_FIELDS = ['peso_kg', 'porcentaje_magro', 'grasa_dorsal_mm', 'puntaje_seurop', 'peso_canal_caliente_kg', 'peso_canal_fria_kg', 'tiempo_espera_sacrificio_horas'];
const INT_FIELDS = ['id', 'color', 'variacion_color', 'tiempo_espera_sacrificio_min'];
const TEXT_FIELDS = ['planta', 'granja', 'pais', 'comercializador', 'sistema_medicion'];
const TEXT_DEFAULTS = { planta: 'Sin planta', granja: 'Sin granja', pais: CFG.DEFAULT_COUNTRY };

/* ---------- Errores con contexto (alimentan el banner de error) ------------- */

class LoadError extends Error {
  /**
   * @param {'network'|'timeout'|'http'|'data'|'parse'|'dependency'} kind
   * @param {'api'|'s3'|'local'|'data'|'cdn'} stage
   */
  constructor(message, { kind, stage, status = null, apiMessage = null, cause } = {}) {
    super(message, { cause });
    this.name = 'LoadError';
    this.kind = kind;
    this.stage = stage;
    this.status = status;
    this.apiMessage = apiMessage;
  }
}

/* ---------- UI de estado ------------------------------------------------------ */

const $ = (sel) => document.querySelector(sel);
const ui = {
  status: $('[data-shell="status"]'),
  loading: $('[data-status="loading"]'),
  message: $('[data-status="message"]'),
  source: $('[data-status="source"]'),
  error: $('[data-status="error"]'),
  errorTitle: $('[data-status="error-title"]'),
  errorDetail: $('[data-status="error-detail"]'),
  errorHints: $('[data-status="error-hints"]'),
  retry: $('[data-status="retry"]'),
  notice: $('[data-shell="notice"]'),
  noticeText: $('[data-shell="notice-text"]'),
};
const icons = () => window.lucide && typeof window.lucide.createIcons === 'function' && window.lucide.createIcons();

function showLoading(message) {
  ui.status.hidden = false;
  ui.error.hidden = true;
  ui.loading.hidden = false;
  ui.message.textContent = message;
}

function showError({ title, detail, hints }) {
  ui.status.hidden = false;
  ui.loading.hidden = true;
  ui.error.hidden = false;
  ui.errorTitle.textContent = title;
  ui.errorDetail.textContent = detail;
  ui.errorHints.replaceChildren(
    ...hints.map((h) => {
      const li = document.createElement('li');
      li.textContent = h;
      return li;
    })
  );
  ui.retry.disabled = false;
  icons();
}

const hideStatus = () => (ui.status.hidden = true);

function showNotice(text) {
  ui.noticeText.textContent = text;
  ui.notice.hidden = false;
  icons();
}

/* ---------- Red ------------------------------------------------------------ */

/** fetch con tiempo límite; convierte cada falla en un LoadError con su etapa. */
async function fetchOk(url, stage) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CFG.REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
  } catch (e) {
    const timeout = e && e.name === 'AbortError';
    throw new LoadError(timeout ? `Sin respuesta en ${CFG.REQUEST_TIMEOUT_MS / 1000} s` : 'Falló la conexión', {
      kind: timeout ? 'timeout' : 'network',
      stage,
      cause: e,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    let apiMessage = null;
    if ((resp.headers.get('content-type') || '').includes('application/json')) {
      try {
        apiMessage = (await resp.json()).error || null;
      } catch (_) {
        /* cuerpo no JSON */
      }
    }
    throw new LoadError(`HTTP ${resp.status}${apiMessage ? `: ${apiMessage}` : ''}`, {
      kind: 'http',
      stage,
      status: resp.status,
      apiMessage,
    });
  }
  return resp;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new LoadError(`No se pudo cargar ${src}`, { kind: 'dependency', stage: 'cdn' }));
    document.body.appendChild(s);
  });
}

/* ---------- Caché en IndexedDB (archivos Parquet crudos) ------------------- */

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB.nombre, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB.store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idb(mode, fn) {
  const db = await openIdb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB.store, mode);
      const req = fn(tx.objectStore(IDB.store));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

/** IndexedDB puede quedarse colgado en algunos navegadores: se limita el tiempo. */
function withLimit(promise, ms) {
  let id;
  const limit = new Promise((_, reject) => (id = setTimeout(() => reject(new Error(`IndexedDB no respondió en ${ms} ms`)), ms)));
  return Promise.race([promise, limit]).finally(() => clearTimeout(id));
}

/** La caché es una conveniencia: si IndexedDB falla, se sigue sin ella. */
async function readCache() {
  try {
    const entry = await withLimit(idb('readonly', (s) => s.get(IDB.clave)), IDB.limiteMs);
    return entry && Array.isArray(entry.files) && entry.files.length ? entry : null;
  } catch (e) {
    console.warn('[data_loader] No se pudo leer la caché:', e);
    return null;
  }
}

async function writeCache(entry) {
  try {
    await withLimit(idb('readwrite', (s) => s.put(entry, IDB.clave)), IDB.limiteMs);
  } catch (e) {
    console.warn('[data_loader] No se pudo guardar la caché:', e);
  }
}

/* ---------- Parquet ------------------------------------------------------------ */

let hyparquet = null;
async function parquetModule() {
  if (hyparquet) return hyparquet;
  try {
    hyparquet = await import(HYPARQUET);
    return hyparquet;
  } catch (e) {
    throw new LoadError('No se pudo cargar el lector de Parquet (hyparquet) desde el CDN', { kind: 'dependency', stage: 'cdn', cause: e });
  }
}

/** Snappy viene incluido; gzip/zstd/brotli cargan el paquete extra solo si hace falta. */
async function readParquet(buffer, name) {
  const { parquetReadObjects } = await parquetModule();
  try {
    try {
      return await parquetReadObjects({ file: buffer });
    } catch (e) {
      if (!/compress|codec/i.test(String(e && e.message))) throw e;
      const { compressors } = await import(HYPARQUET_COMPRESSORS);
      return await parquetReadObjects({ file: buffer, compressors });
    }
  } catch (e) {
    throw new LoadError(`El archivo ${name} no es un Parquet válido: ${e.message}`, { kind: 'parse', stage: 'data', cause: e });
  }
}

/** Parsea varios archivos y concatena sus filas. */
async function readAllParquet(files) {
  const rows = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    showLoading(files.length > 1 ? `Procesando archivo ${i + 1} de ${files.length}…` : 'Procesando datos…');
    const part = await readParquet(f.buffer, f.key.split('/').pop());
    for (const r of part) rows.push(r);
  }
  return rows;
}

/* ---------- Fuente: S3 (vía DATA_API_URL) ----------------------------------- */

/** Acepta { files: [...] } y el formato anterior { key, url, etag }. */
function parseApiInfo(info) {
  const files = Array.isArray(info && info.files) ? info.files : info && info.url ? [info] : [];
  const valid = files.filter((f) => f && typeof f.url === 'string' && f.url && typeof f.key === 'string');
  if (!valid.length || !info.etag) {
    throw new LoadError('El servicio de datos respondió sin archivos para descargar', { kind: 'data', stage: 'api' });
  }
  return {
    etag: String(info.etag),
    location: info.location || info.key || CFG.S3_DATA_URL,
    lastModified: info.last_modified || null,
    files: valid,
  };
}

/**
 * Descarga el dataset desde S3 y devuelve las filas crudas del Parquet.
 * @returns {Promise<{ rows: object[], meta: object }>}
 */
async function loadDataFromS3() {
  showLoading('Consultando la versión más reciente de los datos…');
  const cachePromise = readCache();

  let info = null;
  let failure = null;
  try {
    info = parseApiInfo(await (await fetchOk(CFG.DATA_API_URL, 'api')).json());
  } catch (e) {
    failure = e;
  }
  const cache = await cachePromise;

  let entry = null;
  if (info && cache && cache.etag === info.etag) {
    entry = cache;
  } else if (info) {
    try {
      let done = 0;
      showLoading(info.files.length > 1 ? `Descargando ${info.files.length} archivos desde S3…` : 'Descargando datos desde S3…');
      const files = await Promise.all(
        info.files.map(async (f) => {
          const buffer = await (await fetchOk(f.url, 's3')).arrayBuffer();
          if (info.files.length > 1) showLoading(`Descargando archivos desde S3… (${++done} de ${info.files.length})`);
          return { key: f.key, buffer };
        })
      );
      entry = { etag: info.etag, location: info.location, lastModified: info.lastModified, savedAt: new Date().toISOString(), files };
      await writeCache(entry);
    } catch (e) {
      failure = e;
    }
  }

  const stale = !entry;
  if (stale) {
    if (!cache) throw failure || new LoadError('No se pudo obtener el archivo de datos', { kind: 'network', stage: 'api' });
    console.warn('[data_loader] Se usa la última copia guardada:', failure);
    entry = cache;
  }

  const rows = await readAllParquet(entry.files);
  const name = String(entry.location || '').replace(/\/+$/, '').split('/').pop() || 'Parquet';
  return {
    rows,
    meta: {
      fuente: stale ? `S3 · ${name} (copia guardada)` : `S3 · ${name}`,
      origen: 's3',
      archivo: entry.location,
      archivos: entry.files.map((f) => f.key),
      etag: entry.etag,
      generado: entry.lastModified,
      guardado: entry.savedAt,
      desactualizado: stale,
      error_conexion: stale && failure ? failure.message : null,
    },
  };
}

/* ---------- Fuente: Parquet local (solo pruebas) --------------------------- */

async function loadFromLocalParquet(path) {
  // Solo rutas relativas del mismo sitio (p. ej. data/canales.parquet)
  const url = new URL(path, location.href);
  if (url.origin !== location.origin) {
    throw new LoadError('?archivo= solo admite rutas del mismo sitio', { kind: 'data', stage: 'local' });
  }
  showLoading(`Leyendo ${path}…`);
  const buffer = await (await fetchOk(url.href, 'local')).arrayBuffer();
  const rows = await readAllParquet([{ key: path, buffer }]);
  return {
    rows,
    meta: { fuente: `Parquet local · ${path.split('/').pop()}`, origen: 'parquet', archivo: path, generado: new Date().toISOString() },
  };
}

/* ---------- Validación y saneamiento ---------------------------------------- */

/** number | bigint | string ('101.7', '101,7', '1.234,5') → número finito o null. */
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // miles es-CO
  else if (/^-?\d+,\d+$/.test(s)) s = s.replace(',', '.'); // coma decimal
  const n = Number(s); // a diferencia de parseFloat, rechaza '12abc'
  return Number.isFinite(n) ? n : null;
}

const toInt = (v) => {
  const n = toNumber(v);
  return n === null ? null : Math.round(n);
};

function toText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

// 'sv-SE' produce 'YYYY-MM-DD HH:mm:ss'
const fmtTimestamp = new Intl.DateTimeFormat('sv-SE', {
  timeZone: CFG.TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Comprueba que 'YYYY-MM-DD' sea una fecha real (descarta 2026-02-31). */
function isRealDate(s) {
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Date | string | número (epoch-ms) → 'YYYY-MM-DD HH:mm:ss' o null. */
function toTimestamp(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'bigint') v = Number(v);
  if (typeof v === 'number') v = new Date(v);
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : fmtTimestamp.format(v);
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/.exec(String(v).trim());
  return m && isRealDate(m[1]) ? `${m[1]} ${m[2]}${m[3] || ':00'}` : null;
}

/** Date | string → 'YYYY-MM-DD' o null. Una columna DATE llega como medianoche UTC: se lee en UTC. */
function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  const m = /^\d{4}-\d{2}-\d{2}/.exec(String(v).trim());
  return m && isRealDate(m[0]) ? m[0] : null;
}

/** Nombres de columna: COLUMN_MAP primero; si no, minúsculas sin espacios. */
function columnName(col) {
  const map = CFG.COLUMN_MAP || {};
  return map[col] || map[col.toLowerCase()] || col.trim().toLowerCase();
}

/** Falla temprano y con detalle si al Parquet le faltan columnas obligatorias. */
function checkColumns(rows) {
  const cols = new Set();
  for (const r of rows.slice(0, 50)) if (r && typeof r === 'object') Object.keys(r).forEach((c) => cols.add(columnName(c)));
  const missing = REQUIRED_COLUMNS.filter((c) => !cols.has(c));
  if (!DATE_COLUMNS.some((c) => cols.has(c))) missing.push(DATE_COLUMNS.join(' o '));
  if (missing.length) {
    throw new LoadError(
      `Faltan columnas obligatorias: ${missing.join(', ')}. Columnas recibidas: ${[...cols].join(', ') || 'ninguna'}.`,
      { kind: 'data', stage: 'data' }
    );
  }
}

/**
 * Convierte las filas crudas al esquema del tablero. Nunca lanza por un
 * registro individual: los inválidos se descartan y se cuentan por motivo.
 */
function sanitizeRecords(rows) {
  const registros = [];
  const motivos = { registro_invalido: 0, sin_fecha: 0, peso_invalido: 0, magro_invalido: 0 };
  const completados = { planta: 0, granja: 0, pais: 0 };

  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      motivos.registro_invalido++;
      continue;
    }
    const r = {};
    for (const [col, value] of Object.entries(row)) r[columnName(col)] = typeof value === 'bigint' ? Number(value) : value;

    for (const f of FLOAT_FIELDS) if (f in r) r[f] = toNumber(r[f]);
    for (const f of INT_FIELDS) if (f in r) r[f] = toInt(r[f]);
    for (const f of TIMESTAMP_FIELDS) if (f in r) r[f] = toTimestamp(r[f]);
    for (const f of TEXT_FIELDS) {
      r[f] = toText(r[f]);
      if (r[f] === null && TEXT_DEFAULTS[f]) {
        r[f] = TEXT_DEFAULTS[f];
        completados[f]++;
      }
    }

    // app.js agrupa por `fecha` (YYYY-MM-DD): si no viene, se toma del ingreso a planta
    r.fecha = toDate(r.fecha) || (r.fecha_ingreso_planta ? r.fecha_ingreso_planta.slice(0, 10) : null);
    // % magro expresado como fracción (0,62) → porcentaje (62)
    if (r.porcentaje_magro !== null && r.porcentaje_magro > 0 && r.porcentaje_magro <= 1) r.porcentaje_magro *= 100;

    if (!r.fecha) {
      motivos.sin_fecha++;
      continue;
    }
    if (!(r.peso_kg > 0)) {
      motivos.peso_invalido++;
      continue;
    }
    if (!(r.porcentaje_magro > 0 && r.porcentaje_magro <= 100)) {
      motivos.magro_invalido++;
      continue;
    }

    if (!('grasa_dorsal_mm' in r)) r.grasa_dorsal_mm = null;
    if (!('puntaje_seurop' in r)) r.puntaje_seurop = null;
    if (!Number.isFinite(r.tiempo_espera_sacrificio_min) || !Number.isFinite(r.tiempo_espera_sacrificio_horas)) {
      window.DataUtils.aplicarTiempoEsperaSacrificio(r);
    }
    registros.push(r);
  }

  registros.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  registros.forEach((r, i) => {
    if (r.id == null) r.id = i + 1;
  });

  const descartados = Object.values(motivos).reduce((s, n) => s + n, 0);
  if (descartados) console.warn(`[data_loader] ${descartados} registros descartados por datos inválidos:`, motivos);
  if (completados.planta || completados.granja) console.warn('[data_loader] Registros sin planta/granja (se agrupan como "Sin …"):', completados);
  return { registros, descartados, motivos };
}

const uniques = (registros, field) =>
  [...new Set(registros.map((r) => r[field]).filter((v) => v != null && v !== ''))].sort((a, b) => String(a).localeCompare(String(b), 'es'));

function buildDataset(rows, metaExtra) {
  if (!Array.isArray(rows)) {
    throw new LoadError('El archivo no contiene una lista de registros', { kind: 'data', stage: 'data' });
  }
  if (!rows.length) {
    throw new LoadError('El archivo de datos está vacío (0 registros)', { kind: 'data', stage: 'data' });
  }
  checkColumns(rows);

  const { registros, descartados, motivos } = sanitizeRecords(rows);
  if (!registros.length) {
    throw new LoadError(`Ninguno de los ${rows.length} registros es válido (${JSON.stringify(motivos)})`, { kind: 'data', stage: 'data' });
  }

  const granjas = new Map();
  for (const r of registros) {
    const k = `${r.planta}|${r.granja}`;
    if (!granjas.has(k)) granjas.set(k, { nombre: r.granja, planta: r.planta });
  }
  return {
    meta: {
      tabla: 'canales',
      ...metaExtra,
      desde: registros[0].fecha,
      hasta: registros[registros.length - 1].fecha,
      total: registros.length,
      descartados,
      motivos_descarte: motivos,
    },
    catalogos: {
      plantas: uniques(registros, 'planta'),
      granjas: [...granjas.values()].sort((a, b) => a.nombre.localeCompare(b.nombre, 'es')),
      comercializadores: uniques(registros, 'comercializador'),
      sistemas_medicion: uniques(registros, 'sistema_medicion'),
    },
    registros,
    helpers: window.DataUtils,
  };
}

/* ---------- Mensajes de error para el usuario ------------------------------ */

const isLocalHost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

function describeError(e) {
  const origin = location.origin;
  const corsHint = `Revisa la política CORS del bucket S3: debe permitir GET desde ${origin} (ver PROJECT_CONTEXT.md → Configuración de AWS S3).`;
  const api = CFG.DATA_API_URL;

  if (!(e instanceof LoadError)) {
    return { title: 'Error inesperado al preparar el tablero', detail: e && e.message ? e.message : String(e), hints: ['Recarga la página. Si persiste, revisa la consola del navegador.'] };
  }

  if (e.stage === 'cdn') {
    return { title: 'No se pudo cargar una dependencia', detail: e.message, hints: ['Verifica la conexión a internet o si un firewall/proxy bloquea cdn.jsdelivr.net.'] };
  }

  if (e.stage === 'api') {
    if (e.kind === 'network' || e.kind === 'timeout') {
      return {
        title: 'Sin conexión con el servicio de datos',
        detail: `${e.message} al consultar ${api}.`,
        hints: [
          'Verifica tu conexión a internet.',
          isLocalHost
            ? 'En Live Server, DATA_API_URL (config.js) debe apuntar al despliegue de Vercel y la Function debe permitir este origen (CORS_ALLOWED_ORIGINS).'
            : 'Comprueba que la Vercel Function api/canales.js esté desplegada.',
        ],
      };
    }
    if (e.status === 404 && !e.apiMessage) {
      return {
        title: 'No se encontró el servicio de datos (404)',
        detail: `${api} no existe en este servidor.`,
        hints: isLocalHost
          ? ['Live Server no ejecuta /api: en config.js usa la URL absoluta del despliegue (https://<proyecto>.vercel.app/api/canales) o ejecuta `vercel dev`.']
          : ['Revisa que la carpeta api/ se haya desplegado en Vercel.'],
      };
    }
    if (e.status === 404) {
      return { title: 'No se encontró el Parquet en S3 (404)', detail: e.apiMessage, hints: [`Verifica que exista ${CFG.S3_DATA_URL} y que S3_DATA_URL en Vercel apunte a la misma ruta.`] };
    }
    if (e.status === 403 || /permiso/i.test(e.apiMessage || '')) {
      return {
        title: 'Acceso denegado a S3 (403)',
        detail: e.apiMessage || e.message,
        hints: ['El rol/usuario IAM de la Function necesita s3:ListBucket (sobre el prefijo) y s3:GetObject (sobre los archivos).', 'Si el bucket usa KMS, también kms:Decrypt.'],
      };
    }
    return { title: 'El servicio de datos respondió con un error', detail: e.message, hints: ['Revisa los logs de la Function en Vercel (Deployments → Functions).'] };
  }

  if (e.stage === 's3') {
    if (e.kind === 'network') {
      return {
        title: 'El navegador no pudo descargar el archivo de S3',
        detail: 'La petición a S3 fue bloqueada. La causa más común es CORS.',
        hints: [corsHint, 'Si usas VPN o proxy corporativo, verifica que permita *.s3.amazonaws.com.'],
      };
    }
    if (e.kind === 'timeout') {
      return { title: 'La descarga desde S3 tardó demasiado', detail: e.message, hints: ['Reintenta. Si el archivo es muy grande, aumenta REQUEST_TIMEOUT_MS en config.js.'] };
    }
    if (e.status === 403) {
      return {
        title: 'S3 rechazó la descarga (403 Forbidden)',
        detail: 'La URL firmada expiró o la identidad que la firmó no tiene s3:GetObject sobre el archivo.',
        hints: ['Pulsa "Reintentar conexión" para pedir una URL nueva.', 'Revisa la política IAM de la Function y, si aplica, kms:Decrypt.', corsHint],
      };
    }
    if (e.status === 404) {
      return { title: 'El archivo ya no existe en S3 (404)', detail: 'Probablemente se regeneró mientras se descargaba.', hints: ['Pulsa "Reintentar conexión".'] };
    }
    return { title: 'Error al descargar desde S3', detail: e.message, hints: [corsHint] };
  }

  if (e.stage === 'local') {
    return { title: 'No se pudo leer el Parquet local', detail: e.message, hints: ['Verifica la ruta indicada en ?archivo= (relativa a index.html).'] };
  }

  return {
    title: e.kind === 'parse' ? 'El archivo de datos no se pudo leer' : 'Los datos descargados no son válidos',
    detail: e.message,
    hints: ['Verifica el export de Aurora a S3.', 'Si las columnas tienen otros nombres, mapéalas en COLUMN_MAP (config.js).'],
  };
}

/* ---------- Arranque -------------------------------------------------------- */

let appLoaded = false;

async function boot() {
  ui.retry.disabled = true;
  ui.source.textContent = CFG.S3_DATA_URL || CFG.DATA_API_URL;
  try {
    const localFile = new URLSearchParams(location.search).get('archivo');
    const { rows, meta } = localFile ? await loadFromLocalParquet(localFile) : await loadDataFromS3();

    showLoading('Validando registros…');
    const dataset = buildDataset(rows, meta);
    window.DASHBOARD_DATA = dataset;
    console.info(`[data_loader] ${dataset.meta.total} registros válidos (${dataset.meta.descartados} descartados) · ${dataset.meta.fuente}`);

    if (!appLoaded) {
      showLoading('Construyendo el tablero…');
      await loadScript('app.js');
      appLoaded = true;
    }
    hideStatus();

    const notes = [];
    if (dataset.meta.desactualizado) {
      const when = dataset.meta.generado ? new Date(dataset.meta.generado).toLocaleString('es-CO', { dateStyle: 'medium', timeStyle: 'short' }) : 'fecha desconocida';
      notes.push(`Sin conexión con S3: se muestra la última copia guardada (${when}). Recarga para reintentar.`);
    }
    if (dataset.meta.descartados) {
      notes.push(`${dataset.meta.descartados.toLocaleString('es-CO')} registros se omitieron por datos incompletos o inválidos.`);
    }
    if (notes.length) showNotice(notes.join(' '));
  } catch (e) {
    console.error('[data_loader]', e);
    showError(describeError(e));
  }
}

ui.retry.addEventListener('click', boot);

if (!window.Auth) {
  showError({ title: 'Falta auth.js', detail: 'El módulo de acceso no se cargó.', hints: ['Revisa el orden de los <script> en index.html.'] });
} else {
  ui.status.hidden = true;
  await window.Auth.whenAuthenticated();
  boot();
}
