/* ==========================================================================
 * config.js — Configuración central del origen de datos
 * --------------------------------------------------------------------------
 * El navegador no puede leer una ruta s3:// ni debe recibir credenciales de
 * AWS. Por eso el flujo es:
 *
 *   navegador ──GET──▶ DATA_API_URL (Vercel Function api/canales.js)
 *             ◀────── { etag, files: [{ key, url firmada }] }
 *   navegador ──GET──▶ URL firmada de S3 (requiere CORS en el bucket)
 *
 * S3_DATA_URL documenta la ubicación del Parquet y se muestra en los mensajes
 * de error. La Function lee la MISMA ruta desde su variable de entorno
 * S3_DATA_URL en Vercel: si cambias la ubicación, actualiza ambas.
 * ========================================================================== */
window.APP_CONFIG = Object.freeze({
  /** Ubicación del Parquet: un archivo .parquet o un prefijo (carpeta) con uno o varios archivos. */
  S3_DATA_URL: 's3://aws-athena-query-results-234988943857-us-east-1/alura_carcasses_cipa_in_house/Parquet',

  /**
   * Endpoint que entrega las URLs firmadas.
   *  - En Vercel (y con `vercel dev`): '/api/canales'.
   *  - Con VS Code Live Server u otro servidor estático: la URL absoluta del
   *    despliegue, p. ej. 'https://<tu-proyecto>.vercel.app/api/canales'.
   */
  DATA_API_URL: '/api/canales',

  /** Tiempo máximo por petición antes de mostrar el error de conexión. */
  REQUEST_TIMEOUT_MS: 30000,

  /**
   * Zona horaria con la que se convierten los TIMESTAMP del Parquet a texto.
   *  - 'UTC': el Parquet guarda hora local "naive" (lo usual en un export de Aurora/Athena).
   *  - 'America/Bogota': el Parquet guarda instantes reales en UTC.
   */
  TIMEZONE: 'UTC',

  /** País por defecto cuando el registro no lo trae (define los cuartiles del IQ-Col). */
  DEFAULT_COUNTRY: 'Colombia',

  /** Renombrado de columnas del Parquet → esquema del tablero. Ej.: { peso_canal: 'peso_kg' } */
  COLUMN_MAP: {
    'pesocanal': 'peso_kg',
    'grasadorsalmm': 'grasa_dorsal_mm',
    'magropor' : 'porcentaje_magro',
    'iq_seurop_puntos' : 'puntaje_seurop',
    'sistemademedicion' : 'sistema_medicion',
    'pesoenpie' : 'peso_en_pie',
    'clasepesocanal' : 'clase_peso_canal',
    'clasificacion_seurop' : 'clasificacion_seurop_origen'   
  },
});
