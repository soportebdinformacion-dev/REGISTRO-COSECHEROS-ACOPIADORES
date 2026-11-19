# REPORTE DE COSECHADORES – Registro para Acopiadores(as)
PWA offline-first + Google Apps Script + Google Sheets · Agrícola Huarmey

## 1. Archivos
| Archivo | Función |
|---|---|
| `index.html`, `styles.css`, `app.js` | Interfaz y lógica (HTML/CSS/JS puro, sin compilación) |
| `config.js` | **Único archivo que usted edita**: URL de la API, clave, tiempos |
| `service-worker.js`, `manifest.json`, `icons/` | Instalación y funcionamiento sin internet |
| `Código.gs` | Backend de Apps Script |
| `LOGO HUARMEY.png` | **Usted debe colocarlo** en la misma carpeta (no se adjuntó). Sin él se muestra el texto "AGRÍCOLA HUARMEY" |
| `tests/` e `INFORME_PRUEBAS.md` | Pruebas funcionales y de carga |

**Tecnología:** JavaScript puro porque no requiere compilar, carga rápido en celulares modestos y se puede alojar en cualquier hosting estático. Los iconos incluidos son provisionales: reemplácelos por los oficiales (192, 512 y maskable 512).

## 2. Arquitectura y flujo de datos
```
Celular (PWA)                         Google
┌──────────────┐  guardar   ┌────────────┐   POST lote (JSON)   ┌─────────────────┐   ┌─────────────────────────┐
│ Formulario   │──────────▶ │ IndexedDB  │ ───────────────────▶ │ Apps Script     │──▶│ Google Sheets           │
│ (validación) │            │ records    │ ◀── confirmación ─── │ - valida        │   │ registro-acopiador      │
└──────────────┘            │ masters    │                      │ - LockService   │   │ _control-ids (idempot.) │
   ▲ listas sin internet    └────────────┘ ◀── maestros ─────── │ - caché maestros│◀──│ maestro-*               │
   └────────────────────────────┘                               └─────────────────┘   └─────────────────────────┘
```
1. Al guardar, el registro se escribe **primero en IndexedDB** con UUID, estado `PENDIENTE`.
2. Con internet, la PWA envía lotes (hasta 20) tras una espera aleatoria; el servidor responde por registro `OK`, `DUPLICATE` o `REJECTED`.
3. Solo con esa confirmación pasa a `SINCRONIZADO`. Fallo de red/servidor → sigue `PENDIENTE` con espera creciente (4 s, 8 s, 16 s… máx. 10 min, con aleatoriedad); tras 6 intentos pasa a `ERROR` (se conserva y se reintenta con el botón). Rechazo por validación → `ERROR` con el motivo.
4. Antes de reenviar un registro ya intentado, la PWA consulta `checkStatus` (por si el servidor lo recibió pero la respuesta se perdió). Además el servidor es idempotente: el mismo `id` nunca crea otra fila.
5. Los maestros se descargan, se guardan en IndexedDB y se refrescan según `MASTERS_TTL_MIN`. El servidor los guarda en caché (`MASTERS_CACHE_SECONDS`), de modo que 200 usuarios no leen Sheets 200 veces.

## 3. Configuración paso a paso
1. **Google Sheets:** cree/abra `REGISTRO-PRODUCCION-COSECHA` con las hojas `maestro-modulos` (col. `MODULO - TURNO`), `maestro-acopiador` (`DATOS ACOPIADOR`) y `maestro-caporal` (`DATOS CAPORAL`), encabezado en la fila 1. Copie el **ID** de la URL: `https://docs.google.com/spreadsheets/d/`**`ID`**`/edit`.
2. **Apps Script:** en el Sheets, *Extensiones > Apps Script*; pegue `Código.gs`. En *Configuración del proyecto > Propiedades del script* cree `SPREADSHEET_ID` (el ID) y `API_KEY` (una clave larga inventada por usted). (Alternativa: editar `CONFIG` en el código.)
3. Ejecute **`setup`** una vez y acepte permisos: crea `registro-acopiador` (FECHA REG., MODULO - TURNO, DATOS ACOPIADOR, DATOS CAPORAL, TOTAL) y `_control-ids` (auxiliar, no borrar) y verifica los maestros.
4. **Implementar > Nueva implementación > Aplicación web**: ejecutar como *Yo*; acceso *Cualquier persona*. Copie la URL `/exec`. Cada cambio del código requiere *nueva versión* de la implementación.
5. Edite `config.js`: `API_URL` (URL `/exec`) y `API_KEY` (la misma clave).
6. Coloque `LOGO HUARMEY.png` y sus iconos. **Suba el número `VERSION` de `service-worker.js`** cada vez que cambie algún archivo.
7. Publique la carpeta en un hosting **HTTPS** (GitHub Pages, Netlify, Firebase Hosting, servidor de la empresa). Las PWA no se instalan por `http://` ni desde archivos locales.

## 4. Instalar la PWA
- **Android (Chrome):** abrir la URL con internet → menú ⋮ → *Instalar aplicación* / *Agregar a pantalla principal*. Abrirla una vez con internet para descargar las listas.
- **Escritorio (Chrome/Edge):** icono de instalar en la barra de direcciones → *Instalar*.
- **iPhone (Safari):** Compartir → *Agregar a pantalla de inicio*.

## 5. Autenticación y sus límites (transparencia)
La web app de Apps Script se publica como "Cualquier persona" y la clave `API_KEY` viaja en `config.js`, por lo que **cualquier persona con acceso a la PWA puede verla**. Sirve para frenar accesos casuales y bots, **no** es un secreto fuerte ni identifica al usuario. El servidor valida todo (tipos, rangos, listas maestras) y neutraliza fórmulas. Si se requiere identificar a cada acopiador o revocar accesos individuales, hay que pasar a inicio de sesión (Google Workspace/Firebase Auth) — ver sección 6. No coloque en el navegador contraseñas, tokens privados ni claves de servicio.

## 6. Concurrencia: hasta 200 usuarios – evaluación honesta
**Definición usada:** (a) 200 sesiones abiertas (carga de maestros, mayormente servida desde caché) y (b) ráfagas en que muchos dispositivos sincronizan en pocos minutos.

**Lo que ayuda (implementado):** maestros con caché local y de servidor; envío por lotes; espera aleatoria al abrir/reconectar; backoff exponencial con límite; candado `LockService` solo alrededor de "comprobar duplicados + escritura en bloque" (una única `setValues`); validación fuera del candado; idempotencia por UUID.

**Cuellos de botella probables:** (1) las escrituras se serializan por el candado: si todos guardan en el mismo segundo, algunos recibirán `BUSY` y reintentarán; (2) cada ejecución de Apps Script tiene arranque en frío de varios segundos; (3) Apps Script limita ejecuciones simultáneas por proyecto/usuario y tiene cuotas diarias; (4) `_control-ids` se lee completa en cada lote (crece con los registros; conviene archivar cada temporada).

**Cuotas y límites (verifique los vigentes, cambian con el tiempo y según cuenta gratuita o Workspace):** https://developers.google.com/apps-script/guides/services/quotas — allí figuran ejecuciones simultáneas, tiempo máximo por ejecución, tiempo total de triggers/día, tamaño de caché (100 KB por clave) y límites de Sheets (10 millones de celdas por archivo; cuotas de API). Para los límites de lectura/escritura de Sheets: https://developers.google.com/workspace/sheets/api/limits.

**Veredicto:** *No se puede garantizar* hoy que 200 usuarios guardando **a la vez** funcionen sin errores; no hay mediciones reales. Con registros espaciados (un acopiador registra pocas veces al día) y sincronización dosificada, es **plausible**, pero debe confirmarse con `tests/load-test.js` (ver `INFORME_PRUEBAS.md`). Gracias al diseño offline-first, aun con fallos transitorios **no se pierden datos**: solo se retrasa la sincronización.

**Si la prueba no se aprueba – alternativa escalable:** mantener la misma PWA y reemplazar solo el backend por una API (Cloud Run / Cloud Functions / Supabase / Firebase) con base administrada (PostgreSQL o Firestore): inserciones concurrentes reales con `id` como clave única (idempotencia nativa), autenticación por usuario, y exportación periódica a Google Sheets para los reportes. Cambian: `Código.gs` → API + BD; `API_URL` en `config.js`; el contrato JSON (`masters`, `saveRecords`, `checkStatus`) puede mantenerse idéntico. Costos: normalmente bajos a esta escala (suele caber en niveles gratuitos o pocos dólares/mes), pero requiere mantenimiento técnico; consulte precios vigentes del proveedor.

## 7. Pruebas
- Funcionales del backend (simuladas): `node tests/test-backend.js` → 11/11 correctas.
- Carga: `node tests/load-test.js <URL_EXEC> <API_KEY> 200 5 60` sobre una **copia** del Sheets. Resultados en `INFORME_PRUEBAS.md` (hoy vacío: no se han medido).
- Manual en celular: (1) registrar con internet → fila en `registro-acopiador`; (2) modo avión → registrar 3 → estado PENDIENTE; (3) reconectar → pasan a SINCRONIZADO; (4) cortar internet a mitad de envío y reintentar → sin filas duplicadas; (5) cerrar la app con pendientes y reabrir → siguen ahí.

## 8. Mantenimiento
- Cambiar listas: editar hojas maestras; los equipos las toman en ≤ `MASTERS_TTL_MIN` + caché del servidor, o con *ACTUALIZAR LISTAS*. Un registro hecho offline con un valor luego eliminado de la lista será rechazado con mensaje claro (`VALIDATE_AGAINST_MASTERS`; ponga `false` para aceptarlo).
- No borre ni reordene columnas de `registro-acopiador` ni la hoja `_control-ids`.
- Revise *Apps Script > Ejecuciones* para ver errores técnicos (el usuario solo ve mensajes genéricos).
- Tras cada cambio de la PWA: subir `VERSION` del service worker; tras cada cambio del backend: nueva versión de la implementación.
