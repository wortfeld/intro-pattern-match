// js/app.js
import { KV } from './storage.js';
import {
  ensureFFmpeg,
  decodeHeadToWav,
  decodeSegmentToWav,
  fetchHeadUrl,
  fetchFullUrl,
  bufferToFileLike,
  getDurationFromFile,
  getDurationFromSrc
} from './media.js';
import { parseWavPCM16, computeMFCC } from './features.js';
import { slidingDistance } from './matcher.js';
import {
  parseTime,
  fmtMMSS,
  fmtHHMMSS,
  basenameFromUrl,
  uuid,
  parseBatch
} from './meta.js';

// ---- Logger ----
const logEl = document.getElementById('log');
const log = (el => (msg)=>{ if(!el) return; const d=document.createElement('div'); d.textContent=String(msg); el.appendChild(d); el.scrollTop=el.scrollHeight; })(logEl);

// ---- Engine/UI refs ----
const statusEl = document.getElementById('status');
const coreInfoEl = document.getElementById('coreInfo');
const headWindowEl = document.getElementById('headWindow');
const frameSizeEl = document.getElementById('frameSize');
const hopSizeEl = document.getElementById('hopSize');
const mfccCountEl = document.getElementById('mfccCount');

const refFileEl = document.getElementById('refFile');
const patternNameEl = document.getElementById('patternName');
const introStartEl = document.getElementById('introStart');
const introEndEl = document.getElementById('introEnd');
const outroDurationEl = document.getElementById('outroDuration');
const btnMakePattern = document.getElementById('btnMakePattern');
const refUrlEl = document.getElementById('refUrl');
const btnMakePatternFromUrl = document.getElementById('btnMakePatternFromUrl');

const patternSelect = document.getElementById('patternSelect');
const btnSavePattern = document.getElementById('btnSavePattern');
const btnLoadPattern = document.getElementById('btnLoadPattern');
const patternImportFile = document.getElementById('patternImportFile');
const btnDeletePattern = document.getElementById('btnDeletePattern');

const batchInputEl = document.getElementById('batchInput');
const btnAnalyzeBatch = document.getElementById('btnAnalyzeBatch');
const targetFileEl = document.getElementById('targetFile');
const btnAnalyze = document.getElementById('btnAnalyze');
const btnAbort = document.getElementById('btnAbort');

const resultsTable = document.getElementById('resultsTable').querySelector('tbody');
const btnExportCsv = document.getElementById('btnExportCsv');
const btnExportXml = document.getElementById('btnExportXml');

const overlay = document.getElementById('overlay');
const busyLabel = document.getElementById('busyLabel');
const overlayAbort = document.getElementById('overlayAbort');

// ---- Player overlay refs ----
const playerOverlay = document.getElementById('playerOverlay');
const player = document.getElementById('player');
const playerClose = document.getElementById('playerClose');
const playerMeta = document.getElementById('playerMeta');
const playerTitle = document.getElementById('playerTitle');

// ---- Edit overlay refs ----
const editOverlay = document.getElementById('editOverlay');
const editTitle = document.getElementById('editTitle');
const editIntro = document.getElementById('editIntro');
const editOutro = document.getElementById('editOutro');
const editSave = document.getElementById('editSave');
const editClose = document.getElementById('editClose');

let rowBeingEdited = null; // <tr> Referenz

// ---------- Busy UI ----------
let busyCount = 0;
function setBusy(on, label='Bitte warten …', cancellable=false){
  busyCount += on ? 1 : -1;
  if (busyCount < 0) busyCount = 0;
  const active = busyCount > 0;

  document.body.toggleAttribute('aria-busy', active);
  overlay.classList.toggle('hidden', !active);
  overlay.setAttribute('aria-hidden', String(!active));
  busyLabel.textContent = label;

  if (overlayAbort) {
    overlayAbort.style.display = cancellable ? 'inline' : 'none';
    overlayAbort.disabled = !cancellable;
  }
  // Controls sperren (Abbrechen-Ausnahmen)
  const controls = document.querySelectorAll('button, input, textarea, select');
  controls.forEach(el => {
    if (el === overlayAbort || el === btnAbort) return;
    if (active) el.setAttribute('disabled','disabled');
    else el.removeAttribute('disabled');
  });
}

// ---------- Abort/run controller ----------
let currentRun = null;
function startRun(label='Bitte warten …', cancellable=true){
  if (currentRun && !currentRun.aborted) endRun();
  const ctx = {
    id: Math.random().toString(36).slice(2),
    aborted: false,
    controllers: new Set(),
    makeController(){
      const c = new AbortController();
      this.controllers.add(c);
      return c;
    },
    abortAll(){
      this.aborted = true;
      for (const c of this.controllers) { try { c.abort(); } catch {} }
      this.controllers.clear();
      setBusy(false);
    }
  };
  currentRun = ctx;
  setBusy(true, label, cancellable);
  return ctx;
}
function endRun(){
  if (currentRun) currentRun.abortAll();
  currentRun = null;
}
btnAbort.addEventListener('click', ()=>{ if (currentRun) currentRun.abortAll(); log('abgebrochen.'); });
if (overlayAbort) {
  overlayAbort.addEventListener('click', (e)=>{
    e.preventDefault();
    if (currentRun) currentRun.abortAll();
    log('abgebrochen.');
  });
}
document.addEventListener('keydown', (e)=>{
  if (e.key === 'Escape') {
    if (currentRun) { currentRun.abortAll(); log('abgebrochen.'); }
    if (!playerOverlay?.classList.contains('hidden')) closePlayer();
    if (!editOverlay?.classList.contains('hidden')) closeEdit();
  }
});

// ---------- Helpers ----------
function b64FromFloat32(f32){
  const u8 = new Uint8Array(f32.buffer);
  let s = ''; for(let i=0;i<u8.length;i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}
function float32FromB64(b64){
  const raw = atob(b64);
  const ab = new ArrayBuffer(raw.length);
  const u8 = new Uint8Array(ab);
  for(let i=0;i<raw.length;i++) u8[i]=raw.charCodeAt(i);
  return new Float32Array(ab);
}

async function ensureCore(){
  statusEl.textContent = 'ffmpeg: lädt …';
  try {
    await ensureFFmpeg(msg => log(msg));
    coreInfoEl.textContent = 'core=umd js+wasm';
    statusEl.textContent = 'ffmpeg: bereit';
  } catch (e){
    statusEl.textContent = 'ffmpeg: Fehler';
    log('ffmpeg load failed: '+e);
    throw e;
  }
}

function refreshPatternList(selectedId=null){
  return KV.keys().then(keys => Promise.all(keys.map(k => KV.get(k).then(v => ({ key:k, val:v })))))
    .then(items => {
      patternSelect.innerHTML='';
      if(items.length===0){
        const opt=document.createElement('option'); opt.textContent='(noch keine Muster)'; patternSelect.appendChild(opt); return;
      }
      items.forEach(it=>{
        const opt=document.createElement('option');
        opt.value=it.key; opt.textContent=it.val.name+' ('+it.key.substring(0,8)+')';
        if (selectedId && it.key===selectedId) opt.selected = true;
        patternSelect.appendChild(opt);
      });
    });
}
function selectPatternById(id){
  if (!id) return;
  for (let i=0;i<patternSelect.options.length;i++){
    if (patternSelect.options[i].value === id) { patternSelect.selectedIndex = i; break; }
  }
}

// ---- Player helpers ----
function openPlayer(url, seconds, label='Vorschau'){
  if (!url) return;
  try { player.pause(); } catch {}
  player.src = url; player.currentTime = 0;
  playerTitle.textContent = label;
  playerMeta.textContent = `Start bei ${fmtMMSS(seconds||0)} • Quelle: ${url}`;
  playerOverlay.classList.remove('hidden'); playerOverlay.setAttribute('aria-hidden','false');

  const seekTo = Math.max(0, Math.floor(Number(seconds)||0));
  const onMeta = ()=>{
    player.currentTime = seekTo;
    player.play().catch(()=>{});
    player.removeEventListener('loadedmetadata', onMeta);
  };
  player.addEventListener('loadedmetadata', onMeta);
  if (player.readyState >= 1) onMeta();
}
function closePlayer(){
  try { player.pause(); } catch {}
  player.removeAttribute('src'); try { player.load(); } catch {}
  playerOverlay.classList.add('hidden'); playerOverlay.setAttribute('aria-hidden','true');
}
playerClose?.addEventListener('click', closePlayer);
playerOverlay?.addEventListener('click', (e)=>{ if (e.target === playerOverlay) closePlayer(); });

function buildTimedUrl(rawUrl, seconds){
  try { const u = new URL(rawUrl); u.hash = 't=' + Math.max(0, Math.floor(Number(seconds)||0)); return u.toString(); }
  catch { return rawUrl; }
}

// ---- Edit helpers ----
function openEdit(tr){
  rowBeingEdited = tr;
  const introS = Number(tr.dataset.introS);
  const outroS = Number(tr.dataset.outroS);
  editIntro.value = Number.isFinite(introS) ? fmtMMSS(introS) : '';
  editOutro.value = Number.isFinite(outroS) ? fmtMMSS(outroS) : '';
  editTitle.textContent = 'Zeiten korrigieren';
  editOverlay.classList.remove('hidden');
  editOverlay.setAttribute('aria-hidden','false');
  setTimeout(()=>editIntro.focus(), 0);
}
function closeEdit(){
  rowBeingEdited = null;
  editOverlay.classList.add('hidden');
  editOverlay.setAttribute('aria-hidden','true');
}
editClose?.addEventListener('click', closeEdit);
editOverlay?.addEventListener('click', (e)=>{ if (e.target === editOverlay) closeEdit(); });

function normToSeconds(val){
  const s = parseTime((val||'').trim());
  if (!Number.isFinite(s) || s < 0) return NaN;
  return Math.floor(s);
}
function applyEdit(){
  if (!rowBeingEdited) return;
  const introS = normToSeconds(editIntro.value);
  const outroS = normToSeconds(editOutro.value);

  if (!Number.isFinite(introS) && !Number.isFinite(outroS)){
    alert('Bitte Intro und/oder Outro als mm:ss oder Sekunden angeben.');
    return;
  }
  if (Number.isFinite(introS)){
    rowBeingEdited.dataset.introS = String(introS);
    const tdIntro = rowBeingEdited.querySelector('.tdIntro');
    if (tdIntro) tdIntro.textContent = fmtMMSS(introS);
  }
  if (Number.isFinite(outroS)){
    rowBeingEdited.dataset.outroS = String(outroS);
    const tdOutro = rowBeingEdited.querySelector('.tdOutro');
    if (tdOutro) tdOutro.textContent = fmtMMSS(outroS);
  }
  closeEdit();
}
editSave?.addEventListener('click', applyEdit);

// ---- Tabellenzeile (kompakt + Stift) ----
// Spalten: CMS-ID | Externe | URL | Dauer | Outro mm:ss | Muster | Intro mm:ss | Match | Test(Intro·Outro·✏︎)
function addResultRowCompact({cmsId, externalId, url, durationHHMMSS, outroStartS, patternName, introStartS, conf, score}){
  const tr = document.createElement('tr');
  tr.dataset.introS = Number.isFinite(introStartS) ? String(introStartS) : '';
  tr.dataset.outroS = Number.isFinite(outroStartS) ? String(outroStartS) : '';

  const cText = (txt, cls)=>{ const td=document.createElement('td'); td.textContent=txt; if (cls) td.className=cls; return td; };
  const cLink = ()=>{ const td=document.createElement('td'); const a=document.createElement('a'); a.href=url||''; a.textContent=url||''; a.target='_blank'; a.rel='noopener'; td.appendChild(a); return td; };
  const cTest = ()=>{
    const td=document.createElement('td');

    const mkLink=(label, title, which)=>{
      const b=document.createElement('button');
      b.className='linklike small';
      b.textContent=label;
      b.title=title||'';
      b.addEventListener('click',(e)=>{
        const tr = b.closest('tr');
        const secs = which==='intro' ? Number(tr.dataset.introS) : Number(tr.dataset.outroS);
        const u = tr.querySelector('td:nth-child(3) a')?.href || '';
        const useExternal = e.metaKey || e.ctrlKey || e.shiftKey;
        if (!Number.isFinite(secs)) return;
        if (useExternal && u) window.open(buildTimedUrl(u, secs), '_blank');
        else openPlayer(u, secs, (which==='intro'?'Intro':'Outro')+'-Vorschau');
      });
      return b;
    };

    const spanSep = (t)=>{ const s=document.createElement('span'); s.textContent=t; return s; };

    const introBtn = mkLink('Intro', 'Intro abspielen (Strg/Cmd für neuen Tab)', 'intro');
    const outroBtn = mkLink('Outro', 'Outro abspielen (Strg/Cmd für neuen Tab)', 'outro');

    // Stift-Icon
    const editBtn = document.createElement('button');
    editBtn.className = 'iconbtn';
    editBtn.title = 'Zeiten bearbeiten';
    editBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm18.71-11.04c.39.39.39 1.02 0 1.41l-2.34 2.34-3.75-3.75 2.34-2.34a.996.996 0 1 1 1.41 1.41l-1.27 1.27 3.61 3.66z"/></svg>';
    editBtn.addEventListener('click', ()=> openEdit(td.closest('tr')));

    td.appendChild(introBtn);
    td.appendChild(spanSep(' · '));
    td.appendChild(outroBtn);
    td.appendChild(spanSep(' · '));
    td.appendChild(editBtn);
    return td;
  };

  const matchStr = (conf||'') && (score||'') ? `${conf} / ${score}` : (conf||score||'');

  tr.appendChild(cText(cmsId||''));
  tr.appendChild(cText(externalId||''));
  tr.appendChild(cLink());
  tr.appendChild(cText(durationHHMMSS||''));
  tr.appendChild(cText(Number.isFinite(outroStartS)? fmtMMSS(outroStartS):'', 'tdOutro'));
  tr.appendChild(cText(patternName||''));
  tr.appendChild(cText(Number.isFinite(introStartS)? fmtMMSS(introStartS):'', 'tdIntro'));
  tr.appendChild(cText(matchStr));
  tr.appendChild(cTest());

  resultsTable.appendChild(tr);
}

// ---------- Muster erstellen (URL) ----------
btnMakePatternFromUrl.addEventListener('click', async ()=>{
  setBusy(true, 'Muster wird erstellt …', false);
  try{
    await ensureCore();
    const url = (refUrlEl.value||'').trim(); if(!url){ log('Bitte Referenz-URL eingeben.'); return; }
    const name = (patternNameEl.value||'').trim() || basenameFromUrl(url);
    const s = parseTime(introStartEl.value); const e = parseTime(introEndEl.value);
    if(!Number.isFinite(s)||!Number.isFinite(e)||e<=s){ log('Ungültiger Intro-Start/-Ende.'); return; }
    const outDur = parseTime(outroDurationEl.value);
    if(outroDurationEl.value && !Number.isFinite(outDur)){ log('Ungültige Outro-Dauer.'); return; }

    const frameSize = parseInt(frameSizeEl.value,10)||1024;
    const hop = parseInt(hopSizeEl.value,10)||512;
    const mfccC = parseInt(mfccCountEl.value,10)||13;

    const dur = e - s;
    const obj = await fetchFullUrl(url, 300);
    const fileLike = bufferToFileLike(obj.buffer, basenameFromUrl(url));
    log(`geladen: ${basenameFromUrl(url)} (${(obj.buffer.byteLength/1048576).toFixed(1)} MB)`);
    const buf = await decodeSegmentToWav(fileLike, s, dur, log);
    const wav = parseWavPCM16(buf);
    const feat = computeMFCC(wav.signal, wav.sampleRate, frameSize, hop, mfccC);

    const pat = {
      pattern_id: uuid(),
      name,
      created_at: new Date().toISOString(),
      algo_version: 'intro-match/1.0.0',
      reference_timing: {
        intro_start_s: s,
        intro_end_s: e,
        intro_duration_s: dur,
        outro_duration_s: Number.isFinite(outDur)? outDur : null
      },
      feature_config: { feature_type: 'mfcc'+mfccC, sr_hz: wav.sampleRate, win: frameSize, hop, mel_bins: 40, normalization: 'zscore' },
      feature_payload: { format:'f32', frame_count: feat.frames, dims: feat.dims, data_b64: b64FromFloat32(feat.data) }
    };
    await KV.set(pat.pattern_id, pat);
    log('Muster gespeichert: '+pat.name+' ['+pat.pattern_id+']');
    await refreshPatternList(pat.pattern_id);
  }catch(err){
    if(String(err).includes('TypeError')) log('Hinweis: CORS der Quelle fehlt (Access-Control-Allow-Origin).');
    log('Muster aus URL fehlgeschlagen: '+err);
  } finally { setBusy(false); }
});

// ---------- Muster erstellen (Datei) ----------
btnMakePattern.addEventListener('click', async ()=>{
  setBusy(true, 'Muster wird erstellt …', false);
  try{
    await ensureCore();
    const f = refFileEl.files && refFileEl.files[0]; if(!f){ log('Bitte Datei auswählen.'); return; }
    const name = (patternNameEl.value||'').trim(); if(!name){ log('Bitte Namen eintragen.'); return; }
    const s = parseTime(introStartEl.value); const e = parseTime(introEndEl.value);
    if(!Number.isFinite(s)||!Number.isFinite(e)||e<=s){ log('Ungültiger Intro-Start/-Ende.'); return; }
    const outDur = parseTime(outroDurationEl.value);
    if(outroDurationEl.value && !Number.isFinite(outDur)){ log('Ungültige Outro-Dauer.'); return; }

    const frameSize = parseInt(frameSizeEl.value,10)||1024;
    const hop = parseInt(hopSizeEl.value,10)||512;
    const mfccC = parseInt(mfccCountEl.value,10)||13;

    const dur = e - s;
    const buf = await decodeSegmentToWav(f, s, dur, log);
    const wav = parseWavPCM16(buf);
    const feat = computeMFCC(wav.signal, wav.sampleRate, frameSize, hop, mfccC);

    const pat = {
      pattern_id: uuid(),
      name,
      created_at: new Date().toISOString(),
      algo_version: 'intro-match/1.0.0',
      reference_timing: {
        intro_start_s: s,
        intro_end_s: e,
        intro_duration_s: dur,
        outro_duration_s: Number.isFinite(outDur)? outDur : null
      },
      feature_config: { feature_type: 'mfcc'+mfccC, sr_hz: wav.sampleRate, win: frameSize, hop, mel_bins: 40, normalization: 'zscore' },
      feature_payload: { format:'f32', frame_count: feat.frames, dims: feat.dims, data_b64: b64FromFloat32(feat.data) }
    };
    await KV.set(pat.pattern_id, pat);
    log('Muster gespeichert: '+pat.name+' ['+pat.pattern_id+']');
    await refreshPatternList(pat.pattern_id);
  }catch(err){ log('Muster aus Datei fehlgeschlagen: '+err); }
  finally { setBusy(false); }
});

// ---------- Muster speichern (Export .json) ----------
function berlinStamp(){
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  }).formatToParts(new Date());
  const get = (k)=> parts.find(p=>p.type===k)?.value || '';
  return { dateStr: `${get('year')}${get('month')}${get('day')}`, timeStr: `${get('hour')}${get('minute')}` };
}
function slugify(s){
  return String(s||'pattern')
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'')
    .toLowerCase().replace(/&/g,'-and-')
    .replace(/[^a-z0-9]+/g,'-').replace(/-+/g,'-').replace(/^-|-$/g,'');
}
btnSavePattern.addEventListener('click', async ()=>{
  try{
    const key = patternSelect.value;
    if(!key || key.startsWith('(noch keine')){ log('Bitte Muster auswählen.'); return; }
    const pat = await KV.get(key);
    if(!pat){ log('Muster nicht gefunden.'); return; }
    const payload = {
      _type: 'intro-pattern',
      _version: '1.0.0',
      exported_at: new Date().toISOString(),
      pattern: pat
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type:'application/json' });
    const url = URL.createObjectURL(blob);
    const { dateStr, timeStr } = berlinStamp();
    const fname = `pattern_${dateStr}_${timeStr}_${slugify(pat.name)}_${pat.pattern_id.slice(0,8)}.json`;
    const a = document.createElement('a'); a.href = url; a.download = fname; a.click();
    URL.revokeObjectURL(url);
    log('Muster exportiert: '+fname);
  }catch(err){ log('Export fehlgeschlagen: '+err); }
});

// ---------- Muster laden (Import .json) ----------
btnLoadPattern.addEventListener('click', ()=> patternImportFile?.click());
patternImportFile?.addEventListener('change', async (e)=>{
  try{
    const f = e.target.files?.[0];
    if(!f){ return; }
    const text = await f.text();
    let obj;
    try { obj = JSON.parse(text); }
    catch { log('Ungültige Datei: kein gültiges JSON.'); return; }

    // erlaubt: entpackt pattern-Objekt oder Wrapper
    const pat = obj?.pattern && obj._type==='intro-pattern' ? obj.pattern : obj;

    // Minimal-Validierung
    if (!pat || !pat.name || !pat.feature_payload?.data_b64 || !pat.reference_timing){
      log('Ungültige Musterdatei: erforderliche Felder fehlen.');
      return;
    }

    let id = pat.pattern_id && typeof pat.pattern_id === 'string' ? pat.pattern_id : null;
    if (id) {
      // Wenn ID schon existiert, neue ID vergeben
      const existingKeys = await KV.keys();
      if (existingKeys.includes(id)) {
        id = uuid();
      }
    } else {
      id = uuid();
    }

    const toStore = {
      ...pat,
      pattern_id: id,
      imported_at: new Date().toISOString()
    };
    await KV.set(id, toStore);
    await refreshPatternList(id);
    selectPatternById(id);
    log('Muster importiert: '+toStore.name+' ['+id+']');
  }catch(err){
    log('Import fehlgeschlagen: '+err);
  } finally {
    if (patternImportFile) patternImportFile.value = '';
  }
});

// ---------- Muster löschen ----------
btnDeletePattern.addEventListener('click', async ()=>{
  setBusy(true, 'Löschen …', false);
  try{
    const key = patternSelect.value;
    if(!key || key.startsWith('(noch keine')) return;
    await KV.del(key);
    log('Muster gelöscht: '+key);
    await refreshPatternList();
  }catch(err){ log('Löschen fehlgeschlagen: '+err); }
  finally { setBusy(false); }
});

// ---------- Dateien prüfen ----------
btnAnalyze.addEventListener('click', async ()=>{
  setBusy(true, 'Dateien werden analysiert …', true);
  try{
    await ensureCore();
    const files = targetFileEl.files; if(!files || files.length===0){ log('Bitte mindestens eine Datei wählen.'); return; }
    const key = patternSelect.value; if(!key || key.startsWith('(noch keine')){ log('Bitte Muster auswählen.'); return; }

    const headWindow = parseInt(headWindowEl.value,10)||180;
    const frameSize = parseInt(frameSizeEl.value,10)||1024;
    const hop = parseInt(hopSizeEl.value,10)||512;
    const mfccC = parseInt(mfccCountEl.value,10)||13;

    const pat = await KV.get(key); if(!pat){ log('Muster nicht gefunden.'); return; }
    const patData = float32FromB64(pat.feature_payload.data_b64);
    const patFeat = { frames: pat.feature_payload.frame_count, dims: pat.feature_payload.dims, data: patData };

    const { metaMap } = parseBatch(batchInputEl.value);
    const run = startRun('Analysiere Dateien …', true);

    for (let i=0; i<files.length; i++){
      if (run.aborted) break;
      const file = files[i];

      const durCtrl = run.makeController();
      const durationPromise =
        Number.isFinite(metaMap[file.name]?.duration_s)
          ? Promise.resolve(metaMap[file.name].duration_s)
          : getDurationFromFile(file, durCtrl.signal).catch(()=>NaN);

      const [buf, duration_s] = await Promise.all([
        decodeHeadToWav(file, headWindow, log),
        durationPromise
      ]);
      if (run.aborted) break;

      const wav = parseWavPCM16(buf);
      const headFeat = computeMFCC(wav.signal, wav.sampleRate, frameSize, hop, mfccC);
      const res = slidingDistance(headFeat, patFeat);

      const introStartS = (res.bestIdx<0) ? NaN : (res.bestIdx * hop) / wav.sampleRate;
      const conf = (res.bestIdx<0) ? '' : ((res.second===Infinity)? 1.0 : Math.max(0, Math.min(1, (res.second - res.best) / (res.second || 1)))).toFixed(2);
      const score = (res.bestIdx<0) ? '' : res.best.toFixed(4);

      const outDur = pat.reference_timing && pat.reference_timing.outro_duration_s;
      const outroStartS = (Number.isFinite(duration_s) && Number.isFinite(outDur)) ? Math.max(0, duration_s - outDur) : NaN;

      const meta = metaMap[file.name] || metaMap[file.name.replace(/\.[^/.]+$/, '')] || {};
      addResultRowCompact({
        cmsId: meta.cms_id || '',
        externalId: meta.external_cms_id || '',
        url: meta.url || '',
        durationHHMMSS: Number.isFinite(duration_s) ? fmtHHMMSS(Math.round(duration_s)) : '',
        outroStartS,
        patternName: pat.name,
        introStartS,
        conf, score
      });
    }
  }catch(err){ log('Analyse fehlgeschlagen: '+err); }
  finally { setBusy(false); endRun(); }
});

// ---------- Liste abarbeiten (URLs/TSV) ----------
btnAnalyzeBatch.addEventListener('click', async ()=>{
  setBusy(true, 'URLs werden analysiert …', true);
  try{
    await ensureCore();
    const key = patternSelect.value; if(!key || key.startsWith('(noch keine')){ log('Bitte Muster auswählen.'); return; }

    const headWindow = parseInt(headWindowEl.value,10)||180;
    const frameSize = parseInt(frameSizeEl.value,10)||1024;
    const hop = parseInt(hopSizeEl.value,10)||512;
    const mfccC = parseInt(mfccCountEl.value,10)||13;

    const pat = await KV.get(key); if(!pat){ log('Muster nicht gefunden.'); return; }
    const patData = float32FromB64(pat.feature_payload.data_b64);
    const patFeat = { frames: pat.feature_payload.frame_count, dims: pat.feature_payload.dims, data: patData };

    const { metaMap, urls } = parseBatch(batchInputEl.value);
    if (urls.length===0) { log('Keine URLs in der Liste gefunden.'); return; }

    const run = startRun('URLs werden analysiert …', true);

    for (const u of urls){
      if (run.aborted) break;

      const base = basenameFromUrl(u);
      const meta = metaMap[u] || metaMap[base] || {};
      const durCtrl = run.makeController();
      const durationPromise =
        Number.isFinite(meta.duration_s) ? Promise.resolve(meta.duration_s) : getDurationFromSrc(u, durCtrl.signal).catch(()=>NaN);

      const netCtrl = run.makeController();
      const obj = await fetchHeadUrl(u, 64*1024*1024, netCtrl.signal);
      if (run.aborted) break;

      const f = bufferToFileLike(obj.buffer, base);
      const [buf, duration_s] = await Promise.all([
        decodeHeadToWav(f, headWindow, log),
        durationPromise
      ]);
      if (run.aborted) break;

      const wav = parseWavPCM16(buf);
      const headFeat = computeMFCC(wav.signal, wav.sampleRate, frameSize, hop, mfccC);
      const res = slidingDistance(headFeat, patFeat);

      const introStartS = (res.bestIdx<0) ? NaN : (res.bestIdx * hop) / wav.sampleRate;
      const conf = (res.bestIdx<0) ? '' : ((res.second===Infinity)? 1.0 : Math.max(0, Math.min(1, (res.second - res.best) / (res.second || 1)))).toFixed(2);
      const score = (res.bestIdx<0) ? '' : res.best.toFixed(4);

      const outDur = pat.reference_timing && pat.reference_timing.outro_duration_s;
      const outroStartS = (Number.isFinite(duration_s) && Number.isFinite(outDur)) ? Math.max(0, duration_s - outDur) : NaN;

      addResultRowCompact({
        cmsId: meta.cms_id || '',
        externalId: meta.external_cms_id || '',
        url: meta.url || u,
        durationHHMMSS: Number.isFinite(duration_s) ? fmtHHMMSS(Math.round(duration_s)) : '',
        outroStartS,
        patternName: pat.name,
        introStartS,
        conf, score
      });
    }
  }catch(err){
    if(String(err).includes('TypeError')) log('Hinweis: CORS der Quelle fehlt (Access-Control-Allow-Origin).');
    log('Abarbeitung fehlgeschlagen: '+err);
  } finally { setBusy(false); endRun(); }
});

// ---------- CSV exportieren (schlanke Tabelle + Dateiname mit Datum/Zeit/Slug) ----------
btnExportCsv.addEventListener('click', ()=>{
  const headers = ['cms_id','external_cms_id','video_url','duration_hhmmss','outro_start_mmss','matched_pattern','intro_start_mmss','match'];
  const rows=[headers];
  const trs=resultsTable.querySelectorAll('tr');
  for(const tr of trs){
    const tds=tr.querySelectorAll('td');
    const row=[]; for(let i=0;i<8;i++){ // nur erste 8 Zellen exportieren (ohne "Test")
      const v=(tds[i]?.textContent||'').replace(/"/g,'""');
      row.push('"'+v+'"');
    }
    rows.push(row);
  }
  const csv=rows.map(r=>r.join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
  }).formatToParts(new Date());
  const get=(k)=>parts.find(p=>p.type===k)?.value||'';
  const dateStr=`${get('year')}${get('month')}${get('day')}`, timeStr=`${get('hour')}${get('minute')}`;
  // Mustername aus Select
  const selTxt = patternSelect.options[patternSelect.selectedIndex]?.textContent || '';
  const patName = selTxt.replace(/\s*\([^)]+\)\s*$/,'').trim();
  const slug = slugify(patName);
  const a=document.createElement('a'); a.href=url; a.download=`update_${dateStr}_${timeStr}_${slug}.csv`; a.click();
  URL.revokeObjectURL(url);
});

// ---------- Update-XML exportieren (nutzt korrigierte Zeiten, Dateiname mit Datum/Zeit/Slug) ----------
function toHHMMSSFixed(seconds){
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
  return [h,m,sec].map(n => String(n).padStart(2,'0')).join(':');
}
function xmlEscape(str){
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&apos;');
}
async function loadPatternsByName(){
  const map = {};
  const keys = await KV.keys();
  for (const k of keys){
    const v = await KV.get(k);
    if (v && v.name){
      map[v.name] = {
        intro_duration_s: v?.reference_timing?.intro_duration_s,
        outro_duration_s: v?.reference_timing?.outro_duration_s
      };
    }
  }
  return map;
}
btnExportXml.addEventListener('click', async ()=>{
  setBusy(true, 'XML wird erstellt …', false);
  try{
    const patterns = await loadPatternsByName();

    const docs = [];
    const trs = resultsTable.querySelectorAll('tr');

    trs.forEach(tr=>{
      const tds = tr.querySelectorAll('td');
      if (tds.length < 9) return;

      const cmsId       = tds[0].textContent.trim();
      const externalId  = tds[1].textContent.trim() || cmsId;
      const durationStr = tds[3].textContent.trim();          // hh:mm:ss
      const outroMMSS   = tds[4].textContent.trim();
      const patName     = tds[5].textContent.trim();
      const introMMSS   = tds[6].textContent.trim();

      // Sekunden bevorzugt aus dataset (korrigiert), sonst aus mm:ss
      const introStartS = Number(tr.dataset.introS) || parseTime(introMMSS);
      const outroStartS = Number(tr.dataset.outroS) || parseTime(outroMMSS);

      const pat = patterns[patName] || {};
      const introDurS = Number.isFinite(pat.intro_duration_s)
        ? Math.round(pat.intro_duration_s) : 0;

      let outroDurS = Number.isFinite(pat.outro_duration_s)
        ? Math.round(pat.outro_duration_s) : 0;

      if (!outroDurS) {
        const totalS = parseTime(durationStr);
        if (Number.isFinite(totalS) && Number.isFinite(outroStartS)) {
          outroDurS = Math.max(0, Math.round(totalS - outroStartS));
        }
      }

      const introTime = Number.isFinite(introStartS) ? toHHMMSSFixed(introStartS) : '00:00:00';
      const outroTime = Number.isFinite(outroStartS) ? toHHMMSSFixed(outroStartS) : '00:00:00';

      const doc =
`  <document nodeType="unified-nt:video" externalID="${xmlEscape(externalId)}">
    <properties />
    <childNodes>
      <childNode nodeType="unified-nt:jumpLabelRow" name="unified:jumpLabelRow">
        <properties>
          <property name="unified:jumpLabelDuration">
            <value>${introDurS}</value>
          </property>
          <property name="unified:jumpLabelTime">
            <value>${introTime}</value>
          </property>
          <property name="unified:jumpLabelType">
            <value>INTRO</value>
          </property>
        </properties>
        <childNodes />
        <resourceList />
      </childNode>
      <childNode nodeType="unified-nt:jumpLabelRow" name="unified:jumpLabelRow">
        <properties>
          <property name="unified:jumpLabelDuration">
            <value>${outroDurS}</value>
          </property>
          <property name="unified:jumpLabelTime">
            <value>${outroTime}</value>
          </property>
          <property name="unified:jumpLabelType">
            <value>OUTRO</value>
          </property>
        </properties>
        <childNodes />
        <resourceList />
      </childNode>
    </childNodes>
    <resourceList />
    <fields>
      <site />
      <structureNode />
      <idstem />
      <forceLock timeout="10">true</forceLock>
      <forceCreate>false</forceCreate>
      <channels>
        <enabledChannels />
        <disabledChannels />
      </channels>
    </fields>
    <instructions>
      <lifecycleActivities>
        <lifecycleActivity type="keepState" />
      </lifecycleActivities>
      <proposals />
      <stickyNotes />
    </instructions>
  </document>`;
      docs.push(doc);
    });

    const xml =
`<?xml version="1.0" encoding="UTF-8"?>
<documents xmlns="http://www.sophoracms.com/import/5.0">
${docs.join('\n')}
</documents>`;

    const blob = new Blob([xml], { type: 'application/xml' });
    const urlBlob = URL.createObjectURL(blob);
    const parts = new Intl.DateTimeFormat('de-DE', {
      timeZone: 'Europe/Berlin',
      year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false
    }).formatToParts(new Date());
    const get=(k)=>parts.find(p=>p.type===k)?.value||'';
    const dateStr=`${get('year')}${get('month')}${get('day')}`, timeStr=`${get('hour')}${get('minute')}`;
    const selTxt = patternSelect.options[patternSelect.selectedIndex]?.textContent || '';
    const patNameSel = selTxt.replace(/\s*\([^)]+\)\s*$/,'').trim();
    const slug = slugify(patNameSel);

    const a = document.createElement('a');
    a.href = urlBlob; a.download = `update_${dateStr}_${timeStr}_${slug}.xml`; a.click();
    URL.revokeObjectURL(urlBlob);
  }catch(err){
    log('XML-Export fehlgeschlagen: '+err);
  }finally{
    setBusy(false);
  }
});

// ---------- init ----------
refreshPatternList();
