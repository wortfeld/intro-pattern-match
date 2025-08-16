export function slidingDistance(headFeat, patFeat){
  const D = patFeat.dims, Lp = patFeat.frames, Lt = headFeat.frames;
  if (Lt<Lp) return { bestIdx:-1, best:Infinity, second:Infinity };
  let best=Infinity, bestIdx=-1, second=Infinity;
  for(let s=0; s<=Lt-Lp; s++){
    let sum=0, idxH=s*D, idxP=0;
    for(let j=0;j<Lp;j++){
      for(let d=0; d<D; d++){
        const diff = headFeat.data[idxH + d] - patFeat.data[idxP + d];
        sum += diff*diff;
      }
      idxH += D; idxP += D;
    }
    const score = sum/(Lp*D);
    if(score<best){ second=best; best=score; bestIdx=s; }
    else if(score<second){ second=score; }
  }
  return { bestIdx, best, second };
}
