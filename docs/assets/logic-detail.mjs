const stages={potential_direction:'发现方向',sustained_attention:'持续关注',participation_inferred:'推断已参与',participation_self_reported:'本人承认参与',holding_self_reported:'本人确认持有',revised:'修正判断',closed:'结束跟踪'};
const states={candidate:'候选关联，交易未确认',abandoned:'放弃或明确未买',considered_abandoned:'放弃或明确未买',bought_self_reported:'本人自述买过',holding_self_reported:'本人自述持有',holding_image_indication:'图示持仓线索'};
const labels={success:'后续证据支持',failure:'原假设未成立',pending:'尚待验证'};
const el=(d,t,text,css)=>{const n=d.createElement(t);if(text!=null)n.textContent=String(text);if(css)n.className=css;return n;};
const arr=x=>Array.isArray(x)?x:[];
const unique=x=>[...new Set(x.filter(Boolean))];
const excerpt=(s,n=100)=>String(s || '').length>n?String(s).slice(0,n)+'…':String(s || '');
function disclosure(doc,parent,label,fill){const d=el(doc,'details',null,'logic-disclosure');d.append(el(doc,'summary',label));fill(d);parent.append(d);return d;}
function source(doc,parent,e,{short=false}={}){const text=e.quote || e.evidence || '';const p=el(doc,'p',text?`“${short?excerpt(text):text}” `:null,'logic-source');const id=e.postId || e.post_id;if(/^\d+$/.test(String(id))){const link=el(doc,'a',`原帖 ${id}`);link.href=`https://xueqiu.com/xxxx/${id}`;link.target='_blank';link.rel='noopener noreferrer';p.append(link);}parent.append(p);}
export function groupLogicTimeline(row){
 const groups=new Map();for(const s of arr(row.dailyStates)){const g=groups.get(s.date)||[];g.push(s);groups.set(s.date,g);}
 return [...groups.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([date,versions])=>{
   const ordered=[...versions].sort((a,b)=>String(b.analysisRecordedAt || '').localeCompare(String(a.analysisRecordedAt || ''))),primary=ordered[0],byId=new Map();
   for(const s of ordered)for(const e of arr(s.evidence)){const id=String(e.postId);if(!byId.has(id))byId.set(id,e);}
   return {date,primary,versions:ordered,evidence:[...byId.values()],unknowns:unique(ordered.flatMap(s=>arr(s.unknowns))),counterEvidence:ordered.flatMap(s=>arr(s.counterEvidence)),members:[...new Map([...ordered].reverse().flatMap(s=>arr(s.members)).map(m=>[m.name || m.symbol,m])).values()]};
 });
}
export function renderReasoningTimeline(doc,panel,row,timeline){
 const heading=el(doc,'div',null,'logic-graph-heading');heading.append(el(doc,'h4','这条判断是怎样形成的'));
 const controls=el(doc,'div',null,'logic-graph-controls'),previous=el(doc,'button','← 较早'),next=el(doc,'button','较晚 →');
 previous.type=next.type='button';controls.append(previous,next);heading.append(controls);panel.append(heading);
 panel.append(el(doc,'p','从左到右阅读：原帖线索 → 当时判断 → 新证据后的更新。箭头表示分析演进，具体引用关系见节点内原帖。','logic-meta'));
 const viewport=el(doc,'div',null,'logic-reasoning-viewport');viewport.tabIndex=0;viewport.setAttribute('role','region');viewport.setAttribute('aria-label','横向推理时间轴，可左右滚动');
 previous.addEventListener('click',()=>viewport.scrollBy?.({left:-360,behavior:'smooth'}));next.addEventListener('click',()=>viewport.scrollBy?.({left:360,behavior:'smooth'}));
 const track=el(doc,'ol',null,'logic-reasoning-track');
 for(let i=0;i<timeline.length;i++){
   const t=timeline[i],stage=t.primary.stage,revision=stage==='revised',confirmed=['participation_self_reported','holding_self_reported'].includes(stage);
   const node=el(doc,'li',null,`logic-reasoning-node${revision?' is-revised':confirmed?' is-confirmed':''}`);
   const date=el(doc,'div',null,'logic-graph-date');date.append(el(doc,'span',String(i+1),'logic-graph-dot'),el(doc,'time',t.date));node.append(date);
   const card=el(doc,'article',null,'logic-graph-card');card.append(el(doc,'h5',stages[stage] || stage));
   card.append(el(doc,'p','① 帖子线索','logic-graph-label'));
   if(!t.evidence.length)card.append(el(doc,'p','本日未保存可展示的原帖证据。','logic-meta'));
   for(const e of t.evidence.slice(0,2))source(doc,card,e,{short:true});
   if(t.evidence.length>2)card.append(el(doc,'small',`另有${t.evidence.length-2}条，见下方完整分析`,'logic-meta'));
   card.append(el(doc,'p','↓','logic-graph-inference'),el(doc,'p','② 为什么得出这个判断','logic-graph-label'),el(doc,'p',t.primary.rationale || '尚未记录推理依据。','logic-graph-reason'));
   if(t.unknowns.length)card.append(el(doc,'p',`仍未确认：${t.unknowns.join('；')}`,'logic-graph-unknown'));
   if(t.counterEvidence.length){const warning=el(doc,'div',null,'logic-graph-counter');warning.append(el(doc,'strong','反证 / 修正约束'));for(const c of t.counterEvidence)if(typeof c==='string')warning.append(el(doc,'p',c));else source(doc,warning,c,{short:true});card.append(warning);}
   node.append(card);
   if(i<timeline.length-1){const edge=el(doc,'div',null,'logic-graph-edge');edge.setAttribute('aria-hidden','true');edge.append(el(doc,'span','新增线索'),el(doc,'strong','→'));node.append(edge);}
   track.append(node);
 }
 viewport.append(track);panel.append(viewport);
 if(!timeline.length)panel.append(el(doc,'p','尚无逐日推理记录，等待补充证据。','logic-meta'));
 const outcome=el(doc,'div',null,`logic-graph-outcome logic-status-${row.status}`);outcome.append(el(doc,'strong',`当前结论 · ${labels[row.status]}`),el(doc,'p',row.result));panel.append(outcome);
}
function stockResearch(doc,panel,row){
 panel.append(el(doc,'h4','个股来源与逻辑筛选'));
 panel.append(el(doc,'p','本人明示、本人附图线索与Agent自主筛选分开。产业关联是研究判断；自主备选不代表小马甲买过。','logic-meta'));
 const wrap=el(doc,'div',null,'daily-review-table'),table=el(doc,'table',null,'logic-research-table'),head=el(doc,'tr');for(const label of ['个股 / 来源','与本方向的关系','逻辑与筛选结论','筹码核验 / 风险'])head.append(el(doc,'th',label));table.append(head);
 for(const s of arr(row.relatedStocks)){
   const tr=el(doc,'tr'),name=el(doc,'td');name.append(el(doc,'strong',s.name),el(doc,'p',s.originLabel || '来源待核验',`logic-origin logic-origin-${s.origin || 'unknown'}`),el(doc,'small',s.stateLabel));
   const association=s.association || s.research?.association;
   const relation=el(doc,'td',association?`${association.label}：${association.reason}`:'产业归属尚未独立核验，不凭持仓或同帖关系归类。');
   const rationale=el(doc,'td',s.research?.rationale || '保留作者证据；不自动参加Agent选股排序。');
   if(s.research)rationale.append(el(doc,'p',`筛选时间：${s.research.selectedAt}；${s.research.selectionLabel || '研究备选'}`,'logic-meta'));
   const chip=s.research?.chip,risks=arr(s.research?.risks);const last=el(doc,'td',chip?`${{verified:'已核验',unverified:'筹码待核验',blocked:'筹码核验受阻'}[chip.status]}：${chip.observation || chip.reason || '尚缺可比资料'}`:'筹码未核验');for(const risk of risks)last.append(el(doc,'p',risk,'logic-meta'));
   for(const source of arr(s.research?.sources || association?.sources)){if(!/^https:\/\//.test(source.url || ''))continue;const link=el(doc,'a',source.title);link.href=source.url;link.target='_blank';link.rel='noopener noreferrer';relation.append(el(doc,'br'),link);}
   tr.append(name,relation,rationale,last);table.append(tr);
 }wrap.append(table);panel.append(wrap);
 if(row.marketWatchlist)panel.append(el(doc,'p',`筛选版本：${row.marketWatchlist.ruleVersion}；比较范围：${row.marketWatchlist.comparisonScope || '已列候选'}。${row.marketWatchlist.conclusion || ''}`,'logic-meta'));
}
function prices(doc,panel,row,timeline){
 panel.append(el(doc,'h4','相关个股 · 逐交易日涨跌'));
 const stocks=arr(row.relatedStocks);if(!stocks.length){panel.append(el(doc,'p','这条链尚未识别出具名个股，不用板块成分股代替作者相关标的。'));return;}
 const overview=el(doc,'div',null,'logic-stock-overview');for(const s of stocks){const item=el(doc,'div');item.append(el(doc,'span',s.originLabel || '来源待核验',`logic-origin logic-origin-${s.origin || 'unknown'}`),el(doc,'strong',`${s.name}${s.symbol?`（${s.symbol}）`:''}`),el(doc,'span',s.stateLabel),el(doc,'small',`首次识别：${s.firstSeenDate}`));overview.append(item);}panel.append(overview);
 const dates=arr(row.priceTracking?.dates);if(!dates.length){panel.append(el(doc,'p','行情尚未取得。可关闭弹框后点击“更新行情”；缺失数据不会按0%填充。'));return;}
 const wrap=el(doc,'div',null,'logic-price-scroll'),table=el(doc,'table',null,'logic-price-table'),head=el(doc,'tr');head.append(el(doc,'th','交易日期'),el(doc,'th','当天逻辑变化'));for(const s of stocks)head.append(el(doc,'th',s.name));table.append(head);
 for(const date of dates){const tr=el(doc,'tr');tr.append(el(doc,'td',date),el(doc,'td',timeline.find(t=>t.date===date)?stages[timeline.find(t=>t.date===date).primary.stage] || '判断更新':'无新增判断记录'));
   for(const s of stocks){const cell=el(doc,'td'),bar=arr(s.bars).find(b=>b.date===date);if(date<s.firstSeenDate)cell.append(el(doc,'span','尚未识别','logic-meta'));else if(!bar)cell.append(el(doc,'span','无日线','logic-meta'));else if(bar.changePct==null)cell.append(el(doc,'span','缺前收盘价','logic-meta'));else{cell.append(el(doc,'strong',`${bar.changePct>0?'+':''}${bar.changePct.toFixed(2)}%`,bar.changePct>0?'market-rise':bar.changePct<0?'market-fall':''));cell.title=`前复权收盘 ${bar.close}；${s.name}首次识别 ${s.firstSeenDate}`;}tr.append(cell);}table.append(tr);
 }wrap.append(table);panel.append(wrap);
 panel.append(el(doc,'p',`${row.priceTracking.formula}。${row.priceTracking.boundary}`,'logic-meta'));
 disclosure(doc,panel,'行情来源与数据缺口',body=>{for(const s of stocks)body.append(el(doc,'p',`${s.name}：${s.provider || ({no_adjusted_daily_bars:'行情源未返回可核对的前复权日线',not_fetched:'尚未获取',security_identity_not_verified:'证券身份未通过核验'}[s.marketDataStatus] || s.marketDataStatus)}；取得时间 ${s.marketDataAsOf || '未取得'}；${s.adjustment || '复权口径未取得'}`));});
}
export function renderLogicDetail(doc,panel,row){
 panel.replaceChildren();panel.hidden=false;
 const timeline=groupLogicTimeline(row),summary=el(doc,'section',null,'logic-detail-summary');
 summary.append(el(doc,'h3',row.name),el(doc,'span',labels[row.status],`logic-result-badge logic-status-${row.status}`));
 summary.append(el(doc,'p',row.result,'logic-detail-verdict'));
 summary.append(el(doc,'p',`在验证什么：${row.target}`));
 if(row.failureReason)summary.append(el(doc,'p',`失败原因：${row.failureReason}`,'logic-failure-note'));
 if(row.strategyFailureReason)summary.append(el(doc,'p',`策略反馈：${row.strategyFailureReason}`,'logic-failure-note'));
 summary.append(el(doc,'p',row.retrospective?'本页包含事后重建：方向确认、成员买过、具体买入日分别核对，不算作事前预测命中。':'根据实际保存的分析时点核对；持有和当日买入分别判断。','logic-meta'));
 panel.append(summary);renderReasoningTimeline(doc,panel,row,timeline);
 const complete=disclosure(doc,panel,`逐日完整分析与原帖（${timeline.length}天）`,()=>{});
 for(let i=0;i<timeline.length;i++){
   const t=timeline[i],previous=timeline[i-1],step=el(doc,'section',null,'logic-reading-step');
   step.append(el(doc,'h5',`${t.date} · ${stages[t.primary.stage] || t.primary.stage}`));
   if(previous)step.append(el(doc,'p',`判断变化：${stages[previous.primary.stage] || previous.primary.stage} → ${stages[t.primary.stage] || t.primary.stage}`,'logic-change'));
   step.append(el(doc,'p','当日关键线索','logic-field-label'));for(const e of t.evidence.slice(0,2))source(doc,step,e,{short:true});
   step.append(el(doc,'p','为什么这样判断','logic-field-label'),el(doc,'p',t.primary.rationale));
   if(t.unknowns.length)step.append(el(doc,'p',`当时尚未确认：${t.unknowns.join('；')}`,'logic-open-question'));
   disclosure(doc,step,`查看本日完整原帖与其他分析版本（${t.evidence.length}条证据）`,body=>{
     for(const e of t.evidence)source(doc,body,e);
     for(const c of t.counterEvidence){body.append(el(doc,'p','反证'));if(typeof c==='string')body.append(el(doc,'p',c));else source(doc,body,c);}
     for(const variant of t.versions.slice(1))body.append(el(doc,'p',`另一版分析：${variant.rationale}`));
     for(const m of t.members)body.append(el(doc,'p',`${m.name || m.symbol || '未具名'}：${states[m.state] || m.state || '状态未知'}；动作日期 ${m.actionDate || '未知'}`));
   });complete.append(step);
 }
 stockResearch(doc,panel,row);
 prices(doc,panel,row,timeline);
 panel.append(el(doc,'h4','已确认什么，还缺什么'));
 for(const j of row.reviews){const box=el(doc,'section',null,'logic-verification-brief');box.append(el(doc,'strong',`${j.dimension==='strategy_outcome'?'策略结果复核':'逻辑判断复核'} · ${j.status==='success'?'得到支持':'未成立'}`),el(doc,'p',j.reason));if(j.failureReason)box.append(el(doc,'p',j.failureReason));disclosure(doc,box,`查看验证原帖（${j.evidence.length}条）`,body=>{for(const e of j.evidence)source(doc,body,e);body.append(el(doc,'p',`复核时间 ${j.recordedAt} · ${j.ruleVersion}`,'logic-meta'));});panel.append(box);}
 if(!row.reviews.length)panel.append(el(doc,'p','尚未完成正式复核，保持待验证；不因上涨或出现相关股票就计为成功。'));
 const questions=unique([...arr(row.unknowns),...arr(timeline.at(-1)?.unknowns)]);if(questions.length){const ul=el(doc,'ul');for(const q of questions)ul.append(el(doc,'li',q));panel.append(ul);}
 const next=unique(arr(timeline.at(-1)?.primary.nextVerification));if(next.length){panel.append(el(doc,'p','后续要找的证据','logic-field-label'));const ul=el(doc,'ul');for(const n of next)ul.append(el(doc,'li',n));panel.append(ul);}
 disclosure(doc,panel,'引用关系、分析版本与审计记录',body=>{for(const link of arr(row.links))body.append(el(doc,'p',`${link.fromPostId} → ${link.toPostId}；${link.rationale || link.type}`));for(const a of arr(row.analyses))body.append(el(doc,'p',`${a.kind} · ${a.ruleVersion || '未记录版本'} · ${a.recordedAt || '未记录时间'}`));for(const r of arr(row.reviewHistory))body.append(el(doc,'p',`复核 ${r.reviewId} · ${r.recordedAt}`));});
}
