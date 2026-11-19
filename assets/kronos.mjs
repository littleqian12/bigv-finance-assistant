const labels={running:'运行中',queued:'等待中',completed:'已完成',failed:'失败',interrupted:'已中断'};
const node=(tag,text,css)=>{const e=document.createElement(tag);if(text!=null)e.textContent=String(text);if(css)e.className=css;return e;};
const byId=id=>document.getElementById(id);
const num=n=>Number.isFinite(Number(n))?Number(n).toFixed(2):'—';
let selected=null,timer=null,bound=false,requestId=0,lastEnvironment=null;
async function json(url,options={}){const r=await fetch(url,{cache:'no-store',...options});const data=await r.json();if(!r.ok)throw Error(data.error||`请求失败 ${r.status}`);return data;}
function status(text){const e=byId('kronos-status');if(e)e.textContent=text;}
function progress(text){
  const forecast=String(text||'').match(/^forecast (\d+) \/ (\d+)/);if(forecast)return `正在生成预测路径：${forecast[1]} / ${forecast[2]}`;
  const test=String(text||'').match(/^backtest-(\d+)/);if(test)return '正在进行近期历史检验…';
  return /^device|^Models loaded/.test(text||'')?'模型已加载，正在计算…':text;
}
function table(headers,rows){const wrap=node('div',null,'kronos-table-wrap'),t=node('table',null,'kronos-table'),head=node('thead'),tr=node('tr');headers.forEach(h=>{const e=node('th',h);e.scope='col';tr.append(e);});head.append(tr);const body=node('tbody');for(const row of rows){const r=node('tr');row.forEach(v=>r.append(node('td',v)));body.append(r);}t.append(head,body);wrap.append(t);return wrap;}
export function renderKronosResult(job){
  const panel=byId('kronos-result');if(!panel)return;panel.replaceChildren();
  if(!job){panel.append(node('p','还没有预测记录。输入代码后点击开始预测。'));return;}
  const r=job.result;
  if(!r){panel.append(node('h3',`${job.symbol.toUpperCase()} · ${labels[job.status]||job.status}`),node('p',progress(job.message)||'等待计算结果'));return;}
  const m=r.metadata,v=r.validation||{},last=r.forecast.at(-1),invalid=v.status==='invalid';
  const heading=node('div',null,'kronos-result-heading');heading.append(node('h3',`${m.name} · ${m.symbol}`),node('span',invalid?'交易约束未通过':'研究输出 · 尚未验证可靠'));panel.append(heading);
  panel.append(node('p',`行情截至 ${m.cutoff} · ${m.adjustment?.startsWith('forward')?'前复权':'未复权'} · ${m.lookback} 日窗口 · ${m.paths} 条采样 · 预测未来 ${m.horizon} 个交易日`,'kronos-summary'));
  if(invalid)panel.append(node('div','原始预测中位路径超出普通交易日涨跌幅约束，本次价格输出无效。下方保留原始结果用于诊断，不作为目标价。','kronos-warning kronos-invalid'));
  else panel.append(node('div',v.baseline_beaten?'近期小样本检验误差低于价格不变基准，尚不足以证明稳定预测能力。':'近期历史检验没有优于“价格不变”基准，不宜据此作交易决策。','kronos-warning'));
  const metrics=node('div',null,'kronos-metrics');
  for(const [title,value,copy] of [['最新收盘',`${num(m.last_close)} 元`,m.cutoff],['期末采样中位数',`${num(last.median_close)} 元`,invalid?'原始无效输出':`${num(last.median_change_pct)}% · 相对最新收盘`],['历史检验平均误差',`${num(m.backtest_model_mae)} 元`,`价格不变基准 ${num(m.backtest_flat_mae)} 元`]]){const card=node('div',null,'kronos-metric');card.append(node('span',title),node('strong',value),node('small',copy));metrics.append(card);}panel.append(metrics);
  panel.append(table(['日期','收盘中位数 / 元','相对最新收盘','P10–P90 / 元'],r.forecast.map(f=>[f.date,num(f.median_close),`${num(f.median_change_pct)}%`,`${num(f.p10_close)}–${num(f.p90_close)}`])));
  panel.append(node('p','P10–P90 仅为模型采样分布，未校准为真实覆盖概率。上行采样比例不等于上涨概率。','kronos-summary'));
  const img=node('img',null,'kronos-chart');img.src='data/kronos-forecast.png';img.alt=`${m.name} ${m.lookback}日窗口预测路径与采样分散区间`;panel.append(img);
  const details=node('details',null,'kronos-backtest');details.append(node('summary',`近期 ${m.backtest_windows} 组历史检验 · 误差更小 ${m.backtest_mae_wins}/${m.backtest_windows} 组 · 期末方向正确 ${m.backtest_day5_direction_hits}/${m.backtest_windows} 组`));details.append(node('p','每组取8条采样路径均值，预测随后5个交易日；窗口不重叠。样本少，不构成胜率估计。','kronos-summary'));
  details.append(table(['数据截止','检验结束','模型误差 / 元','不变基准 / 元','方向'],r.backtest.map(b=>[b.cutoff,b.target_end,num(b.model_mae),num(b.flat_mae),b.day5_direction_correct?'正确':'错误'])));panel.append(details);
  panel.append(node('p',`采样日涨跌幅异常 ${v.sample_price_limit_violations ?? '未审计'} 处；K线内部价格关系异常 ${v.ohlc_inconsistencies ?? '未审计'} 处。未强行裁剪价格。${m.amount?.startsWith('not observed')?'成交额由模型按成交量和均价估算。':''} 未输入公告、新闻和基本面，不连接交易账户。`,'kronos-summary'));
  if(m.model_eval_mode!==true||m.tokenizer_eval_mode!==true)panel.prepend(node('div','推理模式未核实，此记录不应使用，请重新运行。','kronos-warning kronos-invalid'));
  const links=node('div',null,'kronos-downloads');for(const [file,title] of [['forecast_summary.csv','预测 CSV'],['backtest.csv','历史检验 CSV'],['run_metadata.json','运行参数']]){const a=node('a',title);a.href='data/'+file;a.target='_blank';a.rel='noopener';links.append(a);}panel.append(links);
}
export async function loadKronos(){
  if(!byId('kronos-jobs'))return;
  const version=++requestId;clearTimeout(timer);
  try{
    const data=await json('/api/kronos/jobs');if(version!==requestId)return;
    lastEnvironment=data.environment;
    byId('kronos-environment').textContent=`${data.environment.ready?'本机模型已就绪':'本机模型环境未就绪'} · Kronos Base · 每次64条采样与5组检验 · 点击开始后才请求行情，通常约1分钟。`;
    byId('kronos-run').disabled=!data.environment.ready||!!data.environment.activeId;
    const jobs=data.jobs||[],list=byId('kronos-jobs');list.replaceChildren();
    if(!jobs.some(j=>j.id===selected))selected=jobs[0]?.id||null;
    if(!jobs.length)list.append(node('p','暂无运行记录。'));
    for(const j of jobs){const b=node('button',`${j.metadata?.name||j.symbol.toUpperCase()} · ${j.lookback}日`,'kronos-job'+(selected===j.id?' is-selected':''));b.type='button';b.setAttribute('aria-pressed',String(selected===j.id));b.append(node('small',`${labels[j.status]||j.status} · 数据 ${j.metadata?.cutoff||'读取中'}`));b.append(node('small',`${j.imported?'历史导入':'本机运行'} · ${new Date(j.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}`));b.addEventListener('click',()=>{selected=j.id;void loadKronos();});list.append(b);}
    if(selected){const {job}=await json('/api/kronos/jobs/'+encodeURIComponent(selected));if(version!==requestId)return;renderKronosResult(job);status(['running','queued'].includes(job.status)?progress(job.message):job.message||'记录已读取');}
    else{renderKronosResult(null);status('输入股票代码开始预测。');}
    if(data.environment.activeId)timer=setTimeout(()=>void loadKronos(),2500);
  }catch(e){if(version===requestId){status('读取失败：'+e.message);if(lastEnvironment?.activeId)timer=setTimeout(()=>void loadKronos(),4000);}}
}
export function bindKronos(){
  if(bound||!byId('kronos-form'))return;bound=true;
  byId('kronos-refresh')?.addEventListener('click',()=>void loadKronos());
  byId('kronos-form').addEventListener('submit',async e=>{
    e.preventDefault();const button=byId('kronos-run');button.disabled=true;status('正在创建预测任务…');
    try{const {job}=await json('/api/kronos/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({symbol:byId('kronos-symbol').value.trim(),lookback:Number(byId('kronos-lookback').value)})});selected=job.id;await loadKronos();}
    catch(error){status('未能开始预测：'+error.message);button.disabled=!!lastEnvironment?.activeId;}
  });
}
