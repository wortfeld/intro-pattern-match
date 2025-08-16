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
import { logger, addResultRowRich } from './ui.js';
import {
  parseTime,
  fmtMMSS,
  fmtHHMMSS,
  basenameFromUrl,
  uuid,
  // TSV-first parsing util you added previously
  parseBatch
} from './meta.js';

const logEl = document.getElementById('log');
const log = logger(logEl);

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
const btnDeletePattern = document.getElementById('btnDeletePattern');

const batchInputEl = document.getElementById('batchInput');
const btnAnalyzeBatch = document.getElementById('btnAnalyzeBatch');
const targetFileEl = document.getElementById('targetFile');
const btnAnalyze = document.getElementById('btnAnalyze');
const btnAbort = document.getElementById('btnAbort');

const resultsTable = document.getElementById('resultsTable').querySelector('tbody');
const btnExportCsv = document.getElementById('btnExportCsv');

const overlay = document.getElementById('overlay');
const busyLabel = document.getElementById('busyLabel');

// ---------- Busy UI ----------
let busyCount = 0;
function setBusy(on, label='Working…'){
  busyCount += on ? 1 : -1;
  if (busyCount < 0) busyCount = 0;
  const active = busyCount > 0;
  document.body.toggleAttribute('aria-busy', active);
  overlay.classList.toggle('hidden', !active);
  overlay.setAttribute('aria-hidden', String(!active));
  busyLabel.textContent = label;
  // keep Abort enabled, disable others
  const controls = document.querySelectorAll('button, input, textarea, select');
  controls.forEach(el => {
    if (el === btnAbort) return;
    if (active) el.setAttribute('disabled','disabled');
    else el.removeAttribute('disabled');
  });
}

// ---------- Abort/run controller ----------
let currentRun = null;
function startRun(label='Working…'){
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
  setBusy(true, label);
  return ctx;
}
function endRun(){
  if (currentRun) currentRun.abortAll();
  currentRun = null;
}
btnAbort.addEventListener('click', ()=>{ if (currentRun) currentRun.abortAll(); log('aborted.'); });

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
  statusEl.textContent = 'ffmpeg: loading…';
  try {
    await ensureFFmpeg(msg => log(msg));
    coreInfoEl.textContent = 'core=umd js+wasm';
    statusEl.textContent = 'ffmpeg: ready';
  } catch (e){
    statusEl.textContent = 'ffmpeg: error';
    log('ffmpeg load failed: '+e);
    throw e;
  }
}

function refreshPatternList(){
  return KV.keys().then(keys => Promise.all(keys.map(k => KV.get(k).then(v => ({ key:k, val:v })))))
    .then(items => {
      patternSelect.innerHTML='';
      if(items.length===0){
        const opt=document.createElement('option'); opt.textContent='(no patterns yet)'; patternSelect.appendChild(opt); return;
      }
      items.forEach(it=>{
        const opt=document.createElement('option');
        opt.value=it.key; opt.textContent=it.val.name+' ('+it.key.substring(0,8)+')';
        patternSelect.appendChild(opt);
      });
    });
}

function addResultRow(cells){
  addResultRowRich(resultsTable, cells);
}

// ---------- Pattern creation (URL-first) ----------
btnMakePatternFromUrl.addEventListener('click', async ()=>{
  setBusy(true, 'Creating pattern…');
  try{
    await ensureCore();
    const url = (refUrlEl.value||'').trim(); if(!url){ log('enter a reference URL'); return; }
    const name = (patternNameEl.value||'').trim() || basenameFromUrl(url);
    const s = parseTime(introStartEl.value); const e = parseTime(introEndEl.value);
    if(!Number.isFinite(s)||!Number.isFinite(e)||e<=s){ log('invalid start/end'); return; }
    const outDur = parseTime(outroDurationEl.value);
    if(outroDurationEl.value && !Number.isFinite(outDur)){ log('invalid outro duration'); return; }

    const frameSize = parseInt(frameSizeEl.value,10)||1024;
    const hop = parseInt(hopSizeEl.value,10)||512;
    const mfccC = parseInt(mfccCountEl.value,10)||13;

    const dur = e - s;
    const obj = await fetchFullUrl(url, 300);
    const fileLike = bufferToFileLike(obj.buffer, basenameFromUrl(url));
    log(`downloaded ${basenameFromUrl(url)} (${(obj.buffer.byteLength/1048576).toFixed(1)} MB)`);
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
    log('pattern saved: '+pat.name+' ['+pat.pattern_id+']');
    await refreshPatternList();
  }catch(err){
    if(String(err).includes('TypeError')) log('Hint: CORS likely missing (Access-Control-Allow-Origin).');
    log('make pattern (URL) failed: '+err);
  } finally { setBusy(false); }
});

// ---------- Pattern creation (file alternative) ----------
btnMakePattern.addEventListener('click', async ()=>{
  setBusy(true, 'Creating pattern…');
  try{
    await ensureCore();
    const f = refFileEl.files && refFileEl.files[0]; if(!f){ log('pick a reference file'); return; }
    const name = (patternNameEl.value||'').trim(); if(!name){ log('enter a pattern name'); return; }
    const s = parseTime(introStartEl.value); const e = parseTime(introEndEl.value);
    if(!Number.isFinite(s)||!Number.isFinite(e)||e<=s){ log('invalid start/end'); return; }
    const outDur = parseTime(outroDurationEl.value);
    if(outroDurationEl.value && !Number.isFinite(outDur)){ log('invalid outro duration'); return; }

    const frameSize = parseInt(frameSizeEl.value,10)||1024;
    const hop = parseInt(hopSizeEl.value,10)||512;
    const mfccC = parseInt(mfccCountEl.value,10)||13;

    const dur = e - s;
    log(`extracting segment ${fmtMMSS(s)}–${fmtMMSS(e)} (${dur.toFixed(2)}s) …`);
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
    log('pattern saved: '+pat.name+' ['+pat.pattern_id+']');
    await refreshPatternList();
  }catch(err){ log('make pattern failed: '+err); }
  finally { setBusy(false); }
});

// ---------- Delete pattern ----------
btnDeletePattern.addEventListener('click', async ()=>{
  setBusy(true, 'Deleting…');
  try{
    const key = patternSelect.value;
    if(!key || key.startsWith('(no')) return;
    await KV.del(key);
    log('pattern deleted: '+key);
    await refreshPatternList();
  }catch(err){ log('delete failed: '+err); }
  finally { setBusy(false); }
});

// ---------- Analyze local files (file alternative) ----------
btnAnalyze.addEventListener('click', async ()=>{
  setBusy(true, 'Analyzing files…');
  try{
    await ensureCore();
    const files = targetFileEl.files; if(!files || files.length===0){ log('pick at least one target file'); return; }
    const key = patternSelect.value; if(!key || key.startsWith('(no')){ log('select a pattern'); return; }

    const headWindow = parseInt(headWindowEl.value,10)||180;
    const frameSize = parseInt(frameSizeEl.value,10)||1024;
    const hop = parseInt(hopSizeEl.value,10)||512;
    const mfccC = parseInt(mfccCountEl.value,10)||13;

    const pat = await KV.get(key); if(!pat){ log('pattern not found'); return; }
    const patData = float32FromB64(pat.feature_payload.data_b64);
    const patFeat = { frames: pat.feature_payload.frame_count, dims: pat.feature_payload.dims, data: patData };

    const { metaMap } = parseBatch(batchInputEl.value);
    const run = startRun('Analyzing files…');

    for (let i=0; i<files.length; i++){
      if (run.aborted) break;
      const file = files[i];
      log('decoding head window for '+file.name+' …');

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
      addResultRow([
        meta.cms_id || '', meta.external_cms_id || '', meta.url || '',
        file.name,
        Number.isFinite(duration_s) ? fmtHHMMSS(Math.round(duration_s)) : '',
        Number.isFinite(outroStartS) ? fmtMMSS(outroStartS) : '',
        Number.isFinite(outroStartS) ? outroStartS.toFixed(2) : '',
        pat.name,
        Number.isFinite(introStartS) ? fmtMMSS(introStartS) : '',
        Number.isFinite(introStartS) ? introStartS.toFixed(2) : '',
        conf, score
      ]);
    }
  }catch(err){ log('analyze failed: '+err); }
  finally { setBusy(false); endRun(); }
});

// ---------- Analyze batch (URL-first standard) ----------
btnAnalyzeBatch.addEventListener('click', async ()=>{
  setBusy(true, 'Analyzing URLs…');
  try{
    await ensureCore();
    const key = patternSelect.value; if(!key || key.startsWith('(no')){ log('select a pattern'); return; }

    const headWindow = parseInt(headWindowEl.value,10)||180;
    const frameSize = parseInt(frameSizeEl.value,10)||1024;
    const hop = parseInt(hopSizeEl.value,10)||512;
    const mfccC = parseInt(mfccCountEl.value,10)||13;

    const pat = await KV.get(key); if(!pat){ log('pattern not found'); return; }
    const patData = float32FromB64(pat.feature_payload.data_b64);
    const patFeat = { frames: pat.feature_payload.frame_count, dims: pat.feature_payload.dims, data: patData };

    const { metaMap, urls } = parseBatch(batchInputEl.value);
    if (urls.length===0) { log('no URLs found in batch'); return; }

    const run = startRun('Analyzing URLs…');

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
      log('downloaded head for '+u+' ('+(obj.buffer.byteLength/1048576).toFixed(1)+' MB)');
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

      addResultRow([
        meta.cms_id || '', meta.external_cms_id || '', meta.url || u,
        base,
        Number.isFinite(duration_s) ? fmtHHMMSS(Math.round(duration_s)) : '',
        Number.isFinite(outroStartS) ? fmtMMSS(outroStartS) : '',
        Number.isFinite(outroStartS) ? outroStartS.toFixed(2) : '',
        pat.name,
        Number.isFinite(introStartS) ? fmtMMSS(introStartS) : '',
        Number.isFinite(introStartS) ? introStartS.toFixed(2) : '',
        conf, score
      ]);
    }
  }catch(err){
    if(String(err).includes('TypeError')) log('Hint: CORS likely missing (Access-Control-Allow-Origin).');
    log('analyze batch failed: '+err);
  } finally { setBusy(false); endRun(); }
});

// ---------- Export CSV ----------
btnExportCsv.addEventListener('click', ()=>{
  const headers = ['cms_id','external_cms_id','video_url','video_id','duration_hhmmss','outro_start_mmss','outro_start_s','matched_pattern','intro_start_mmss','intro_start_s','confidence','score'];
  const rows=[headers];
  const trs=resultsTable.querySelectorAll('tr');
  for(const tr of trs){
    const tds=tr.querySelectorAll('td');
    const row=[]; for(const td of tds){ const v=td.textContent.replace(/"/g,'""'); row.push('"'+v+'"'); }
    rows.push(row);
  }
  const csv=rows.map(r=>r.join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download='intro_outro_results.csv'; a.click();
  URL.revokeObjectURL(url);
});

// ---------- init ----------
refreshPatternList();
