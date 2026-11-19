# Informe de pruebas – REPORTE DE COSECHADORES

## 1. Comprobado en esta entrega
| Prueba | Método | Resultado |
|---|---|---|
| 11 pruebas funcionales del backend (`Código.gs`): clave, maestros sin vacíos/duplicados, orden de 5 columnas, idempotencia (mismo id y duplicado en el lote), validación de TOTAL/fecha/maestros, neutralización de fórmulas, candado ocupado → BUSY, checkStatus, límite de lote | `node tests/test-backend.js` con Google Sheets **simulado** | 11/11 correctas |
| Sintaxis de `app.js`, `service-worker.js`, `config.js` | `node --check` | Correcta |

**Límite:** el simulador no mide tiempos ni cuotas reales de Google. No valida el comportamiento del candado bajo concurrencia real.

## 2. NO comprobado todavía (requiere su implementación)
- Pruebas en celular real (instalación, modo avión, reconexión).
- **Prueba de 200 usuarios**: no se ha ejecutado. Ninguna cifra de rendimiento de este documento es medida.

## 3. Cómo ejecutar la prueba de 200 usuarios
Sobre una **copia de prueba** del Google Sheets (se escriben filas reales):
```
node tests/load-test.js <URL_EXEC> <API_KEY> 200 5 60    # 200 usuarios repartidos en 60 s
node tests/load-test.js <URL_EXEC> <API_KEY> 200 5 0     # peor caso: todos a la vez
node tests/load-test.js <URL_EXEC> <API_KEY> 200 5 10    # pico: 200 usuarios en 10 s
```
Genera `resultado-prueba-carga.json` y la verificación contra el servidor.

## 4. Resultados medidos (completar tras ejecutar)
| Escenario | Éxito % | Errores (tipo) | p50 ms | p95 ms | Máx ms | Registros confirmados / filas en hoja | Duplicados | Duración |
|---|---|---|---|---|---|---|---|---|
| 200 usuarios / 60 s | | | | | | | | |
| 200 usuarios / 10 s | | | | | | | | |
| 200 usuarios / 0 s (peor caso) | | | | | | | | |

## 5. Criterio de decisión
- Aprobado: éxito ≥ 99 % tras reintentos de la PWA, 0 duplicados, filas en hoja = confirmados.
- Si aparecen errores BUSY/SERVER_ERROR frecuentes o p95 > 15 s en el escenario real de uso: aplicar la alternativa de la sección 6 de `INSTRUCCIONES.md`.
