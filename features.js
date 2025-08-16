export function parseWavPCM16(buf){
  const dv = new DataView(buf);
  const str=(o,l)=>String.fromCharCode(...Array.from({length:l},(_,i)=>dv.getUint8(o+i)));
  if (str(0,4)!=='RIFF' || str(8,4)!=='WAVE') throw new Error('Not WAVE');
  let off=12, fmt=null, dataOff=0, dataLen=0;
  while(off<dv.byteLength){
    const id=str(off,4), size=dv.getUint32(off+4,true);
    if(id==='fmt ') fmt={ audioFormat: dv.getUint16(off+8,true), numChannels: dv.getUint16(off+10,true), sampleRate: dv.getUint32(off+12,true), bitsPerSample: dv.getUint16(off+22,true) };
    else if(id==='data'){ dataOff=off+8; dataLen=size; }
    off+=8+size;
  }
  if(!fmt||!dataOff) throw new Error('Invalid WAV');
  if(fmt.audioFormat!==1||fmt.numChannels!==1||fmt.bitsPerSample!==16) throw new Error('Expect PCM16 mono');
  const samples = new Int16Array(buf, dataOff, dataLen/2);
  const out = new Float32Array(samples.length);
  for(let i=0;i<samples.length;i++) out[i]=samples[i]/32768;
  return { sampleRate: fmt.sampleRate, signal: out };
}

export function computeMFCC(signal, sr, frameSize, hop, mfccCount){
  const frames = Math.floor((signal.length - frameSize) / hop) + 1;
  if(frames<1) return { frames:0, dims: mfccCount, data: new Float32Array(0) };
  const data = new Float32Array(frames * mfccCount);
  for(let i=0;i<frames;i++){
    const start = i*hop;
    const frame = signal.subarray(start, start+frameSize);
    const feats = window.Meyda.extract('mfcc', frame, { sampleRate: sr, bufferSize: frameSize, melBands: 40, numberOfMFCCCoefficients: mfccCount }) || new Array(mfccCount).fill(0);
    for(let k=0;k<mfccCount;k++) data[i*mfccCount+k] = feats[k];
  }
  // z-score per dim
  for(let d=0; d<mfccCount; d++){
    let sum=0; for(let i=0;i<frames;i++) sum += data[i*mfccCount+d];
    const mean=sum/frames;
    let varsum=0; for(let i=0;i<frames;i++){ const v=data[i*mfccCount+d]-mean; varsum+=v*v; }
    let std=Math.sqrt(varsum/Math.max(1,frames-1)); if(std<1e-6) std=1;
    for(let i=0;i<frames;i++) data[i*mfccCount+d] = (data[i*mfccCount+d]-mean)/std;
  }
  return { frames, dims: mfccCount, data };
}
