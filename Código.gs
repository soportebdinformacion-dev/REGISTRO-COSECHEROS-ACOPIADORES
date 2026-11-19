/**
 * REPORTE DE COSECHADORES - Backend (Google Apps Script)
 * API JSON para la PWA "Registro para Acopiadores(as)" - Agrícola Huarmey.
 *
 * Acciones (POST, cuerpo JSON en texto plano):
 *   masters      -> listas maestras (con caché del servidor)
 *   saveRecords  -> recibe un lote de registros (idempotente por "id")
 *   checkStatus  -> verifica qué ids ya existen en el servidor
 *   ping         -> prueba de vida
 *
 * Hojas del archivo REGISTRO-PRODUCCION-COSECHA:
 *   maestro-modulos (MODULO - TURNO), maestro-acopiador (DATOS ACOPIADOR),
 *   maestro-caporal (DATOS CAPORAL), registro-acopiador (destino),
 *   _control-ids (auxiliar: ids ya recibidos, para idempotencia).
 */
const CONFIG = {
  SPREADSHEET_ID: 'PEGAR_AQUI_EL_ID_DEL_GOOGLE_SHEETS',   // ver INSTRUCCIONES.md
  API_KEY: 'CAMBIAR_CLAVE_DE_ACCESO',                      // debe coincidir con config.js (o use Propiedades del script)
  SHEET_MODULOS: 'maestro-modulos',
  SHEET_ACOPIADOR: 'maestro-acopiador',
  SHEET_CAPORAL: 'maestro-caporal',
  SHEET_REGISTRO: 'registro-acopiador',
  SHEET_IDS: '_control-ids',
  COL_MODULO: 'MODULO - TURNO',
  COL_ACOPIADOR: 'DATOS ACOPIADOR',
  COL_CAPORAL: 'DATOS CAPORAL',
  REG_HEADERS: ['FECHA REG.', 'MODULO - TURNO', 'DATOS ACOPIADOR', 'DATOS CAPORAL', 'TOTAL'],
  MASTERS_CACHE_SECONDS: 600,      // caché de maestros (máx. permitido por CacheService: 21600)
  MAX_BATCH: 50,                   // registros máximos por solicitud
  LOCK_WAIT_MS: 20000,             // espera máxima por el candado
  MAX_TOTAL: 9999999,
  MAX_TEXT: 150,
  DAYS_BACK: 400,                  // fecha mínima aceptada (días atrás)
  DAYS_AHEAD: 1,                   // fecha máxima aceptada (días adelante)
  VALIDATE_AGAINST_MASTERS: true   // rechaza valores que no estén en las hojas maestras
};

/* ---------- Puntos de entrada ---------- */
function doGet() { return json_({ ok: true, service: 'REPORTE DE COSECHADORES', time: new Date().toISOString() }); }

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!authorized_(body.key)) return json_({ ok: false, code: 'UNAUTHORIZED', retry: false, message: 'Clave de acceso incorrecta. Revise config.js.' });
    switch (body.action) {
      case 'ping': return json_({ ok: true, time: new Date().toISOString() });
      case 'masters': return json_(Object.assign({ ok: true }, getMasters_()));
      case 'saveRecords': return json_(saveRecords_(body.records));
      case 'checkStatus': return json_(checkStatus_(body.ids));
      default: return json_({ ok: false, code: 'BAD_ACTION', retry: false, message: 'Acción no válida.' });
    }
  } catch (err) {
    console.error('doPost error: ' + (err && err.stack || err));        // detalle solo en el registro del servidor
    return json_({ ok: false, code: 'SERVER_ERROR', retry: true, message: 'Error temporal del servidor. Se reintentará.' });
  }
}

/* ---------- Maestros (con caché) ---------- */
function getMasters_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get('masters_v1');
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* recalcula */ } }
  const ss = ss_();
  const data = {
    modulos: readColumn_(ss, CONFIG.SHEET_MODULOS, CONFIG.COL_MODULO),
    acopiadores: readColumn_(ss, CONFIG.SHEET_ACOPIADOR, CONFIG.COL_ACOPIADOR),
    caporales: readColumn_(ss, CONFIG.SHEET_CAPORAL, CONFIG.COL_CAPORAL),
    updatedAt: new Date().toISOString()
  };
  try { cache.put('masters_v1', JSON.stringify(data), CONFIG.MASTERS_CACHE_SECONDS); }
  catch (e) { console.warn('No se pudo guardar en caché (¿>100 KB?): ' + e); }
  return data;
}

function readColumn_(ss, sheetName, header) {
  const sh = ss.getSheetByName(sheetName);
  if (!sh) throw new Error('No existe la hoja "' + sheetName + '".');
  const last = sh.getLastRow(); if (last < 2) return [];
  const heads = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim().toUpperCase(); });
  const idx = heads.indexOf(header.toUpperCase());
  if (idx < 0) throw new Error('No existe la columna "' + header + '" en "' + sheetName + '".');
  const vals = sh.getRange(2, idx + 1, last - 1, 1).getValues();
  const seen = {}, out = [];
  vals.forEach(function (r) { const v = String(r[0]).trim(); if (v && !seen[v]) { seen[v] = 1; out.push(v); } });
  return out;
}

/* ---------- Recepción de registros ---------- */
function saveRecords_(records) {
  if (!Array.isArray(records) || !records.length) return { ok: false, code: 'EMPTY', retry: false, message: 'No se enviaron registros.' };
  if (records.length > CONFIG.MAX_BATCH) return { ok: false, code: 'TOO_MANY', retry: false, message: 'Lote demasiado grande (máx. ' + CONFIG.MAX_BATCH + ').' };

  // 1) Validación fuera del candado (rápida, sin tocar la hoja)
  const masters = CONFIG.VALIDATE_AGAINST_MASTERS ? getMasters_() : null;
  const results = [], valid = [];
  records.forEach(function (r) {
    const v = validate_(r, masters);
    if (v.error) results.push({ id: String(r && r.id || ''), status: 'REJECTED', message: v.error });
    else valid.push(v.rec);
  });

  // 2) Sección crítica corta: comprobar duplicados + escribir en lote
  if (valid.length) {
    const lock = LockService.getScriptLock();
    if (!lock.tryLock(CONFIG.LOCK_WAIT_MS)) return { ok: false, code: 'BUSY', retry: true, message: 'Servidor ocupado. Se reintentará automáticamente.' };
    try {
      const ss = ss_(), reg = sheet_(ss, CONFIG.SHEET_REGISTRO, CONFIG.REG_HEADERS), ids = sheet_(ss, CONFIG.SHEET_IDS, ['ID', 'RECIBIDO']);
      const known = {};
      const lastId = ids.getLastRow();
      if (lastId > 1) ids.getRange(2, 1, lastId - 1, 1).getValues().forEach(function (r) { known[r[0]] = 1; });
      const rows = [], idRows = [], now = new Date();
      valid.forEach(function (rec) {
        if (known[rec.id]) { results.push({ id: rec.id, status: 'DUPLICATE' }); return; }
        known[rec.id] = 1;
        const p = rec.fecha.split('-');
        rows.push([new Date(+p[0], +p[1] - 1, +p[2]), rec.modulo, rec.acopiador, rec.caporal, rec.total]);
        idRows.push([rec.id, now]);
        results.push({ id: rec.id, status: 'OK' });
      });
      if (rows.length) {
        const start = reg.getLastRow() + 1;
        reg.getRange(start, 1, rows.length, 5).setValues(rows);
        reg.getRange(start, 1, rows.length, 1).setNumberFormat('dd/mm/yyyy');
        ids.getRange(ids.getLastRow() + 1, 1, idRows.length, 2).setValues(idRows);
        SpreadsheetApp.flush();      // asegura la escritura antes de liberar el candado
      }
    } finally { lock.releaseLock(); }
  }
  return { ok: true, results: results };
}

function validate_(r, masters) {
  if (!r || typeof r !== 'object') return { error: 'Registro vacío.' };
  const id = String(r.id || '');
  if (!/^[0-9a-fA-F-]{20,64}$/.test(id)) return { error: 'Identificador de registro no válido.' };
  const fecha = String(r.fecha || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return { error: 'FECHA no válida.' };
  const d = new Date(fecha + 'T00:00:00'), today = new Date(); today.setHours(0, 0, 0, 0);
  if (isNaN(d.getTime())) return { error: 'FECHA no válida.' };
  if (d < new Date(today.getTime() - CONFIG.DAYS_BACK * 864e5) || d > new Date(today.getTime() + CONFIG.DAYS_AHEAD * 864e5))
    return { error: 'FECHA fuera del rango permitido.' };
  const fields = [['modulo', 'MODULO - TURNO', masters && masters.modulos], ['acopiador', 'DATOS ACOPIADOR', masters && masters.acopiadores], ['caporal', 'DATOS CAPORAL', masters && masters.caporales]];
  const out = { id: id, fecha: fecha };
  for (var i = 0; i < fields.length; i++) {
    const v = String(r[fields[i][0]] == null ? '' : r[fields[i][0]]).trim();
    if (!v) return { error: fields[i][1] + ' es obligatorio.' };
    if (v.length > CONFIG.MAX_TEXT) return { error: fields[i][1] + ' es demasiado largo.' };
    if (fields[i][2] && fields[i][2].indexOf(v) < 0) return { error: fields[i][1] + ' "' + v + '" ya no existe en la lista maestra. Descarte el registro y vuelva a capturarlo.' };
    out[fields[i][0]] = /^[=+\-@]/.test(v) ? "'" + v : v;      // evita inyección de fórmulas en Sheets
  }
  const t = r.total;
  if (typeof t !== 'number' || !isFinite(t) || Math.floor(t) !== t || t < 1 || t > CONFIG.MAX_TOTAL) return { error: 'TOTAL debe ser un entero positivo (máx. ' + CONFIG.MAX_TOTAL + ').' };
  out.total = t;
  return { rec: out };
}

/* ---------- Verificación ---------- */
function checkStatus_(ids) {
  if (!Array.isArray(ids)) return { ok: false, code: 'BAD_REQUEST', retry: false, message: 'Solicitud no válida.' };
  const sh = ss_().getSheetByName(CONFIG.SHEET_IDS); const known = {};
  if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().forEach(function (r) { known[r[0]] = 1; });
  return { ok: true, found: ids.slice(0, 200).filter(function (i) { return known[i]; }) };
}

/* ---------- Auxiliares ---------- */
function ss_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID') || CONFIG.SPREADSHEET_ID); }
function authorized_(k) { const real = PropertiesService.getScriptProperties().getProperty('API_KEY') || CONFIG.API_KEY; return !!k && k === real; }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function sheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold'); sh.setFrozenRows(1); }
  return sh;
}

/** Ejecutar UNA vez desde el editor: crea registro-acopiador y _control-ids si faltan y pide permisos. */
function setup() {
  const ss = ss_();
  sheet_(ss, CONFIG.SHEET_REGISTRO, CONFIG.REG_HEADERS);
  sheet_(ss, CONFIG.SHEET_IDS, ['ID', 'RECIBIDO']);
  const m = getMasters_();
  Logger.log('Listo. Módulos: %s · Acopiadores: %s · Caporales: %s', m.modulos.length, m.acopiadores.length, m.caporales.length);
}
