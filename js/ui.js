export function logger(el){
  return (s)=>{ const t=document.createTextNode(s); el.appendChild(t); el.appendChild(document.createElement('br')); el.scrollTop = el.scrollHeight; };
}
export function addResultRowRich(tbody, cells){
  const tr=document.createElement('tr');
  for(const v of cells){ const td=document.createElement('td'); td.textContent = v ?? ''; tr.appendChild(td); }
  tbody.appendChild(tr);
}
