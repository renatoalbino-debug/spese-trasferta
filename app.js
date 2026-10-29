'use strict';

/* ---------- Utilità ---------- */
const $ = s => document.querySelector(s);
const eur = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' });
const pad = n => String(n).padStart(2, '0');
const localISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => localISO(new Date());
const fmtDate = d => new Date(d + 'T00:00:00').toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit', year: 'numeric' });
const monthName = m => {
  const [y, mm] = m.split('-').map(Number);
  const s = new Date(y, mm - 1, 1).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  return s[0].toUpperCase() + s.slice(1);
};
const shiftMonth = (m, delta) => {
  const [y, mm] = m.split('-').map(Number);
  const d = new Date(y, mm - 1 + delta, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sum = arr => arr.reduce((a, e) => a + e.importo, 0);

function parseAmount(v) {
  v = String(v).trim().replace(/[€\s]/g, '');
  if (v.includes(',')) v = v.replace(/\./g, '').replace(',', '.');
  const n = Number(v);
  return v && Number.isFinite(n) ? Math.round(n * 100) / 100 : NaN;
}

function toast(msg) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  // Dentro un dialog aperto, altrimenti resterebbe nascosto sotto di esso.
  (document.querySelector('dialog[open]') || document.body).appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2600);
}

/* ---------- Database (IndexedDB, solo sul telefono) ---------- */
let db;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('spese-trasferta', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('trips', { keyPath: 'id' });
      d.createObjectStore('expenses', { keyPath: 'id' });
      d.createObjectStore('settings', { keyPath: 'key' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
function tx(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const r = fn(t.objectStore(store));
    t.oncomplete = () => res(r && r.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const getAll = s => tx(s, 'readonly', st => st.getAll());
const get = (s, k) => tx(s, 'readonly', st => st.get(k));
const put = (s, v) => tx(s, 'readwrite', st => st.put(v));
const del = (s, k) => tx(s, 'readwrite', st => st.delete(k));
const setSetting = (key, value) => put('settings', { key, value });

/* ---------- Stato ---------- */
const state = { trips: [], expenses: [], nome: '', lastBackup: null, month: today().slice(0, 7), view: 'spese' };
const DEFAULT_CAUSALI = ['Vitto', 'Alloggio', 'Carburante', 'Pedaggio autostradale', 'Parcheggio', 'Taxi', 'Treno', 'Aereo',
  'Noleggio auto', 'Mezzi pubblici', 'Cancelleria', 'Spese postali', 'Telefono', 'Altro'];
const TITLES = { spese: 'Spese', trasferte: 'Trasferte', report: 'Report mensile', impostazioni: 'Impostazioni' };

async function loadAll() {
  state.trips = await getAll('trips');
  state.expenses = await getAll('expenses');
  state.nome = (await get('settings', 'nome'))?.value || '';
  state.lastBackup = (await get('settings', 'lastBackup'))?.value || null;
}

const tripById = id => state.trips.find(t => t.id === id);
const tripsSorted = () => [...state.trips].sort((a, b) => (b.dal || '').localeCompare(a.dal || ''));
function tripDates(t) {
  if (t.dal && t.al) return t.dal === t.al ? fmtDate(t.dal) : `${fmtDate(t.dal)} – ${fmtDate(t.al)}`;
  if (t.dal) return 'dal ' + fmtDate(t.dal);
  return 'date non indicate';
}
const guessTrip = date => state.trips.find(t => t.dal && date >= t.dal && date <= (t.al || t.dal));

// Spese del mese, divise in gruppi: una per trasferta, poi le spese varie.
function groupMonth(m) {
  const list = state.expenses.filter(e => e.data.slice(0, 7) === m)
    .sort((a, b) => a.data.localeCompare(b.data) || a.createdAt - b.createdAt);
  const map = new Map();
  for (const e of list) {
    const key = e.tipo === 'trasferta' && tripById(e.tripId) ? e.tripId : 'varie';
    if (!map.has(key)) map.set(key, { key, trip: key === 'varie' ? null : tripById(key), items: [] });
    map.get(key).items.push(e);
  }
  const groups = [...map.values()].sort((a, b) =>
    (a.key === 'varie') - (b.key === 'varie') || (a.trip.dal || '').localeCompare(b.trip.dal || ''));
  return { list, groups };
}
const groupTitle = g => g.trip ? `🧳 ${g.trip.nome}` : '🗂 Spese varie del mese';

/* ---------- URL delle foto ---------- */
let urls = [];
function objUrl(blob) { const u = URL.createObjectURL(blob); urls.push(u); return u; }
function resetUrls() { urls.forEach(u => URL.revokeObjectURL(u)); urls = []; }

/* ---------- Rendering ---------- */
function render() {
  resetUrls();
  fillCausali();
  renderSpese();
  renderTrips();
  renderSettings();
  if (state.view === 'report') renderReport();
}

function fillCausali() {
  const count = new Map();
  for (const e of state.expenses) count.set(e.causale, (count.get(e.causale) || 0) + 1);
  const used = [...count.keys()].sort((a, b) => count.get(b) - count.get(a));
  const all = [...new Set([...used, ...DEFAULT_CAUSALI])];
  $('#causali').innerHTML = all.map(c => `<option value="${esc(c)}">`).join('');
}

function itemHTML(e) {
  const thumb = e.foto ? `<img class="thumb" src="${objUrl(e.foto)}" alt="">` : '<div class="thumb none">🧾</div>';
  return `<button class="item" data-exp="${e.id}">${thumb}<div class="item-main">
    <div class="item-title">${esc(e.causale)}</div>
    <div class="item-sub">${fmtDate(e.data)}${e.note ? ' · ' + esc(e.note) : ''}</div></div>
    <div class="item-amt">${eur.format(e.importo)}</div></button>`;
}

function renderSpese() {
  $('#month-label').textContent = monthName(state.month);
  const { list, groups } = groupMonth(state.month);
  $('#month-total').textContent = eur.format(sum(list));

  const days = state.lastBackup ? (Date.now() - new Date(state.lastBackup)) / 864e5 : Infinity;
  $('#backup-banner').innerHTML = state.expenses.length && days > 30
    ? `<div class="banner"><span>${state.lastBackup ? 'Ultimo backup più di un mese fa.' : 'Non hai ancora fatto un backup.'}</span>
       <button class="btn small" data-action="backup">Fai backup</button></div>` : '';

  $('#expense-list').innerHTML = list.length
    ? groups.map(g => `<div class="group"><div class="group-head"><span>${esc(groupTitle(g))}</span>
        <span>${eur.format(sum(g.items))}</span></div>${g.items.map(itemHTML).join('')}</div>`).join('')
    : '<div class="empty">Nessuno scontrino in questo mese.<br>Tocca 📷 per aggiungerne uno.</div>';
}

function renderTrips() {
  const trips = tripsSorted();
  $('#trip-list').innerHTML = trips.length ? trips.map(t => {
    const its = state.expenses.filter(e => e.tipo === 'trasferta' && e.tripId === t.id);
    return `<button class="item" data-trip="${t.id}"><div class="thumb none">🧳</div><div class="item-main">
      <div class="item-title">${esc(t.nome)}</div>
      <div class="item-sub">${tripDates(t)} · ${its.length} scontrin${its.length === 1 ? 'o' : 'i'}</div></div>
      <div class="item-amt">${eur.format(sum(its))}</div></button>`;
  }).join('') : '<div class="empty">Nessuna trasferta.<br>Creane una per raggrupparvi gli scontrini.</div>';
}

function renderReport() {
  const m = $('#report-month').value || state.month;
  const { list, groups } = groupMonth(m);
  let h = `<div class="report-doc"><h2>Nota spese – ${esc(monthName(m))}</h2>${state.nome ? `<p class="muted">${esc(state.nome)}</p>` : ''}`;
  if (!list.length) {
    $('#report').innerHTML = h + '<p class="empty">Nessuna spesa registrata in questo mese.</p></div>';
    return;
  }
  let n = 0;
  const numbered = [];
  for (const g of groups) {
    h += `<h3>${esc(groupTitle(g))}${g.trip ? ` <span class="muted">(${tripDates(g.trip)})</span>` : ''}</h3>
      <table><thead><tr><th>N.</th><th>Data</th><th>Causale</th><th>Note</th><th class="num">Importo</th></tr></thead><tbody>`;
    for (const e of g.items) {
      numbered.push({ n: ++n, e });
      h += `<tr><td>${n}</td><td>${fmtDate(e.data)}</td><td>${esc(e.causale)}</td><td>${esc(e.note)}</td><td class="num">${eur.format(e.importo)}</td></tr>`;
    }
    h += `</tbody><tfoot><tr><td colspan="4">Totale ${g.trip ? 'trasferta' : 'spese varie'}</td>
      <td class="num">${eur.format(sum(g.items))}</td></tr></tfoot></table>`;
  }

  const byCausale = new Map();
  for (const e of list) {
    const k = e.causale.trim().toLowerCase();
    const cur = byCausale.get(k) || { label: e.causale.trim(), tot: 0, n: 0 };
    cur.tot += e.importo; cur.n++;
    byCausale.set(k, cur);
  }
  h += `<h3>Riepilogo per causale</h3><table><thead><tr><th>Causale</th><th class="num">Scontrini</th><th class="num">Totale</th></tr></thead><tbody>
    ${[...byCausale.values()].sort((a, b) => b.tot - a.tot).map(c =>
      `<tr><td>${esc(c.label)}</td><td class="num">${c.n}</td><td class="num">${eur.format(c.tot)}</td></tr>`).join('')}
    </tbody></table>
    <div class="grand"><span>Totale del mese</span><span>${eur.format(sum(list))}</span></div>`;

  const withPhoto = numbered.filter(x => x.e.foto);
  if ($('#report-photos').checked && withPhoto.length) {
    h += `<h3 class="page-break">Allegati – scontrini</h3><div class="annex">${withPhoto.map(({ n, e }) =>
      `<figure><img src="${objUrl(e.foto)}" alt=""><figcaption>N. ${n} · ${fmtDate(e.data)} · ${esc(e.causale)} · ${eur.format(e.importo)}</figcaption></figure>`).join('')}</div>`;
  }
  $('#report').innerHTML = h + '</div>';
}

async function renderSettings() {
  if (document.activeElement !== $('#s-nome')) $('#s-nome').value = state.nome;
  $('#last-backup').textContent = state.lastBackup
    ? 'Ultimo backup: ' + new Date(state.lastBackup).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })
    : 'Nessun backup effettuato.';
  if (navigator.storage?.estimate) {
    const { usage } = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    $('#storage-info').textContent = `${state.expenses.length} scontrini, ${state.trips.length} trasferte · circa ${(usage / 1048576).toFixed(1)} MB.`
      + (persisted ? ' Archiviazione protetta dalla pulizia automatica.' : '');
  }
}

function showView(v) {
  state.view = v;
  document.querySelectorAll('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  document.querySelectorAll('.tabbar button').forEach(b => b.classList.toggle('active', b.dataset.view === v));
  $('#title').textContent = TITLES[v];
  $('#fab').hidden = !(v === 'spese' || v === 'trasferte');
  if (v === 'report') renderReport();
  window.scrollTo(0, 0);
}

/* ---------- Foto ---------- */
// Riduce la foto a 1600 px: resta leggibile ma occupa ~300 KB invece di diversi MB.
async function compressImage(file) {
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * sc);
    c.height = Math.round(bmp.height * sc);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    return await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
  } catch {
    return file;
  }
}

function openViewer(src) {
  $('#viewer img').src = src;
  $('#viewer').showModal();
}

/* ---------- Scontrino: nuovo / modifica ---------- */
let editing = null;
let draftPhoto = null;
let previewUrl = null;

function setPhoto(blob) {
  draftPhoto = blob;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = blob ? URL.createObjectURL(blob) : null;
  const img = $('#photo-preview');
  img.hidden = !blob;
  if (blob) img.src = previewUrl; else img.removeAttribute('src');
  $('#photo-empty').hidden = !!blob;
  $('#btn-rmphoto').hidden = !blob;
}

function fillTripSelect(selected) {
  $('#f-trip').innerHTML = '<option value="">— Scegli la trasferta —</option>'
    + tripsSorted().map(t => `<option value="${t.id}">${esc(t.nome)} (${tripDates(t)})</option>`).join('')
    + '<option value="__new">➕ Nuova trasferta…</option>';
  $('#f-trip').value = selected || '';
}

const currentTipo = () => document.querySelector('input[name=tipo]:checked').value;
function setTipo(tipo) {
  document.querySelector(`input[name=tipo][value=${tipo}]`).checked = true;
  $('#trip-select-wrap').hidden = tipo !== 'trasferta';
}

function openExpense(id) {
  const e = id ? state.expenses.find(x => x.id === id) : null;
  editing = e;
  $('#expense-dlg-title').textContent = e ? 'Modifica scontrino' : 'Nuovo scontrino';
  setPhoto(e?.foto || null);
  $('#f-importo').value = e ? e.importo.toFixed(2).replace('.', ',') : '';
  const date = e?.data || today();
  $('#f-data').value = date;
  $('#f-causale').value = e?.causale || '';
  $('#f-note').value = e?.note || '';
  const trip = e ? (e.tipo === 'trasferta' ? e.tripId : null) : guessTrip(date)?.id;
  fillTripSelect(trip);
  setTipo(e ? e.tipo : (trip ? 'trasferta' : 'varie'));
  $('#btn-delete-expense').hidden = !e;
  $('#expense-dlg').showModal();
}

async function handlePhotoFile(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  setPhoto(await compressImage(file));
  if (!$('#f-importo').value) $('#f-importo').focus();
}

function invalid(sel, msg) {
  toast(msg);
  $(sel).focus();
}

async function saveExpense(ev) {
  ev.preventDefault();
  const importo = parseAmount($('#f-importo').value);
  if (!(importo > 0)) return invalid('#f-importo', "Inserisci l'importo");
  const data = $('#f-data').value;
  if (!data) return invalid('#f-data', 'Inserisci la data');
  const causale = $('#f-causale').value.trim();
  if (!causale) return invalid('#f-causale', 'Inserisci la causale di spesa');
  const tipo = currentTipo();
  const tripId = tipo === 'trasferta' ? $('#f-trip').value : null;
  if (tipo === 'trasferta' && (!tripId || tripId === '__new')) return invalid('#f-trip', 'Scegli la trasferta oppure "Spese varie del mese"');
  if (!draftPhoto && !confirm('Salvare lo scontrino senza foto?')) return;

  const e = {
    id: editing?.id || uid(), data, importo, causale, tipo, tripId,
    note: $('#f-note').value.trim(), foto: draftPhoto, createdAt: editing?.createdAt || Date.now()
  };
  await put('expenses', e);
  state.expenses = state.expenses.filter(x => x.id !== e.id).concat(e);
  state.month = data.slice(0, 7);
  $('#expense-dlg').close();
  render();
  toast(editing ? 'Scontrino aggiornato' : 'Scontrino salvato');
}

async function deleteExpense() {
  if (!editing || !confirm('Eliminare questo scontrino? L\'operazione non si può annullare.')) return;
  await del('expenses', editing.id);
  state.expenses = state.expenses.filter(x => x.id !== editing.id);
  $('#expense-dlg').close();
  render();
  toast('Scontrino eliminato');
}

/* ---------- Trasferta: nuova / modifica ---------- */
let editingTrip = null;
let onTripSaved = null;

function openTrip(id, onSaved) {
  const t = id ? tripById(id) : null;
  editingTrip = t;
  onTripSaved = onSaved || null;
  $('#trip-dlg-title').textContent = t ? 'Modifica trasferta' : 'Nuova trasferta';
  $('#t-nome').value = t?.nome || '';
  const d = $('#f-data').value && onSaved ? $('#f-data').value : today();
  $('#t-dal').value = t ? (t.dal || '') : d;
  $('#t-al').value = t ? (t.al || '') : d;
  $('#t-note').value = t?.note || '';
  const its = t ? state.expenses.filter(e => e.tipo === 'trasferta' && e.tripId === t.id).sort((a, b) => a.data.localeCompare(b.data)) : [];
  $('#trip-expenses').innerHTML = its.length
    ? `<h3>Scontrini (${its.length}) · ${eur.format(sum(its))}</h3>${its.map(itemHTML).join('')}` : '';
  $('#btn-delete-trip').hidden = !t;
  $('#trip-dlg').showModal();
}

async function saveTrip(ev) {
  ev.preventDefault();
  const nome = $('#t-nome').value.trim();
  if (!nome) return invalid('#t-nome', 'Inserisci il nome della trasferta');
  let dal = $('#t-dal').value, al = $('#t-al').value;
  if (dal && al && al < dal) [dal, al] = [al, dal];
  const t = { id: editingTrip?.id || uid(), nome, dal, al, note: $('#t-note').value.trim() };
  await put('trips', t);
  state.trips = state.trips.filter(x => x.id !== t.id).concat(t);
  $('#trip-dlg').close();
  const cb = onTripSaved;
  onTripSaved = null;
  if (cb) cb(t.id);
  render();
  toast('Trasferta salvata');
}

async function deleteTrip() {
  if (!editingTrip) return;
  const its = state.expenses.filter(e => e.tipo === 'trasferta' && e.tripId === editingTrip.id);
  const msg = its.length
    ? `Eliminare la trasferta? I suoi ${its.length} scontrini non verranno cancellati: passeranno nelle "Spese varie" del loro mese.`
    : 'Eliminare la trasferta?';
  if (!confirm(msg)) return;
  for (const e of its) {
    Object.assign(e, { tipo: 'varie', tripId: null });
    await put('expenses', e);
  }
  await del('trips', editingTrip.id);
  state.trips = state.trips.filter(x => x.id !== editingTrip.id);
  $('#trip-dlg').close();
  render();
  toast('Trasferta eliminata');
}

/* ---------- Esportazioni ---------- */
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// Su Android apre il menu "Condividi" (email, Drive, WhatsApp…); altrimenti scarica il file.
async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (err) { if (err.name === 'AbortError') return; }
  }
  download(blob, name);
}

function exportCSV() {
  const m = $('#report-month').value || state.month;
  const { list, groups } = groupMonth(m);
  if (!list.length) return toast('Nessuna spesa in questo mese');
  const rows = [['Data', 'Attribuzione', 'Trasferta', 'Causale', 'Note', 'Importo']];
  for (const g of groups) for (const e of g.items) {
    rows.push([fmtDate(e.data), g.trip ? 'Trasferta' : 'Spese varie', g.trip ? g.trip.nome : '', e.causale, e.note || '', e.importo.toFixed(2).replace('.', ',')]);
  }
  rows.push(['', '', '', '', 'TOTALE', sum(list).toFixed(2).replace('.', ',')]);
  // Punto e virgola e BOM: Excel in italiano lo apre già diviso in colonne.
  const csv = '﻿' + rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  shareOrDownload(new Blob([csv], { type: 'text/csv' }), `nota-spese-${m}.csv`);
}

async function printReport() {
  showView('report');
  await Promise.all([...document.querySelectorAll('#report img')].map(i => i.decode().catch(() => {})));
  window.print();
}

/* ---------- Backup / ripristino ---------- */
const blobToDataURL = b => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(r.result);
  r.onerror = () => rej(r.error);
  r.readAsDataURL(b);
});

async function backup() {
  toast('Preparazione backup…');
  const expenses = await Promise.all(state.expenses.map(async e => ({ ...e, foto: e.foto ? await blobToDataURL(e.foto) : null })));
  const data = { app: 'spese-trasferta', version: 1, exportedAt: new Date().toISOString(), nome: state.nome, trips: state.trips, expenses };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `backup-spese-${today()}.json`);
  state.lastBackup = new Date().toISOString();
  await setSetting('lastBackup', state.lastBackup);
  render();
}

async function restore(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
    if (data.app !== 'spese-trasferta') throw new Error();
  } catch {
    return toast('Questo file non è un backup di Spese Trasferta');
  }
  if (!confirm(`Ripristinare ${data.expenses.length} scontrini e ${data.trips.length} trasferte?\nGli scontrini già presenti restano; quelli uguali vengono sostituiti.`)) return;
  for (const t of data.trips) await put('trips', t);
  for (const e of data.expenses) {
    await put('expenses', { ...e, foto: e.foto ? await (await fetch(e.foto)).blob() : null });
  }
  if (data.nome && !state.nome) await setSetting('nome', data.nome);
  await loadAll();
  render();
  toast('Ripristino completato');
}

/* ---------- Eventi ---------- */
function bind() {
  document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#prev-month').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); render(); });
  $('#next-month').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); render(); });

  // Il pulsante 📷 apre subito la fotocamera, con il modulo già pronto dietro.
  $('#fab').addEventListener('click', () => {
    openExpense(null);
    $('#cam-input').click();
  });
  $('#btn-cam').addEventListener('click', () => $('#cam-input').click());
  $('#btn-gal').addEventListener('click', () => $('#gal-input').click());
  $('#btn-rmphoto').addEventListener('click', () => setPhoto(null));
  $('#cam-input').addEventListener('change', e => handlePhotoFile(e.target));
  $('#gal-input').addEventListener('change', e => handlePhotoFile(e.target));
  $('#photo-preview').addEventListener('click', () => openViewer(previewUrl));

  document.querySelectorAll('input[name=tipo]').forEach(r => r.addEventListener('change', () => {
    setTipo(currentTipo());
    if (currentTipo() === 'trasferta' && !$('#f-trip').value) $('#f-trip').value = guessTrip($('#f-data').value)?.id || '';
  }));
  $('#f-data').addEventListener('change', () => {
    if (currentTipo() === 'trasferta' && !$('#f-trip').value) $('#f-trip').value = guessTrip($('#f-data').value)?.id || '';
  });
  $('#f-trip').addEventListener('change', () => {
    if ($('#f-trip').value !== '__new') return;
    $('#f-trip').value = '';
    openTrip(null, id => fillTripSelect(id));
  });

  $('#expense-form').addEventListener('submit', saveExpense);
  $('#btn-delete-expense').addEventListener('click', deleteExpense);
  $('#expense-dlg').addEventListener('close', () => { setPhoto(null); editing = null; });

  $('#new-trip').addEventListener('click', () => openTrip(null));
  $('#trip-form').addEventListener('submit', saveTrip);
  $('#btn-delete-trip').addEventListener('click', deleteTrip);
  $('#trip-dlg').addEventListener('close', () => { onTripSaved = null; });

  document.addEventListener('click', ev => {
    const closer = ev.target.closest('[data-close]');
    if (closer) return closer.closest('dialog').close();
    const exp = ev.target.closest('[data-exp]');
    if (exp) {
      if ($('#trip-dlg').open) $('#trip-dlg').close();
      return openExpense(exp.dataset.exp);
    }
    const trip = ev.target.closest('[data-trip]');
    if (trip) return openTrip(trip.dataset.trip);
    if (ev.target.closest('[data-action=backup]')) backup();
  });
  $('#viewer').addEventListener('click', ev => { if (ev.target.tagName === 'IMG') $('#viewer').close(); });

  $('#report-month').addEventListener('change', renderReport);
  $('#report-photos').addEventListener('change', renderReport);
  $('#btn-print').addEventListener('click', printReport);
  $('#btn-csv').addEventListener('click', exportCSV);

  $('#s-nome').addEventListener('change', async () => {
    state.nome = $('#s-nome').value.trim();
    await setSetting('nome', state.nome);
    toast('Nome salvato');
  });
  $('#btn-backup').addEventListener('click', backup);
  $('#btn-restore').addEventListener('click', () => $('#restore-input').click());
  $('#restore-input').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) restore(f);
  });
}

/* ---------- Avvio ---------- */
(async function start() {
  db = await openDB();
  await loadAll();
  $('#report-month').value = state.month;
  bind();
  render();
  // Chiede ad Android di non cancellare i dati quando libera spazio.
  navigator.storage?.persist?.().then(renderSettings);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
})();
