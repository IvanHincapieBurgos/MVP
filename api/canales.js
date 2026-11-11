/* ==========================================================================
 * api/canales.js — Vercel Function (Node.js)
 * --------------------------------------------------------------------------
 * GET /api/canales → {
 *   etag, last_modified, size,
 *   files: [{ key, etag, size, last_modified, url }]
 * }
 *
 * La respuesta y los mensajes de error no incluyen el bucket ni la ruta
 * configurada (solo las URLs firmadas, que S3 necesita para servir el archivo).
 *
 * Resuelve la ubicación del Parquet en S3 y devuelve URLs firmadas de corta
 * duración para descargarlo. El bucket sigue privado: el navegador nunca
 * recibe credenciales de AWS. El front usa `etag` para saber si su copia
 * guardada sigue vigente.
 *
 * La ubicación puede ser:
 *   - un archivo:  s3://bucket/ruta/canales.parquet
 *   - un prefijo:  s3://bucket/ruta/Parquet   (carpeta de un UNLOAD/CTAS de
 *                  Athena con uno o varios archivos; se devuelven todos)
 *
 * Variables de entorno (Vercel → Settings → Environment Variables):
 *   S3_DATA_URL            s3://bucket/ruta (recomendada; igual a config.js)
 *   S3_BUCKET + S3_KEY     Alternativa a S3_DATA_URL (S3_KEY puede ser archivo o prefijo)
 *   S3_REGION              Región del bucket (por defecto us-east-1)
 *   Credenciales (una de las dos opciones):
 *   AWS_ROLE_ARN           Recomendado: rol IAM asumido vía OIDC de Vercel (sin llaves fijas)
 *   S3_ACCESS_KEY_ID /
 *   S3_SECRET_ACCESS_KEY   Llaves de un usuario IAM (Vercel reserva AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY)
 *   URL_EXPIRA_SEGUNDOS    Vigencia de las URLs firmadas (por defecto 300)
 *   CORS_ALLOWED_ORIGINS   Orígenes extra que pueden llamar a esta API, separados por coma.
 *                          http://localhost:* y http://127.0.0.1:* siempre se permiten (Live Server).
 *
 * Permisos IAM mínimos:
 *   s3:GetObject  sobre arn:aws:s3:::<bucket>/<ruta>*
 *   s3:ListBucket sobre arn:aws:s3:::<bucket> (condición s3:prefix = <ruta>*) — solo para prefijos
 * ========================================================================== */
import { createHash } from 'node:crypto';
import { S3Client, HeadObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { awsCredentialsProvider } from '@vercel/oidc-aws-credentials-provider';

const {
  S3_DATA_URL,
  S3_BUCKET,
  S3_KEY,
  S3_REGION = 'us-east-1',
  AWS_ROLE_ARN,
  S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY,
  URL_EXPIRA_SEGUNDOS = '300',
  CORS_ALLOWED_ORIGINS = '',
} = process.env;

const MAX_ARCHIVOS = 200;
/** Archivos auxiliares que Athena/Spark dejan junto a los datos. */
const NO_DATOS = /(^|\/)(_|\.)[^/]*$|\.(metadata|manifest|csv|txt|json|crc)$/i;

/** 's3://bucket/ruta' o S3_BUCKET + S3_KEY → { bucket, path }. */
function ubicacion() {
  if (S3_DATA_URL) {
    const m = /^s3:\/\/([^/]+)\/?(.*)$/.exec(S3_DATA_URL.trim());
    if (!m) return null;
    return { bucket: m[1], path: m[2] };
  }
  if (S3_BUCKET && S3_KEY) return { bucket: S3_BUCKET, path: S3_KEY };
  return null;
}

function credenciales() {
  if (AWS_ROLE_ARN) return awsCredentialsProvider({ roleArn: AWS_ROLE_ARN });
  if (S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY) {
    return { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY };
  }
  return undefined; // cadena por defecto del SDK
}

const s3 = new S3Client({ region: S3_REGION, credentials: credenciales() });

/* ---------- CORS (para llamar la API desde Live Server u otro dominio) ---- */

const ORIGENES_EXTRA = new Set(
  CORS_ALLOWED_ORIGINS.split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean)
);
const ORIGEN_LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function aplicarCors(req, res) {
  const origin = req.headers.origin;
  if (origin && (ORIGEN_LOCAL.test(origin) || ORIGENES_EXTRA.has(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Vary', 'Origin');
  }
}

/* ---------- S3 ------------------------------------------------------------- */

/** Lista los archivos de datos bajo un prefijo (sin carpetas ni auxiliares). */
async function listarPrefijo(bucket, path) {
  const prefix = path && !path.endsWith('/') ? `${path}/` : path;
  const archivos = [];
  let token;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    for (const o of r.Contents || []) {
      if (!o.Size || o.Key.endsWith('/') || NO_DATOS.test(o.Key)) continue;
      archivos.push({ key: o.Key, etag: o.ETag, size: o.Size, last_modified: o.LastModified });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token && archivos.length < MAX_ARCHIVOS);
  return archivos.sort((a, b) => a.key.localeCompare(b.key));
}

async function resolverArchivos({ bucket, path }) {
  // 1) ¿Es un archivo? (HeadObject). 2) Si no, se trata como prefijo.
  if (path && !path.endsWith('/')) {
    try {
      const h = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: path }));
      return [{ key: path, etag: h.ETag, size: h.ContentLength ?? null, last_modified: h.LastModified }];
    } catch (e) {
      const status = e?.$metadata?.httpStatusCode;
      // 404 (o 403 sin ListBucket) en un "directorio": se intenta como prefijo
      if (status !== 404 && status !== 403) throw e;
    }
  }
  return listarPrefijo(bucket, path);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  aplicarCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET, OPTIONS');
    return res.status(405).json({ error: 'Método no permitido' });
  }

  const loc = ubicacion();
  if (!loc) {
    return res.status(500).json({ error: 'Falta S3_DATA_URL (o S3_BUCKET + S3_KEY) en las variables de entorno' });
  }

  try {
    const archivos = await resolverArchivos(loc);
    if (!archivos.length) {
      console.error(`[api/canales] Sin archivos de datos en s3://${loc.bucket}/${loc.path}`);
      return res.status(404).json({ error: 'No hay archivos de datos en la ubicación configurada' });
    }
    if (archivos.length > MAX_ARCHIVOS) archivos.length = MAX_ARCHIVOS;

    const expiresIn = Number(URL_EXPIRA_SEGUNDOS) || 300;
    const files = await Promise.all(
      archivos.map(async (a) => ({
        key: a.key,
        etag: a.etag,
        size: a.size,
        last_modified: a.last_modified ? new Date(a.last_modified).toISOString() : null,
        url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: loc.bucket, Key: a.key }), { expiresIn }),
      }))
    );

    // ETag del conjunto: cambia si cambia cualquier archivo (o la lista de archivos)
    const etag =
      files.length === 1
        ? files[0].etag
        : `"${createHash('sha1').update(files.map((f) => `${f.key}:${f.etag}`).join('|')).digest('hex')}"`;
    const fechas = files.map((f) => f.last_modified).filter(Boolean).sort();

    return res.status(200).json({
      etag,
      last_modified: fechas.length ? fechas[fechas.length - 1] : null,
      size: files.reduce((s, f) => s + (f.size || 0), 0),
      files,
    });
  } catch (e) {
    const status = e?.$metadata?.httpStatusCode;
    console.error('[api/canales]', e);
    if (status === 404) return res.status(404).json({ error: 'El archivo o el bucket no existe en S3' });
    if (status === 403) return res.status(403).json({ error: 'Sin permiso para leer el archivo en S3 (revisa la política IAM)' });
    return res.status(502).json({ error: 'No se pudo consultar S3' });
  }
}
