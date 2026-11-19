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

### Doble Parquet (principal + complementario)

La misma carpeta de S3 (`S3_DATA_URL`) contiene dos archivos, definidos en `config.js`:

| Archivo | Config | Contenido | Obligatorio |
|---|---|---|---|
| `alura_carcasses_cipa_in_house.parquet` | `MAIN_PARQUET` | Detalle canal por canal. | Sí: si falla, el tablero muestra el error. |
| `additional_data_cipa.parquet` | `ADDITIONAL_PARQUET` | Consolidado (fechas y pesos de proceso) que se anexa a cada canal. | No: ver tolerancia a fallos. |

La Function firma todos los archivos de datos de la carpeta sin distinguirlos; `data_loader.js` los separa por nombre (`splitFiles()`). Si ningún archivo se llama como `MAIN_PARQUET` (p. ej. partes de un UNLOAD de Athena), el principal son todos los que no sean el complementario.

Se descargan en paralelo (`Promise.all`) y se leen en paralelo con `parquetReadObjects` (hyparquet 1.31.5). **Tolerancia a fallos del complementario:** si no está en la carpeta, tarda más de `ADDITIONAL_TIMEOUT_MS` (15 s), falla la descarga o la lectura, o viene vacío, se registra un `console.warn` y los canales quedan con los campos adicionales en `null`; el principal nunca se bloquea. En ese caso la copia de IndexedDB se marca `incomplete` y no se da por vigente con ese ETag, de modo que la siguiente carga reintenta el complementario.

### Flujo de datos

```
Aurora PostgreSQL ──export──▶ S3 (carpeta con 2 Parquet, bucket privado)
                                   ▲            │
                       ListBucket/ │            │ GET con URL firmada (CORS)
                       HeadObject  │            ▼
 Navegador ──GET /api/canales──▶ Vercel Function ──▶ { etag, files:[{ key, url }] }
     │                                                     │
     └──────────── descarga cada url (en paralelo) ◀───────┘
           hyparquet → sanitizeRecords(principal) ──┐
           hyparquet → índices Map (complementario) ┴▶ joinAdditional() (LEFT JOIN)
                    → tiempo de espera → window.DASHBOARD_DATA → app.js
```

### Cruce condicional por planta (LEFT JOIN en memoria)

`joinAdditional()` (en `data_loader.js`) indexa el complementario en dos `Map` antes de recorrer los canales (búsqueda O(1), sin bucles anidados):

- `mapByFechaTurno`: llave `YYYY-MM-DD|turno`. Ignora filas con fecha o turno vacíos.
- `mapByLote`: llave `lote` en minúsculas y sin espacios. Ignora filas con lote vacío.

La planta del canal se compara con `trim().toLowerCase()`:

| Planta del canal | Índice | Llave tomada del canal |
|---|---|---|
| `Efege` | `mapByFechaTurno` | `fecha` + turno (**últimos 3 dígitos de `id_lote`**) |
| `Supercerdo Paisa S.A.S`, `Progresar` | `mapByLote` | lote (**`id_lote`**) |
| Cualquier otra (fallback) | `mapByLote` | lote (`id_lote`); sin lote no hay cruce |

**El principal no trae columnas `lote` ni `turno`**: ambos salen de `id_lote` (`loteDe()` y `turnoDe()` en `data_loader.js`; si algún día llegan columnas `lote`/`turno`, tienen prioridad). En Efege, `id_lote` es `DDMMAA` + `02` + turno de 3 dígitos (`16112602167` → 16/11/2026, turno 167; en registros antiguos es solo el turno, `"167"`), así que el turno son siempre los últimos 3 caracteres. Las demás plantas usan `id_lote` tal cual (`"55237"`).

Cobertura verificada con los Parquet de producción (19/11/2026): Progresar 88,0 %, Supercerdo Paisa 62,1 %, Efege 29,8 % global (88,8 % de los canales desde 2026-01-04, que es donde empieza el complementario). Las plantas que no están en el complementario (Ble, Cavasa, Frigoporcinos Bello, etc.) cruzan 0 %, y es lo esperado: sus campos adicionales quedan en `null`.

(Las dos últimas filas se comportan igual; solo `efege` está en el código como excepción, `PLANTAS_POR_FECHA_TURNO`.)

Normalización de llaves (hyparquet devuelve `Date`/string y `Number`/`BigInt`): `normalizeDate` → `YYYY-MM-DD` en UTC o `""`; `normalizeInt` → entero como texto (`"01"` y `1n` → `"1"`) o `""`; `normalizeText` → `trim().toLowerCase()` o `""`. Las columnas del complementario se buscan sin distinguir mayúsculas (`Fecha`/`fecha`, `Turno`/`turno`, `Lote`/`lote`, `Planta`/`planta`); en el principal se leen `planta`, `fecha` e `id_lote`.

Reglas del merge:

- Las llaves repetidas en el complementario se resuelven con el **primer** registro; la consola informa cuántas hubo.
- Las columnas de cruce del complementario (`fecha`, `turno`, `lote`, `planta`) **no** se anexan: nunca pisan las del principal.
- **No se sobrescribe nada del principal.** Un campo adicional solo se completa si el canal lo trae vacío (`null`/ausente). Por eso `fecha_ingreso_planta`, `fecha_pesaje_pie` y `fecha_sacrificio`, que el principal ya puede traer, conservan su valor.
- Sin coincidencia (o con llaves vacías), cada campo adicional queda en `null` explícito.
- Cualquier otra columna del complementario también se anexa, salvo que ya exista en el canal.
- Tras el cruce se calcula `tiempo_espera_sacrificio_*` para los canales que aún no lo tengan y cuyas dos fechas existan.
- Al terminar se imprime **un solo** `console.info` con: registros del principal y del complementario, llaves indexadas y duplicadas, si el complementario trae columna `planta` (las llaves se indexan de forma global, sin planta) y cruzados con su porcentaje, global y `por_planta` (`cruzados/total (%)`), más un diagnóstico de llaves: `columnas_principal`, `columnas_complementario`, `ejemplo_llaves_complementario` y `ejemplo_canales_sin_cruce` (llaves ya normalizadas, para compararlas a simple vista).

El navegador **no** puede leer una ruta `s3://` ni debe tener credenciales de AWS. La Function firma URLs de corta duración (5 min por defecto) y el navegador descarga el Parquet directamente desde S3. El resultado se guarda en IndexedDB y solo se vuelve a descargar cuando cambia el `ETag`; si S3 no responde, se muestra la última copia guardada con un aviso.

### Abstracción de la ruta S3

La ubicación del bucket solo existe en `config.js` (`S3_DATA_URL`, como referencia) y en la variable de entorno `S3_DATA_URL` de la Function. Ningún texto visible la muestra:

- El sidebar indica solo el estado de la fuente: **"Datos en línea"**, **"Copia guardada"** (sin conexión) o **"Archivo local de prueba"** (`?archivo=`).
- `/api/canales` no devuelve el bucket ni la ruta; sus mensajes de error tampoco. El detalle completo queda solo en los logs de Vercel.
- El estado de carga y los mensajes de error no citan rutas ni dominios de S3, y el loader no imprime la fuente en consola.

Límite: las URLs firmadas que descarga el navegador llevan el nombre del bucket y se ven en la pestaña **Network** de DevTools. Es inherente a descargar desde S3. Además, `config.js` es un archivo público del sitio.

### Estado de carga

Mientras se consulta la API, se descargan y se procesan los archivos, una capa centrada cubre el contenido (`[data-status="loading"]` en `index.html`): spinner `animate-spin` en `--color-primary` y el mensaje en `text-sm font-medium text-grey-strong`.

Los mensajes avanzan por etapas: "Cargando información del sistema..." → "Obteniendo datos..." (con "n de m" si hay varios archivos) → "Procesando datos..." → "Preparando el tablero...". Al terminar, la capa se desvanece en 300 ms (`hideStatus()` en `data_loader.js`) y cada vista entra con una animación suave (`@keyframes view-in`), desactivada con `prefers-reduced-motion`.

---

## 2. Estructura de archivos

| Archivo | Rol |
|---|---|
| `index.html` | Estructura de la SPA, tokens `@theme` (Tailwind v4) y componentes CSS, pantalla de ingreso, estados de carga/error y orden de los `<script>`. |
| `config.js` | `window.APP_CONFIG`: ubicación S3 (`S3_DATA_URL`), nombres de los Parquet (`MAIN_PARQUET`, `ADDITIONAL_PARQUET`), endpoint de la API (`DATA_API_URL`), tiempos límite (`REQUEST_TIMEOUT_MS`, `ADDITIONAL_TIMEOUT_MS`), zona horaria, país por defecto y `COLUMN_MAP`. |
| `auth_config.js` | `window.ALLOWED_EMAILS`: correos con acceso. |
| `auth.js` | Gatekeeper: muestra el login o la app, guarda la sesión (`auth_user`), pinta el correo en el sidebar y gestiona "Cerrar sesión". Expone `window.Auth`. |
| `data_utils.js` | `window.DataUtils`: cálculo del tiempo de espera ingreso → sacrificio (`calcularTiempoEsperaSacrificio`, `aplicarTiempoEsperaSacrificio`). |
| `seurop_quartiles.js` | Cuartiles Q25/Q75 por país y año para el IQ-Col (generado; no editar a mano). |
| `data_loader.js` | Módulo ES: espera la sesión, `loadDataFromS3()` (principal + complementario), caché IndexedDB, validación/saneamiento, cruce `joinAdditional()`, estados de carga y error, y carga de `app.js`. |
| `app.js` | Lógica de la SPA: tokens JS, dominio (SEUROP, IQ-Col), agregación, ECharts, filtros globales, vistas y router. |
| `api/canales.js` | Vercel Function (Node.js): resuelve el archivo o prefijo en S3 y devuelve URLs firmadas. |
| `package.json` | Dependencias de la Function (`@aws-sdk/*`, OIDC de Vercel). El front no necesita instalación. |
| `PROJECT_CONTEXT.md` | Este documento. |

**Orden de carga** (`index.html`): `config.js` → `auth_config.js` → `auth.js` → `data_utils.js` → `seurop_quartiles.js` → `data_loader.js` (módulo) → `app.js` (lo inyecta el loader cuando los datos están listos).

### Vistas

| Ruta | Contenido |
|---|---|
| `#inicio` | KPIs, distribución SEUROP, **Ranking por granja** (paginado de 10 en 10, con posición `#`, CV Peso y columnas fijas en móvil), Distribución SEUROP y evolución de variables físicas, ambas con **selector de Eje X** (tiempo / granja). |
| `#despacho` | Dispersión peso vs. % magro por clase SEUROP y detalle paginado de canales. |
| `#scores` | En construcción ("Próximamente"). La versión anterior está en el commit `7859625`. |

Los filtros del header (planta, granja, fechas y granularidad) viven en `App.filters`; cada vista se suscribe y se recalcula en tiempo real sobre los registros cargados desde S3.

### Header: filtros en dos líneas

La zona de filtros (`[data-shell="filters"]`, armada por `mountFilters()` en `app.js`) tiene dos filas, dentro del mismo contenedor con scroll horizontal (`.scroll-fade`) para pantallas angostas:

1. **Filtros de datos:** Planta, Granja, Rango de fechas (atajo + desde → hasta) y el botón de restablecer.
2. **Agrupación temporal:** la etiqueta *"Agrupar tiempo por:"* (`text-[0.72rem] font-semibold text-grey-mid`) seguida del control segmentado `Día · Semana · Mes · Trimestre · Año`. La etiqueta deja claro que esto solo cambia cómo se agrupan los gráficos en el tiempo; no filtra datos (cambiar la granularidad no vuelve a filtrar: `App.filters.set({ gran })` no incrementa `dataVersion`).

Desde 1440 px de ancho (`min-[1440px]:`) el título queda a la izquierda y el bloque de filtros a la derecha; por debajo, el título va arriba y los filtros debajo.

### Granjas únicas (identidad por nombre)

Una granja se identifica **solo por su nombre**. Si la misma granja entrega a tres plantas, es **una** granja y sus canales se consolidan. (Hasta la versión anterior se usaba la clave compuesta `Planta - Granja`; esa lógica se eliminó.)

- `data_loader.js` sigue armando `catalogos.granjas` con un par `{ nombre, planta }` por cada combinación. `app.js` lo usa solo para construir `plantasPorGranja` (nombre → plantas con registros).
- `App.data.granjas` es la lista de **nombres únicos**, ordenada alfabéticamente (`Intl.Collator('es')`). `App.data.granjasDePlantas(plantas)` devuelve las granjas únicas con registros en al menos una de esas plantas.
- `App.filters.state.granjas` guarda **nombres de granja**. `App.data.filter()` exige que el registro cumpla planta **y** granja, así que con plantas parciales una granja multiplanta solo aporta los canales de las plantas elegidas.
- El KPI "Granjas activas" muestra cuántas granjas únicas tienen canales en la selección, sobre el total (`de N granjas`).
- `App.data.aggregate()` agrupa `granjas` por nombre: una entrada por granja, con todas sus plantas consolidadas.

### Filtro de granjas (lista plana)

- `MultiSelect` muestra una lista **plana** de nombres únicos de granja, en orden alfabético, con búsqueda por nombre, "Seleccionar todo" y "Limpiar" (estas dos actúan sobre las opciones visibles).
- **Reactividad cruzada:** al cambiar el filtro de plantas, la lista se restringe a `granjasDePlantas(plantasSeleccionadas)` (`cascadeGranjas()` en el shell). Conserva las granjas que ya estaban marcadas y marca las que aparecen por primera vez.
- El resumen del disparador ("Todas (N)", "k de N") cuenta granjas únicas.

### Ranking por granja

- **Una fila por granja única** (consolida todas sus plantas). "Cat. SEUROP" es la clase predominante (moda) de la granja y CV Peso se calcula sobre todos sus canales.
- **10 granjas por página** (`RANKING_PAGE_SIZE` en `App.views.inicio`). La paginación inferior usa la variante `pagerStyle: 'simple'` de `DataTable`: "‹ Anterior", "Página X de Y", "Siguiente ›" y el rango "1–10 de N granjas", dentro de un contenedor `rounded-[20px] border border-line bg-surface`.
- **Columna `#`** (primera a la izquierda, no ordenable): la posición según el orden activo (por defecto, más canales primero). Continúa entre páginas: `((paginaActual − 1) × 10) + índice + 1`, así que la página 2 va de 11 a 20. `DataTable` pasa esa posición como segundo argumento de `render(row, pos)`.
- Al reordenar o cambiar un filtro, la tabla vuelve a la página 1 y la numeración se recalcula.
- **Columnas fijas (móvil):** la tabla vive en `.table-scroll` (scroll horizontal). Las columnas `#` (`sticky left-0`, ancho fijo `3.25rem`) y **Granja** (`sticky left-[calc(3.25rem_-_1px)]`, 1 px de solape para tapar la costura) quedan fijas al deslizar. Las celdas tienen `z-10` y los `<th>` `z-20 bg-surface`. El fondo es explícito: `bg-white` en filas impares y `bg-surface` en pares (la tabla usa `striped: true`, así que toda la fila alterna igual) y `group-hover:bg-row-hover` para acompañar el hover de la fila. La columna Granja lleva `border-r border-line` y trunca nombres largos (`max-w-[9.5rem]`, `sm:max-w-[16rem]`, nombre completo en `title`).
- **Ayuda en "IQ-Col promedio":** icono `info` (SVG de Lucide en línea) junto al encabezado. Con hover o foco muestra el globo *"Indicador de calidad de canal (detalle en próxima versión)."* El icono lleva `data-no-sort`: hacer clic sobre él no reordena la columna.

### Selector de Eje X (Distribución SEUROP y Variables físicas)

Cada tarjeta tiene en su cabecera un control segmentado `Por tiempo · Por granja` (`[data-axis="timeline"|"fisicas"]`). El estado vive en `App.views.inicio` (`state.axis`), es independiente por tarjeta y no toca `App.filters`. Cambiarlo redibuja solo esa tarjeta, reutilizando la última agregación (`lastAgg`).

- **Por tiempo:** categorías = periodos de la granularidad activa (comportamiento original; el `dataZoom` muestra los periodos más recientes).
- **Por granja:** categorías = `agg.granjasPorVolumen` (granjas filtradas, de mayor a menor número de canales). Las etiquetas se inclinan 35° y se truncan a 110 px. Si hay más granjas de las que caben (~56 px por barra según `chart.getWidth()`), se activa `dataZoom` (slider + rueda) **desde el inicio**, es decir, desde las granjas de mayor volumen (`App.charts.zoomFor(n, visibles, fromStart = true)`).
- En **Distribución SEUROP**, el título cambia a "Distribución SEUROP por granja" y la tabla sincronizada cambia su primera columna de `Periodo (…)` a `Granja`, con orden inicial por cantidad de canales (desc). Al volver a "Por tiempo", vuelve a `Periodo` en orden ascendente (`DataTable.setSort`). El hover de la tabla sigue resaltando la barra correspondiente (`idx`).
- En **Variables físicas**, por granja, % magro y grasa dorsal se dibujan como **puntos sin línea**: entre granjas no hay continuidad que una línea pueda sugerir.
- Los colores salen de `App.tokens` / paleta SEUROP. Los gráficos se reajustan con `ResizeObserver` → `chart.resize()` y en `onShow()` de la vista.

### Componentes reutilizables (`App.components`)

- `MultiSelect`: lista plana con búsqueda (sin agrupación).
- `DateRange`: atajo + desde → hasta.
- `DataTable`: orden, paginación y hover sincronizable. Por columna acepta `headClass` y `cellClass(row, i)` (clases extra, p. ej. columnas fijas); por tabla, `striped`. También tiene `setSort(key, dir)`.
- `Tooltip`: un único globo con posición fija en `<body>` para cualquier elemento con `[data-tip]` (hover o foco; `Esc` lo cierra). Al estar fuera de la tabla, `overflow` no lo recorta. Estilos `.info-tip` y `.tip-bubble` en `index.html`.

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
| `tiempo_espera_sacrificio_min` / `_horas` | entero / número | Si no vienen, se calculan tras el cruce con el complementario como `fecha_sacrificio − fecha_ingreso_planta`; `null` si falta alguna fecha. |
| `id_lote` | texto | Lote del canal; también codifica el turno en Efege. Solo se usa como llave del cruce (§1); no se transforma. |

### Columnas del complementario (`additional_data_cipa.parquet`)

Se anexan a cada canal con **el nombre que traen en el Parquet** (no se renombran al esquema anterior: `peso_canal_frio` ≠ `peso_canal_fria_kg`, `fecha_peso_canal_caliente` ≠ `fecha_canal_caliente`). Llaves de cruce del complementario: `Fecha` (solo fecha), `Turno` (INT) y `Lote` (TEXT); no se anexan.

| Campo | Tipo | Sin coincidencia / valor inválido |
|---|---|---|
| `fecha_ingreso_planta`, `fecha_pesaje_pie`, `fecha_sacrificio` | `TIMESTAMP` → `'YYYY-MM-DD HH:mm:ss'` | `null`. Si el principal ya trae el valor, se conserva el del principal. |
| `fecha_peso_canal_caliente`, `fecha_peso_canal_frio` | `TIMESTAMP` → `'YYYY-MM-DD HH:mm:ss'` | `null` |
| `peso_canal_caliente`, `peso_canal_frio`, `peso_pie` | número | `null` |
| `peso_pie_prom` | número (FLOAT) | `null` |
| _(planta)_ | El complementario **no** trae columna de planta: las llaves se indexan de forma global. | — |

**Ojo: son totales por lote (o por turno en Efege), no por canal.** Cada canal recibe el mismo valor de su lote (p. ej. `peso_canal_caliente = 6614,3` kg en los miles de canales de un lote de Progresar); sumarlos por canal multiplicaría el peso. Úsalos como atributo del lote o toma un valor por lote antes de agregar.

Ninguno es obligatorio y ninguna vista los usa todavía; solo `fecha_ingreso_planta` y `fecha_sacrificio` alimentan `tiempo_espera_sacrificio_*`, que se calcula **después** del cruce (ver §1).

### Reglas de saneamiento (`data_loader.js → sanitizeRecords`)

- La respuesta debe ser un arreglo con al menos un registro; si faltan columnas obligatorias se muestra cuáles faltan y cuáles llegaron.
- Números: acepta `number`, `bigint` y texto (`"101.7"`, `"101,7"`, `"1.234,5"`); cualquier otro valor queda en `null`. Se usa `Number()` en lugar de `parseFloat` para no aceptar `"12abc"`.
- Un registro malo nunca detiene la carga: se descarta, se cuenta por motivo (`sin_fecha`, `peso_invalido`, `magro_invalido`, `registro_invalido`) y se informa en consola y en un aviso del tablero.

### Campos derivados en `app.js`

`iq_col`, `clasificacion_seurop`, `_iq`, `_seu` y las claves de periodo `_dia`, `_semana`, `_mes`, `_trimestre`, `_anio`. La granja se identifica directamente por `granja` (nombre único); ya no existe la clave compuesta `_gk`.

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

En el ranking, "Cat. SEUROP" es la clase predominante (moda) de la granja (todas sus plantas).

### CV Peso (%) — Ranking por granja

Se calcula por granja única, sobre todos sus canales en las plantas filtradas.

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

Si `S3_DATA_URL` es un prefijo (carpeta), la Function lista los archivos de datos (ignora `_SUCCESS`, `.metadata`, `.csv`, etc.) y el navegador separa el complementario (`additional_data_cipa.parquet`) y concatena el resto como principal. **El complementario debe vivir en esa misma carpeta**; si lo subes a otra, mueve ambos o cambia `S3_DATA_URL` (config.js y Vercel) y la política IAM (§5.2). Un UNLOAD de Athena exige un prefijo vacío, así que la carpeta contiene una sola versión del dataset.

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
| "No se encontraron los datos (404)" | La ubicación de `S3_DATA_URL` no tiene archivos de datos; el log de Vercel indica la ruta consultada. |
| "Faltan columnas obligatorias" | El export cambió de nombres: usa `COLUMN_MAP`. |
| Consola: "…complementario… quedarán en null" (`console.warn`) | El complementario no está en la carpeta, falló/tardó la descarga, no se pudo leer o está vacío. El tablero carga igual. |
| Consola: `cruzados_pct` bajo | Llaves que no coinciden: revisa `id_lote`, `fecha` y el nombre de la planta; las plantas que no están en el complementario siempre dan 0 %. `llaves_duplicadas` > 0 indica llaves repetidas en el complementario (hoy son filas idénticas; se usa la primera). |

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

**Sin acceso a S3:** copia un snapshot a `data/` (ignorado por git) y abre `http://127.0.0.1:5500/index.html?archivo=data/canales.parquet`. Pasa por la misma validación que los datos de S3. Para probar también el cruce, añade el complementario: `…/index.html?archivo=data/canales.parquet&complemento=data/additional_data_cipa.parquet`.

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
