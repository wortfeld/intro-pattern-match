// js/media.js
let ffmpeg = null;

function toBlobURL(url, mime){
  return fetch(url).then(r => {
    if (!r.ok) throw new Error('fetch '+r.status+' '+url);
    return r.arrayBuffer();
  }).then(buf => URL.createObjectURL(new Blob([buf], { type: mime })));
}

export async function ensureFFmpeg(log){
  if (ffmpeg) return;
  if (!window.FFmpegWASM) throw new Error('FFmpegWASM global missing');
  const FF = window.FFmpegWASM.FFmpeg;
  ffmpeg = new FF();
  if (log) ffmpeg.on('log', ev => ev?.message && log('[ffmpeg] '+ev.message));

  const bases = [
    new URL('../vendor/ffmpeg/core/umd/', import.meta.url).href,
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd/',
    'https://unpkg.com/@ffmpeg/core@0.12.10/dist/umd/',
  ];

  async function tryBase(i=0){
    if (i>=bases.length) throw new Error('no core base worked');
    try {
      const coreURL = await toBlobURL(bases[i]+'ffmpeg-core.js','text/javascript');
      const wasmURL = await toBlobURL(bases[i]+'ffmpeg-core.wasm','application/wasm');
      await ffmpeg.load({ coreURL, wasmURL });
    } catch {
      return tryBase(i+1);
    }
  }
  await tryBase(0);
}

export async function decodeSegmentToWav(fileLike, ss, t, log){
  const inName='in.bin', outName='out.wav';
  await ffmpeg.writeFile(inName, new Uint8Array(await fileLike.arrayBuffer()));
  const args = ['-ss', String(ss), '-t', String(t), '-i', inName, '-vn', '-ac','1','-ar','16000','-sample_fmt','s16', outName];
  if (log) log('ff: '+args.join(' '));
  await ffmpeg.exec(args);
  const data = await ffmpeg.readFile(outName);
  try { ffmpeg.deleteFile(inName); ffmpeg.deleteFile(outName); } catch {}
  return data.buffer;
}

export async function decodeHeadToWav(fileLike, headWindow, log){
  const inName='in2.bin', outName='head.wav';
  await ffmpeg.writeFile(inName, new Uint8Array(await fileLike.arrayBuffer()));
  const args = ['-t', String(headWindow), '-i', inName, '-vn', '-ac','1','-ar','16000','-sample_fmt','s16', outName];
  if (log) log('ff: '+args.join(' '));
  await ffmpeg.exec(args);
  const data = await ffmpeg.readFile(outName);
  try { ffmpeg.deleteFile(inName); ffmpeg.deleteFile(outName); } catch {}
  return data.buffer;
}

export function bufferToFileLike(buf, name){
  return { name, arrayBuffer: () => Promise.resolve(buf) };
}

// Abortable HEAD-range fetch for the first chunk of a URL
export function fetchHeadUrl(url, maxBytes=64*1024*1024, signal){
  return fetch(url, { headers: { 'Range': 'bytes=0-'+(maxBytes-1) }, mode: 'cors', signal })
    .then(async r => {
      if (r.status===206 || r.status===200) {
        const buffer = await r.arrayBuffer();
        return { name: url, buffer };
      }
      throw new Error('HTTP '+r.status+' for '+url);
    });
}

// Full fetch (used when creating a pattern from URL)
// (Not wired to AbortController in app.js, but you can pass one and it will work.)
export function fetchFullUrl(url, maxMB=300, signal){
  return fetch(url, { mode: 'cors', signal }).then(async r => {
    if(!r.ok) throw new Error('HTTP '+r.status+' '+url);
    const len = parseInt(r.headers.get('Content-Length')||'0',10);
    if(len && len > maxMB*1024*1024) throw new Error('file too large ('+len+' bytes) for cap '+maxMB+' MB');
    const buffer = await r.arrayBuffer();
    return { name: url, buffer };
  });
}

// Duration helpers (abortable)
export function getDurationFromSrc(src, signal){
  return new Promise((resolve,reject)=>{
    const el = document.createElement('video');
    el.preload='metadata';
    el.crossOrigin='anonymous';

    const onAbort = () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };

    function cleanup(){
      el.onloadedmetadata = null;
      el.onerror = null;
      try { el.removeAttribute('src'); el.load(); } catch {}
      if (signal) signal.removeEventListener('abort', onAbort);
    }

    el.onloadedmetadata = () => {
      const d = el.duration;
      cleanup();
      Number.isFinite(d) ? resolve(d) : reject(new Error('duration unavailable'));
    };
    el.onerror = () => { cleanup(); reject(new Error('metadata load failed')); };

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort);
    }

    el.src = src;
  });
}

export function getDurationFromFile(file, signal){
  const url = URL.createObjectURL(file);
  return getDurationFromSrc(url, signal).finally(()=>URL.revokeObjectURL(url));
}
