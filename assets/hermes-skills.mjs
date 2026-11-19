const el=(tag,text,css)=>{const n=document.createElement(tag);if(text!=null)n.textContent=text;if(css)n.className=css;return n;};
let selected=null,selectedFile='SKILL.md',loaded=false,requestId=0,bound=false;
function renderInventory(data){
 const list=document.getElementById('hermes-skills-list');list.replaceChildren();
 for(const skill of data.skills){const button=el('button',null,`hermes-skill-item${skill.id===selected?' is-selected':''}`);button.type='button';button.setAttribute('aria-pressed',String(skill.id===selected));button.append(el('strong',skill.name),el('small',skill.description));button.title=skill.description;button.addEventListener('click',()=>void loadHermesSkills({skillId:skill.id,filePath:'SKILL.md',force:true}));list.append(button);}
}
function renderFiles(data){
 const tree=document.getElementById('hermes-skills-tree'),content=document.getElementById('hermes-skills-content');tree.replaceChildren();content.replaceChildren();
 tree.append(el('h3','目录结构'),el('p',data.skill.id,'logic-meta'));
 const add=(parent,nodes,depth=0)=>{for(const node of nodes){if(node.kind==='directory'){const details=el('details',null,'hermes-skill-directory');details.open=depth===0;details.append(el('summary',`📁 ${node.name}`));add(details,node.children,depth+1);parent.append(details);}else if(node.kind==='file'){const button=el('button',node.name,`hermes-skill-file${node.path===selectedFile?' is-selected':''}`);button.type='button';button.title=node.path;button.setAttribute('aria-pressed',String(node.path===selectedFile));button.addEventListener('click',()=>void loadHermesSkills({skillId:selected,filePath:node.path,force:true}));parent.append(button);}else parent.append(el('small',`${node.name}（符号链接）`,'logic-meta'));}};
 add(tree,data.tree);if(data.treeTruncated)tree.append(el('p','目录较大，结构已截断。','logic-meta'));
 content.append(el('h3',data.file.path),el('p',`${data.file.size.toLocaleString()} 字节 · 更新 ${new Date(data.file.modifiedAt).toLocaleString('zh-CN')}`,'logic-meta'));
 if(data.file.binary)content.append(el('p','该文件为二进制或暂不支持文本预览。'));
 else{const pre=el('pre',data.file.content,'hermes-skill-source');pre.tabIndex=0;content.append(pre);if(data.file.truncated)content.append(el('p','文件较大，当前展示前512KB。','logic-meta'));}
}
export async function loadHermesSkills({skillId=selected,filePath=selectedFile,force=false}={}){
 const status=document.getElementById('hermes-skills-status'),button=document.getElementById('hermes-skills-refresh');if(!status)return;
 if(loaded&&!force&&skillId===selected&&filePath===selectedFile)return;
 const id=++requestId;button.disabled=true;status.textContent='正在读取本机Hermes技能文件…';
 try{const query=new URLSearchParams();if(skillId){query.set('skill',skillId);query.set('file',filePath);}const response=await fetch(`/api/hermes/skills?${query}`);if(!response.ok)throw Error('skill_read_failed');const data=await response.json();if(id!==requestId)return;
   if(!data.available)throw Error('skills_unavailable');
   if(!data.skill && data.skills.length){const skill=data.skills.find(s=>s.id===selected)||data.skills[0];await loadHermesSkills({skillId:skill.id,filePath:'SKILL.md',force:true});return;}
   selected=data.skill?.id||null;selectedFile=data.file?.path||'SKILL.md';renderInventory(data);
   if(data.skill)renderFiles(data);else{document.getElementById('hermes-skills-tree').replaceChildren();document.getElementById('hermes-skills-content').replaceChildren();}
   loaded=true;status.textContent=`小马甲Hermes · ${data.skills.length}项已安装技能 · 读取于 ${new Date(data.readAt).toLocaleString('zh-CN')} · ${data.root}`;
 }catch{if(id===requestId)status.textContent='技能文件读取失败，已展示内容保留；请点击刷新技能重试。';}finally{if(id===requestId)button.disabled=false;}
}
export function bindHermesSkills(){const button=document.getElementById('hermes-skills-refresh');if(!button||bound)return;bound=true;button.addEventListener('click',()=>void loadHermesSkills({skillId:null,force:true}));}
