import {renderDailyReviewMarkdown} from './daily-reviews.mjs';
const time=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value)):'未记录';
function node(doc,tag,text){const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;return el;}
export function bindNextDayReviews({doc=document,fetchImpl=fetch}={}) {
  if(!doc.getElementById('next-day-reviews'))return;
  const picker=doc.getElementById('next-day-review-picker'),status=doc.getElementById('next-day-review-status');
  const body=doc.getElementById('next-day-review-body'),audit=doc.getElementById('next-day-review-audit');
  let requestId=0;
  async function load(key='') {
    const current=++requestId;
    status.textContent='正在读取隔日建议…';
    try{
      const [mode,date,edition]=key.split(':');
      const query=date?`?${new URLSearchParams({date,mode,format:edition||'daily_framework'})}`:'';
      const response=await fetchImpl(`/api/next-day-reviews${query}`,{cache:'no-store'});
      if(!response.ok)throw Error('读取失败');
      const data=await response.json();if(current!==requestId)return;
      picker.replaceChildren(...data.reports.map(r=>{const option=node(doc,'option',r.title);option.value=r.key;return option;}));
      if(data.selectedKey)picker.value=data.selectedKey;
      body.replaceChildren();audit.replaceChildren();
      if(!data.report){status.textContent=`暂无可展示的隔日建议。${data.rejectedCount?'有未完成或校验未通过的文件，未展示。':''}`;return;}
      const r=data.report;
      status.textContent=`${r.retrospective?'历史回放测试 · 非盲测':'23:00盘后增量'}｜目标交易日 ${r.targetTradingDate||'待确认'}｜${r.incrementalCount} 条增量｜截止 ${time(r.publicationCutoff)}｜实际生成 ${time(r.generatedAt)}${r.retrospective?`｜${r.lateCapturedCount} 条晚采`:''}`;
      renderDailyReviewMarkdown(doc,body,r.markdown);
      const details=node(doc,'details');details.append(node(doc,'summary',`逐帖核对：${r.audit.length} 条（展开原文与判断理由）`));
      for(const p of r.audit){
        const item=node(doc,'section');
        const link=node(doc,'a',`${time(p.publishedAt)} · 原帖 ${p.postId}`);link.href=p.url;link.target='_blank';link.rel='noopener noreferrer';
        item.append(link,node(doc,'p',`实际入库 ${time(p.availableAt)}；${p.result==='candidate'?'形成方向候选':'未形成新方向候选'}`),node(doc,'blockquote',p.text),node(doc,'p',p.reason));
        if(p.directions.length)item.append(node(doc,'p',`关联方向：${p.directions.join('、')}`));
        details.append(item);
      }
      audit.append(details);
    }catch{if(current!==requestId)return;body.replaceChildren();audit.replaceChildren();status.textContent='隔日建议读取失败，请刷新重试。';}
  }
  picker.addEventListener('change',()=>void load(picker.value));
  doc.getElementById('next-day-review-refresh')?.addEventListener('click',()=>void load(picker.value));
  const params=new URLSearchParams(doc.defaultView?.location?.search||'');
  const initialDate=params.get('nextDayDate'),initialFormat=params.get('nextDayFormat');
  void load(initialDate&&initialFormat?`${params.get('nextDayMode')||'replay'}:${initialDate}:${initialFormat}`:'');
  return {load};
}
