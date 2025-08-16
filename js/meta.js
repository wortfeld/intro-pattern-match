// js/meta.js

// ---- Formatting helpers ----
export function fmtMMSS(seconds) {
  seconds = Math.max(0, seconds);
  const s = Math.round(seconds);
  const m = Math.floor(s/60);
  const r = s%60;
  return String(m).padStart(2,'0')+":"+String(r).padStart(2,'0');
}

export function fmtHHMMSS(seconds){
  seconds = Math.max(0, seconds|0);
  const h = Math.floor(seconds/3600);
  const m = Math.floor((seconds%3600)/60);
  const s = seconds%60;
  return (h>0? String(h).padStart(2,'0')+':' : '') + String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}

export function parseTime(str){
  if(!str) return NaN;
  const x=str.trim();
  if(/^\d+(\.\d+)?$/.test(x)) return parseFloat(x);
  if(/^\d{1,2}:\d{2}$/.test(x)){ const p=x.split(":"); return (+p[0])*60+(+p[1]); }
  if(/^\d{1,2}:\d{2}:\d{2}$/.test(x)){ const p=x.split(":").map(Number); return p[0]*3600+p[1]*60+p[2]; }
  return NaN;
}

export function basenameFromUrl(u){
  try { const p=new URL(u); const s=p.pathname.split('/'); return decodeURIComponent(s[s.length-1]||'remote.bin'); }
  catch { return 'remote.bin'; }
}

export function uuid(){
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r=Math.random()*16|0, v=c==='x'?r:(r&0x3|0x8); return v.toString(16);
  });
}

// ---- Batch parsing (TSV-first, CSV fallback) ----
export function smartSplit(line) {
  // Prefer TAB (Excel-friendly). Fall back to comma.
  if (line.includes('\t')) return line.split('\t').map(s=>s.trim());
  if (line.includes(','))  return line.split(',').map(s=>s.trim());
  return [line.trim()];
}

export function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s);
}

// Hidden power feature: build CDN MP4 when 3rd column is not a .mp4
const POWER_BASE = 'https://mediandr-a.akamaihd.net';
function toCdnMp4IfNeeded(raw) {
  if (!raw) return '';
  const t = String(raw).trim();
  if (!t) return '';
  const noQuery = t.split(/[?#]/)[0];
  if (noQuery.toLowerCase().endsWith('.mp4')) return t; // already an .mp4 URL
  // Compose: POWER_BASE + t + '.ln.mp4' (normalize slashes)
  const base = POWER_BASE.replace(/\/+$/,'');
  const path = t.replace(/^\/+/, '');
  return `${base}/${path}.ln.mp4`;
}

/**
 * Parse a mixed batch:
 *  - Lines with 2–4 TAB/CSV fields -> metadata: cms_id, external_id, url?, duration?
 *  - Bare lines that look like URLs -> treated as URL-only entries
 * Returns: { metaMap, urls }
 *
 * NOTE: The hidden power feature is applied ONLY to the 3rd column (MP4-URL field) of metadata rows.
 */
export function parseBatch(text) {
  const metaMap = {};
  const urls = [];

  (text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).forEach(line=>{
    const parts = smartSplit(line);

    if (parts.length === 1) {
      const p = parts[0];
      // Bare URL line: keep as-is (no power feature on single-field lines)
      if (looksLikeUrl(p)) urls.push(p);
      return;
    }

    // Treat as metadata row
    const [cms='', ext='', urlField='', dur=''] = parts;
    const durS = parseTime(dur);

    // Apply hidden power feature on the MP4-URL field
    const finalUrl = urlField ? toCdnMp4IfNeeded(urlField) : '';

    const entry = {
      cms_id: cms,
      external_cms_id: ext,
      url: finalUrl,
      duration_s: Number.isFinite(durS)? durS : NaN
    };

    if (finalUrl) {
      metaMap[finalUrl] = entry;
      metaMap[basenameFromUrl(finalUrl)] = entry;
      // also process as a URL task
      urls.push(finalUrl);
    }

    if (cms && !finalUrl) {
      // Allow matching local files by cms_id if no URL provided
      metaMap[cms] = entry;
    }
  });

  return { metaMap, urls };
}

// (Optional legacy helper; kept for compatibility, not used by app.js)
export function parseMetaCsv(text){
  const map = {};
  (text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).forEach(line=>{
    const parts = smartSplit(line);
    const [cms='', ext='', url='', dur=''] = parts;
    const durS = parseTime(dur);
    const entry = { cms_id: cms, external_cms_id: ext, url, duration_s: Number.isFinite(durS)? durS : NaN };
    if(url){ map[url] = entry; map[basenameFromUrl(url)] = entry; }
    if(cms && !url) map[cms] = entry;
  });
  return map;
}
