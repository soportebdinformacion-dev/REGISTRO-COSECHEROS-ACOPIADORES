/* ============================================================
 * CONFIGURACIÓN DE LA PWA  (edite SOLO este archivo)
 * ============================================================ */
window.APP_CONFIG = {
  // URL de implementación de Apps Script (termina en /exec).
  // Se obtiene en: Apps Script > Implementar > Administrar implementaciones.
  API_URL: 'PEGAR_AQUI_LA_URL_DE_IMPLEMENTACION_EXEC',

  // Clave de acceso compartida. Debe ser IGUAL a la de Código.gs (API_KEY).
  // OJO: al estar en el navegador NO es un secreto fuerte; solo filtra accesos casuales.
  API_KEY: 'CAMBIAR_CLAVE_DE_ACCESO',

  MASTERS_TTL_MIN: 30,        // minutos antes de volver a pedir las listas maestras
  BATCH_SIZE: 20,             // registros por envío (agrupa solicitudes)
  MAX_RETRIES: 6,             // reintentos automáticos antes de marcar ERROR
  BACKOFF_BASE_MS: 4000,      // espera base; crece x2 con cada intento (+ aleatorio)
  BACKOFF_MAX_MS: 10 * 60 * 1000,
  AUTO_SYNC_INTERVAL_MS: 60000, // revisión periódica de pendientes
  START_JITTER_MS: 5000,      // retraso aleatorio al abrir/reconectar (evita picos de 200 usuarios)
  REQUEST_TIMEOUT_MS: 30000,
  MAX_TOTAL: 9999999
};
