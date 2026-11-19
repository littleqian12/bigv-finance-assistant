import {renderLogicDetail} from './logic-detail.mjs';
export {renderLogicDetail};
const labels={success:'验证成功',failure:'验证失败',pending:'待验证'};
const stages={potential_direction:'潜在方向',sustained_attention:'持续研究',participation_inferred:'参与推断',participation_self_reported:'本人自述参与',holding_self_reported:'本人自述持有',revised:'判断修正',closed:'已关闭'};
const dimensions={author_participation:'本人参与判断',direction_thesis:'方向假设',strategy_outcome:'作者策略反馈'};
const el=(doc,tag,text,css)=>{const n=doc.createElement(tag);if(text!=null)n.textContent=String(text);if(css)n.className=css;return n;};
const percent=n=>n==null?'暂无已闭环样本':`${(n*100).toFixed(1)}%`;
let current=null,requestId=0,selected=null;
let returnFocus=null,savedOverflow='';
export function openLogicDetail(row,{doc=document,trigger=null}={}){
  const detail=doc.getElementById('logic-history-detail'),dialog=doc.getElementById('logic-history-dialog');if(!detail || !dialog)return;
  selected=row.claimId;renderLogicDetail(doc,detail,row);
  if(!dialog.open){returnFocus=trigger || doc.activeElement;savedOverflow=doc.documentElement?.style?.overflow || '';if(doc.documentElement?.style)doc.documentElement.style.overflow='hidden';dialog.showModal();}
  detail.scrollTop=0;
}
export function renderLogicHistory(data,{doc=document}={}){
  const summary=doc.getElementById('logic-history-summary'),list=doc.getElementById('logic-history-list'),detail=doc.getElementById('logic-history-detail');if(!summary || !list || !detail)return;
  summary.replaceChildren();list.replaceChildren();
  if(!data?.available){summary.append(el(doc,'p','逻辑链台账暂不可用，请刷新重试。'));return;}
  const m=data.metrics,stats=el(doc,'div',undefined,'logic-metrics');
  for(const [title,value,note] of [
    ['历史复盘验证率',percent(m.retrospective.successRate),`${m.retrospective.success}成功 / ${m.retrospective.failure}失败；已闭环${m.retrospective.resolved}项判断`],
    ['事前预测成功率',percent(m.prospective.successRate),`已闭环${m.prospective.resolved}项；后验重建不计入`],
    ['逻辑链覆盖',`${m.totalChains}条`,`${m.pendingChains}条待验证；${m.strategyFailureCount}条有策略失败反馈`]
  ]){const card=el(doc,'div',undefined,'logic-metric');card.append(el(doc,'span',title),el(doc,'strong',value),el(doc,'small',note));stats.append(card);}summary.append(stats,el(doc,'p',data.method));
  const groups=m.byDimension || {};summary.append(el(doc,'p',Object.entries(groups).map(([k,v])=>`${dimensions[k]}：${v.success}成功、${v.failure}失败（${percent(v.successRate)}）`).join('；'),'logic-meta'));
  if(data.invalidReviews?.length)summary.append(el(doc,'p',`${data.invalidReviews.length}项复核未通过原帖校验，已排除统计。`));
  const filter=doc.getElementById('logic-history-filter')?.value || 'all';const rows=data.rows.filter(r=>filter==='all' || (filter==='strategy_failure'?!!r.strategyFailureReason:r.status===filter));
  summary.append(el(doc,'p','按首次线索日期降序，同日按最新证据日期降序。最后一列引用最近一份有对应判级的日报；0信息、1观察、2强化关注、3交易暗示、4明确动作。','logic-meta'));
  const wrap=el(doc,'div',undefined,'daily-review-table'),table=el(doc,'table',undefined,'logic-history-table'),head=el(doc,'tr');for(const label of ['逻辑链 / 点击查看分析','相关个股','首次线索 ↓','最新证据','逻辑验证','失败原因 / 未决问题','日报信号等级'])head.append(el(doc,'th',label));table.append(head);
  const open=(row,trigger)=>openLogicDetail(row,{doc,trigger});
  for(const row of rows){const tr=el(doc,'tr');const name=el(doc,'td'),button=el(doc,'button',row.name,'logic-open');button.type='button';button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-controls','logic-history-dialog');button.addEventListener('click',event=>{event.stopPropagation?.();open(row,button);});name.append(button);
    const grade=el(doc,'td');if(row.dailySignalGrade){const g=row.dailySignalGrade;grade.append(el(doc,'strong',`${g.level}级 · ${g.label}`),el(doc,'p',`${g.date} 日报`,'logic-meta'));grade.title=g.entries.map(e=>`${e.object}：${e.basis}`).join('；')+'；'+g.boundary;}else grade.append(el(doc,'span','未判级','logic-meta'));
    const stocks=el(doc,'td',null,'logic-related-stocks'),related=row.relatedStocks || [];
    if(!related.length)stocks.append(el(doc,'span','尚未具名'));
    else{
      const priority=s=>['bought_self_reported','holding_self_reported'].includes(s.state)?0:s.origin==='author_image'?1:s.state==='abandoned'||s.state==='considered_abandoned'?4:s.origin==='agent_screened'?3:2;
      const preview=[...related].sort((a,b)=>priority(a)-priority(b)).slice(0,2);
      stocks.append(el(doc,'span',preview.map(s=>s.name).join('、')+(related.length>2?'…':''),'logic-stock-summary'));
      const counts=new Map();for(const s of related){const label={author_explicit:'明示',author_image:'附图',agent_screened:'自主筛选',author_mentioned:'提及'}[s.origin] || '待核';counts.set(label,(counts.get(label)||0)+1);}
      stocks.append(el(doc,'small',[...counts].map(([label,count])=>`${label}${count}`).join(' · '),'logic-stock-counts'));
      const more=el(doc,'button',`共${related.length}只 · 查看详情`,'logic-stock-more');more.type='button';more.setAttribute('aria-haspopup','dialog');more.addEventListener('click',event=>{event.stopPropagation?.();open(row,more);});stocks.append(more);
    }

    tr.append(name,stocks,el(doc,'td',row.firstPotential?.date || '未知'),el(doc,'td',row.lastEvidenceDate || '未知'),el(doc,'td',`${labels[row.status]}${row.retrospective?' · 后验复盘':''}`,`logic-status-${row.status}`),el(doc,'td',row.failureReason || (row.status==='pending'?row.verificationSummary?.summary || row.unknowns[0] || '等待后续证据':'已获后续证据支持；目标及边界见详情')),grade);tr.addEventListener('click',()=>open(row,button));table.append(tr);}
  wrap.append(table);list.append(wrap);if(!rows.length)list.append(el(doc,'p','当前筛选没有逻辑链。'));
  if(selected){const row=data.rows.find(r=>r.claimId===selected);if(row)renderLogicDetail(doc,detail,row);else doc.getElementById('logic-history-dialog')?.close();}
}
export async function loadLogicHistory({doc=document,fetchImpl=fetch}={}){
  const summary=doc.getElementById('logic-history-summary');if(!summary)return;
  const id=++requestId;summary.textContent='正在读取逻辑链与验证台账…';
  try{const r=await fetchImpl('/api/logic-history');if(!r.ok)throw Error(`HTTP ${r.status}`);const d=await r.json();if(id!==requestId)return;current=d;renderLogicHistory(d,{doc});}catch{if(id===requestId)summary.textContent='逻辑链读取失败，请点击刷新重试。';}
}
export function bindLogicHistory({doc=document}={}){
  doc.getElementById('logic-history-refresh')?.addEventListener('click',()=>{void loadLogicHistory({doc});});doc.getElementById('logic-history-filter')?.addEventListener('change',()=>{if(current)renderLogicHistory(current,{doc});});
  const marketButton=doc.getElementById('logic-market-refresh');marketButton?.addEventListener('click',async()=>{
    marketButton.disabled=true;const summary=doc.getElementById('logic-history-summary');summary.textContent='正在核对证券身份并更新历史日线…';
    try{const response=await fetch('/api/logic-history/refresh-market',{method:'POST'});if(!response.ok)throw Error('refresh_failed');const result=await response.json();if(result.error)throw Error(result.error);await loadLogicHistory({doc});const failures=(result.results || []).filter(r=>r.status==='failed');if(failures.length)summary.append(el(doc,'p',`${failures.length}只股票行情暂未取得，详情保留缺口，不补造涨跌幅。`));}catch{summary.textContent='行情更新失败，已保存数据仍保留；请稍后重试。';}finally{marketButton.disabled=false;}
  });
  const dialog=doc.getElementById('logic-history-dialog');if(!dialog)return;
  doc.getElementById('logic-history-close')?.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom)dialog.close();});
  dialog.addEventListener('close',()=>{selected=null;if(doc.documentElement?.style)doc.documentElement.style.overflow=savedOverflow;returnFocus?.focus?.({preventScroll:true});returnFocus=null;});
}
