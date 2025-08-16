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
export function parseMetaCsv(text){
  const map = {};
  (text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).forEach(line=>{
    const [cms='', ext='', url='', dur=''] = line.split(',').map(s=>s.trim());
    const durS = parseTime(dur);
    const entry = { cms_id: cms, external_cms_id: ext, url, duration_s: Number.isFinite(durS)? durS : NaN };
    if (url) { map[url] = entry; map[basenameFromUrl(url)] = entry; }
    if (cms && !url) map[cms] = entry;
  });
  return map;
}
export function uuid(){
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c=>{
    const r=Math.random()*16|0, v=c==='x'?r:(r&0x3|0x8); return v.toString(16);
  });
}

export function smartSplit(line) {
  // Prefer TAB (Excel-friendly). Fall back to comma.
  if (line.includes('\t')) return line.split('\t').map(s=>s.trim());
  if (line.includes(','))  return line.split(',').map(s=>s.trim());
  return [line.trim()];
}

export function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s);
}

/**
 * Parse a mixed batch:
 * - Lines with at least 2 TAB/CSV fields -> metadata: cms_id, external_id, url?, duration?
 * - Bare lines that look like URLs -> treated as URL-only entries
 * Returns: { metaMap, urls }
 */
export function parseBatch(text) {
  const metaMap = {};
  const urls = [];
  (text||'').split(/\r?\n/).map(s=>s.trim()).filter(Boolean).forEach(line=>{
    const parts = smartSplit(line);
    if (parts.length === 1) {
      const p = parts[0];
      if (looksLikeUrl(p)) urls.push(p);
      return;
    }
    // Treat as metadata row
    const [cms='', ext='', url='', dur=''] = parts;
    const durS = parseTime(dur);
    const entry = { cms_id: cms, external_cms_id: ext, url, duration_s: Number.isFinite(durS)? durS : NaN };
    if (url) {
      metaMap[url] = entry;
      metaMap[basenameFromUrl(url)] = entry;
    }
    if (cms && !url) metaMap[cms] = entry; // allow cms_id lookup for local files
    // If a 3rd/4th column is actually a URL without headers, we also push to urls
    if (looksLikeUrl(url)) urls.push(url);
  });
  return { metaMap, urls };
}
