const D = JSON.parse(document.getElementById('suite-data').textContent);
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clean = s => s.replace(/^(?:🔴|🟠|🟡)?\s*【P[012]】\s*/u, '');
const categories = D.categories;
const registry = new Map(), root = {id:'root',label:D.title,type:'root',children:[],depth:0};
registry.set(root.id, root);
const caseById = new Map(D.cases.map(c => [c.id,c]));
let local = null;
try { local = window.localStorage; } catch { /* Storage is optional in previews. */ }
const usage = new CaseSelection([...caseById.keys()], D.suiteId, local, D.usageSnapshot);

function categoryOf(c) {
  return c.categoryId;
}
function node(id,label,type,parent,extra={}) {
  const n = {id,label,type,parent,children:[],depth:parent.depth+1,...extra};
  parent.children.push(n); registry.set(id,n); return n;
}
for (const [key,label] of categories) {
  const category = node(key,label,'category',root);
  const records = D.cases.filter(c => categoryOf(c) === key);
  [...new Set(records.map(c => c.group))].forEach((g,i) => {
    const group = node(key+'-g'+i,g.split(' / ').at(-1),'group',category,{fullLabel:g});
    for (const sceneName of ['正常场景','异常场景','边界场景']) {
      const recordsInScene = records.filter(c => c.group === g && c.scene === sceneName);
      if (!recordsInScene.length) continue;
      const scene = node(group.id+'-'+sceneName,sceneName,'scene',group);
      for (const c of recordsInScene) node(c.id,clean(c.title),'case',scene,{record:c});
    }
  });
}
function indexLeaves(n) {
  n.leafIds = n.type === 'case' ? [n.id] : n.children.flatMap(indexLeaves);
  return n.leafIds;
}
indexLeaves(root);
const expanded = new Set(['root',...categories.map(c => c[0])]);
let searchActive=false,savedExpansion=null,selected=null,matching=D.cases.slice();
const searchTexts = new Map(D.cases.map(c => [c.id,[c.group,c.title,c.pre,...c.steps,...c.expect,c.note].join(' ').toLowerCase()]));
const view={x:24,y:24,scale:1},size={width:0,height:0};
let shown=[],layoutPending=false;
const positions=new Map(),columnX=[0,310,600,930,1125],widths=[265,245,285,150,360],gap=14;
function transform() {
  $('world').style.transform=`translate(${view.x}px,${view.y}px) scale(${view.scale})`;
  $('zoom-value').textContent=Math.round(view.scale*100)+'%';
}
function fit() {
  const r=$('viewport').getBoundingClientRect();
  if (!size.width || !r.width) return;
  view.scale=Math.max(.02,Math.min(1,(r.width-56)/size.width,(r.height-70)/size.height));
  view.x=(r.width-size.width*view.scale)/2;view.y=(r.height-size.height*view.scale)/2;transform();
}
function zoom(factor,x,y) {
  const r=$('viewport').getBoundingClientRect();x??=r.width/2;y??=r.height/2;
  const s=Math.max(.02,Math.min(2.5,view.scale*factor));
  view.x=x-(x-view.x)*s/view.scale;view.y=y-(y-view.y)*s/view.scale;view.scale=s;transform();
}
function visibleChildren(n) { return expanded.has(n.id) ? n.children.filter(c=>c.matches>0) : []; }
function syncSelection() {
  for (const element of document.querySelectorAll('.node')) {
    const n=registry.get(element.dataset.id),state=usage.inspect(n.leafIds),checkbox=element.querySelector('.node-check');
    checkbox.checked=state.checked;checkbox.indeterminate=state.indeterminate;
    element.dataset.selection=state.checked?'all':state.indeterminate?'partial':'none';
    const count=element.querySelector('.usage-count');
    if(count) count.textContent=state.count+'/'+state.total;
  }
  const state=usage.inspect(root.leafIds);
  $('selection-summary').textContent=`已选 ${state.count} / ${state.total} 条 · 未选 ${state.total-state.count} 条`;
  $('save-notice').textContent=usage.notice;
  if(selected && $('detail-use')) {
    $('detail-use').checked=usage.selected[selected];
    $('detail-usage').textContent=usage.selected[selected]?'使用这条用例':'不使用这条用例';
  }
}
function setNodeUsage(id,keep) { usage.set(registry.get(id).leafIds,keep);syncSelection(); }
function render(anchorId) {
  nodeSizeObserver.disconnect();
  shown=[];
  function collect(n){if(n.matches===0)return;shown.push(n);visibleChildren(n).forEach(collect)}collect(root);
  $('empty').hidden=matching.length!==0;
  $('nodes').innerHTML=shown.map(n=>{
    const leaf=n.type==='case',label=esc(n.label);
    const title=leaf?`<span class="prio">${n.record.priority}</span>${label}${n.record.kind==='专项验证'?'<span class="kind-tag">专项</span>':''}`:label;
    const meta=leaf?'':`<span class="node-meta"><span class="usage-count"></span><span class="toggle-mark" aria-hidden="true">${expanded.has(n.id)?'−':'+'}</span></span>`;
    return `<div class="node${selected===n.id?' selected':''}" data-id="${esc(n.id)}" data-type="${n.type}" style="width:${widths[n.depth]}px"><input type="checkbox" class="node-check" aria-label="使用「${label}」"><button class="node-open" ${leaf?'':`aria-expanded="${expanded.has(n.id)}"`} aria-label="${leaf?'查看用例':'展开或收起'}「${label}」" title="${esc(n.fullLabel||n.label)}"><span class="label">${title}</span>${meta}</button></div>`;
  }).join('');
  // Counts can wrap the label, so fill them before measuring the final content.
  syncSelection();
  layoutNodes(anchorId);
  $('result').textContent=`匹配 ${matching.length} / ${D.cases.length} 条`;
  for(const element of document.querySelectorAll('.node')){
    const id=element.dataset.id;
    element.querySelector('.node-check').addEventListener('change',e=>setNodeUsage(id,e.target.checked));
    element.querySelector('.node-open').addEventListener('click',()=>{
      const n=registry.get(id);
      if(n.type==='case')showCase(id);
      else{expanded.has(id)?expanded.delete(id):expanded.add(id);render(id);document.querySelector(`[data-id="${id}"] .node-open`)?.focus({preventScroll:true})}
    });
    nodeSizeObserver.observe(element);
  }
}
function layoutNodes(anchorId) {
  const old=anchorId?positions.get(anchorId):null;
  const elements=new Map([...document.querySelectorAll('.node')].map(e=>[e.dataset.id,e]));
  const heights=shown.map(n=>elements.get(n.id).offsetHeight);
  // Hidden preview tabs have no measurable boxes. ResizeObserver retries on reveal.
  layoutPending=heights.some(height=>height<=0);
  if(layoutPending)return;
  shown.forEach((n,i)=>{n.height=heights[i]});
  function measure(n){const kids=visibleChildren(n);n.span=Math.max(n.height,kids.reduce((s,c)=>s+measure(c),0)+Math.max(0,kids.length-1)*gap);return n.span}
  positions.clear();
  if(shown.length){
    measure(root);
    function place(n,top){
      const pos={x:columnX[n.depth],y:top+(n.span-n.height)/2,width:widths[n.depth],height:n.height};positions.set(n.id,pos);
      Object.assign(elements.get(n.id).style,{left:pos.x+'px',top:pos.y+'px'});
      const kids=visibleChildren(n),height=kids.reduce((s,c)=>s+c.span,0)+Math.max(0,kids.length-1)*gap;
      let next=top+(n.span-height)/2;
      for(const c of kids){place(c,next);next+=c.span+gap}
    }place(root,0);
  }
  size.width=shown.length?Math.max(...shown.map(n=>columnX[n.depth]+widths[n.depth])):0;size.height=shown.length?root.span:0;
  $('world').style.width=size.width+'px';$('world').style.height=size.height+'px';
  $('links').setAttribute('width',size.width);$('links').setAttribute('height',size.height);
  $('links').innerHTML=shown.filter(n=>n.parent&&positions.has(n.parent.id)).map(n=>{
    const p=positions.get(n.parent.id),c=positions.get(n.id),x1=p.x+p.width,y1=p.y+p.height/2,x2=c.x,y2=c.y+c.height/2,m=(x1+x2)/2;
    return `<path d="M ${x1},${y1} C ${m},${y1} ${m},${y2} ${x2},${y2}"/>`;
  }).join('');
  if(old&&positions.has(anchorId)){const now=positions.get(anchorId);view.x+=(old.x-now.x)*view.scale;view.y+=(old.y-now.y)*view.scale}transform();
}
function refresh() {
  const query=$('search').value.trim().toLowerCase(),active=Boolean(query);
  if(active&&!searchActive)savedExpansion=new Set(expanded);
  if(!active&&searchActive&&savedExpansion){expanded.clear();for(const id of savedExpansion)expanded.add(id);savedExpansion=null}
  searchActive=active;
  matching=D.cases.filter(c=>(!query||searchTexts.get(c.id).includes(query))&&(!$('kind').value||c.kind===$('kind').value)&&(!$('priority').value||c.priority===$('priority').value));
  const ids=new Set(matching.map(c=>c.id));
  function matches(n){n.matches=n.type==='case'?(ids.has(n.id)?1:0):n.children.reduce((s,c)=>s+matches(c),0);if(active&&n.matches&&n.type!=='case')expanded.add(n.id);return n.matches}matches(root);
  render();if(active)fit();if(selected&&!ids.has(selected))closeDetail(false);
}
function showCase(id) {
  const c=caseById.get(id);selected=id;$('detail').hidden=false;$('mobile-shade').hidden=false;
  $('detail-body').innerHTML=`<h2><span class="prio">${c.priority}</span>${esc(clean(c.title))}</h2><p class="path">${esc(c.group)} / ${esc(c.scene)} · ${esc(c.kind)}</p><label class="detail-selection"><input type="checkbox" id="detail-use"><span id="detail-usage"></span></label><h3>前置条件</h3><p>${esc(c.pre)}</p><h3>操作步骤</h3><ol>${c.steps.map(s=>'<li>'+esc(s)+'</li>').join('')}</ol><h3>预期结果</h3><ol>${c.expect.map(s=>'<li>'+esc(s)+'</li>').join('')}</ol>${c.note?'<h3>本条备注</h3><p class="note">'+esc(c.note)+'</p>':''}`;
  $('detail-use').addEventListener('change',e=>setNodeUsage(id,e.target.checked));$('detail').scrollTop=0;syncSelection();
  document.querySelectorAll('.node').forEach(e=>e.classList.toggle('selected',e.dataset.id===id));
  const i=matching.findIndex(c=>c.id===id);$('previous-case').disabled=i<=0;$('next-case').disabled=i>=matching.length-1;
  requestAnimationFrame(revealSelected);$('detail-use').focus({preventScroll:true});
}
function revealSelected(){
  if(!selected||!positions.has(selected))return;
  const p=positions.get(selected),r=$('viewport').getBoundingClientRect(),padding=25;
  if(view.scale<.7)view.scale=.85;
  const left=p.x*view.scale+view.x,right=(p.x+p.width)*view.scale+view.x,top=p.y*view.scale+view.y,bottom=(p.y+p.height)*view.scale+view.y;
  if(left<padding)view.x+=padding-left;else if(right>r.width-padding)view.x-=right-r.width+padding;
  if(top<padding)view.y+=padding-top;else if(bottom>r.height-padding)view.y-=bottom-r.height+padding;transform();
}
function closeDetail(restore=true){const current=selected?document.querySelector(`[data-id="${selected}"] .node-open`):null;$('detail').hidden=true;$('mobile-shade').hidden=true;selected=null;document.querySelectorAll('.node').forEach(e=>e.classList.remove('selected'));if(restore)current?.focus({preventScroll:true})}
function adjacent(delta){const next=matching[matching.findIndex(c=>c.id===selected)+delta];if(!next)return;let n=registry.get(next.id);while(n.parent){expanded.add(n.parent.id);n=n.parent}render();showCase(next.id)}
function download(name,text,type){const url=URL.createObjectURL(new Blob([text],{type})),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000)}
function htmlWithSelection(){
  const clone=document.documentElement.cloneNode(true);
  clone.querySelector('#suite-data').textContent=JSON.stringify({...D,usageSnapshot:usage.snapshot()}).replaceAll('<',String.fromCharCode(92)+'u003c');
  for(const s of ['#nodes','#links','#detail-body'])clone.querySelector(s).replaceChildren();
  for(const s of ['#detail','#mobile-shade','#selection-dialog'])clone.querySelector(s).hidden=true;
  clone.querySelector('#world').removeAttribute('style');clone.querySelector('#selection-text').textContent='';clone.querySelector('header a.button')?.remove();
  clone.querySelector('#search').setAttribute('value','');
  for(const id of ['kind','priority'])for(const option of clone.querySelector('#'+id).options)option.toggleAttribute('selected',option.value==='');
  return '<!doctype html>'+String.fromCharCode(10)+clone.outerHTML;
}
async function copySelection(){try{await navigator.clipboard.writeText($('selection-text').value);$('export-notice').textContent=D.confirmation?'已复制，请粘回会话确认。':'已复制勾选清单。'}catch{$('selection-text').focus();$('selection-text').select();$('export-notice').textContent='自动复制不可用，请手动复制下面已选文本。'}}
$('select-all').addEventListener('click',()=>setNodeUsage('root',true));$('select-none').addEventListener('click',()=>setNodeUsage('root',false));
$('export-selection').addEventListener('click',()=>{$('selection-text').value=confirmationText(D.confirmation,usage.selected,D.suiteId);$('selection-dialog').hidden=false;copySelection()});
$('copy-selection').addEventListener('click',copySelection);
$('download-selection').addEventListener('click',()=>{download('用例勾选结果.txt',$('selection-text').value,'text/plain;charset=utf-8');$('export-notice').textContent='已发起下载；若没有保存，请复制上面的文本。'});
$('close-export').addEventListener('click',()=>{$('selection-dialog').hidden=true;$('export-selection').focus()});
$('save-html').addEventListener('click',()=>{download('用例勾选思维导图.html',htmlWithSelection(),'text/html;charset=utf-8');$('save-notice').textContent='已发起勾选版 HTML 下载，请确认文件已保存。'});
$('previous-case').addEventListener('click',()=>adjacent(-1));$('next-case').addEventListener('click',()=>adjacent(1));$('close-detail').addEventListener('click',()=>closeDetail());$('mobile-shade').addEventListener('click',()=>closeDetail());
function trapPanel(panel,close){panel.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();close()}if(e.key!=='Tab')return;const controls=[...panel.querySelectorAll('button:not(:disabled),input,textarea')];if(e.shiftKey&&document.activeElement===controls[0]){e.preventDefault();controls.at(-1)?.focus()}else if(!e.shiftKey&&document.activeElement===controls.at(-1)){e.preventDefault();controls[0]?.focus()}})}
trapPanel($('detail'),closeDetail);trapPanel($('selection-dialog'),()=>$('close-export').click());
let timer;$('search').addEventListener('input',()=>{clearTimeout(timer);timer=setTimeout(refresh,160)});
for(const id of ['kind','priority'])$(id).addEventListener('change',()=>{refresh();fit()});
$('overview').addEventListener('click',()=>{closeDetail(false);$('search').value='';$('kind').value='';$('priority').value='';searchActive=false;savedExpansion=null;expanded.clear();expanded.add('root');categories.forEach(([id])=>expanded.add(id));refresh();fit()});
$('expand-all').addEventListener('click',()=>{for(const n of registry.values())if(n.type!=='case')expanded.add(n.id);refresh();fit()});
$('fit-top').addEventListener('click',fit);$('fit-bottom').addEventListener('click',fit);$('zoom-in').addEventListener('click',()=>zoom(1.25));$('zoom-out').addEventListener('click',()=>zoom(.8));
const viewport=$('viewport');
viewport.addEventListener('wheel',e=>{if(e.target.closest('input'))return;e.preventDefault();const r=viewport.getBoundingClientRect();zoom(Math.exp(-e.deltaY*.0015),e.clientX-r.left,e.clientY-r.top)},{passive:false});
let drag=null;
viewport.addEventListener('pointerdown',e=>{if(e.button!==0||e.target.closest('.node,button,input'))return;drag={x:e.clientX,y:e.clientY,vx:view.x,vy:view.y};viewport.setPointerCapture(e.pointerId);viewport.classList.add('dragging')});
viewport.addEventListener('pointermove',e=>{if(!drag)return;view.x=drag.vx+e.clientX-drag.x;view.y=drag.vy+e.clientY-drag.y;transform()});
for(const event of ['pointerup','pointercancel'])viewport.addEventListener(event,()=>{drag=null;viewport.classList.remove('dragging')});
viewport.addEventListener('keydown',e=>{if(e.target!==viewport)return;if(e.key==='0'){e.preventDefault();fit()}else if(e.key==='+'||e.key==='='){e.preventDefault();zoom(1.25)}else if(e.key==='-'){e.preventDefault();zoom(.8)}else if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();view.x+=e.key==='ArrowLeft'?45:e.key==='ArrowRight'?-45:0;view.y+=e.key==='ArrowUp'?45:e.key==='ArrowDown'?-45:0;transform()}});
let layoutFrame;
const nodeSizeObserver=new ResizeObserver(entries=>{
  if(!entries.some(({target})=>target.offsetHeight>0&&(layoutPending||target.offsetHeight!==registry.get(target.dataset.id)?.height)))return;
  cancelAnimationFrame(layoutFrame);
  layoutFrame=requestAnimationFrame(()=>{layoutNodes();if(selected)revealSelected();else fit()});
});
refresh();requestAnimationFrame(fit);let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{layoutNodes();if(selected)revealSelected();else fit()},100)}).observe(viewport);
