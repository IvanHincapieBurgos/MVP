# Tablero a la medida · Pigbox (Calidad de canales)

Contexto técnico del proyecto: qué hace, de dónde salen los datos, cómo se calculan las métricas y cómo ejecutarlo y desplegarlo.

---

## 1. Descripción general

**Tablero a la medida** es una SPA estática (HTML + JavaScript + Tailwind v4 por CDN) para monitorear el rendimiento de canales porcinas: peso, % magro, grasa dorsal, IQ-Col y clasificación SEUROP por planta, granja y periodo.

- **Hosting:** Vercel (sitio estático + una Vercel Function en `api/`).
- **Origen de los datos:** la tabla `canales` de **AWS Aurora PostgreSQL**, exportada como **Parquet** a S3 (UNLOAD/CTAS de Athena):

  ```
  s3://aws-athena-query-results-234988943857-us-east-1/alura_carcasses_cipa_in_house/Parquet
  ```

- **Acceso:** lista blanca de correos (`auth_config.js`), ver [§6](#6-autenticación-por-lista-blanca).

### Flujo de datos

```
Aurora PostgreSQL ──export──▶ S3 (Parquet, bucket privado)
                                   ▲            │
                       ListBucket/ │            │ GET con URL firmada (CORS)
                       HeadObject  │            ▼
 Navegador ──GET /api/canales──▶ Vercel Function ──▶ { etag, files:[{ key, url }] }
     │                                                     │
     └──────────── descarga cada url ◀─────────────────────┘
           hyparquet → sanitizeRecords() → window.DASHBOARD_DATA → app.js
```

El navegador **no** puede leer una ruta `s3://` ni debe tener credenciales de AWS. La Function firma URLs de corta duración (5 min por defecto) y el navegador descarga el Parquet directamente desde S3. El resultado se guarda en IndexedDB y solo se vuelve a descargar cuando cambia el `ETag`; si S3 no responde, se muestra la última copia guardada con un aviso.

---

## 2. Estructura de archivos

| Archivo | Rol |
|---|---|
| `index.html` | Estructura de la SPA, tokens `@theme` (Tailwind v4) y componentes CSS, pantalla de ingreso, estados de carga/error y orden de los `<script>`. |
| `config.js` | `window.APP_CONFIG`: ubicación S3 (`S3_DATA_URL`), endpoint de la API (`DATA_API_URL`), tiempo límite, zona horaria, país por defecto y `COLUMN_MAP`. |
| `auth_config.js` | `window.ALLOWED_EMAILS`: correos con acceso. |
| `auth.js` | Gatekeeper: muestra el login o la app, guarda la sesión (`auth_user`), pinta el correo en el sidebar y gestiona "Cerrar sesión". Expone `window.Auth`. |
| `data_utils.js` | Helpers de fechas compartidos (`parsearTimestamp`, `calcularTiempoEsperaSacrificio`…). |
| `seurop_quartiles.js` | Cuartiles Q25/Q75 por país y año para el IQ-Col (generado; no editar a mano). |
| `data_loader.js` | Módulo ES: espera la sesión, `loadDataFromS3()`, caché IndexedDB, validación/saneamiento y carga de `app.js`. |
| `app.js` | Lógica de la SPA: tokens JS, dominio (SEUROP, IQ-Col), agregación, ECharts, filtros globales, vistas y router. |
| `api/canales.js` | Vercel Function (Node.js): resuelve el archivo o prefijo en S3 y devuelve URLs firmadas. |
| `package.json` | Dependencias de la Function (`@aws-sdk/*`, OIDC de Vercel). El front no necesita instalación. |
| `PROJECT_CONTEXT.md` | Este documento. |

**Orden de carga** (`index.html`): `config.js` → `auth_config.js` → `auth.js` → `data_utils.js` → `seurop_quartiles.js` → `data_loader.js` (módulo) → `app.js` (lo inyecta el loader cuando los datos están listos).

### Vistas

| Ruta | Contenido |
|---|---|
| `#inicio` | KPIs, distribución SEUROP, **Ranking por granja** (incluye CV Peso), SEUROP en el tiempo y evolución de variables físicas. |
| `#despacho` | Dispersión peso vs. % magro por clase SEUROP y detalle paginado de canales. |
| `#scores` | En construcción ("Próximamente"). La versión anterior está en el commit `7859625`. |

Los filtros del header (fechas, planta, granja, granularidad) viven en `App.filters`; cada vista se suscribe y se recalcula en tiempo real sobre los registros cargados desde S3.

---

## 3. Diccionario de datos

Cada fila del Parquet (una canal) se convierte en un objeto. Los nombres de columna se pasan a minúsculas; si el export usa otros nombres, mapéalos en `APP_CONFIG.COLUMN_MAP` (p. ej. `{ peso_canal: 'peso_kg' }`).

### Obligatorios (si faltan o son inválidos, el registro se descarta)

| Campo | Tipo | Regla |
|---|---|---|
| `fecha` | `DATE` / `'YYYY-MM-DD'` | Fecha de la canal. Si no viene, se toma de `fecha_ingreso_planta`. Debe ser una fecha real. |
| `peso_kg` | número | Peso del canal en kg. Debe ser `> 0`. |
| `porcentaje_magro` | número | % magro. Debe estar en `(0, 100]`. Si viene como fracción (`0,62`) se convierte a `62`. |

### Dimensiones (si faltan se agrupan con una etiqueta)

| Campo | Tipo | Nulo → |
|---|---|---|
| `planta` | texto | `"Sin planta"` |
| `granja` | texto | `"Sin granja"` |
| `pais` | texto | `APP_CONFIG.DEFAULT_COUNTRY` (`"Colombia"`); define los cuartiles del IQ-Col |

### Opcionales (nulo permitido)

| Campo | Tipo | Manejo de nulos |
|---|---|---|
| `id` | entero | Si falta, se asigna un consecutivo tras ordenar por fecha. |
| `grasa_dorsal_mm` | número | Se excluye del promedio de grasa (no cuenta en n). |
| `puntaje_seurop` | número 0–1 | Informativo; la clase SEUROP se calcula con el IQ-Col. |
| `comercializador`, `sistema_medicion` | texto | `null` |
| `color`, `variacion_color` | entero | `null` |
| `peso_canal_caliente_kg`, `peso_canal_fria_kg` | número | `null` |
| `fecha_ingreso_planta`, `fecha_pesaje_pie`, `fecha_sacrificio`, `fecha_canal_caliente`, `fecha_canal_fria` | `TIMESTAMP` → `'YYYY-MM-DD HH:mm:ss'` | `null`. La zona de conversión es `APP_CONFIG.TIMEZONE`. |
| `tiempo_espera_sacrificio_min` / `_horas` | entero / número | Si no vienen, se calculan como `fecha_sacrificio − fecha_ingreso_planta`; `null` si falta alguna fecha. |

### Reglas de saneamiento (`data_loader.js → sanitizeRecords`)

- La respuesta debe ser un arreglo con al menos un registro; si faltan columnas obligatorias se muestra cuáles faltan y cuáles llegaron.
- Números: acepta `number`, `bigint` y texto (`"101.7"`, `"101,7"`, `"1.234,5"`); cualquier otro valor queda en `null`. Se usa `Number()` en lugar de `parseFloat` para no aceptar `"12abc"`.
- Un registro malo nunca detiene la carga: se descarta, se cuenta por motivo (`sin_fecha`, `peso_invalido`, `magro_invalido`, `registro_invalido`) y se informa en consola y en un aviso del tablero.

### Campos derivados en `app.js`

`iq_col`, `clasificacion_seurop`, `_iq`, `_seu` y las claves de periodo `_dia`, `_semana`, `_mes`, `_trimestre`, `_anio`.

---

## 4. Métricas y fórmulas

### IQ-Col

Con los cuartiles del país y año de la canal (`seurop_quartiles.js`; si el año no existe se usa el anterior más reciente):

```
peso_norm  = (peso_kg − Q25_peso) / (Q75_peso − Q25_peso)
magro_norm = (magro − Q25_magro[rango_peso]) / (Q75_magro[rango_peso] − Q25_magro[rango_peso])   # magro en fracción 0–1
IQ-Col     = peso_norm × 50 + magro_norm × 50
```

Rangos de peso: `bajo` (< 60), `a.60<=70kg`, `b.>70<=80kg`, `c.>80<=90kg`, `d.>90<=100kg`, `e.>100<=110kg`, `f.>110<=120kg`, `Alto` (> 120).

### Clasificación SEUROP (derivada del IQ-Col)

| Clase | IQ-Col |
|---|---|
| S · Superior | ≥ 100 |
| E · Excelente | 87,29 – < 100 |
| U · Muy bueno | 57,78 – < 87,29 |
| R · Bueno | 43,44 – < 57,78 |
| O · Menos bueno | 13,32 – < 43,44 |
| P · Baja | < 13,32 |

En el ranking, "Cat. SEUROP" es la clase predominante (moda) de la granja.

### CV Peso (%) — Ranking por granja

```
CV = Stdev(peso_kg) / Avg(peso_kg) × 100
```

- Desviación estándar **muestral** (n − 1), calculada en una sola pasada con Σx y Σx².
- Con 1 canal la desviación no está definida: se muestra `—`. Si todos los pesos son iguales: `0,00%`.
- Formato es-CO con 2 decimales (`3,45%`). Un CV bajo indica lotes más homogéneos.

### Otros promedios

Peso, % magro, grasa dorsal e IQ-Col promedio son medias aritméticas sobre los registros filtrados; los nulos de grasa dorsal no cuentan.

---

## 5. Configuración de AWS S3 y Vercel

### 5.1 Variables de entorno de la Function (Vercel → Settings → Environment Variables)

| Variable | Valor |
|---|---|
| `S3_DATA_URL` | `s3://aws-athena-query-results-234988943857-us-east-1/alura_carcasses_cipa_in_house/Parquet` (la misma de `config.js`) |
| `S3_REGION` | `us-east-1` |
| `AWS_ROLE_ARN` | Recomendado: rol IAM con confianza en el OIDC de Vercel (sin llaves fijas). Alternativa: `S3_ACCESS_KEY_ID` + `S3_SECRET_ACCESS_KEY`. |
| `URL_EXPIRA_SEGUNDOS` | Opcional, por defecto `300`. |
| `CORS_ALLOWED_ORIGINS` | Opcional: orígenes extra que pueden llamar a `/api/canales` (separados por coma). `http://localhost:*` y `http://127.0.0.1:*` siempre se permiten. |

Si `S3_DATA_URL` es un prefijo (carpeta), la Function lista los archivos de datos (ignora `_SUCCESS`, `.metadata`, `.csv`, etc.) y el navegador concatena todos. Un UNLOAD de Athena exige un prefijo vacío, así que la carpeta contiene una sola versión del dataset.

### 5.2 Política IAM mínima del rol de la Function

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::aws-athena-query-results-234988943857-us-east-1/alura_carcasses_cipa_in_house/Parquet/*"
    },
    {
      "Effect": "Allow",
      "Action": "s3:ListBucket",
      "Resource": "arn:aws:s3:::aws-athena-query-results-234988943857-us-east-1",
      "Condition": { "StringLike": { "s3:prefix": "alura_carcasses_cipa_in_house/Parquet*" } }
    }
  ]
}
```

Si el bucket cifra con KMS, añade `kms:Decrypt` sobre la llave. **No hagas público el bucket**: es el bucket de resultados de Athena de la cuenta y puede contener otras consultas.

### 5.3 Política CORS del bucket (obligatoria)

El navegador descarga el Parquet directamente desde S3 con la URL firmada, así que el bucket debe permitir `GET` desde los orígenes del tablero. En la consola: **S3 → bucket → Permissions → Cross-origin resource sharing (CORS) → Edit**:

```json
[
  {
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedOrigins": [
      "http://localhost:*",
      "http://127.0.0.1:*",
      "https://<tu-proyecto>.vercel.app",
      "https://<dominio-final>"
    ],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag", "Content-Length", "Last-Modified"],
    "MaxAgeSeconds": 3600
  }
]
```

S3 acepta un comodín `*` en `AllowedOrigins`, por eso `http://localhost:*` cubre cualquier puerto (Live Server usa el 5500 por defecto). Con la CLI:

```bash
aws s3api put-bucket-cors --bucket aws-athena-query-results-234988943857-us-east-1 --cors-configuration file://cors.json
```

(`cors.json` con el objeto `{ "CORSRules": [ …la regla de arriba… ] }`.)

### 5.4 Diagnóstico de errores en el tablero

| Mensaje | Causa probable |
|---|---|
| "El navegador no pudo descargar el archivo de S3" | Falta la regla CORS del bucket para este origen, o una VPN/proxy bloquea S3. |
| "S3 rechazó la descarga (403)" | URL firmada vencida (reintentar), falta `s3:GetObject` o `kms:Decrypt`. |
| "Acceso denegado a S3 (403)" | El rol de la Function no tiene `s3:ListBucket`/`s3:GetObject`. |
| "No se encontró el servicio de datos (404)" | Live Server no ejecuta `/api`: ajusta `DATA_API_URL` (ver §7). |
| "Faltan columnas obligatorias" | El export cambió de nombres: usa `COLUMN_MAP`. |

---

## 6. Autenticación por lista blanca

- `auth_config.js` define `window.ALLOWED_EMAILS`. La comparación normaliza con `trim()` + `toLowerCase()`.
- Sin sesión, la app se oculta y aparece "Acceso a Tablero a la medida". Con un correo válido, se guarda `auth_user` en `sessionStorage` (o en `localStorage` si se marca "Mantener la sesión en este equipo").
- En cada carga la sesión se revalida contra la lista: **quitar un correo revoca el acceso en la siguiente recarga**.
- "Cerrar sesión" (sidebar, y header en pantallas pequeñas) borra la sesión y recarga.
- Los datos no se descargan hasta que hay sesión.

### Alcance de la autenticación

Es un **control de interfaz, no de seguridad**: no hay verificación del correo (no se envía código ni contraseña), `auth_config.js` es público y `/api/canales` responde a cualquiera que lo llame. Sirve para evitar accesos casuales. Para proteger los datos de verdad, combínalo con una de estas opciones:

1. **Vercel Deployment Protection** (Password Protection o Vercel Authentication) sobre todo el sitio, incluida la API.
2. Un proveedor de identidad (Amazon Cognito, Microsoft Entra ID, Google Workspace) y validar el token en `api/canales.js` antes de firmar URLs.

---

## 7. Ejecución local

### Opción A — VS Code Live Server (solo front)

1. Instala la extensión **Live Server** y abre la carpeta del proyecto en VS Code.
2. Live Server no ejecuta la carpeta `api/`. En `config.js`, apunta `DATA_API_URL` al despliegue:
   ```js
   DATA_API_URL: 'https://<tu-proyecto>.vercel.app/api/canales',
   ```
   (La Function ya permite `http://localhost:*` y `http://127.0.0.1:*` por CORS.) No subas este cambio: en Vercel debe quedar `'/api/canales'`.
3. Verifica que la regla CORS del bucket incluya `http://localhost:*` / `http://127.0.0.1:*` (§5.3).
4. Clic derecho en `index.html` → **Open with Live Server** (`http://127.0.0.1:5500`).
5. Ingresa con un correo de `auth_config.js`.

**Sin acceso a S3:** copia un snapshot a `data/` (ignorado por git) y abre `http://127.0.0.1:5500/index.html?archivo=data/canales.parquet`. Pasa por la misma validación que los datos de S3.

### Opción B — Vercel CLI (front + API)

```bash
npm install
```

```bash
vercel env pull .env.local
```

```bash
vercel dev
```

Abre `http://localhost:3000`. Aquí `DATA_API_URL: '/api/canales'` funciona tal cual.

### Gestionar la lista de correos

1. Edita `auth_config.js` y agrega o quita correos del arreglo (las mayúsculas no importan).
2. Haz commit y despliega. Los usuarios retirados pierden el acceso en su siguiente recarga.

### Forzar una recarga completa de los datos

La caché vive en IndexedDB (`tablero-canales` → `archivos`). Se invalida sola cuando cambia el ETag en S3; para borrarla a mano: DevTools → Application → IndexedDB → eliminar `tablero-canales`.
