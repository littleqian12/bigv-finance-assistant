const LABELS={author_confirmed:'本人确认当日买入',execution_verified:'成交材料已核验',later_buy_confirmed:'后来买入，非原日命中',author_denied:'本人否认当日买入',conflicting:'买入与否认有冲突',date_unresolved:'买入日期待核验',unconfirmed:'仍未确认'};
function el(doc,tag,text,css){const node=doc.createElement(tag);if(text!==undefined)node.textContent=text;if(css)node.className=css;return node;}
function sourceLink(doc,e){const a=el(doc,'a',`原帖 ${e.post_id}`);if(/^https:\/\/(?:www\.)?xueqiu\.com\/xxxx\/\d+$/.test(e.url||'')){a.href=e.url;a.target='_blank';a.rel='noopener noreferrer';}return a;}
export function renderBuyVerification(data,{doc=document}={}){
  const panel=doc.getElementById('buy-verification-panel');if(!panel)return;
  if(panel.dataset.checkedAt&&(!data?.available||Date.parse(panel.dataset.checkedAt)>Date.parse(data.checkedAt)))return;
  panel.replaceChildren();
  const heading=el(doc,'div',undefined,'panel-heading');heading.append(el(doc,'h2','历史验证原始台账'));
  const refresh=el(doc,'button','刷新验证','overview-link');refresh.addEventListener('click',()=>{void loadBuyVerification({doc});});heading.append(refresh);panel.append(heading);
  panel.append(el(doc,'p','判断事件：小马甲本人在信号对应交易日是否实际买入该标的。包括新建仓或加仓；历史持仓、后来买入和股价上涨分别记录。','today-panel-copy'));
  if(!data?.available){panel.append(el(doc,'p','验证记录尚未建立，等待每日检查。','empty-state'));return;}
  panel.dataset.checkedAt=data.checkedAt;
  panel.append(el(doc,'p',`本人当日买入概率：暂无法可靠量化 · 生效判断版本 ${data.logicVersion}`,'buy-probability-status'));
  panel.append(el(doc,'p',`检查时间 ${new Date(data.checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} · 验证引擎 ${data.engine} · 调用来源 ${data.producer}`,'today-panel-copy'));
  const m=data.metrics||{};
  panel.append(el(doc,'p',`独立标的日期事件 ${m.total||0} 个 · 本人确认 ${m.authorConfirmed||0} · 成交核验 ${m.executionVerified||0} · 后来买入 ${m.laterBuyConfirmed||0} · 仍未确认 ${m.unconfirmed||0}`,'today-panel-copy'));
  panel.append(el(doc,'p','未确认不算未买；旧研究评分、题材级确认和涨幅不参与这个概率的计算。首次导入或补建记录不计为事前预测。','today-panel-copy'));
  const cases=data.cases||[];
  const grouped=new Map();
  for(const c of cases.filter(c=>c.originKind!=='legacy_research_import')){const key=`${c.symbol}:${c.targetDate}`;const group=grouped.get(key)||[];group.push(c);grouped.set(key,group);}
  const visible=[...grouped.values()].map(group=>({...group[0],origins:group.map(c=>c.originKind==='model_hypothesis'?'系统判断':'本人潜在线索'),initialEvidence:[...new Map(group.flatMap(c=>c.initialEvidence||[]).map(e=>[e.post_id,e])).values()],history:group.flatMap(c=>c.history||[])}));
  const list=el(doc,'div',undefined,'today-symbol-list');
  for(const c of visible.slice(0,20)){
    const card=el(doc,'article',undefined,'today-symbol-card');
    card.append(el(doc,'h3',`${c.symbol}｜${c.name||'未记录名称'}`));
    card.append(el(doc,'p',`信号日 ${c.targetDate} · 来源 ${c.origins.join('、')} · 判断版本 ${c.logicVersion}`,'today-history-meta'));
    card.append(el(doc,'p','当日买入概率：暂无法可靠量化','buy-probability-status'));
    card.append(el(doc,'p',`验证：${LABELS[c.verification?.status]||'仍未确认'}${c.verification?.laterBuyDates?.length?' · 后来买入日期 '+c.verification.laterBuyDates.join('、'):''}`));
    card.append(el(doc,'p',`首次记录 ${new Date(c.recordedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}${c.backfilled?' · 历史补建，不计事前命中':''}${c.outcomeAlreadyKnown?' · 建档时结果已知，不计事前命中':''}`,'today-panel-copy'));
    const details=el(doc,'details');details.append(el(doc,'summary','查看初始判断、确认依据与审计记录'));
    for(const e of c.initialEvidence||[]){const p=el(doc,'p',`初始线索：${e.summary||''} `);p.append(sourceLink(doc,e));details.append(p);}
    for(const e of c.verification?.evidence||[]){const p=el(doc,'p',`后续证据：${e.evidence} · 动作日 ${e.action_date||'未确认'} `);p.append(sourceLink(doc,e));details.append(p);}
    if(!c.verification?.evidence?.length)details.append(el(doc,'p','尚无可归属到该标的及日期的本人买入或否认证据。'));
    for(const e of c.history||[])details.append(el(doc,'p',`${e.occurredAt} · ${e.kind==='hypothesis_registered'?'首次判断':'验证更新'}${e.status?' · '+(LABELS[e.status]||e.status):''} · 审计 ${e.hash.slice(0,12)}`,'today-panel-copy'));
    card.append(details);list.append(card);
  }
  if(!visible.length)list.append(el(doc,'p','尚无当天或前一日可映射线索。','empty-state'));
  panel.append(list);
  const changes=el(doc,'details');changes.append(el(doc,'summary',`每日优化记录与版本历史 · 当前 ${data.logicVersion}`));
  changes.append(el(doc,'p',data.optimizations?.status==='rules_changed'?'今天有规则变更，详见下方版本记录。':'今天没有规则变更，沿用原版本；每日检查不自动递增版本。'));
  for(const version of data.versionHistory||[]){changes.append(el(doc,'h3',`v${version.version} · ${version.releasedAt}`));for(const change of version.changes||[])changes.append(el(doc,'p',`${change.ruleId}：${change.change}；依据：${change.basis}`));}
  for(const p of data.optimizations?.proposals||[])changes.append(el(doc,'p',`待验证提案：${p.reason}；未生效。`));
  for(const run of (data.dailyHistory||[]).slice(-10).reverse())changes.append(el(doc,'p',`${run.checkedAt} · ${run.producer} · 版本 ${run.logicVersion} · ${run.optimizationStatus==='rules_changed'?'有规则变更':'无规则变更'}`,'today-panel-copy'));
  changes.append(el(doc,'p',`审计链校验值 ${data.auditHead}`,'today-panel-copy'));panel.append(changes);
}
export async function loadBuyVerification({doc=document,fetchImpl=fetch}={}){try{const response=await fetchImpl('/api/buy-verification');if(!response.ok)throw Error();renderBuyVerification(await response.json(),{doc});}catch{const panel=doc.getElementById('buy-verification-panel');if(panel&&!panel.dataset.checkedAt)panel.textContent='买入验证暂不可读，请刷新页面重试。';}}
