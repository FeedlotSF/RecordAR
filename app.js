/**
 * Feedlot Dietas — app.js
 * Máquina de estados por corral, persistencia localStorage, notificaciones Web API.
 *
 * Reglas de negocio (ver guia_recordatorios_feedlot.md — ANEXO):
 *  - Adaptación 1: duración VARIABLE (1-5 días), se confirma manualmente.
 *  - Adaptaciones 2-5: 5 días fijos, editables manualmente.
 *  - Si el cambio cae domingo → avisar el sábado anterior.
 *  - Si pasan 1-2 días sin confirmar → aviso ATRASADO.
 *  - Toda edición queda en historial con timestamp.
 *  - Al completar Adaptación 5 → aviso especial "ENTRA EN TERMINACIÓN".
 */

'use strict';

// ─── Configuración de corrales ─────────────────────────────────────────────
const CORRALES_NUMERICOS = Array.from({ length: 22 }, (_, i) => String(i + 1));
const CORRALES_NOMINALES = [
  { id: 'A1', label: 'A1' },
  { id: 'A2', label: 'A2' },
  { id: 'B',  label: 'B',  nota: 'Enfermería' },
  { id: 'C',  label: 'C' },
  { id: 'D',  label: 'D' },
  { id: 'E',  label: 'E' },
  { id: 'F',  label: 'F' },
  { id: 'G',  label: 'G' },
  { id: 'H',  label: 'H' },
];
const DIAS_POR_DIETA   = 5;
const TOTAL_ETAPAS     = 5;
const STORAGE_KEY      = 'feedlot_corrales_v2';
const AVISOS_KEY       = 'feedlot_avisos_v2';
const TELEGRAM_CFG_KEY = 'feedlot_telegram_cfg';
const GAS_URL_DEFAULT  = 'https://script.google.com/macros/s/AKfycbwV88P9TSpRoja-b-MA7qSFvCRydHiQYILwMxf-LH8Yzvl3cJjkg0Js4m8CYDBzTZy6/exec';

// ─── State ─────────────────────────────────────────────────────────────────
let corrales  = [];   // array de objetos corral
let avisos    = [];   // array de avisos generados
let telegramCfg = { botToken: '', chatId: '' };
let activeTab = 'dashboard';
let detailId  = null; // corral actualmente en vista detalle
let extendPickerOpen  = false;
let restartPickerOpen = false;
let confirmandoEliminar = false;
let calMes  = new Date().getMonth();
let calAnio = new Date().getFullYear();
let deferredInstallPrompt = null;

// ─── Utils de fecha ─────────────────────────────────────────────────────────
const hoy = () => {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d;
};

const fechaStr = (d) => {
  if (!d) return '';
  const dt = new Date(d); dt.setHours(0, 0, 0, 0);
  return dt.toISOString().slice(0, 10);
};

const parseFecha = (s) => {
  if (!s) return null;
  const d = new Date(s + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
};

const sumarDias = (fecha, dias) => {
  const d = new Date(fecha); d.setDate(d.getDate() + dias); return d;
};

const diffDias = (a, b) => {
  const da = new Date(fechaStr(a) + 'T00:00:00');
  const db = new Date(fechaStr(b) + 'T00:00:00');
  return Math.round((da - db) / 86400000);
};

const esDomingo = (d) => new Date(d).getDay() === 0;
const esSabado  = (d) => new Date(d).getDay() === 6;

const fmt = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return dt.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: '2-digit' });
};

const fmtTs = (ts) => {
  const d = new Date(ts);
  return d.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' }) + ' ' +
         d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
};

// ─── Storage ─────────────────────────────────────────────────────────────────
const guardar = () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(corrales));
  localStorage.setItem(AVISOS_KEY,  JSON.stringify(avisos));
  localStorage.setItem(TELEGRAM_CFG_KEY, JSON.stringify(telegramCfg));
  sincronizarConAppsScript();
};

const cargar = () => {
  try {
    const c = localStorage.getItem(STORAGE_KEY);
    const a = localStorage.getItem(AVISOS_KEY);
    const t = localStorage.getItem(TELEGRAM_CFG_KEY);
    corrales = c ? JSON.parse(c) : [];
    avisos   = a ? JSON.parse(a) : [];
    telegramCfg = t ? JSON.parse(t) : { botToken: '8925363013:AAHYK15KNV-5RVrlcgUaqxkrZISU0e7Wc1U', chatId: '1891231041', gasUrl: GAS_URL_DEFAULT };
  } catch {
    corrales = [];
    avisos = [];
    telegramCfg = { botToken: '8925363013:AAHYK15KNV-5RVrlcgUaqxkrZISU0e7Wc1U', chatId: '1891231041', gasUrl: GAS_URL_DEFAULT };
  }
};

// ─── Modelo de corral ─────────────────────────────────────────────────────
const crearCorral = (id) => ({
  id,
  etapaActual:       1,
  fechaInicioEtapa:  fechaStr(hoy()),
  duracionEtapaDias: null,           // null = variable (Adaptación 1)
  fechaEstimadaCambio: fechaStr(sumarDias(hoy(), DIAS_POR_DIETA)), // estimada, puede cambiarse
  estado:            'Activo',
  historial: [{
    ts:     Date.now(),
    accion: `Ingreso registrado. Inicia Adaptación 1.`,
    motivo: ''
  }]
});

const encontrarCorral = (id) => corrales.find(c => c.id === id);

const calcFechaEstimada = (c) => {
  const inicio = parseFecha(c.fechaInicioEtapa);
  if (!inicio) return null;
  const duracion = c.duracionEtapaDias ?? DIAS_POR_DIETA;
  return sumarDias(inicio, duracion);
};

// ─── Registrar ingreso ────────────────────────────────────────────────────
const registrarIngreso = (id) => {
  let corral = encontrarCorral(id);
  if (corral) {
    // Ya existe — reiniciar adaptación a 1 (nuevo lote)
    corral.etapaActual       = 1;
    corral.fechaInicioEtapa  = fechaStr(hoy());
    corral.duracionEtapaDias = null;
    corral.fechaEstimadaCambio = fechaStr(sumarDias(hoy(), DIAS_POR_DIETA));
    corral.estado            = 'Activo';
    corral.historial.unshift({ ts: Date.now(), accion: 'Reinicio: nuevo ingreso de terneros. Vuelve a Adaptación 1.', motivo: '' });
    toast(`🔄 Corral ${id}: adaptación reiniciada`);
  } else {
    corral = crearCorral(id);
    corrales.push(corral);
    toast(`✅ Corral ${id} registrado — inicia Adaptación 1`);
  }
  // Aviso inmediato en avisos internos
  agregarAviso('info', id, 'Ingreso registrado',
    `Corral ${id} inicia Adaptación 1. Próximo cambio estimado: ${fmt(calcFechaEstimada(corral))}.`);
  guardar();
  notificacion(`🐄 Corral ${id} ingresado`, `Adaptación 1 iniciada. Cambio estimado: ${fmt(calcFechaEstimada(corral))}.`);
  render();
};

// ─── Confirmar cambio de etapa ────────────────────────────────────────────
const confirmarCambioEtapa = (id, motivo = '') => {
  const corral = encontrarCorral(id);
  if (!corral || corral.estado !== 'Activo') return;

  const etapaAnterior = corral.etapaActual;

  if (etapaAnterior >= TOTAL_ETAPAS) {
    // Completa todas las adaptaciones → Terminación
    corral.estado            = 'Terminacion';
    corral.etapaActual       = 'Terminacion';
    corral.fechaEstimadaCambio = null;
    corral.historial.unshift({ ts: Date.now(), accion: `Adaptación 5 completada → ENTRA EN TERMINACIÓN.`, motivo });
    agregarAviso('done', id, '🏁 ENTRA EN TERMINACIÓN',
      `Corral ${id} completó las 5 etapas de adaptación. ¡Pasa a Terminación!`);
    notificacion(`🏁 Corral ${id} — Terminación`, 'Completó las 5 etapas de adaptación.');
    toast(`🏁 Corral ${id} entra en TERMINACIÓN`);
  } else {
    const nuevaEtapa = etapaAnterior + 1;
    corral.etapaActual       = nuevaEtapa;
    corral.fechaInicioEtapa  = fechaStr(hoy());
    corral.duracionEtapaDias = DIAS_POR_DIETA; // 2-5 son fijas por defecto
    corral.fechaEstimadaCambio = fechaStr(sumarDias(hoy(), DIAS_POR_DIETA));
    corral.historial.unshift({ ts: Date.now(), accion: `Avanzó de Adaptación ${etapaAnterior} → Adaptación ${nuevaEtapa}.`, motivo });
    agregarAviso('info', id, `Adaptación ${nuevaEtapa} iniciada`,
      `Corral ${id} pasa a Adaptación ${nuevaEtapa}. Próximo cambio: ${fmt(calcFechaEstimada(corral))}.`);
    notificacion(`🔔 Corral ${id} — Adaptación ${nuevaEtapa}`, `Próximo cambio: ${fmt(calcFechaEstimada(corral))}.`);
    toast(`✅ Corral ${id}: avanzó a Adaptación ${nuevaEtapa}`);
  }
  guardar();
  render();
};

// ─── Extender días ────────────────────────────────────────────────────────
const extenderDias = (id, dias, motivo = '') => {
  const corral = encontrarCorral(id);
  if (!corral) return;
  const anterior = corral.duracionEtapaDias ?? DIAS_POR_DIETA;
  corral.duracionEtapaDias = anterior + dias;
  corral.fechaEstimadaCambio = fechaStr(calcFechaEstimada(corral));
  corral.historial.unshift({
    ts: Date.now(),
    accion: `Adaptación ${corral.etapaActual} extendida +${dias} día${dias > 1 ? 's' : ''} (nueva duración: ${corral.duracionEtapaDias} días).`,
    motivo
  });
  guardar();
  toast(`➕ Extendido ${dias}d — nuevo cambio: ${fmt(parseFecha(corral.fechaEstimadaCambio))}`);
  render();
};

// ─── Reiniciar adaptación ─────────────────────────────────────────────────
const reiniciarAdaptacion = (id, etapaDestino, motivo = '') => {
  const corral = encontrarCorral(id);
  if (!corral) return;
  const anterior = corral.etapaActual;
  corral.etapaActual       = etapaDestino;
  corral.fechaInicioEtapa  = fechaStr(hoy());
  corral.duracionEtapaDias = etapaDestino === 1 ? null : DIAS_POR_DIETA;
  corral.fechaEstimadaCambio = fechaStr(sumarDias(hoy(), DIAS_POR_DIETA));
  corral.estado            = 'Activo';
  corral.historial.unshift({
    ts: Date.now(),
    accion: `Reinicio: de Adaptación ${anterior} → Adaptación ${etapaDestino} (ingreso de nuevos animales).`,
    motivo
  });
  guardar();
  toast(`🔄 Corral ${id}: reiniciado a Adaptación ${etapaDestino}`);
  render();
};

// ─── Eliminar corral ────────────────────────────────────────────────────
// Primer clic: muestra confirmación inline (evita confirm() bloqueado en file://)
const pedirConfirmacionEliminar = (id) => {
  confirmandoEliminar = true;
  extendPickerOpen = false;
  restartPickerOpen = false;
  renderDetalle(id);
};

const cancelarEliminar = (id) => {
  confirmandoEliminar = false;
  renderDetalle(id);
};

const eliminarCorral = (id) => {
  corrales = corrales.filter(c => c.id !== id);
  avisos   = avisos.filter(a => a.corralId !== id);
  guardar();
  confirmandoEliminar = false;
  toast(`🗑️ Corral ${id} eliminado`);
  detailId = null;
  showPage('dashboard');
  render();
};

// Libera el corral al finalizar terminación: lo saca de la lista, queda "vacío"
const liberarCorral = (id) => {
  corrales = corrales.filter(c => c.id !== id);
  avisos   = avisos.filter(a => a.corralId !== id);
  guardar();
  toast(`🧹 Corral ${id} liberado — queda vacío`);
  detailId = null;
  showPage('dashboard');
  render();
};

// ─── Pausar / Reactivar ───────────────────────────────────────────────────
const pausarCorral = (id, motivo = '') => {
  const corral = encontrarCorral(id);
  if (!corral) return;
  const anterior = corral.estado;
  corral.estado = anterior === 'Pausado' ? 'Activo' : 'Pausado';
  corral.historial.unshift({
    ts: Date.now(),
    accion: corral.estado === 'Pausado'
      ? `Corral pausado / marcado como enfermería.`
      : `Corral reactivado desde pausa.`,
    motivo
  });
  guardar();
  toast(corral.estado === 'Pausado' ? `⏸️ Corral ${id} pausado` : `▶️ Corral ${id} reactivado`);
  render();
};

// ─── Edición manual ───────────────────────────────────────────────────────
const editarManual = (id, campos, motivo = '') => {
  const corral = encontrarCorral(id);
  if (!corral) return;
  if (campos.etapaActual !== undefined) corral.etapaActual = Number(campos.etapaActual);
  if (campos.duracionEtapaDias !== undefined) {
    corral.duracionEtapaDias = campos.duracionEtapaDias === '' ? null : Number(campos.duracionEtapaDias);
  }
  if (campos.fechaInicioEtapa !== undefined) corral.fechaInicioEtapa = campos.fechaInicioEtapa;
  if (campos.estado !== undefined) corral.estado = campos.estado;
  // Recalcular fecha estimada
  corral.fechaEstimadaCambio = fechaStr(calcFechaEstimada(corral));
  corral.historial.unshift({
    ts: Date.now(),
    accion: `Edición manual: ${JSON.stringify(campos)}.`,
    motivo
  });
  guardar();
  toast(`✏️ Corral ${id} editado`);
  render();
};

// ─── Revisar cambios (lógica diaria, se ejecuta al abrir la app) ──────────
const revisarCambios = () => {
  const hoyDate = hoy();
  corrales.forEach(c => {
    if (c.estado !== 'Activo') return;
    const fechaCambio = parseFecha(c.fechaEstimadaCambio);
    if (!fechaCambio) return;

    const diff = diffDias(fechaCambio, hoyDate);

    // Aviso anticipado sábado si el cambio cae domingo
    if (esDomingo(fechaCambio) && esSabado(hoyDate) && diff === 1) {
      const yaAvisado = avisos.find(a =>
        a.corralId === c.id && a.tipo === 'sabado-anticipado' && a.fecha === fechaStr(hoyDate));
      if (!yaAvisado) {
        agregarAviso('warn', c.id, `⚠️ Aviso anticipado — cambia MAÑANA (domingo)`,
          `Corral ${c.id} tiene cambio de dieta el DOMINGO ${fmt(fechaCambio)}. Programalo hoy o dejalo listo.`,
          'sabado-anticipado');
        notificacion(`⚠️ Corral ${c.id} — Cambio mañana (domingo)`,
          `Programá el cambio de dieta hoy sábado.`);
      }
    }

    // Hoy es el día del cambio y no es domingo
    if (diff === 0 && !esDomingo(fechaCambio)) {
      const yaAvisado = avisos.find(a =>
        a.corralId === c.id && a.tipo === 'cambio-hoy' && a.fecha === fechaStr(hoyDate));
      if (!yaAvisado) {
        const sig = typeof c.etapaActual === 'number' ? c.etapaActual + 1 : null;
        agregarAviso('warn', c.id, `🔔 HOY — Cambio de Adaptación ${c.etapaActual}`,
          sig && sig <= TOTAL_ETAPAS
            ? `Corral ${c.id} pasa hoy a Adaptación ${sig}.`
            : `Corral ${c.id} completa Adaptación ${c.etapaActual} hoy.`,
          'cambio-hoy');
        notificacion(`🔔 Corral ${c.id} — Cambio hoy`,
          `Adaptación ${c.etapaActual} → ${sig || 'Terminación'}.`);
      }
    }

    // Atrasado: 1-3 días sin confirmar
    if (diff < 0 && diff >= -3) {
      const yaAvisado = avisos.find(a =>
        a.corralId === c.id && a.tipo === 'atrasado' && a.fecha === fechaStr(hoyDate));
      if (!yaAvisado) {
        agregarAviso('alert', c.id, `🔴 ATRASADO — Corral ${c.id}`,
          `El cambio de Adaptación ${c.etapaActual} debía hacerse el ${fmt(fechaCambio)} (hace ${Math.abs(diff)} día${Math.abs(diff) > 1 ? 's' : ''}). Confirmá o editá.`,
          'atrasado');
        notificacion(`🔴 ATRASADO — Corral ${c.id}`,
          `Cambio pendiente desde ${fmt(fechaCambio)}.`);
      }
    }

    // Adaptación 1: aviso diario "¿ya agarró la comida?"
    if (c.etapaActual === 1) {
      const diaEnEtapa = diffDias(hoyDate, parseFecha(c.fechaInicioEtapa)) + 1;
      const yaAvisado  = avisos.find(a =>
        a.corralId === c.id && a.tipo === 'ad1-diario' && a.fecha === fechaStr(hoyDate));
      if (!yaAvisado && diaEnEtapa >= 1) {
        agregarAviso('info', c.id, `🌾 Adaptación 1 — Día ${diaEnEtapa}`,
          `Corral ${c.id}: ¿ya agarró la comida? Si es así, confirmá el pase a Adaptación 2.`,
          'ad1-diario');
      }
    }
  });
};

// ─── Avisos ───────────────────────────────────────────────────────────────
const agregarAviso = (nivel, corralId, titulo, detalle, tipo = 'generico') => {
  avisos.unshift({
    id:       Date.now() + Math.random(),
    nivel,    // 'info' | 'warn' | 'alert' | 'done'
    corralId,
    titulo,
    detalle,
    tipo,
    fecha:    fechaStr(hoy()),
    ts:       Date.now(),
    leido:    false
  });
  // Mantener máximo 200 avisos
  if (avisos.length > 200) avisos.length = 200;
};

const avisosNoLeidos = () => avisos.filter(a => !a.leido).length;

const marcarAvisosLeidos = () => {
  avisos.forEach(a => a.leido = true);
  guardar();
  updateBadge();
};

// ─── Telegram Bot API ─────────────────────────────────────────────────────
const enviarTelegram = async (mensaje) => {
  if (!telegramCfg.botToken || !telegramCfg.chatId) return false;
  const token = telegramCfg.botToken.trim();
  const chatId = telegramCfg.chatId.trim();
  if (!token || !chatId) return false;

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: mensaje,
        parse_mode: 'HTML'
      })
    });
    const data = await res.json();
return data.ok;
    } catch (err) {
      console.warn('Error enviando Telegram:', err);
      return false;
    }
  };

const sincronizarConAppsScript = async () => {
  if (!telegramCfg.gasUrl || corrales.length === 0) return;
  try {
    await fetch(telegramCfg.gasUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ corrales })
    });
  } catch (e) {
    console.warn('Error sincronizando con Apps Script:', e);
  }
};

const cargarDesdeAppsScript = async (mostrarToast = false) => {
  if (!telegramCfg.gasUrl) return;
  if (mostrarToast) toast('☁️ Sincronizando con la nube...');
  try {
    const data = await new Promise((resolve, reject) => {
      const cb = 'jpcb_' + Date.now();
      const s = document.createElement('script');
      const t = setTimeout(() => {
        document.body.removeChild(s);
        delete window[cb];
        reject(new Error('timeout'));
      }, 15000);
      window[cb] = (d) => {
        clearTimeout(t);
        document.body.removeChild(s);
        delete window[cb];
        resolve(d);
      };
      const sep = telegramCfg.gasUrl.includes('?') ? '&' : '?';
      s.src = telegramCfg.gasUrl + sep + 'callback=' + cb;
      document.body.appendChild(s);
    });
    if (data && data.ok && Array.isArray(data.corrales)) {
      if (data.corrales.length > 0) {
        corrales = data.corrales;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(corrales));
        revisarCambios();
        render();
        if (mostrarToast) toast(`✅ Sincronizado: ${corrales.length} corrales`);
      } else if (corrales.length > 0) {
        if (mostrarToast) toast('☁️ Subiendo datos locales a la nube...');
        await sincronizarConAppsScript();
        if (mostrarToast) toast(`✅ ${corrales.length} corrales subidos a la nube`);
      } else if (mostrarToast) {
        toast('☁️ Sin datos en la nube ni local.');
      }
    } else if (mostrarToast) {
      toast('⚠️ Error al leer datos de la nube.');
    }
  } catch (e) {
    if (mostrarToast) toast('⚠️ No se pudo conectar con la nube. Verificá que el script esté desplegado como "Cualquier persona, incluso anónimo".');
    console.warn('Error cargando desde Apps Script:', e);
  }
};

// ─── Notificaciones Web & Telegram ────────────────────────────────────────
const notificacion = async (title, body) => {
  // Notificación local del navegador/SO
  if ('Notification' in window && Notification.permission === 'granted') {
    try { new Notification(title, { body, icon: 'icon-192.png' }); } catch {}
  }
  // Notificación a Telegram
  if (telegramCfg.botToken && telegramCfg.chatId) {
    enviarTelegram(`<b>${title}</b>\n${body}`);
  }
};

const pedirPermiso = async () => {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') {
    await Notification.requestPermission();
  }
};

// ─── Toast ────────────────────────────────────────────────────────────────
let toastTimer;
const toast = (msg) => {
  const el = document.getElementById('snackbar');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
};

// ─── Clasificación visual de corrales ────────────────────────────────────
const claseBadge = (c) => {
  if (c.estado === 'Pausado')     return ['badge-pause', '⏸️ Pausado'];
  if (c.estado === 'Terminacion') return ['badge-done', '✅ Terminación'];
  const fechaCambio = parseFecha(c.fechaEstimadaCambio);
  if (!fechaCambio) return ['badge-ok', '✅ Activo'];
  const diff = diffDias(fechaCambio, hoy());
  if (diff < 0 && diff >= -3)   return ['badge-alert', '🔴 Atrasado'];
  if (diff === 0)                return ['badge-warn', '🔔 Hoy!'];
  if (esDomingo(fechaCambio) && esSabado(hoy()) && diff === 1)
                                  return ['badge-warn', '⚠️ Mañana (dom)'];
  return ['badge-ok', `📅 ${fmt(fechaCambio)}`];
};

const claseEtapa = (c) => {
  if (c.estado === 'Terminacion') return 'terminacion';
  if (c.estado === 'Pausado')     return 'pausado';
  const fechaCambio = parseFecha(c.fechaEstimadaCambio);
  if (fechaCambio) {
    const d = diffDias(fechaCambio, hoy());
    if (d < 0) return `etapa-${c.etapaActual} atrasado`;
  }
  return `etapa-${c.etapaActual}`;
};

const diasEnEtapa = (c) => {
  const inicio = parseFecha(c.fechaInicioEtapa);
  if (!inicio) return 0;
  return diffDias(hoy(), inicio) + 1;
};

const diasRestantes = (c) => {
  const fechaCambio = parseFecha(c.fechaEstimadaCambio);
  if (!fechaCambio) return '—';
  const d = diffDias(fechaCambio, hoy());
  if (d < 0) return `${Math.abs(d)}d atrasado`;
  if (d === 0) return '¡Hoy!';
  return `${d}d`;
};

// ─── Render principal ─────────────────────────────────────────────────────
const render = () => {
  renderDashboard();
  renderRegistrar();
  if (detailId) renderDetalle(detailId);
  renderAvisos();
  updateBadge();
};

const updateBadge = () => {
  const n = avisosNoLeidos();
  const badge = document.getElementById('badge-avisos');
  badge.textContent = n > 0 ? (n > 9 ? '9+' : n) : '';
  badge.style.display = n > 0 ? 'flex' : 'none';
};

// ─── Dashboard ────────────────────────────────────────────────────────────
const MESES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'
];
const DIAS_SEMANA = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const renderDashboard = () => {
  const activos = corrales.filter(c => c.estado === 'Activo');
  const statActivosEl = document.getElementById('stat-activos');
  if (statActivosEl) statActivosEl.textContent = activos.length;

  renderCalendario();

  const container = document.getElementById('lista-corrales');
  if (!container) return;

  if (corrales.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🐄</div>
        <h3>Sin corrales registrados</h3>
        <p>Andá a la pestaña <strong>Registrar</strong> y tocá el número de corral que ingresó hoy.</p>
      </div>`;
    return;
  }

  // Ordenar: atrasados primero, luego activos, pausados, terminados
  const ordenados = [...corrales].sort((a, b) => {
    const prioA = estadoPrioridad(a);
    const prioB = estadoPrioridad(b);
    return prioA - prioB;
  });

  container.innerHTML = ordenados.map(c => {
    const [clBadge, txtBadge] = claseBadge(c);
    const clEtapa = claseEtapa(c);
    const duracion = c.duracionEtapaDias ?? DIAS_POR_DIETA;
    const enEtapa  = diasEnEtapa(c);
    const prog     = c.estado === 'Terminacion' ? 100
                   : Math.min(100, Math.round((enEtapa / duracion) * 100));
    const etapaLabel = c.estado === 'Terminacion' ? 'Terminación'
                     : c.estado === 'Pausado'     ? `Ad. ${c.etapaActual} — Pausado`
                     : `Adaptación ${c.etapaActual}`;
    return `
    <div class="corral-card ${clEtapa}" onclick="verDetalle('${c.id}')">
      <div class="card-row">
        <div class="card-id">${c.id}</div>
        <div class="card-meta">
          <div class="card-etapa">${etapaLabel}</div>
          <div class="card-sub">Día ${enEtapa}${c.duracionEtapaDias ? ` de ${c.duracionEtapaDias}` : ''} · Faltan: ${diasRestantes(c)}</div>
        </div>
        <span class="card-badge ${clBadge}">${txtBadge}</span>
      </div>
      <div class="prog-wrap">
        <div class="prog-bar" style="width:${prog}%"></div>
      </div>
    </div>`;
  }).join('');
};

const estadoPrioridad = (c) => {
  if (c.estado === 'Activo') {
    const fechaCambio = parseFecha(c.fechaEstimadaCambio);
    if (fechaCambio) {
      const d = diffDias(fechaCambio, hoy());
      if (d < 0) return 0;  // atrasado = máxima prioridad
      if (d === 0) return 1; // hoy
    }
    return 2; // activo normal
  }
  if (c.estado === 'Pausado')     return 3;
  if (c.estado === 'Terminacion') return 4;
  return 5;
};

// ─── Calendario Mensual ───────────────────────────────────────────────────
const navMes = (delta) => {
  calMes += delta;
  if (calMes > 11) { calMes = 0; calAnio++; }
  if (calMes < 0)  { calMes = 11; calAnio--; }
  renderCalendario();
};

const renderCalendario = () => {
  const container = document.getElementById('cal-container');
  if (!container) return;

  const hoyD = hoy();
  const hoyStr = fechaStr(hoyD);

  const corralesActivos = corrales.filter(c => c.estado === 'Activo');

  // Si no hay corrales activos
  if (corralesActivos.length === 0) {
    container.innerHTML = `
      <div class="cal-wrap">
        <div class="cal-header">
          <button class="cal-nav-btn" onclick="navMes(-1)">‹</button>
          <span class="cal-title">📅 ${MESES[calMes]} ${calAnio}</span>
          <button class="cal-nav-btn" onclick="navMes(1)">›</button>
        </div>
        <div class="cal-empty-hint">Sin corrales en adaptación activa</div>
      </div>
    `;
    return;
  }

  // Precalcular cronograma completo por cada corral activo
  // Si ingresa el 9 por 5 días: come Ad.1 el 9, 10, 11, 12, 13. El 14 arranca Ad.2
  const corralSchedules = corralesActivos.map(c => {
    const etapas = [];
    let curInicio = parseFecha(c.fechaInicioEtapa) || hoyD;
    let curCambio = parseFecha(c.fechaEstimadaCambio) || sumarDias(curInicio, c.duracionEtapaDias ?? DIAS_POR_DIETA);

    for (let e = c.etapaActual; e <= TOTAL_ETAPAS; e++) {
      const dur = (e === c.etapaActual && c.duracionEtapaDias) ? c.duracionEtapaDias : DIAS_POR_DIETA;
      // Último día que come esta dieta = curCambio - 1 día
      const finDieta = sumarDias(curCambio, -1);
      const esDom = esDomingo(curCambio);
      // Si el cambio cae domingo, el aviso se anticipa al sábado
      const avisoDt = esDom ? sumarDias(curCambio, -1) : curCambio;

      etapas.push({
        etapa: e,
        inicio: curInicio,
        inicioStr: fechaStr(curInicio),
        fin: finDieta,
        finStr: fechaStr(finDieta),
        fechaCambio: curCambio,
        cambioStr: fechaStr(curCambio),
        avisoStr: fechaStr(avisoDt),
        esDomingo: esDom,
        proxima: e < TOTAL_ETAPAS ? e + 1 : 'Term.'
      });

      // La siguiente etapa arranca el mismo día del cambio (curCambio)
      curInicio = new Date(curCambio);
      curCambio = sumarDias(curInicio, DIAS_POR_DIETA);
    }

    return { id: c.id, etapas };
  });

  const primerDiaMes = new Date(calAnio, calMes, 1);
  const ultimoDiaMes = new Date(calAnio, calMes + 1, 0);
  const totalDiasMes = ultimoDiaMes.getDate();
  const startDayOfWeek = primerDiaMes.getDay(); // 0 = Domingo

  let cellsHtml = '';

  // Días previos (mes anterior)
  const ultimoDiaMesAnt = new Date(calAnio, calMes, 0).getDate();
  for (let i = startDayOfWeek - 1; i >= 0; i--) {
    const num = ultimoDiaMesAnt - i;
    cellsHtml += `<div class="cal-cell other-month"><span class="cal-day-num">${num}</span></div>`;
  }

  // Días del mes actual
  for (let dia = 1; dia <= totalDiasMes; dia++) {
    const currDate = new Date(calAnio, calMes, dia);
    const dStr = fechaStr(currDate);
    const isToday = dStr === hoyStr;
    const isSun = currDate.getDay() === 0;
    const isSat = currDate.getDay() === 6;

    let hasAnyActivity = false;
    let lanesHtml = '';

    // Renderizar una pista/carril para cada corral activo
    corralSchedules.forEach(cs => {
      // Encontrar si este día cae en alguna etapa del corral
      let segInfo = null;
      for (const et of cs.etapas) {
        if (dStr >= et.inicioStr && dStr <= et.finStr) {
          const isStart = dStr === et.inicioStr;
          const isEnd   = dStr === et.finStr;
          const isAviso = dStr === et.avisoStr;
          segInfo = {
            etapa: et.etapa,
            isStart,
            isEnd,
            isAviso,
            esDomingo: et.esDomingo,
            proxima: et.proxima,
            corralId: cs.id,
            isCambioDia: false
          };
          break;
        } else if (dStr === et.cambioStr && et.etapa === TOTAL_ETAPAS) {
          // Día en que entra a terminación
          segInfo = {
            etapa: 'Term',
            isStart: true,
            isEnd: true,
            isAviso: dStr === et.avisoStr,
            esDomingo: et.esDomingo,
            proxima: 'Term.',
            corralId: cs.id,
            isCambioDia: true
          };
          break;
        }
      }

      if (segInfo) {
        hasAnyActivity = true;
        const clBg = segInfo.etapa === 'Term' ? 'bg-term' : `bg-e${segInfo.etapa}`;
        const shapeCl = segInfo.isStart && segInfo.isEnd ? 'seg-both'
                      : segInfo.isStart ? 'seg-start'
                      : segInfo.isEnd ? 'seg-end' : '';

        // Marcador visual vertical en el día del aviso o fin de etapa (cambio de dieta)
        let markerHtml = '';
        if (segInfo.isAviso || segInfo.isEnd) {
          const markerType = segInfo.esDomingo ? 'marker-dom' : '';
          const avisoTitle = segInfo.esDomingo ? `¡Aviso sábado! Cambio domingo para ${segInfo.corralId}` : `Cambio de dieta para ${segInfo.corralId}`;
          markerHtml = `<span class="cal-change-marker ${markerType}" title="${avisoTitle}"></span>`;
        }

        // Mostrar label legible (ej: A1: 1, A1: 2, 7: 1, 7: 2)
        const showLabel = segInfo.isStart || currDate.getDay() === 1;
        const txt = showLabel ? (segInfo.etapa === 'Term' ? `${segInfo.corralId}: Term` : `${segInfo.corralId}: ${segInfo.etapa}`) : '';

        lanesHtml += `
          <div class="cal-corral-lane" title="Corral ${segInfo.corralId} · ${segInfo.etapa === 'Term' ? 'Entra a Terminación' : `Adaptación ${segInfo.etapa}`}">
            <div class="cal-bar-segment ${clBg} ${shapeCl}" onclick="event.stopPropagation(); verDetalle('${segInfo.corralId}')">
              ${txt}
            </div>
            ${markerHtml}
          </div>
        `;
      } else {
        // Espacio vacío para mantener alineada la pista de este corral
        lanesHtml += `<div class="cal-corral-lane"></div>`;
      }
    });

    const clExtra = [
      isToday ? 'today' : '',
      isSun ? 'is-sunday' : '',
      isSat ? 'is-saturday' : '',
      hasAnyActivity ? 'has-activity' : ''
    ].filter(Boolean).join(' ');

    cellsHtml += `
      <div class="cal-cell ${clExtra}">
        <span class="cal-day-num">${dia}</span>
        <div class="cal-corral-track">
          ${lanesHtml}
        </div>
      </div>
    `;
  }

  // Días sobrantes para completar última fila
  const totalSlots = startDayOfWeek + totalDiasMes;
  const remSlots = (7 - (totalSlots % 7)) % 7;
  for (let d = 1; d <= remSlots; d++) {
    cellsHtml += `<div class="cal-cell other-month"><span class="cal-day-num">${d}</span></div>`;
  }

  const dowHtml = DIAS_SEMANA.map((d, i) => `
    <div class="cal-dow-label ${i === 0 ? 'dow-dom' : ''}">${d}</div>
  `).join('');

  // Leyenda de etapas
  const legendHtml = `
    <div class="cal-legend">
      <div class="cal-legend-item"><span class="cal-legend-dot bg-e1"></span> Ad. 1</div>
      <div class="cal-legend-item"><span class="cal-legend-dot bg-e2"></span> Ad. 2</div>
      <div class="cal-legend-item"><span class="cal-legend-dot bg-e3"></span> Ad. 3</div>
      <div class="cal-legend-item"><span class="cal-legend-dot bg-e4"></span> Ad. 4</div>
      <div class="cal-legend-item"><span class="cal-legend-dot bg-e5"></span> Ad. 5</div>
      <div class="cal-legend-item" style="margin-left:auto; color:var(--text-muted)">⚪ Línea = Día de cambio</div>
    </div>
  `;

  container.innerHTML = `
    <div class="cal-wrap">
      <div class="cal-header">
        <button class="cal-nav-btn" onclick="navMes(-1)" title="Mes anterior">‹</button>
        <span class="cal-title">📅 ${MESES[calMes]} ${calAnio}</span>
        <button class="cal-nav-btn" onclick="navMes(1)" title="Mes siguiente">›</button>
      </div>
      ${legendHtml}
      <div class="cal-dow">
        ${dowHtml}
      </div>
      <div class="cal-grid">
        ${cellsHtml}
      </div>
    </div>
  `;
};

// ─── Detalle de corral ────────────────────────────────────────────────────
const verDetalle = (id) => {
  detailId = id;
  extendPickerOpen  = false;
  restartPickerOpen = false;
  showPage('detalle');
  renderDetalle(id);
};

const renderDetalle = (id) => {
  const c = encontrarCorral(id);
  if (!c) return;

  const container = document.getElementById('detalle-content');
  const duracion  = c.duracionEtapaDias ?? DIAS_POR_DIETA;
  const enEtapa   = diasEnEtapa(c);
  const prog      = c.estado === 'Terminacion' ? 100
                  : Math.min(100, Math.round((enEtapa / duracion) * 100));
  const circumference = 326;
  const dashOffset    = circumference - (prog / 100) * circumference;

  const colorRing = c.estado === 'Terminacion' ? '#a855f7'
    : c.etapaActual === 1 ? '#eab308'
    : c.etapaActual === 2 ? '#f97316'
    : c.etapaActual === 3 ? '#3b82f6'
    : c.etapaActual === 4 ? '#a855f7'
    : '#22c55e';

  const etapaLabel = c.estado === 'Terminacion' ? 'Terminación'
                   : `Adaptación ${c.etapaActual}`;

  const fechaCambio = parseFecha(c.fechaEstimadaCambio);
  const [clBadge, txtBadge] = claseBadge(c);

  // Adaptación 1 prompt
  const ad1Html = c.etapaActual === 1 && c.estado === 'Activo' ? `
    <div class="ad1-prompt">
      <div class="ad1-emoji">🌾</div>
      <p>Día <strong>${enEtapa}</strong> en Adaptación 1 — ¿Ya agarró la comida?</p>
      <div class="ad1-btn-row">
        <button class="btn btn-success" onclick="confirmarCambioEtapa('${c.id}', 'Ya come bien')">
          ✅ Sí, pasá a Adaptación 2
        </button>
        <button class="btn btn-ghost" onclick="toast('Bien, se sigue monitoreando 📋')">
          ❌ Todavía no
        </button>
      </div>
    </div>` : '';

  // Botones de acción según estado
  let accionesHtml = '';
  if (c.estado === 'Activo') {
    accionesHtml = `
      <div class="actions-panel">
        <div class="actions-title">Acciones</div>
        ${c.etapaActual !== 1 ? `
        <button class="btn btn-success" onclick="confirmarCambioEtapa('${c.id}')">
          ✅ Confirmar cambio de etapa hoy
        </button>` : ''}
        <button class="btn btn-warn" onclick="toggleExtendPicker()">
          ➕ Extender días
        </button>
        <div class="extend-picker ${extendPickerOpen ? 'open' : ''}" id="extend-picker">
          <div class="extend-picker-label">¿Cuántos días más?</div>
          <div class="extend-chips">
            ${[1,2,3,5,7].map(d => `<span class="chip" onclick="extenderDias('${c.id}', ${d}, 'Ajuste manual'); toggleExtendPicker()">+${d}d</span>`).join('')}
          </div>
        </div>
        <button class="btn btn-warn" onclick="toggleRestartPicker()">
          🔄 Reiniciar adaptación
        </button>
        <div class="restart-picker ${restartPickerOpen ? 'open' : ''}" id="restart-picker">
          <div class="restart-picker-label">Volver a etapa:</div>
          <div class="extend-chips">
            ${[1,2,3,4].map(e => `<span class="chip" onclick="pedirReinicio('${c.id}', ${e})">Adap. ${e}</span>`).join('')}
          </div>
        </div>
        <button class="btn btn-ghost" onclick="pausarCorral('${c.id}')">
          ⏸️ Marcar en enfermería / pausar
        </button>
        <button class="btn btn-ghost" onclick="abrirModalEditar('${c.id}')">
          ✏️ Editar manualmente
        </button>
        ${confirmandoEliminar ? `
        <div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:12px;padding:12px;margin-top:4px">
          <p style="font-size:13px;color:#ef4444;margin:0 0 10px;text-align:center">⚠️ ¿Eliminar corral ${c.id} y su historial?</p>
          <div class="btn-row">
            <button class="btn btn-ghost btn-sm" onclick="cancelarEliminar('${c.id}')">Cancelar</button>
            <button class="btn btn-danger btn-sm" onclick="eliminarCorral('${c.id}')">Sí, eliminar</button>
          </div>
        </div>` : `
        <button class="btn btn-danger" onclick="pedirConfirmacionEliminar('${c.id}')">
          🗑️ Eliminar corral
        </button>`}
      </div>`;
  } else if (c.estado === 'Pausado') {
    accionesHtml = `
      <div class="actions-panel">
        <div class="actions-title">Acciones</div>
        <button class="btn btn-primary" onclick="pausarCorral('${c.id}')">
          ▶️ Reactivar corral
        </button>
        <button class="btn btn-ghost" onclick="abrirModalEditar('${c.id}')">
          ✏️ Editar manualmente
        </button>
        ${confirmandoEliminar ? `
        <div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:12px;padding:12px;margin-top:4px">
          <p style="font-size:13px;color:#ef4444;margin:0 0 10px;text-align:center">⚠️ ¿Eliminar corral ${c.id} y su historial?</p>
          <div class="btn-row">
            <button class="btn btn-ghost btn-sm" onclick="cancelarEliminar('${c.id}')">Cancelar</button>
            <button class="btn btn-danger btn-sm" onclick="eliminarCorral('${c.id}')">Sí, eliminar</button>
          </div>
        </div>` : `
        <button class="btn btn-danger" onclick="pedirConfirmacionEliminar('${c.id}')">
          🗑️ Eliminar corral
        </button>`}
      </div>`;
  } else if (c.estado === 'Terminacion') {
    accionesHtml = `
      <div class="actions-panel">
        <div class="actions-title">Corral en Terminación</div>
        <button class="btn btn-primary" onclick="registrarIngreso('${c.id}')">
          🐄 Nuevo ingreso — iniciar adaptación
        </button>
        <button class="btn btn-ghost" onclick="liberarCorral('${c.id}')">
          🧹 Corral vacío — liberar
        </button>
        ${confirmandoEliminar ? `
        <div style="background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.3);border-radius:12px;padding:12px;margin-top:4px">
          <p style="font-size:13px;color:#ef4444;margin:0 0 10px;text-align:center">⚠️ ¿Eliminar registro de corral ${c.id}?</p>
          <div class="btn-row">
            <button class="btn btn-ghost btn-sm" onclick="cancelarEliminar('${c.id}')">Cancelar</button>
            <button class="btn btn-danger btn-sm" onclick="eliminarCorral('${c.id}')">Sí, eliminar</button>
          </div>
        </div>` : `
        <button class="btn btn-danger" onclick="pedirConfirmacionEliminar('${c.id}')">
          🗑️ Eliminar registro
        </button>`}
      </div>`;
  }

  // Historial
  const histHtml = c.historial.length === 0 ? '<p class="text-muted" style="font-size:13px">Sin historial.</p>' :
    c.historial.map(h => `
      <div class="hist-item">
        <div class="hist-dot"></div>
        <div class="hist-body">
          <div class="hist-action">${h.accion}</div>
          ${h.motivo ? `<div class="hist-motivo">"${h.motivo}"</div>` : ''}
          <div class="hist-time">${fmtTs(h.ts)}</div>
        </div>
      </div>`).join('');

  container.innerHTML = `
    <div class="detail-header">
      <div class="back-btn" onclick="volverDashboard()">←</div>
      <div>
        <div class="detail-id">Corral ${c.id}</div>
        <div class="detail-status">
          <span class="card-badge ${clBadge}" style="padding:2px 8px;font-size:11px">${txtBadge}</span>
        </div>
      </div>
    </div>

    <div class="progress-ring-wrap">
      <div class="ring-container">
        <svg class="ring-svg" width="130" height="130" viewBox="0 0 130 130">
          <circle class="ring-track" cx="65" cy="65" r="52"/>
          <circle class="ring-progress" cx="65" cy="65" r="52"
            style="stroke:${colorRing};stroke-dashoffset:${dashOffset}"/>
        </svg>
        <div class="ring-center">
          <div class="ring-day" style="color:${colorRing}">${enEtapa}</div>
          <div class="ring-of">de ${c.estado === 'Terminacion' ? '∞' : duracion}</div>
        </div>
      </div>
      <div class="etapa-label">${etapaLabel}</div>
      <div class="etapa-sublabel">
        ${c.estado === 'Terminacion'
          ? 'Proceso de adaptación completado'
          : fechaCambio
            ? `Próximo cambio: ${fmt(fechaCambio)}`
            : 'Sin fecha estimada'}
      </div>
    </div>

    ${ad1Html}
    ${accionesHtml}

    <div class="historial-wrap">
      <div class="historial-title">Historial</div>
      ${histHtml}
    </div>`;
};

const volverDashboard = () => {
  detailId = null;
  confirmandoEliminar = false;
  showPage('dashboard');
};

const toggleExtendPicker = () => {
  extendPickerOpen = !extendPickerOpen;
  restartPickerOpen = false;
  renderDetalle(detailId);
};

const toggleRestartPicker = () => {
  restartPickerOpen = !restartPickerOpen;
  extendPickerOpen  = false;
  renderDetalle(detailId);
};

const pedirReinicio = (id, etapa) => {
  reiniciarAdaptacion(id, etapa, '');
  restartPickerOpen = false;
  renderDetalle(id);
};

// ─── Registrar page ───────────────────────────────────────────────────────
const renderRegistrar = () => {
  // Grid numérico
  const gridNum = document.getElementById('grid-numericos');
  if (!gridNum) return;
  gridNum.innerHTML = CORRALES_NUMERICOS.map(id => {
    const c = encontrarCorral(id);
    const clExtra = !c ? '' : c.estado === 'Terminacion' ? 'has-term'
      : `has-active etapa-${c.etapaActual}`;
    return `<button class="btn-corral ${clExtra}" onclick="regDesdeGrid('${id}')">${id}</button>`;
  }).join('');

  // Grid nominales
  const gridNom = document.getElementById('grid-nominales');
  if (!gridNom) return;
  gridNom.innerHTML = CORRALES_NOMINALES.map(({ id, label, nota }) => {
    const c = encontrarCorral(id);
    const clExtra = !c ? '' : c.estado === 'Terminacion' ? 'has-term' : 'has-active';
    return `
      <button class="btn-corral-named ${clExtra}" onclick="regDesdeGrid('${id}')">
        ${label}
        ${nota ? `<small>${nota}</small>` : ''}
      </button>`;
  }).join('');
};

const regDesdeGrid = (id) => {
  const c = encontrarCorral(id);
  if (c && c.estado === 'Activo') {
    // Ya activo — preguntar si es reingreso
    const confirmar = confirm(`⚠️ Corral ${id} ya está activo en Adaptación ${c.etapaActual}.\n¿Ingresaron terneros nuevos? Esto reiniciará la adaptación a 0.`);
    if (!confirmar) return;
  }
  registrarIngreso(id);
};

const procesarTextoLibre = () => {
  const input = document.getElementById('input-texto-libre');
  const texto = input.value.trim();
  if (!texto) return;

  // Tolera texto libre: busca números o nombres de corrales
  // Ej: "ingreso corral 7", "A2 hoy", "14", "corral B"
  let idEncontrado = null;

  // Buscar nombres de corrales nominales primero
  const textUp = texto.toUpperCase();
  for (const { id } of CORRALES_NOMINALES) {
    if (textUp.includes(id)) { idEncontrado = id; break; }
  }

  // Si no encontró nominal, buscar número
  if (!idEncontrado) {
    const match = texto.match(/\b(\d{1,2})\b/);
    if (match) {
      const num = String(parseInt(match[1]));
      if (CORRALES_NUMERICOS.includes(num)) idEncontrado = num;
    }
  }

  if (!idEncontrado) {
    toast(`❌ No encontré un corral válido en: "${texto}"`);
    return;
  }

  input.value = '';
  regDesdeGrid(idEncontrado);
};

// ─── Avisos page ──────────────────────────────────────────────────────────
const renderAvisos = () => {
  marcarAvisosLeidos();
  const container = document.getElementById('lista-avisos');
  if (!container) return;

  if (avisos.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔕</div>
        <h3>Sin avisos</h3>
        <p>Los avisos diarios de cambio de dieta aparecerán aquí.</p>
      </div>`;
    return;
  }

  container.innerHTML = avisos.map(a => `
    <div class="aviso-item ${a.nivel}" onclick="verDetalle('${a.corralId}')">
      <div class="aviso-icon">${iconoNivel(a.nivel)}</div>
      <div class="aviso-body">
        <div class="aviso-title">${a.titulo}</div>
        <div class="aviso-sub">${a.detalle}</div>
        <div class="aviso-time">${fmtTs(a.ts)}</div>
      </div>
    </div>`).join('');
};

const iconoNivel = (nivel) => ({
  alert: '🔴', warn: '⚠️', info: '🔔', done: '🏁'
}[nivel] || '📢');

// ─── Modal editar manual ──────────────────────────────────────────────────
const abrirModalEditar = (id) => {
  const c = encontrarCorral(id);
  if (!c) return;
  document.getElementById('modal-corral-id').textContent = `Corral ${id}`;
  document.getElementById('modal-etapa').value    = c.etapaActual === 'Terminacion' ? 6 : c.etapaActual;
  document.getElementById('modal-duracion').value  = c.duracionEtapaDias ?? '';
  document.getElementById('modal-inicio').value    = c.fechaInicioEtapa ?? '';
  document.getElementById('modal-estado').value    = c.estado;
  document.getElementById('modal-motivo').value    = '';
  document.getElementById('modal-id-hidden').value = id;
  document.getElementById('modal-overlay').classList.add('open');
};

const cerrarModal = () => {
  document.getElementById('modal-overlay').classList.remove('open');
};

const guardarEdicionManual = () => {
  const id      = document.getElementById('modal-id-hidden').value;
  const etapa   = document.getElementById('modal-etapa').value;
  const dur     = document.getElementById('modal-duracion').value;
  const inicio  = document.getElementById('modal-inicio').value;
  const estado  = document.getElementById('modal-estado').value;
  const motivo  = document.getElementById('modal-motivo').value.trim();

  const campos = {
    etapaActual:       etapa === '6' ? 'Terminacion' : Number(etapa),
    duracionEtapaDias: dur,
    fechaInicioEtapa:  inicio,
    estado
  };
  editarManual(id, campos, motivo);
  cerrarModal();
  if (detailId === id) renderDetalle(id);
};

// ─── Navegación ───────────────────────────────────────────────────────────
const showPage = (name) => {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const page = document.getElementById(`page-${name}`);
  if (page) page.classList.add('active');
  const nav  = document.querySelector(`[data-page="${name}"]`);
  if (nav)  nav.classList.add('active');
  activeTab = name;
  if (name === 'avisos') marcarAvisosLeidos();
};

// ─── Init ─────────────────────────────────────────────────────────────────
const init = async () => {
  cargar();
  revisarCambios();

  // Sincronizar con la nube al iniciar (JSONP para evitar CORS)
  if (telegramCfg.gasUrl) {
    try {
      const data = await new Promise((resolve, reject) => {
        const cb = 'jpcb_' + Date.now();
        const s = document.createElement('script');
        const t = setTimeout(() => {
          document.body.removeChild(s);
          delete window[cb];
          reject(new Error('timeout'));
        }, 15000);
        window[cb] = (d) => {
          clearTimeout(t);
          document.body.removeChild(s);
          delete window[cb];
          resolve(d);
        };
        const sep = telegramCfg.gasUrl.includes('?') ? '&' : '?';
        s.src = telegramCfg.gasUrl + sep + 'callback=' + cb;
        document.body.appendChild(s);
      });
      if (data && data.ok && Array.isArray(data.corrales)) {
        if (data.corrales.length > 0) {
          corrales = data.corrales;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(corrales));
          revisarCambios();
        } else if (corrales.length > 0) {
          await sincronizarConAppsScript();
        }
      }
    } catch (e) {
      console.warn('Error en sincronización inicial:', e);
    }
  }

  guardar();
  render();
  pedirPermiso();

  // Navegación
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', () => {
      const pg = item.dataset.page;
      if (pg === 'detalle') return;
      detailId = null;
      showPage(pg);
      render();
    });
  });

  // Texto libre — Enter
  document.getElementById('input-texto-libre')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') procesarTextoLibre();
  });

  // Modal overlays close on backdrop
  document.getElementById('modal-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-overlay') cerrarModal();
  });
  document.getElementById('modal-config-overlay')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-config-overlay') cerrarModalConfig();
  });

  showPage('dashboard');
};

// ─── PWA Install Prompt ───────────────────────────────────────────────────
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('btn-instalar');
  if (btn) btn.style.display = 'flex';
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const btn = document.getElementById('btn-instalar');
  if (btn) btn.style.display = 'none';
  toast('✅ ¡Feedlot instalado con éxito!');
});

const instalarPWA = async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    deferredInstallPrompt = null;
    const btn = document.getElementById('btn-instalar');
    if (btn) btn.style.display = 'none';
  }
};

// Exponer globales que usa el HTML inline
Object.assign(window, {
  registrarIngreso,
  confirmarCambioEtapa,
  extenderDias,
  reiniciarAdaptacion,
  pausarCorral,
  eliminarCorral,
  liberarCorral,
  pedirConfirmacionEliminar,
  cancelarEliminar,
  editarManual,
  verDetalle,
  volverDashboard,
  toggleExtendPicker,
  toggleRestartPicker,
  pedirReinicio,
  regDesdeGrid,
  procesarTextoLibre,
  abrirModalEditar,
  cerrarModal,
  guardarEdicionManual,
  instalarPWA,
  showPage,
  toast,
  navMes,
  renderCalendario,
});

document.addEventListener('DOMContentLoaded', init);
