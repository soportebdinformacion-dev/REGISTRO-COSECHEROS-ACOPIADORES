/* REPORTE DE COSECHADORES - Registro para Acopiadores(as)
 * Lógica de la PWA: IndexedDB (maestros + registros), validación, sincronización offline-first.
 * Módulos internos: DB, Masters, Records, Sync, UI. */
(() => {
  'use strict';
  const CFG = window.APP_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  /* ============ DB (IndexedDB) ============ */
  const DB = (() => {
    let dbp;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        const rq = indexedDB.open('reporte-cosechadores', 1);
        rq.onupgradeneeded = () => {
          const db = rq.result;
          if (!db.objectStoreNames.contains('masters')) db.createObjectStore('masters', { keyPath: 'key' });
          if (!db.objectStoreNames.contains('records')) {
            const s = db.createObjectStore('records', { keyPath: 'id' });
            s.createIndex('status', 'status'); s.createIndex('createdAt', 'createdAt');
          }
        };
        rq.onsuccess = () => resolve(rq.result);
        rq.onerror = () => reject(rq.error);
      });
      return dbp;
    }
    async function tx(store, mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction(store, mode); const s = t.objectStore(store);
        let out; const r = fn(s);
        if (r && 'onsuccess' in r) r.onsuccess = () => { out = r.result; };
        t.oncomplete = () => resolve(out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
      });
    }
    return {
      get: (s, k) => tx(s, 'readonly', (st) => st.get(k)),
      put: (s, v) => tx(s, 'readwrite', (st) => st.put(v)),
      del: (s, k) => tx(s, 'readwrite', (st) => st.delete(k)),
      all: (s) => tx(s, 'readonly', (st) => st.getAll())
    };
  })();

  /* ============ Utilidades ============ */
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));
  const todayLocal = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const fmtDate = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
  const fmtDT = (ts) => new Date(ts).toLocaleString('es-PE', { dateStyle: 'short', timeStyle: 'short' });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const jitter = (max) => Math.floor(Math.random() * max);
  const configured = () => CFG.API_URL && /^https:\/\/script\.google(usercontent)?\.com\//.test(CFG.API_URL);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ============ API (Apps Script) ============ */
  async function api(action, payload) {
    if (!configured()) throw Object.assign(new Error('Falta configurar la URL de la API en config.js.'), { code: 'NOCONFIG', retry: false });
    const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), CFG.REQUEST_TIMEOUT_MS || 30000);
    try {
      // text/plain evita la solicitud previa CORS (preflight) que Apps Script no soporta.
      const res = await fetch(CFG.API_URL, {
        method: 'POST', redirect: 'follow', signal: ctl.signal,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action, key: CFG.API_KEY }, payload || {}))
      });
      if (!res.ok) throw Object.assign(new Error('El servidor respondió ' + res.status + '.'), { retry: true });
      let data; try { data = await res.json(); } catch (e) { throw Object.assign(new Error('Respuesta no válida del servidor.'), { retry: true }); }
      if (!data.ok) throw Object.assign(new Error(data.message || 'Error del servidor.'), { code: data.code, retry: !!data.retry });
      return data;
    } catch (e) {
      if (e.name === 'AbortError') throw Object.assign(new Error('El servidor tardó demasiado en responder.'), { retry: true });
      if (e instanceof TypeError) throw Object.assign(new Error('No hay conexión con el servidor.'), { retry: true });
      throw e;
    } finally { clearTimeout(to); }
  }

  /* ============ Maestros ============ */
  const Masters = {
    data: { modulos: [], acopiadores: [], caporales: [], updatedAt: null, fetchedAt: null },
    async load() { const r = await DB.get('masters', 'main'); if (r) this.data = r.value; this.fill(); this.info(); },
    fill() {
      const sets = [['modulo', this.data.modulos], ['acopiador', this.data.acopiadores], ['caporal', this.data.caporales]];
      sets.forEach(([id, arr]) => {
        const sel = $(id); const prev = sel.value;
        sel.innerHTML = '<option value="">Seleccione…</option>' + (arr || []).map((v) => `<option>${esc(v)}</option>`).join('');
        if (prev && arr && arr.includes(prev)) sel.value = prev;
      });
    },
    info() {
      const d = this.data;
      if (!d.fetchedAt) { $('mastersInfo').textContent = 'Listas: aún no descargadas (conéctese una vez a internet)'; return; }
      const local = !navigator.onLine ? ' · usando copia guardada en el equipo' : '';
      $('mastersInfo').textContent = `Listas actualizadas: ${fmtDT(d.fetchedAt)}${local}`;
    },
    stale() { return !this.data.fetchedAt || (Date.now() - this.data.fetchedAt) > (CFG.MASTERS_TTL_MIN || 30) * 60000; },
    async refresh(manual) {
      if (!navigator.onLine) { if (manual) UI.toast('Sin internet: se usan las listas guardadas.', 'bad'); return false; }
      try {
        const r = await api('masters');
        const clean = (a) => (a || []).filter((x) => String(x).trim() !== '');
        this.data = { modulos: clean(r.modulos), acopiadores: clean(r.acopiadores), caporales: clean(r.caporales), updatedAt: r.updatedAt, fetchedAt: Date.now() };
        await DB.put('masters', { key: 'main', value: this.data });
        this.fill(); this.info(); if (manual) UI.toast('Listas actualizadas.', 'ok'); return true;
      } catch (e) { if (manual) UI.toast('No se pudieron actualizar las listas: ' + e.message, 'bad'); return false; }
    }
  };

  /* ============ Registros ============ */
  const Records = {
    validate(v) {
      const e = {};
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v.fecha) || isNaN(new Date(v.fecha + 'T00:00:00'))) e.fecha = 'Seleccione una fecha válida.';
      if (!v.modulo) e.modulo = 'Seleccione el MODULO - TURNO.';
      if (!v.acopiador) e.acopiador = 'Seleccione los DATOS DEL ACOPIADOR.';
      if (!v.caporal) e.caporal = 'Seleccione los DATOS DEL CAPORAL.';
      const t = String(v.total).trim();
      if (t === '') e.total = 'Ingrese el TOTAL.';
      else if (!/^\d+$/.test(t)) e.total = 'El TOTAL debe ser un número entero, sin letras, puntos ni comas.';
      else if (parseInt(t, 10) < 1) e.total = 'El TOTAL debe ser mayor que cero.';
      else if (parseInt(t, 10) > (CFG.MAX_TOTAL || 9999999)) e.total = 'El TOTAL es demasiado grande.';
      return e;
    },
    async add(v) {
      const rec = { id: uuid(), fecha: v.fecha, modulo: v.modulo, acopiador: v.acopiador, caporal: v.caporal,
        total: parseInt(String(v.total).trim(), 10), status: 'PENDIENTE', createdAt: Date.now(), attempts: 0, nextTryAt: 0, lastError: '' };
      await DB.put('records', rec); return rec;
    }
  };

  /* ============ Sincronización ============ */
  const Sync = {
    running: false, timer: null,
    backoff(n) { const ms = Math.min((CFG.BACKOFF_BASE_MS || 4000) * Math.pow(2, n - 1), CFG.BACKOFF_MAX_MS || 600000); return ms / 2 + jitter(ms / 2); },
    async run(manual) {
      if (this.running) return;
      if (!configured()) { if (manual) UI.toast('Falta configurar la URL de la API (config.js).', 'bad'); return; }
      if (!navigator.onLine) { if (manual) UI.toast('Sin internet. Sus registros siguen guardados.', 'bad'); return; }
      this.running = true; UI.syncBusy(true);
      let ok = 0, rejected = 0, failed = 0, lastMsg = '';
      try {
        const now = Date.now(); let recs = await DB.all('records');
        let todo = recs.filter((r) => r.status === 'PENDIENTE' && (manual || !r.nextTryAt || r.nextTryAt <= now));
        if (manual) todo = todo.concat(recs.filter((r) => r.status === 'ERROR'));
        todo.sort((a, b) => a.createdAt - b.createdAt);
        // Verificación previa: los que ya se intentaron pudieron llegar al servidor aunque no se recibió la respuesta.
        const retried = todo.filter((r) => r.attempts > 0);
        if (retried.length) {
          try {
            const chk = await api('checkStatus', { ids: retried.map((r) => r.id).slice(0, 200) });
            const found = new Set(chk.found || []);
            for (const r of retried) if (found.has(r.id)) { await this.mark(r, 'SINCRONIZADO'); ok++; }
            todo = todo.filter((r) => !found.has(r.id));
          } catch (e) { /* se continúa: el envío es idempotente */ }
        }
        const size = CFG.BATCH_SIZE || 20;
        for (let i = 0; i < todo.length; i += size) {
          const chunk = todo.slice(i, i + size);
          try {
            const res = await api('saveRecords', { records: chunk.map(({ id, fecha, modulo, acopiador, caporal, total }) => ({ id, fecha, modulo, acopiador, caporal, total })) });
            const byId = new Map((res.results || []).map((x) => [x.id, x]));
            for (const r of chunk) {
              const x = byId.get(r.id);
              if (x && (x.status === 'OK' || x.status === 'DUPLICATE')) { await this.mark(r, 'SINCRONIZADO'); ok++; }
              else if (x && x.status === 'REJECTED') { r.status = 'ERROR'; r.lastError = x.message || 'El servidor rechazó el registro.'; r.nextTryAt = 0; await DB.put('records', r); rejected++; lastMsg = r.lastError; }
              else { await this.fail(r, 'El servidor no confirmó este registro.'); failed++; }
            }
          } catch (e) {
            lastMsg = e.message;
            for (const r of chunk) { await this.fail(r, e.message, e.retry === false); failed++; }
            if (e.retry !== false) break;   // fallo de red/servidor: se detiene y se reintenta luego con espera
            break;
          }
          await sleep(300 + jitter(700));   // dosifica envíos
        }
      } catch (e) { lastMsg = e.message; }
      finally {
        this.running = false; UI.syncBusy(false); await UI.refresh();
        const parts = [];
        if (ok) parts.push(`${ok} sincronizado(s)`); if (rejected) parts.push(`${rejected} rechazado(s)`); if (failed) parts.push(`${failed} por reintentar`);
        UI.syncMsg(parts.length ? `Última sincronización ${fmtDT(Date.now())}: ${parts.join(', ')}.${lastMsg ? ' ' + lastMsg : ''}` : (manual ? 'No hay registros por enviar.' : ''));
        if (manual) UI.toast(ok && !rejected && !failed ? 'Registros sincronizados.' : (parts.join(', ') || 'No hay registros por enviar.'), ok && !rejected && !failed ? 'ok' : 'bad');
      }
    },
    async mark(r, status) { r.status = status; r.syncedAt = Date.now(); r.lastError = ''; await DB.put('records', r); },
    async fail(r, msg, final) {
      r.attempts = (r.attempts || 0) + 1; r.lastError = msg;
      if (final || r.attempts >= (CFG.MAX_RETRIES || 6)) { r.status = 'ERROR'; r.nextTryAt = 0; }
      else { r.status = 'PENDIENTE'; r.nextTryAt = Date.now() + this.backoff(r.attempts); }
      await DB.put('records', r);
    },
    schedule(delay) { clearTimeout(this._d); this._d = setTimeout(() => this.run(false), delay == null ? jitter(CFG.START_JITTER_MS || 5000) : delay); },
    start() {
      clearInterval(this.timer);
      this.timer = setInterval(async () => {
        if (!navigator.onLine) return;
        if (Masters.stale()) await Masters.refresh(false);
        this.run(false);
      }, (CFG.AUTO_SYNC_INTERVAL_MS || 60000) + jitter(5000));
    }
  };

  /* ============ Interfaz ============ */
  const UI = {
    filter: 'ALL', tt: null,
    toast(msg, kind) { const t = $('toast'); t.textContent = msg; t.className = 'toast ' + (kind || ''); t.hidden = false; clearTimeout(this.tt); this.tt = setTimeout(() => { t.hidden = true; }, 4500); },
    syncMsg(m) { $('syncMsg').textContent = m || ''; },
    syncBusy(b) { $('btnSync').disabled = b; $('btnSync').lastChild.textContent = b ? 'SINCRONIZANDO…' : 'SINCRONIZAR AHORA'; },
    conn() {
      const on = navigator.onLine, el = $('connBadge');
      el.className = 'badge ' + (on ? 'badge-on' : 'badge-off');
      el.innerHTML = `<svg class="ic"><use href="#i-${on ? 'online' : 'offline'}"/></svg><span>${on ? 'Con conexión' : 'Sin conexión (modo local)'}</span>`;
      Masters.info();
    },
    clearErrors() { ['fecha', 'modulo', 'acopiador', 'caporal', 'total'].forEach((k) => { $('err-' + k).textContent = ''; $(k).classList.remove('invalid'); }); },
    resetForm(keepDate) {
      this.clearErrors(); $('modulo').value = ''; $('acopiador').value = ''; $('caporal').value = ''; $('total').value = '';
      if (!keepDate) $('fecha').value = todayLocal();
    },
    async refresh() {
      const recs = (await DB.all('records')).sort((a, b) => b.createdAt - a.createdAt);
      const c = { PENDIENTE: 0, SINCRONIZADO: 0, ERROR: 0 }; recs.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
      $('cPend').textContent = c.PENDIENTE; $('cSync').textContent = c.SINCRONIZADO; $('cErr').textContent = c.ERROR;
      const shown = recs.filter((r) => this.filter === 'ALL' || r.status === this.filter).slice(0, 100);
      const ico = { PENDIENTE: 'clock', SINCRONIZADO: 'ok', ERROR: 'warn' };
      $('list').innerHTML = shown.length ? shown.map((r) => `
        <li class="item ${r.status}">
          <div class="row1"><span>${fmtDate(r.fecha)} · TOTAL ${r.total}</span>
            <span class="st ${r.status}"><svg class="ic"><use href="#i-${ico[r.status]}"/></svg>${r.status}</span></div>
          <div class="meta">${esc(r.modulo)} · ${esc(r.acopiador)} · Caporal: ${esc(r.caporal)}</div>
          ${r.lastError && r.status !== 'SINCRONIZADO' ? `<div class="emsg">${esc(r.lastError)}</div>` : ''}
          ${r.status === 'ERROR' ? `<button class="del" data-del="${r.id}" type="button"><svg class="ic"><use href="#i-trash"/></svg>Descartar este registro</button>` : ''}
        </li>`).join('') : '<li class="empty">No hay registros en esta vista.</li>';
    }
  };

  /* ============ Eventos ============ */
  $('form').addEventListener('submit', async (ev) => {
    ev.preventDefault(); UI.clearErrors();
    const v = { fecha: $('fecha').value, modulo: $('modulo').value, acopiador: $('acopiador').value, caporal: $('caporal').value, total: $('total').value };
    const errs = Records.validate(v); const keys = Object.keys(errs);
    if (keys.length) { keys.forEach((k) => { $('err-' + k).textContent = errs[k]; $(k).classList.add('invalid'); }); $(keys[0]).focus(); UI.toast('Revise los campos marcados.', 'bad'); return; }
    try {
      const rec = await Records.add(v);
      UI.toast(`Registro guardado en el equipo (TOTAL ${rec.total}).${navigator.onLine ? ' Enviando…' : ' Se enviará al volver el internet.'}`, 'ok');
      UI.resetForm(true); $('fecha').value = v.fecha; await UI.refresh(); Sync.schedule(jitter(2500));
    } catch (e) { UI.toast('No se pudo guardar en el equipo: ' + e.message, 'bad'); }
  });
  $('total').addEventListener('input', () => { const c = $('total').value.replace(/\D/g, ''); if (c !== $('total').value) $('total').value = c; });
  $('btnClear').addEventListener('click', () => UI.resetForm(false));
  $('btnSync').addEventListener('click', () => Sync.run(true));
  $('btnMasters').addEventListener('click', () => Masters.refresh(true));
  $('btnPurge').addEventListener('click', async () => {
    const synced = (await DB.all('records')).filter((r) => r.status === 'SINCRONIZADO');
    if (!synced.length) return UI.toast('No hay registros sincronizados para quitar.');
    if (!confirm(`Se quitarán ${synced.length} registro(s) ya confirmados por el servidor. ¿Continuar?`)) return;
    for (const r of synced) await DB.del('records', r.id); UI.refresh();
  });
  $('list').addEventListener('click', async (ev) => {
    const id = ev.target.closest('[data-del]')?.dataset.del; if (!id) return;
    if (confirm('Este registro NO llegó al servidor. Si lo descarta se perderá. ¿Descartar?')) { await DB.del('records', id); UI.refresh(); }
  });
  document.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('on')); b.classList.add('on'); UI.filter = b.dataset.f; UI.refresh();
  }));
  window.addEventListener('online', () => { UI.conn(); Sync.schedule(); if (Masters.stale()) Masters.refresh(false); });
  window.addEventListener('offline', UI.conn);
  $('logo').addEventListener('error', () => { $('logo').hidden = true; $('logoFallback').hidden = false; });

  /* ============ Arranque ============ */
  (async () => {
    $('fecha').value = todayLocal();
    $('configWarn').hidden = configured();
    UI.conn();
    try { await Masters.load(); await UI.refresh(); } catch (e) { UI.toast('No se pudo abrir el almacenamiento local: ' + e.message, 'bad'); }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    Sync.start();
    setTimeout(async () => { if (navigator.onLine && Masters.stale()) await Masters.refresh(false); Sync.run(false); }, jitter(CFG.START_JITTER_MS || 5000));
  })();
})();
