const $ = id => document.getElementById(id);
const labels = { queued: '排队中', running: '执行中', waiting: '等待中', completed: '已完成', failed: '需要检查', cancelled: '已取消', interrupted: '执行中断' };
let csrf; try { csrf = sessionStorage.getItem('js-superagent-csrf'); } catch {}
let tickets = [], selected, nextOffset = null, paused = false, revision, workerRevision, repositoryRevision, schedulerRevision, recoveryRevision, deliveryRevision, promptState, contextCursor = null, contextItems = [];
const replyDrafts = new Map(), replySending = new Set(), sessionDrafts = new Map(), editors = new Map();
const jobDrafts=new Map(),jobSending=new Set();
const loads = new Map();
let workerHarnesses = [];
const editorControls={
  coordinator:['settings','coord-workflow','coord-mode','coord-retry','policy-add','save-settings'],
  worker:['worker-settings','worker-prompt','worker-driver','worker-model','worker-timeout','worker-managed','worker-agent-tools','save-worker'],
  repository:['repository-settings','repo-enabled','repo-observe','repo-pulls','repo-issues','repo-comments','repo-mentions','repo-reviewComments','repo-defaultBranchCI','save-repository'],
  scheduler:['scheduler-max','scheduler-reserve','save-scheduler'],recovery:['recovery-resume','recovery-enabled','recovery-attempts','recovery-delay','save-recovery'],
  delivery:['delivery-mode','delivery-auto','review-ready','review-request','review-resolve','review-users','review-teams','evidence-mode','evidence-scenario','evidence-theme','evidence-width','evidence-height','save-delivery'],prompts:['prompt-communication','prompt-scope','prompt-delivery','prompt-knowledge','prompt-preview','save-prompts']
};
function beginLoad(key) { const id=(loads.get(key)??0)+1;loads.set(key,id);return ()=>loads.get(key)===id; }
let detailRequest = 0;
const evidenceImages=new Set();
let ticketQuery='', contextQuery='', contextResource='triggers', searchTimer, contextSearchTimer;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
let draftStore, draftProjectId, coordinationDraft;
const drafts = globalThis.SuperagentDrafts;
function draftNotice(reason) {
  const element = $('draft-storage-status');
  if (element) element.textContent = ({identity:'尚未核对项目身份；草稿暂存本页。',sensitive:'含敏感字段或未完成 JSON 的草稿仅保留在本页，不写入浏览器存储。',invalid:'旧草稿格式无法恢复；服务端内容未改变。',oversized:'草稿超过浏览器保存上限，仅保留在本页。',unavailable:'浏览器无法保存草稿；刷新前请保留需要的内容。'})[reason] ?? '草稿暂未持久保存。';
}
function bindDraftProject(projectId) {
  if (projectId === draftProjectId && draftStore) return;
  const changed = draftProjectId !== undefined && projectId !== draftProjectId;
  draftProjectId = projectId; draftStore = drafts.createStore({storage:()=>sessionStorage,projectId,notify:draftNotice});
  if (changed) {
    replyDrafts.clear(); sessionDrafts.clear(); jobDrafts.clear();jobSending.clear();editors.clear(); selected = undefined;
    revision=workerRevision=repositoryRevision=schedulerRevision=recoveryRevision=deliveryRevision=promptState=undefined;
    for (const ids of Object.values(editorControls)) for (const id of ids) if ($(id)) $(id).disabled=true;
    $('detail').replaceChildren(); message('项目已切换，旧项目草稿仍保留在原项目下。');
  }
  coordinationDraft=draftStore.load('coordination');
  $('coordination-text').value=coordinationDraft?.text??'';
  if (!projectId) draftNotice('identity');
}
function persistEditor(state) {
  if (!state.loaded || !draftStore) return;
  if (!editorDirty(state)) { draftStore.remove(`editor:${state.key}`); return; }
  draftStore.save(`editor:${state.key}`, {base:state.base,value:state.read(),revision:state.baseRevision}, {editorKey:state.key});
}
function persistEditors() { for (const state of editors.values()) persistEditor(state); }
function editor(key, read, write, buttonId) {
  let state = editors.get(key);
  if (!state) { state = { key, read, write, buttonId, loaded: false }; editors.set(key, state); }
  state.read = read; state.write = write;
  return state;
}
function editorDirty(state) { return state.loaded && !same(state.read(), state.base); }
function finishConflict(state) {
  state.base=structuredClone(state.pending.value); state.baseRevision=state.pending.revision; state.pending=null;
  persistEditor(state); showEditorConflict(state);
}
function showEditorConflict(state) {
  if (!state.panel) { state.panel = node('div', undefined, 'draft-conflict'); $(state.buttonId).parentNode.append(state.panel); }
  state.panel.replaceChildren();
  if (!state.pending) return;
  state.panel.append(node('p', `服务端已是版本 ${state.pending.revision}；不同字段已合并，以下字段需选择。合并结果尚未保存。`, 'question'));
  for (const conflict of state.pending.conflicts) {
    const row=node('div');row.append(node('strong',conflict.path.join('.')||'此设置'),node('pre',`本地：${JSON.stringify(conflict.local)??'未设置'}\n服务端：${JSON.stringify(conflict.remote)??'未设置'}`));
    for (const [side,label] of [['local','此字段保留本地'],['remote','此字段采用服务端']]) {
      const button=node('button',label);button.addEventListener('click',()=>{
        // Keeping local means the text currently being edited, including edits
        // made after this conflict was first displayed.
        if(side==='remote'){const value=drafts.choose(drafts.decode(state.key,state.read()),conflict.path,conflict.remote);state.write(drafts.encode(state.key,value));}
        state.pending.conflicts=state.pending.conflicts.filter(item=>item!==conflict);
        if (!state.pending.conflicts.length) finishConflict(state); else {persistEditor(state);showEditorConflict(state);}
      });row.append(button);
    }state.panel.append(row);
  }
  const keep = node('button', '保留本地草稿，以新版本为基准'), remote = node('button', '采用服务端版本，替换本地草稿');
  keep.addEventListener('click', () => { finishConflict(state); message('已保留冲突字段的本地值，并合并其余服务端修改；尚未保存。'); });
  remote.addEventListener('click', () => { state.write(state.pending.value); finishConflict(state); message('已采用服务端版本。'); });
  state.panel.append(keep, remote);
}
function receiveEditor(state, nextRevision, value) {
  if (!state.loaded) {
    const saved=draftStore?.load(`editor:${state.key}`);
    if (saved && Object.hasOwn(saved,'base') && Object.hasOwn(saved,'value') && Number.isSafeInteger(saved.revision) && drafts.safeEditor(state.key,saved)) {
      try { state.write(saved.value);state.base=saved.base;state.baseRevision=saved.revision;state.loaded=true; }
      catch { draftStore.remove(`editor:${state.key}`);draftNotice('invalid'); }
    }
  }
  let clean=true;
  if (editorDirty(state)) {
    clean=false;
    const merged=drafts.merge3(drafts.decode(state.key,state.base),drafts.decode(state.key,state.read()),drafts.decode(state.key,value));
    const mergedValue=drafts.encode(state.key,merged.value);if(!same(mergedValue,state.read()))state.write(mergedValue);
    if (merged.conflicts.length) state.pending={revision:nextRevision,value:structuredClone(value),conflicts:merged.conflicts};
    else {state.base=structuredClone(value);state.baseRevision=nextRevision;state.pending=null;}
  } else {
    state.write(value);state.base=structuredClone(state.read());state.baseRevision=nextRevision;state.pending=null;
  }
  state.loaded=true;for(const id of editorControls[state.key]??[])$(id).disabled=false;
  persistEditor(state);showEditorConflict(state);return clean;
}
async function saveEditor(key, request, reload) {
  const state = editors.get(key);
  if (!state?.loaded) throw new Error('请先读取当前设置。');
  if (state.pending) throw new Error('服务端版本已更新；请先核对并选择保留本地草稿或采用服务端版本。');
  persistEditor(state);
  const sent = structuredClone(state.read());
  let result;
  try { result=await request(sent,state.baseRevision); }
  catch(error) { persistEditor(state);if(error.status===409)try{await reload();}catch{}throw error; }
  // A queued save is not a new settings revision. Keep its draft until the owner actually applies it.
  if(result?.operationId){persistEditor(state);await reload();return result;}
  state.base = sent;
  const savedRevision = result?.revision ?? result?.settings?.revision;
  if (Number.isSafeInteger(savedRevision)) state.baseRevision = savedRevision;
  persistEditor(state);await reload(); return result;
}
function replyDraft(id) {
  if (!replyDrafts.has(id)) { const saved=draftStore?.load(`reply:${id}`);replyDrafts.set(id,saved&&typeof saved.text==='string'&&Number.isSafeInteger(saved.version)?saved:{text:'',version:0}); }
  return replyDrafts.get(id);
}
function setReplyDraft(id, text) {
  const value = { text, version: replyDraft(id).version + 1 }; replyDrafts.set(id, value);
  if(text)draftStore?.save(`reply:${id}`,value);else draftStore?.remove(`reply:${id}`);return value;
}
async function sendReply(id) {
  if(replySending.has(id))throw new Error('这项回复正在发送；请等待结果，避免重复提交。');
  replySending.add(id);
  try{const sent = { ...replyDraft(id) }, result = await api(`/api/tickets/${id}/reply`, { text: sent.text });
    if (same(replyDraft(id), sent)) setReplyDraft(id, '');return result;
  }finally{replySending.delete(id);if(selected===id&&$('reply-send'))$('reply-send').disabled=false;}
}
function node(tag, value, className) { const element = document.createElement(tag); if (value !== undefined) element.textContent = String(value); if (className) element.className = className; return element; }
function message(value, error = false) { $('message').textContent = value; $('message').className = error ? 'error' : ''; }
function date(value) { return value ? new Date(value).toLocaleString() : '尚无记录'; }
function associationLinks(associations={},current={}) {
  const links=node('div',undefined,'buttons');
  for(const ticket of associations.tickets??[]){const button=node('button',`打开工单 ${ticket.title??ticket.id}`);button.addEventListener('click',()=>detail(ticket.id).then(()=>$('detail-title').scrollIntoView?.({block:'start'})).catch(error=>message(error.message,true)));links.append(button);}
  for(const resource of ['triggers','decisions'])for(const record of associations[resource]??[]){
    if(resource===current.resource&&record.id===current.id)continue;
    const title=resource==='triggers'?'查看关联事件':'查看关联判断';links.append(lazySection(`${title} ${record.id}`,box=>loadContextRecord(resource,record.id,box)));
  }
  for(const value of associations.urls??[]){try{const url=new URL(value.url);if(url.protocol!=='https:'||url.username||url.password)continue;const link=node('a',`打开来源或结果：${url.href}`);link.href=url.href;link.target='_blank';link.rel='noreferrer noopener';links.append(link);}catch{}}
  if(associations.truncated)links.append(node('p','关联较多，仅显示前 20 项；可继续通过完整记录检索。','subtle'));
  return links;
}
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: { 'X-Superagent-Request': csrf ?? 'local-ui', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401) { try{sessionStorage.removeItem('js-superagent-csrf');}catch{} $('connection').textContent = '需要本机登录链接'; }
    const error=new Error(result.error ?? '请求失败');error.status=response.status;throw error;
  }
  return result;
}
function controlNeedsInspection(result) { return !!result?.operationId && ['failed','unknown','cancelled'].includes(result.status); }
function actionMessage(result) {
  if(result?.operationId){
    const id=result.operationId.slice(0,12);
    const states={queued:`请求已排队（${id}）；在后台操作记录中查看处理结果。`,running:`请求正在处理（${id}）；尚无最终结果。`,completed:`调用已完成（${id}）；请在后台操作记录中核对业务结果。`,failed:`请求未执行（${id}）；目标状态已变化，请核对操作记录。`,unknown:`执行结果不明（${id}）；请核对工单和外部结果，勿重复发送。`,cancelled:`请求已取消（${id}）；原后台已退出，操作未执行。`};
    if(states[result.status])return states[result.status];
  }
  return result === false ? '当前状态无需或不能执行此操作；没有作出更改。' : result?.queued || result?.status === 'queued' ? '请求已排队；后台处理后刷新查看结果。' : '操作已保存';
}
async function act(button, action) {
  button.disabled = true;
  try { const result = await action(); message(actionMessage(result),controlNeedsInspection(result)); await refresh(); }
  catch (error) { message(error.message, true); }
  finally { button.disabled = false; }
}
function health(data) {
  paused = data.runtime.paused;
  $('delivery-section').hidden = !data.capabilities?.delivery; $('incident-section').hidden = !data.capabilities?.incidents; $('operations-section').hidden = !data.capabilities?.scheduler; $('prompt-sections-section').hidden = !data.capabilities?.prompts;
  $('pause').textContent = paused ? '恢复业务处理' : '暂停业务处理';
  $('connection').textContent = paused ? '已暂停 · 继续收件' : data.runtime.running ? '后台运行中' : '运行循环未启动';
  const metrics = [
    ['执行', data.runtime.active ? '工作进行中' : '当前空闲', data.scheduler ? `占用 ${data.scheduler.held}/${data.scheduler.maxWorkers} · 等待子任务 ${data.scheduler.yielded}` : data.runtime.running ? '运行循环已启动' : '面板不会自动启动执行循环'],
    ['渠道同步', !data.ingress.configured ? '仅本地' : data.ingress.healthy ? '最近同步成功' : '需要检查', data.ingress.lastError ?? `最近成功：${date(data.ingress.lastSuccess?.at)}`],
    ['待处理动作', data.queue.count, data.queue.oldestDueAgeMs === null ? '队列为空' : `最早到期动作已等待 ${Math.floor(data.queue.oldestDueAgeMs / 1000)} 秒`],
    ['结果回传', `${data.notifications.pending} 项待发送`, data.runtime.lastError ?? '业务状态与进程状态分别核对'],
  ];
  if (data.sources?.length) metrics.push(['其他事件来源', `${data.sources.filter(source => source.healthy).length}/${data.sources.length} 同步正常`, data.sources.map(source => `${source.id}：${source.healthy ? '正常' : source.error ? '同步失败' : '尚未同步'}`).join(' · ')]);
  if (data.business?.sources?.length) metrics.push(['业务健康', data.business.incidents?.length ? `${data.business.incidents.length} 项待检查` : '未发现持续异常', data.business.sources.map(source => `${source.id}：${({healthy:'正常',stale:'同步停滞',degraded:'连续失败',disabled:'已关闭',stopped:'已停止',starting:'等待首次同步'})[source.state] ?? source.state}`).join(' · ')]);
  if (data.business?.models?.length) metrics.push(['模型等待', `${data.business.models.length} 个执行正在等待`, data.business.models.map(model => `${model.provider??model.driver}：${({budget:'供应商预算耗尽','rate-limit':'限流等待',authentication:'认证需要检查',transient:'临时错误重试',unknown:'原生重试，原因未知'})[model.reason]??'原因未知'}${model.attempts===null?'':`，已重试 ${model.attempts} 次`}`).join(' · ')]);
  $('health').replaceChildren(...metrics.map(([label, value, note]) => { const item = node('div', undefined, 'metric'); item.append(node('span', label, 'subtle'), node('strong', value), node('p', note)); return item; }));
}
function renderTickets() {
  const priority = ticket => ['failed', 'interrupted', 'waiting'].includes(ticket.status) ? 0 : ticket.status === 'running' ? 1 : 2;
  const shown = tickets;
  $('tickets').replaceChildren(...shown.map(ticket => {
    const button = node('button', undefined, `ticket${selected === ticket.id ? ' selected' : ''}`);
    button.append(node('span', ticket.awaitingReview && ticket.status==='completed' ? '等待审阅' : (labels[ticket.status] ?? ticket.status), `badge${priority(ticket) === 0 ? ' attention' : ''}`), node('strong', ticket.text.slice(0, 160)), node('small', `${ticket.id.slice(0, 12)} · ${date(ticket.updatedAt)}`));
    button.addEventListener('click', () => detail(ticket.id).catch(error => message(error.message, true))); return button;
  }));
  if (!shown.length) $('tickets').append(node('p', '当前没有匹配的工单。', 'subtle'));
  $('task-count').textContent = `已加载 ${tickets.length} 项 · 当前显示 ${shown.length} 项`;
  $('more').hidden = nextOffset === null;
}
async function loadTickets(more=false) {
  const currentLoad=beginLoad('tickets'),query=$('search').value.trim();
  if(more&&(query!==ticketQuery||nextOffset===null))return;
  const target=more?100:query===ticketQuery?Math.max(100,tickets.length):100;
  let offset=more?nextOffset:0,items=[],next=null;
  do {
    const result=await api(`/api/tickets?limit=100&offset=${offset}&q=${encodeURIComponent(query)}`);
    if(!currentLoad()||query!==$('search').value.trim())return;
    items.push(...result.items);next=result.nextOffset;
    if(!result.items.length||next===null||next<=offset)break;
    offset=next;
  }while(items.length<target);
  tickets=[...new Map((more?[...tickets,...items]:items).map(item=>[item.id,item])).values()];ticketQuery=query;nextOffset=next;renderTickets();
}
function continuationDetails(data) {
  const rows=[],inspection=data.continuationInspection,current=data.continuation;
  if(inspection?.status==='inspection') {
    const reason=({'read-only-continuation-inspector-unavailable':'需要配置支持只读判断的协调者',
      'previous-owner-active':'先前的执行进程尚未退出','previous-input-outcome-unknown':'先前追加反馈的接收结果尚未核对',
      'previous-operation-outcome-unknown':'先前执行或交付的结果尚未核对','previous-jobs-unsettled':'先前的后台任务尚未收尾',
      'closed-source-unverified':'原 PR 的关闭状态尚未核实','closed-source-observation-conflict':'原 PR 的观察记录不一致',
      'closed-source-unavailable':'尚未取得已关闭 PR 的记录','closed-target-ambiguous':'存在多个可能的原 PR，需要明确续作目标',
      'previous-workspace-unverified':'先前工作区的记录尚未核对','previous-workspace-invalid':'先前工作区无法通过归属检查',
      'continuation-requires-worktree':'此续作需要独立的 Git 工作区','previous-workspace-head-changed':'先前工作区的提交已改变',
      'previous-workspace-dirty':'先前工作区还有未提交的改动'})[inspection.reason]??'续作前置条件尚需核对';
    rows.push(node('p',`后续代码工作需要检查：${reason}。${inspection.at?`检查时间：${date(inspection.at)}。`:''}`,'question'));
  }
  if(current)rows.push(node('p',`后续代码工作第 ${current.generation} 轮：${current.status==='ready'?'新工作区已准备':'新工作区准备中'}。原讨论 ${current.source.repository}#${current.source.number} 已${current.source.merged?'合并':'关闭'}；本轮目标为 ${current.target.repository} 的 ${current.target.base}。`,'subtle'));
  const history=data.continuationHistory??[],records=[...history];
  if(current&&!records.some(item=>item.id===current.id))records.push(current);
  if(records.length){
    const box=node('details');box.append(node('summary','后续工作与先前工作区记录'));
    for(const item of records.slice(-10).reverse()){
      box.append(node('p',`第 ${item.generation} 轮 · ${date(item.createdAt)} · ${item.status==='ready'?'工作区已准备':'工作区准备中'}`),
        node('p',`来源：${item.source.repository}#${item.source.number} · 起点：${item.target.strategy==='previous-head'?'已关闭 PR 的原提交':'目标分支提交'} ${item.target.baseCommit.slice(0,8)}`,'subtle'),
        node('p',`先前工作区：${item.previousWorkspace.path}`,'subtle'));
      if(item.workspace)box.append(node('p',`本轮工作区：${item.workspace.path}`,'subtle'));
    }
    box.append(node('p','原 PR 与先前工作区保留为历史记录；本轮验证和交付按新的工作区分别记录。','subtle'));rows.push(box);
  }
  return rows;
}
function inputField(label, value = '', type = 'text') {
  const wrapper=node('label',label),input=node(type==='textarea'?'textarea':'input');
  if(type!=='textarea')input.type=type;else input.rows=3;
  input.value=value;wrapper.append(input);return {wrapper,input};
}
function reviewDetails(data,id) {
  const requests=data.reviewActions??[],budgets=data.botReviews??[],rows=[];
  if(requests.length){
    const box=node('details');box.append(node('summary','PR 审阅动作与回执'));
    for(const request of requests){
      const kind=({ready:'转为可审阅',requestReviewers:'请求审阅',resolveThread:'解决已修复讨论',finding:'处理审阅发现'})[request.input.kind]??request.input.kind;
      const state=({pending:'等待验证与交付',retrying:'等待有限重试',sending:'正在核对远端结果',completed:'已核对完成',failed:'需要检查',inspection:'结果尚未确定，等待读回核对'})[request.status]??request.status;
      box.append(node('p',`${kind} · ${state}`),node('small',`发起于 ${date(request.at)}${request.action?.intent?.headSha?' · 提交 '+request.action.intent.headSha.slice(0,8):''}`));
      if(request.error)box.append(node('p',request.error,'question'));
      if(request.input.disposition)box.append(node('p',`处置：${({fixed:'已修复',declined:'不采纳并说明原因',unresolved:'仍未解决'})[request.input.disposition]??request.input.disposition} · ${request.input.reason??''}`));
      if(request.nextAt)box.append(node('p',`已安排有限接续，最早 ${date(request.nextAt)}；每次先读回核对。`,'subtle'));
      if(request.action?.replyReceipt)box.append(node('p','处置说明已取得远端回执。','subtle'));
      if(data.managementActions?.prReview&&request.status!=='completed'){
        const retry=node('button','核对并接续');retry.addEventListener('click',()=>act(retry,()=>api(`/api/review-actions/${request.id}/run`,{})));box.append(retry);
      }
    }rows.push(box);
  }
  if(data.managementActions?.prReview&&data.ticket.pullRequests?.length)rows.push(lazySection('发起 PR 审阅动作',box=>loadReviewForm(id,box,data.ticket.pullRequests)));
  if(budgets.length||data.managementActions?.botReview&&data.ticket.pullRequests?.length)rows.push(lazySection('机器人审阅轮次与额度',box=>loadBotReviewForm(id,box,data.ticket.pullRequests??[],budgets,data.managementActions?.botReview)));
  return rows;
}
async function loadReviewForm(id,box,pulls) {
  const settings=await api('/api/delivery'),policy=settings.review??{},key=`review-action:${id}`,saved=draftStore?.load(key)??{};
  const form=node('div'),kind=node('select'),pull=node('select');
  for(const [value,label,enabled] of [['ready','转为可审阅',policy.ready],['requestReviewers','请求审阅者',policy.requestReviewers],['finding','处理审阅发现',policy.resolveThreads]]){
    const option=node('option',`${label}${enabled?'':'（未授权）'}`);option.value=value;option.disabled=!enabled;kind.append(option);
  }
  const enabled=[...kind.options].filter(option=>!option.disabled);if(!enabled.length){box.append(node('p','尚未启用审阅动作。请在“验证与交付”中分别配置所需授权。','subtle'));return;}
  const savedKind=saved.kind==='resolveThread'?'finding':saved.kind;kind.value=enabled.some(option=>option.value===savedKind)?savedKind:enabled[0].value;
  for(const binding of pulls){const option=node('option',`${binding.repository} #${binding.number}`);option.value=String(binding.number);pull.append(option);}if(pulls.some(binding=>String(binding.number)===saved.pull))pull.value=saved.pull;
  const actionLabel=node('label','动作'),pullLabel=node('label','关联 PR');actionLabel.append(kind);pullLabel.append(pull);form.append(actionLabel,pullLabel);
  const recipients=node('div'),userBoxes=[],teamBoxes=[];
  for(const [items,target,prefix] of [[policy.reviewers??[],userBoxes,'审阅者'],[policy.teams??[],teamBoxes,'团队']])for(const name of items){
    const field=inputField(`${prefix}：${name}`,'','checkbox');const selectedNames=target===userBoxes?saved.reviewers:saved.teams;field.input.checked=Array.isArray(selectedNames)&&selectedNames.includes(name);field.input.value=name;target.push(field.input);recipients.append(field.wrapper);
  }
  if(!userBoxes.length&&!teamBoxes.length)recipients.append(node('p','允许的审阅者和团队尚未配置。','subtle'));
  const comment=inputField('原始行内评论编号',saved.commentId??'','number'),trigger=inputField('已读的原始事件 ID',saved.triggerId??''),reason=inputField('处置原因与修复说明',saved.reason??'','textarea'),disposition=node('select'),dispositionLabel=node('label','处置');
  for(const [value,label]of [['fixed','已修复'],['declined','不采纳，并回复原因'],['unresolved','仍未解决，保持讨论打开']]){const option=node('option',label);option.value=value;disposition.append(option);}disposition.value=saved.disposition??'fixed';dispositionLabel.append(disposition);
  comment.input.min='1';reason.input.maxLength=2000;const resolution=node('div');resolution.append(dispositionLabel,comment.wrapper,trigger.wrapper,reason.wrapper);
  const read=()=>({kind:kind.value,pull:pull.value,reviewers:userBoxes.filter(input=>input.checked).map(input=>input.value),teams:teamBoxes.filter(input=>input.checked).map(input=>input.value),commentId:comment.input.value,triggerId:trigger.input.value,reason:reason.input.value,disposition:disposition.value});
  const update=()=>{recipients.hidden=kind.value!=='requestReviewers';resolution.hidden=kind.value!=='finding';};update();
  for(const event of ['input','change'])form.addEventListener(event,()=>{update();draftStore?.save(key,read());});
  const submit=node('button','记录审阅请求');submit.addEventListener('click',()=>act(submit,async()=>{
    const sent=read(),input={kind:sent.kind,pullNumber:Number(sent.pull)};
    if(input.kind==='requestReviewers'){input.reviewers=sent.reviewers;input.teams=sent.teams;}
    if(input.kind==='finding'){input.commentId=Number(sent.commentId);input.triggerId=sent.triggerId.trim();input.reason=sent.reason.trim();input.disposition=sent.disposition;}
    const result=await api(`/api/tickets/${id}/review`,input);if(same(sent,read()))draftStore?.remove(key);return result;
  }));
  form.append(recipients,resolution,node('p','请求先记录，验证与交付完成后才执行。系统会再次核对授权、当前提交和原始评论；无法确定的远端结果先读回。','subtle'),submit);box.append(form);
}
async function loadBotReviewForm(id,box,pulls,budgets,canControl) {
  box.replaceChildren(node('p','同一次审阅中的多条发现合计一轮。更换工单、重试或重启不会重置已用轮次。额度调整需填写原因。','subtle'));
  for(const record of budgets){
    box.append(node('p',`${record.repository} #${record.pullNumber} · 机器人 ID ${record.actorId} · 已用 ${record.rounds.length} 轮 · 剩余 ${Math.max(0,record.limit-record.rounds.length)} 轮${record.historicalUnknown?' · 历史额度尚未确认':''}`));
    for(const round of record.rounds)box.append(node('p',`第 ${round.number} 轮：${round.disposition?.summary??'等待处理'}（${round.eventIds.length} 项发现）`,'subtle'));
    for(const observation of (record.observations??[]).filter(row=>row.reason).slice(-5))box.append(node('p',`暂缓：${observation.reason} · 原始事件 ${observation.eventId}`,'subtle'));
  }
  if(!pulls.length||!canControl)return;
  const form=node('div'),key=`bot-review:${id}`,saved=draftStore?.load(key)??{},pull=node('select');
  for(const binding of pulls){const option=node('option',`${binding.repository} #${binding.number}`);option.value=String(binding.number);pull.append(option);}if(pulls.some(binding=>String(binding.number)===saved.pull))pull.value=saved.pull;
  const pullLabel=node('label','关联 PR');pullLabel.append(pull);
  const actor=inputField('机器人固定数字 ID',saved.actorId??budgets[0]?.actorId??'','text'),remaining=inputField('明确设置剩余轮次（0–3）',saved.remaining??'0','number'),reason=inputField('调整或关联原因',saved.reason??'','textarea');
  actor.input.inputMode='numeric';remaining.input.min='0';remaining.input.max='3';reason.input.maxLength=500;
  const run=inputField('审阅运行 ID（仅用于显式关联）',saved.runId??''),events=inputField('待关联的原始事件 ID（每行一个）',saved.events??'','textarea');
  const read=()=>({pull:pull.value,actorId:actor.input.value.trim(),remaining:remaining.input.value,reason:reason.input.value,runId:run.input.value,events:events.input.value});
  for(const event of ['input','change'])form.addEventListener(event,()=>draftStore?.save(key,read()));
  const save=node('button','保存剩余额度'),associate=node('button','关联这次审阅的原始事件');
  const endpoint=()=>{if(!/^[1-9]\d*$/.test(actor.input.value.trim()))throw new Error('请填写 GitHub 机器人固定数字 ID。');return `/api/github/bot-review/${pull.value}/${actor.input.value.trim()}`;};
  save.addEventListener('click',()=>act(save,async()=>{const sent=read(),record=budgets.find(row=>row.pullNumber===Number(sent.pull)&&row.actorId===sent.actorId);const result=await api(`${endpoint()}/budget`,{remaining:Number(sent.remaining),reason:sent.reason,expectedRevision:record?.revision??0});if(same(sent,read()))draftStore?.remove(key);return result;}));
  associate.addEventListener('click',()=>act(associate,async()=>{const sent=read();const result=await api(`${endpoint()}/associate`,{runId:sent.runId.trim(),eventIds:sent.events.split(/\r?\n/).map(value=>value.trim()).filter(Boolean),reason:sent.reason});if(same(sent,read()))draftStore?.remove(key);return result;}));
  const extra=node('details');extra.append(node('summary','无法自动识别审阅轮次时，手动关联'),run.wrapper,events.wrapper,node('p','只接受本 PR、同一机器人留下的原始事件；已有原生审阅 ID 的记录不能改写。关联后可从原始事件重新评估。','subtle'),associate);
  form.append(pullLabel,actor.wrapper,remaining.wrapper,reason.wrapper,save,extra);box.append(form);
}

function nativeHandoffDetails(records = [], ticketId, canControl = false) {
  if (!records.length) return [];
  const box=node('details');box.append(node('summary','原生命令的交接记录'));
  for(const record of records.slice(-10).reverse()) {
    const label=({holding:'等人处理，后台命令仍受管',resuming:'正在接续本轮',closing:'正在收尾',completed:'输出已收取，进程已退出',interrupted:'执行中断，需要检查',transferred:'已交给下一轮'})[record.status]??'状态待核对';
    box.append(node('p',label),node('p',`命令数：${record.jobIds.length} · 已收取：${(record.results??[]).filter(item=>item.type==='settled').length} · 截止：${date(record.deadlineAt)}`,'subtle'));
    for(const preview of record.previews??[]) {
      const row=node('div');row.append(node('strong',`预览：${preview.profileId}`),node('p',`租约截止 ${date(preview.expiresAt)} · 归属本工单与当前原生会话`,'subtle'));
      try{const url=new URL(preview.url);if(record.status==='holding'&&Date.parse(preview.expiresAt)>Date.now()&&url.protocol==='http:'&&['127.0.0.1','[::1]'].includes(url.hostname)&&url.port&&!url.username&&!url.password){const link=node('a','打开本地预览');link.href=url.href;link.target='_blank';link.rel='noreferrer noopener';row.append(link);}}catch{}
      if(canControl&&record.status==='holding'){
        const renew=node('button','续期 15 分钟');renew.addEventListener('click',()=>act(renew,()=>api(`/api/tickets/${ticketId}/native-preview`,{leaseId:record.id,jobId:preview.jobId,action:'renew',ttlMs:900000})));row.append(renew);
      }box.append(row);
    }
    if(canControl&&record.status==='holding'&&record.previews?.length){
      const close=node('button','关闭本组预览');close.addEventListener('click',()=>act(close,()=>api(`/api/tickets/${ticketId}/native-preview`,{leaseId:record.id,jobId:record.previews[0].jobId,action:'close'})));box.append(close,node('p','关闭会释放该租约中的全部命令；到期也会自动关闭。进程失联后只显示记录，不重新启动。','subtle'));
    }
    if(record.consumedAt)box.append(node('p',`结果已在 ${date(record.consumedAt)} 的正常业务轮次读取。`,'subtle'));
  }
  box.append(node('p','命令完成只保存结果；不会自行撤销问题或重新启动模型。','subtle'));return [box];
}
function ciDetails(pulls) {
  return (pulls??[]).map(pull=>{
    const snapshot=pull.ciSnapshot,box=node('details'),title=`${pull.repository}#${pull.number} 的 CI 观察`;
    if(!snapshot){box.append(node('summary',`${title}：尚无完整快照`),node('p',pull.ci?.length?`已保存 ${pull.ci.length} 条单项检查记录；无法据此确定整组检查状态。`:'尚无可用的检查观察。','subtle'));return box;}
    const historical=snapshot.headSha!==(pull.lastObservedHeadSha??pull.headSha);
    const state=({failed:'观察到失败',unknown:'状态不完整',running:'仍在运行',passed:'所选检查已结束，无失败'})[snapshot.state]??'待核对';
    box.append(node('summary',`${title}：${state}${historical?' · 历史提交':''}`),
      node('p',`提交 ${snapshot.headSha.slice(0,8)} · ${date(snapshot.observedAt)}。仅涵盖本机配置选择的检查，不代表分支保护要求已满足或 PR 可以合并。`,'subtle'));
    if(!snapshot.complete)box.append(node('p','本次读取不完整，不能作为全部检查的结论。','subtle'));
    const unresolved=[['missing','未观察到的配置项'],['ambiguous','无法区分的重跑'],['uncertain','结果未能确定的检查'],['missingPreviouslyObserved','先前失败但本次缺失的检查']]
      .filter(([key])=>snapshot[key]?.length).map(([key,label])=>`${label} ${snapshot[key].length} 项`);
    if(unresolved.length)box.append(node('p',unresolved.join('；'),'subtle'));
    if(snapshot.pendingFailureKeys?.length)box.append(node('p',`仍有 ${snapshot.pendingFailureKeys.length} 项已知故障尚未取得完整恢复证据。`,'subtle'));
    if(snapshot.recoveredAt)box.append(node('p',`已核对所选观察的故障恢复：${date(snapshot.recoveredAt)}。`,'subtle'));
    for(const entry of snapshot.entries??[])box.append(node('p',`${entry.name} · ${entry.status==='completed'?(entry.conclusion??'结果未知'):'运行中或等待中'}`,'subtle'));
    return box;
  });
}
function uiEvidenceDetails(evidence,id){
  if(!evidence)return [];
  const box=node('details');box.append(node('summary','界面 Before / After 验收'),node('p',`状态：${({captured:'前后截图已核对',complete:'前后截图已核对',baseline:'修改前截图已保存','baseline-recorded':'已记录修改前文件状态，截图另行核对',incomplete:'截图证据不完整',blocked:'截图证据缺失，需要补齐',skipped:'本轮无需截图','not-required':'本轮无需截图'})[evidence.status]??evidence.status}`));
  if(evidence.error)box.append(node('p',evidence.error,'question'));
  const settings=evidence.settings??{};box.append(node('p',`场景：${settings.scenario??'未指定'} · 视口：${settings.viewport?`${settings.viewport.width} × ${settings.viewport.height}`:'未指定'} · 主题：${settings.theme??'system'}`,'subtle'));
  for(const [side,label]of [['before','修改前'],['after','修改后']])if(evidence[side]){const capture=evidence[side],row=node('div'),button=node('button',`查看${label}截图`);button.addEventListener('click',async()=>{button.disabled=true;const request=detailRequest;try{const response=await fetch(`/api/tickets/${encodeURIComponent(id)}/ui-evidence/${side}.png`,{credentials:'same-origin',headers:{'X-Superagent-Request':csrf??'local-ui'}});if(!response.ok)throw new Error('截图已变化或无法读取，请刷新后重新核对。');const blob=await response.blob();if(selected!==id||detailRequest!==request)return;const url=URL.createObjectURL(blob),image=node('img');evidenceImages.add(url);image.src=url;image.alt=`${label}：${settings.scenario??'界面验收'}`;image.className='evidence-image';row.append(image);}catch(error){message(error.message,true);button.disabled=false;}});row.append(button,node('p',`${date(capture.at)} · 图像 ${capture.sha256??'待核对'} · 文件快照 ${capture.treeDigest??'待核对'} · 基础提交 ${capture.baseCommit??'无'}`,'subtle'));box.append(row);}
  if(!['not-required','skipped'].includes(evidence.status)&&(!evidence.before||!evidence.after))box.append(node('p','尚未取得完整的同场景前后截图，不能据此声明视觉验收通过。','subtle'));
  return [box];
}
async function detail(id) {
  const request = ++detailRequest;
  selected = id; renderTickets();
  const data = await api(`/api/tickets/${encodeURIComponent(id)}/details`);
  if (selected !== id || request !== detailRequest) return;
  for(const url of evidenceImages)URL.revokeObjectURL(url);evidenceImages.clear();
  const ticket = data.ticket;
  $('detail-title').textContent = ticket.text.slice(0, 120);
  const content = [node('p', `${ticket.awaitingReview && ticket.status==='completed' ? '等待审阅' : (labels[ticket.status] ?? ticket.status)} · ${data.stage}${data.action ? ` / ${data.action}` : ''}`, 'subtle')];
  if (data.attention?.question) content.push(node('p', data.attention.question, 'question'));
  for (const link of data.pullLinks ?? []) content.push(node('p', `需要先关联此 PR：${link.repository}#${link.pullNumber}。关联当前 head 后，下一次同步会把这条讨论交给本工单。`, 'question'));
  if (data.failure) content.push(node('p', data.failure.requiresInspection ? '执行结果需要检查。可以先补充信息；系统保存后会等待你明确重试。' : '补充说明即可继续原工单。', 'question'));
  if (data.heldFeedback?.length) content.push(node('p', `${data.heldFeedback.length} 条补充已保存，等待检查后继续。`, 'subtle'));
  if (data.recovery?.status === 'pending') content.push(node('p', `等待第 ${Number(data.recovery.attempt??0)+1} 次恢复，最早 ${date(data.recovery.nextAt)}。`, 'subtle'));
  if (data.recovery?.status === 'inspect') content.push(node('p', '已排入只读恢复检查；核对原执行记录后，才决定是否可以继续。', 'subtle'));
  if (data.recovery?.status === 'inspection') {
    const reason=({'native-pending-wakeup-unsupported':'当前 DSH 版本无法直接继续原待处理队列。追加要求已保留，尚未确认读取；重复重试不会重发。请先核对原会话，明确处理旧工作后再考虑替换会话',
      'managed-job-unsettled':'受管任务尚无可核对的完成证据，请先检查其结果和进程状态',
      'managed-job-needs-inspection':'受管任务的完成证据仍不充分，请查看任务检查记录，核对结果与进程状态',
      'host-operation-unreconciled':'宿主操作尚未完成对账，请先检查已保存的操作记录',
      'child-adoption-unreconciled':'子任务成果采纳尚未完成，请先核对采纳记录并恢复或回退',
      'recovery-deadline':'本次恢复期限已用完，请检查已有结果后再决定后续操作'})[data.recovery.reason];
    content.push(node('p', `恢复需要检查：${reason??data.recovery.reason??'无法核对原生执行状态'}。`, 'question'));
  }
  if (data.nativeResultRecoveredFrom) content.push(node('p', '已核对并接收中断前的完成报告，没有重复执行任务。', 'subtle'));
  const observation=data.executionObservation;
  if(observation?.state==='waiting') content.push(node('p',`原生模型正在等待：${({budget:'供应商预算耗尽','rate-limit':'请求限流',authentication:'认证需要检查',transient:'临时错误重试',unknown:'原因未知'})[observation.reason]??'原因未知'}${observation.provider?` · ${observation.provider}`:''}${observation.attempts==null?'':` · 已重试 ${observation.attempts} 次`}。${observation.since?`自 ${date(observation.since)} 起。`:''}仍可按现有方式取消；不会自动提高预算或更换模型。`,'question'));
  const policy=data.nativeFacts?.policy;
  if(policy) {
    const evidenceRun=policy.evidence?.runId,currentRun=typeof evidenceRun==='string'&&evidenceRun===ticket.runId;
    const applied=currentRun?'本轮已采用':typeof evidenceRun==='string'?'此前执行已采用':'记录为已采用，执行轮次待核对';
    const state=({selected:'已选择，等待执行端接收',accepted:'执行端已接收，等待使用证据',applied})[policy.status]??'状态待核对';
    content.push(node('p',`团队规约第 ${policy.revision} 版：${!currentRun&&policy.status!=='applied'?'此前记录：':''}${state}。${policy.status==='applied'&&policy.at?`应用时间：${date(policy.at)}。`:''}`,'subtle'));
  }
  if(data.policyStatus?.status==='legacy-unresolved') content.push(node('p','旧会话的团队规约无法与固定设置精确分离，已保留原设置。请检查会话设置后明确迁移或替换；尚未自动采用新规约。','question'));
  else if(data.policyStatus?.desiredRevision!==undefined&&data.policyStatus.desiredRevision!==(policy?.revision??null)) content.push(node('p',`最新团队规约为第 ${data.policyStatus.desiredRevision} 版，将在下一次正常业务轮次采用；保存设置不会主动唤醒工单。`,'subtle'));
  for (const input of data.liveInputs??[]) content.push(node('p', `追加反馈：${input.supersededBySessionReplacement?'旧会话投递已交人工核对，已替换会话；':''}${({pending:'待交付',sending:'正在交付',accepted:'已接收，尚未确认读取',read:'已确认读取','not-sent':'确定未发送',unknown:'发送结果未知，等待核对',rejected:'执行端拒绝',failed:'待检查'})[input.status]??input.status}${input.status==='not-sent'?(input.attempts<3?`；最早重试 ${date(input.nextAt)}`:'；本轮重试次数已用完，保留至下一轮'):''}${input.status==='read'&&input.evidence?.type==='model-final-ack'?'（报告确认）':input.status==='read'?'（原生记录确认）':''}`, 'subtle'));
  const rules=data.nativeFacts?.projectRules;
  if(rules){const box=node('details');box.append(node('summary', `本次项目规则：${rules.files?.length??0} 份`));for(const rule of rules.files??[])box.append(node('p',`${rule.path} · 作用范围 ${rule.scope} · ${rule.sha256.slice(0,12)}`));if(rules.skippedSymlinks?.length)box.append(node('p',`未读取符号链接：${rules.skippedSymlinks.join('、')}`));content.push(box);}
  content.push(...continuationDetails(data),...ciDetails(ticket.pullRequests),...nativeHandoffDetails(data.nativeHandoffs,id,data.managementActions?.nativePreview),...reviewDetails(data,id),...uiEvidenceDetails(data.uiEvidence,id));
  for(const review of ticket.pullRequests?.flatMap(pr=>pr.reviews??[])??[])content.push(node('p',`审阅结论：${({APPROVED:'已批准',CHANGES_REQUESTED:'要求修改',DISMISSED:'已撤销',COMMENTED:'已评论'})[review.state]??review.state} · ${review.actor??''} · ${review.headSha?.slice(0,8)??''}`,'subtle'));
  for(const item of ticket.messages.filter(message=>message.superseded))content.push(node('p',`一条先前的要求已有修订：${item.text.slice(0,120)}`,'subtle'));
  if (ticket.source?.url) { const link = node('a', '打开原始讨论'); link.href = ticket.source.url; link.target = '_blank'; link.rel = 'noreferrer noopener'; content.push(link); }
  content.push(node('h3', '授权范围'), node('pre', ticket.scope));
  const actions = node('div', undefined, 'buttons');
  const pendingDelivery = ['failed', 'running'].includes(data.deliveryAttempt?.state);
  if (pendingDelivery) content.push(node('p', data.managementActions?.deliveryConfigured ? '交付尚未完成。检查交付记录后，可接续保存的交付操作。' : '交付尚未完成。请先在本机配置受信任的交付策略。', 'question'));
  for (const [action, title, enabled] of [['deliver', '检查后恢复交付', pendingDelivery && data.managementActions?.deliveryConfigured], ['retry', '检查后重试', !pendingDelivery && ['failed', 'interrupted', 'cancelled'].includes(ticket.status)], ['cancel', '取消工作', data.outcome===null||data.outcome===undefined&&!['completed', 'cancelled'].includes(ticket.status)]]) {
    if (!enabled) continue;
    const button = node('button', title); button.addEventListener('click', () => act(button, () => api(`/api/tickets/${id}/${action}`, {}))); actions.append(button);
  }
  content.push(actions);
  if (['queued', 'running', 'waiting', 'completed', 'failed', 'interrupted'].includes(ticket.status)) {
    const label = node('label', '回答问题或补充要求'); label.htmlFor = 'reply-text'; const input = node('textarea'); input.id = 'reply-text'; input.rows = 4; input.value = replyDraft(id).text;
    input.addEventListener('input', () => setReplyDraft(id, input.value));
    const button = node('button', '发送给工单');button.id='reply-send';button.disabled=replySending.has(id);button.addEventListener('click', () => act(button, () => sendReply(id)));
    content.push(label, input, button);
  }
  content.push(node('h3', '最近报告'));
  for (const report of ticket.reports.slice(-8).reverse()) { const row = node('div', undefined, 'timeline'); row.append(node('small', `${report.status} · ${date(report.at)}`), node('pre', report.summary)); content.push(row); }
  if (!ticket.reports.length) content.push(node('p', '尚未产生报告。', 'subtle'));
  if (data.verification) content.push(node('h3', '验证记录'), node('pre', JSON.stringify(data.verification, null, 2)));
  if (data.delivery) content.push(node('h3', '交付记录'), node('pre', JSON.stringify(data.delivery, null, 2)));
  if (data.deliveryAttempt) content.push(node('h3', '当前交付进度'), node('pre', JSON.stringify(data.deliveryAttempt, null, 2)));
  if (data.sessionSettings?.execution) content.push(node('h3', '本工单固定的 Worker 设置'),
    node('p', data.sessionSettings.pinOrigin === 'legacy-effective-settings-before-change' ? '旧会话在最近更改前保留的有效设置；并非历史创建时的完整记录。' : '模型、工具和基础执行设置保持固定；可核对的团队规约在下一轮更新，实际版本见上方状态。', 'subtle'),
    node('pre', JSON.stringify(data.sessionSettings, null, 2)));
  if (data.managementActions?.requestStatus && data.actionAvailability?.requestStatus?.allowed) { const button=node('button','询问执行进展'); button.addEventListener('click',()=>act(button,()=>api(`/api/tickets/${id}/request-status`,{}))); content.push(button); }
  else if(data.actionAvailability?.requestStatus?.reason)content.push(node('p',data.actionAvailability.requestStatus.reason,'subtle'));
  if (data.managementActions?.trace) content.push(lazySection('工作来由与完整时间线', box=>loadTrace(id,box)));
  if (data.managementActions?.jobs) content.push(lazySection('后台任务、预览与子任务成果', box=>loadJobs(id,box,data.managementActions)));
  if (data.managementActions?.adoptionRecovery) content.push(lazySection('子任务采纳与中断恢复', box=>loadAdoptions(id,box)));
  if (data.managementActions?.session) content.push(lazySection('执行会话与替换记录', box=>loadSession(id,box)));
  $('detail').replaceChildren(...content);
}
async function refresh() {
  const currentLoad=beginLoad('refresh'),[state] = await Promise.all([api('/api/status'), loadTickets()]);
  if(!currentLoad())return;bindDraftProject(state.projectId);health(state);
  if (selected) await detail(selected);
  if (state.capabilities?.incidents) await loadIncidents();
  if ($('background-panel')?.open) await loadBackground();
}
async function loadBackground() {
  const currentLoad=beginLoad('background');
  const [service,controls]=await Promise.all([api('/api/service-health'),api('/api/controls')]);
  if(!currentLoad())return;
  const names={'not-installed':'未安装',stopped:'已停止',starting:'启动中',retrying:'等待重试','setup-blocked':'设置阻塞',unobserved:'尚无有效心跳',stalled:'心跳已失效',degraded:'业务需要处理',paused:'业务已暂停',healthy:'正常',unsupported:'当前系统无内置后台服务'};
  const healthBox=$('service-health');
  healthBox.replaceChildren(node('p',`后台：${names[service.state]??service.state} · 最近心跳：${date(service.lastHeartbeatAt)}`));
  if(service.reason)healthBox.append(node('p',service.reason,'subtle'));
  const labels={queued:'等待后台处理',running:'正在处理',completed:'调用已完成，请核对结果',failed:'前置条件不满足',unknown:'执行结果不明，先核对工单',cancelled:'原后台已退出，未执行'};
  $('control-records').replaceChildren(...controls.map(record=>{
    const row=node('details');row.append(node('summary',`${labels[record.status]??record.status} · ${record.method} · ${record.operationId.slice(0,12)}`),node('pre',JSON.stringify(record,null,2)));return row;
  }));
  if(!controls.length)$('control-records').append(node('p','暂无后台操作记录。','subtle'));
}
async function loadSetup() {
  const currentLoad=beginLoad('setup');const report=await api('/api/setup');if(!currentLoad())return;
  const labels={passed:'已通过',blocked:'需处理',unchecked:'待检查','not-applicable':'未配置',warning:'提示'};
  $('setup-records').replaceChildren(...report.checks.map(check=>{const item=node('div');item.append(node('strong',`${labels[check.status]} · ${check.id}`),node('p',check.message));if(check.nextAction)item.append(node('p',check.nextAction,'subtle'));return item;}));
}
let diagnosticCursor=null,diagnosticFilter='',diagnosticItems=[];
const diagnosticLabels={filtered:'已过滤',ignored:'未接入',deferred:'暂停待处理',received:'已接收',stored:'已记录',pending:'等待处理',evaluating:'正在研判',decided:'已有判断',none:'未进入研判',sent:'已发送',failed:'发送失败，等待重试',dropped:'已撤回或无法发送',read:'已读取',delivered:'已交给执行端',retired:'已被新版本替代',unknown:'记录不足',accept:'已接单',ignore:'不接单',unavailable:'未能完成判断',reopen:'继续原工单',stop:'停止工作'};
function diagnosticReason(value) {
  if(value==null)return '';
  if(typeof value==='string')return ({'runtime-paused':'业务已暂停，回复等待恢复。','waiting-for-earlier-reply':'同一讨论的前一条回复尚未处理完。','withdrawn-or-unavailable':'回复已撤回，或目标已不可用。','pull-link-required':'需要先把这个 PR 显式关联到目标工单。'})[value]??value;
  if(Array.isArray(value))return value.map(diagnosticReason).filter(Boolean).join('；');
  if(value.values?.text)return value.values.text;
  return value.reason??value.code??JSON.stringify(value);
}
function diagnosticTicketLink(id,box) {
  if(!id)return;const button=node('button',`打开工单 ${id.slice(0,12)}`);
  button.addEventListener('click',()=>detail(id).then(()=>$('detail-title').scrollIntoView?.({block:'start'})).catch(error=>message(error.message,true)));box.append(button);
}
function diagnosticReply(reply) {
  const row=node('div',undefined,'timeline');
  row.append(node('strong',`${diagnosticLabels[reply.status]??reply.status} · ${reply.kind??'回复'}`));
  if(reply.relation)row.append(node('p',reply.relation==='direct'?'直接关联此事件':'同工单或讨论的相关回传，不代表由此事件触发','subtle'));
  row.append(node('p',reply.text??''),node('p',`${reply.source} · ${reply.thread??''} · 已尝试 ${reply.attempts??0} 次`,'subtle'));
  if(reply.textTruncated)row.append(node('p','正文仅显示摘要。','subtle'));
  for(const value of [reply.reason,reply.error])if(value)row.append(node('p',diagnosticReason(value),'question'));
  if(reply.blockedBy?.length)row.append(node('p',`前序回复：${reply.blockedBy.join('、')}`,'subtle'));
  if(reply.nextRetryAt)row.append(node('p',`下次尝试：${date(reply.nextRetryAt)}`,'subtle'));
  diagnosticTicketLink(reply.ticketId,row);
  if(reply.thread)row.append(lazySection('查看讨论记录',child=>loadContextRecord('threads',`${reply.source}:${reply.thread}`,child)));
  if(reply.url)row.append(associationLinks({urls:[{url:reply.url}]}));
  return row;
}
async function loadDiagnosticDetail(id,box) {
  const data=await api(`/api/diagnostics/event?id=${encodeURIComponent(id)}`);
  box.replaceChildren(node('p',data.text||'没有保留正文。'));
  box.append(node('p',`事件编号：${id}`,'subtle'));
  if(!data.available)box.append(node('p','此记录没有保存完整原始事件；以下仅展示已保存的处理事实。','subtle'));
  box.append(node('h4','接收与判断'),node('p',`${diagnosticLabels[data.intake.status]??data.intake.status}${data.intake.reason?' · '+diagnosticReason(data.intake.reason):''}`),node('p',`研判：${diagnosticLabels[data.evaluation.status]??data.evaluation.status}`));
  for(const result of data.intake.outcomes??[])box.append(node('p',`${result.ticketId}：${diagnosticLabels[result.status]??result.status} ${diagnosticReason(result.reason)}`));
  for(const decision of data.evaluation.decisions??[]){const item=node('div');item.append(node('p',`${diagnosticLabels[decision.kind]??decision.kind} · ${diagnosticReason(decision.reason)}`),lazySection('查看判断原始记录',child=>loadContextRecord('decisions',decision.id,child)));diagnosticTicketLink(decision.ticketId,item);box.append(item);}
  box.append(node('h4','到达哪些工单'));
  if(!data.tickets.length)box.append(node('p','未记录关联工单。','subtle'));
  for(const ticket of data.tickets){const item=node('div',undefined,'timeline');diagnosticTicketLink(ticket.ticketId,item);item.append(node('p',ticket.context?'只作上下文，不取得新请求归属':ticket.fanout?'已投递到工单':'原始或历史关联'));if(ticket.acknowledged)item.append(node('p','执行者已确认接下此请求。'));if(ticket.handback)item.append(node('p',`已交回重新判断：${diagnosticReason(ticket.handback)}`));for(const input of ticket.inputs??[])item.append(node('p',`${diagnosticLabels[input.state]??input.state} · ${date(input.readAt??input.at)}`,'subtle'));box.append(item);}
  box.append(node('h4','回传记录'));
  if(!data.replies.length)box.append(node('p','没有匹配的回传记录。收到事件不代表系统必须回复。','subtle'));
  else box.append(...data.replies.map(diagnosticReply));
  if(data.url)box.append(associationLinks({urls:[{url:data.url}]}));
  if(data.available)box.append(lazySection('查看原始事件',child=>loadContextRecord('triggers',id,child)));
  if(Object.values(data.omitted??{}).some(value=>value>0))box.append(node('p','关联较多，当前为有界摘要；请按工单或原始记录继续查看。','subtle'));
}
async function loadDiagnostics(more=false) {
  const filters={kind:$('diagnostic-kind').value,query:$('diagnostic-query').value.trim(),source:$('diagnostic-source').value.trim(),problems:$('diagnostic-problems').checked};
  const signature=JSON.stringify(filters),continuing=more&&signature===diagnosticFilter&&diagnosticCursor;
  const currentLoad=beginLoad('diagnostics'),params=new URLSearchParams({limit:'20',q:filters.query,problems:filters.problems?'1':'0'});
  if(filters.source)params.set('source',filters.source);if(continuing)params.set('cursor',diagnosticCursor);
  const data=await api(`/api/diagnostics/${filters.kind}?${params}`);
  if(!currentLoad()||filters.kind!==$('diagnostic-kind').value||filters.query!==$('diagnostic-query').value.trim()||filters.source!==$('diagnostic-source').value.trim()||filters.problems!==$('diagnostic-problems').checked)return;
  diagnosticItems=continuing?[...diagnosticItems,...data.items]:data.items;diagnosticCursor=data.nextCursor;diagnosticFilter=signature;
  $('diagnostic-summary').textContent=`符合条件 ${data.total} 条；已显示 ${diagnosticItems.length} 条。`;
  const box=$('diagnostic-records');box.replaceChildren();
  if(!diagnosticItems.length)box.append(node('p','没有符合条件的已保存记录。','subtle'));
  for(const item of diagnosticItems){if(filters.kind==='replies')box.append(diagnosticReply(item));else{const title=`${diagnosticLabels[item.intake.status]??item.intake.status} · ${item.source} · ${(item.text||item.id).slice(0,100)}`;box.append(lazySection(title,child=>loadDiagnosticDetail(item.id,child)));}}
  $('diagnostic-more').hidden=!diagnosticCursor;
}
function historyRows(history, current, toDraft, loadDraft) {
  return (history ?? []).slice(-10).reverse().map(item => {
    const row = node('details'), summary = node('summary', `版本 ${item.revision} · ${date(item.at)}`);
    const draft = toDraft(item);
    const differences = [];
    const compare = (oldValue, currentValue, path) => {
      if (JSON.stringify(oldValue) === JSON.stringify(currentValue)) return;
      if (oldValue && currentValue && !Array.isArray(oldValue) && !Array.isArray(currentValue) && typeof oldValue === 'object' && typeof currentValue === 'object') {
        for (const key of new Set([...Object.keys(oldValue), ...Object.keys(currentValue)])) compare(oldValue[key], currentValue[key], path ? `${path}.${key}` : key);
      } else differences.push(`${path}\n历史：${JSON.stringify(oldValue) ?? '未设置'}\n当前：${JSON.stringify(currentValue) ?? '未设置'}`);
    };
    compare(draft, current, '');
    const load = node('button', '加载此版本为草稿');
    load.addEventListener('click', () => {
      loadDraft(draft, item.revision);
      message('历史设置已载入草稿，尚未保存。');
    });
    row.append(summary, node('pre', differences.length ? differences.join('\n\n') : '与当前设置相同。'), load); return row;
  });
}
function patchAdmissionRow(id, update, rerender = false) {
  try {
    const value=JSON.parse($('settings').value),rows=value.policy?.sourceRows??[],index=rows.findIndex(row=>row.id===id);
    if(index<0)throw new Error('此范围已在高级设置中改变，请重新读取草稿。');
    rows[index]=update(rows[index]);value.policy={...value.policy,sourceRows:rows};$('settings').value=JSON.stringify(value,null,2);
    if(rerender)renderAdmission();persistEditor(editors.get('coordinator'));
  }catch(error){message(error.message,true);}
}
function renderAdmission() {
  const box=$('policy-matrix');if(!box)return;box.replaceChildren();
  let value;try{value=JSON.parse($('settings').value);}catch{box.append(node('p','高级设置尚不是完整 JSON；完成后可继续编辑准入表。','subtle'));return;}
  const rows=value.policy?.sourceRows??[];
  if(!Array.isArray(rows)){box.append(node('p','接收范围需要使用列表。','error'));return;}
  if(!rows.length)box.append(node('p','尚未添加额外接收范围。现有本机名单内的明确委托继续有效。','subtle'));
  for(const row of rows){
    const card=node('fieldset',undefined,'admission-card');card.append(node('legend',row.id));
    const source=node('select');for(const [id,label] of [['github','GitHub'],['feishu','飞书'],...(['github','feishu'].includes(row.source)?[]:[[row.source,row.source]])]){const option=node('option',label);option.value=id;source.append(option);}source.value=row.source;
    const sourceLabel=node('label','来源');sourceLabel.append(source);card.append(sourceLabel);
    source.addEventListener('change',()=>patchAdmissionRow(row.id,current=>({...current,source:source.value,scope:source.value==='github'?{repository:''}:{tenantKey:'',chatId:''},admission:{...current.admission,unlistedAddressed:'ignore'}}),true));
    const fields=row.source==='github'?[['repository','仓库（owner/name）']]:row.source==='feishu'?[['tenantKey','租户标识'],['chatId','接收群 chat_id']]:[];
    const scopeBox=node('div',undefined,'form-grid');
    for(const [key,label] of fields){const field=inputField(label,row.scope?.[key]??'');field.input.addEventListener('input',()=>patchAdmissionRow(row.id,current=>({...current,scope:{...current.scope,[key]:field.input.value.trim()}})));scopeBox.append(field.wrapper);}
    if(!fields.length)scopeBox.append(node('p',`范围：${JSON.stringify(row.scope??{})}`,'subtle'));card.append(scopeBox);
    const identities=node('div',undefined,'form-grid');
    for(const [key,label] of [['actors','名单内真人（逗号分隔）'],['bots','机器人身份（逗号分隔）']]){const field=inputField(label,(row[key]??[]).join(', '));field.input.addEventListener('input',()=>patchAdmissionRow(row.id,current=>({...current,[key]:field.input.value.split(',').map(item=>item.trim()).filter(Boolean)})));identities.append(field.wrapper);}card.append(identities);
    card.append(node('p','名单内真人的明确委托始终走授权接单；机器人始终是推断候选，不能取得真人权限。','subtle'));
    const table=node('table',undefined,'admission-table'),head=node('tr');for(const label of ['消息来源','处理方式'])head.append(node('th',label));table.append(head);
    const warning=node('p','允许范围内的非名单真人明确委托，会扩大谁能发起工作的范围。只有核验为真人且消息明确寻址时才生效。','question');
    for(const [key,label] of [['listedUnaddressed','名单内真人，未明确寻址'],['unlistedAddressed','非名单真人，明确寻址'],['unlistedUnaddressed','非名单真人，未明确寻址']]){
      const tr=node('tr'),cell=node('td'),select=node('select');
      for(const [optionValue,title] of [['ignore','忽略'],['inferred','作为推断候选'],...(key==='unlistedAddressed'&&fields.length?[['explicit','作为明确委托']]:[])]){const option=node('option',title);option.value=optionValue;select.append(option);}
      const saved=row.admission?.[key];select.value=saved===true?'inferred':saved===false||saved===undefined?'ignore':saved;select.id=`admission-${row.id}-${key}`;
      select.addEventListener('change',()=>{patchAdmissionRow(row.id,current=>({...current,admission:{...current.admission,[key]:select.value}}));if(key==='unlistedAddressed')warning.hidden=select.value!=='explicit';});
      cell.append(select);tr.append(node('th',label),cell);table.append(tr);
    }
    warning.hidden=row.admission?.unlistedAddressed!=='explicit';card.append(table,warning);
    const remove=node('button','移除此范围');remove.addEventListener('click',()=>{try{const latest=JSON.parse($('settings').value);latest.policy.sourceRows=(latest.policy.sourceRows??[]).filter(item=>item.id!==row.id);writeCoordinatorDraft(JSON.stringify(latest,null,2));persistEditor(editors.get('coordinator'));}catch(error){message(error.message,true);}});card.append(remove);box.append(card);
  }
}
function writeCoordinatorDraft(value){$('settings').value=value;try{const parsed=JSON.parse(value);$('coord-mode').value=parsed.policy?.mode??'off';$('coord-workflow').value=parsed.workflowMode??'candidates';$('coord-retry').checked=parsed.workRetry?.autoRetry??false;}catch{}renderAdmission();}
async function loadSettings() {
  const currentLoad=beginLoad('coordinator'),data = await api('/api/coordinator');if(!currentLoad())return;const settings = data.settings ?? data;
  revision = settings.revision; $('revision').textContent = `当前版本 ${revision} · ${settings.version} · ${date(settings.at)}`;
  const current = { policy: settings.policy, assessor: settings.assessor, workflowMode: settings.workflowMode ?? 'candidates', workRetry:settings.workRetry??{autoRetry:false,maxAttempts:3,initialDelayMs:2000,timeoutMs:120000} };
  const coordinatorHarnesses=(data.harnesses??[]).filter(item=>item.roles?.includes('coordinator'));
  $('coordinator-harnesses').textContent=coordinatorHarnesses.length?`可用协调执行端：${coordinatorHarnesses.map(item=>item.label??item.id).join('、')}。通过高级设置选择；凭据仅填写环境变量引用。`:'';
  const state = editor('coordinator', () => $('settings').value, writeCoordinatorDraft, 'save-settings');
  const loaded=receiveEditor(state, revision, JSON.stringify(current,null,2));
  $('draft-origin').textContent = loaded ? '草稿与当前版本一致。保存时检查当前版本号。' : '本地草稿已保留；重新读取不会覆盖尚未保存的文字。';
  $('history').replaceChildren(...historyRows(data.history, current, item => ({ policy: item.policy, assessor: item.assessor, workflowMode: item.workflowMode ?? 'candidates',workRetry:item.workRetry??{autoRetry:false,maxAttempts:3,initialDelayMs:2000,timeoutMs:120000} }), (draft, historicalRevision) => {
    writeCoordinatorDraft(JSON.stringify(draft, null, 2));
    $('draft-origin').textContent = `草稿来自版本 ${historicalRevision}；保存仍需基准版本 ${state.baseRevision} 匹配，并创建新版本。`;
  }));
}
function workerDraft(execution) {
  const { prompt, ...settings } = execution;
  $('worker-settings').value = JSON.stringify(settings, null, 2); $('worker-prompt').value = prompt ?? '';
  $('worker-driver').value=settings.driver??''; $('worker-model').value=settings.model??''; $('worker-timeout').value=(settings.timeoutMs??600000)/1000; $('worker-managed').checked=!!settings.enableManagedJobs;
  workerCapabilities(settings);
}
function workerCapabilities(settings) {
  const descriptor=workerHarnesses.find(item=>item.id===settings.driver);
  const capabilities=descriptor?.capabilities;
  const managed=capabilities?.backgroundTasks===true&&capabilities?.subagents===true;
  $('worker-managed').disabled=!managed;
  $('worker-managed').checked=settings.enableManagedJobs===true;
  $('worker-agent-tools').disabled=capabilities?.agentTools!==true;
  $('worker-agent-tools').checked=settings.enableAgentTools===true;
  $('worker-capabilities').textContent=capabilities
    ? `${descriptor.label??descriptor.id} · ${capabilities.sessionResume?'支持原生会话续作':'后续轮次重新提供工单上下文'} · ${capabilities.realtimeInput?'支持运行中追加输入':'追加输入在下一轮处理'} · ${capabilities.agentTools?(settings.enableAgentTools?'业务工具已启用':'业务工具未启用'):'无业务工具桥接'} · ${managed?(settings.enableManagedJobs?'受管理后台任务已启用':'受管理后台任务未启用'):'不支持受管理后台任务'}`
    : '服务端未提供此执行端的能力声明；保存时将重新检查配置。';
}
async function loadWorker() {
  const currentLoad=beginLoad('worker'),data = await api('/api/executor');if(!currentLoad())return;const settings = data.settings;
  workerRevision = settings.revision; $('worker-revision').textContent = `当前版本 ${workerRevision} · ${date(settings.at)}`;
  const execution = settings.execution ?? data.effective ?? { driver: data.harnesses?.[0]?.id };
  workerHarnesses=Array.isArray(data.harnesses)?data.harnesses.filter(item=>typeof item.id==='string'&&(!item.roles||item.roles.includes('worker'))):[];
  let selectedDriver=execution.driver;
  try{selectedDriver=JSON.parse($('worker-settings').value).driver??selectedDriver;}catch{}
  const choices=[...workerHarnesses];
  if(!choices.some(item=>item.id===selectedDriver)){const legacy={id:selectedDriver,label:`${selectedDriver}（旧配置，需迁移）`,preserveOnSave:['executable','backend','permission','contextMode']};choices.push(legacy);workerHarnesses.push(legacy);}
  $('worker-driver').replaceChildren(...choices.map(item=>{const option=node('option',item.label??item.id);option.value=item.id;return option;}));
  $('worker-driver').value=selectedDriver;
  const state=editor('worker',()=>({settings:$('worker-settings').value,prompt:$('worker-prompt').value}),value=>{try{workerDraft({...JSON.parse(value.settings),...(value.prompt?{prompt:value.prompt}:{})});}catch{$('worker-settings').value=value.settings;$('worker-prompt').value=value.prompt;}},'save-worker');
  const {prompt,...options}=execution;
  receiveEditor(state,workerRevision,{settings:JSON.stringify(options,null,2),prompt:prompt??''});
  try{workerCapabilities(JSON.parse($('worker-settings').value));}catch{}
  const migration=data.migration;
  $('worker-draft-origin').textContent = migration?.required
    ? `旧执行配置需要迁移${migration.target?`到 ${workerHarnesses.find(item=>item.id===migration.target)?.label??migration.target}`:''}。保存新设置不会自动替换旧工单会话；${migration.tickets?.length??0} 个工单需要检查并明确替换会话。${migration.coordinator?'协调者设置也需要更新。':''}${migration.child?'子任务设置也需要更新。':''}`
    : '当前设置仅用于之后新建执行会话的工单。';
  $('worker-history').replaceChildren(...historyRows(data.history, execution, item => item.execution, (draft, historicalRevision) => {
    workerDraft(draft); $('worker-draft-origin').textContent = `草稿来自版本 ${historicalRevision}；保存仍需当前版本 ${workerRevision} 匹配，并创建新版本。`;
  }));
}
async function loadRepository() {
  const currentLoad=beginLoad('repository'),settings = await api('/api/repository');if(!currentLoad())return;repositoryRevision = settings.revision;
  $('repository-revision').textContent = `当前版本 ${repositoryRevision} · ${date(settings.at)}`;
  receiveEditor(editor('repository',()=>$('repository-settings').value,value=>{$('repository-settings').value=value;try{repositoryControls(JSON.parse(value));}catch{}},'save-repository'),repositoryRevision,JSON.stringify({enabled:settings.enabled,observe:settings.observe,streams:settings.streams},null,2));
}
function lazySection(title, load) {
  const section = node('details'), body = node('div'); let loaded = false;
  section.append(node('summary', title), body);
  section.addEventListener('toggle', () => { if (section.open && !loaded) { loaded = true; load(body).catch(error => { loaded = false; body.replaceChildren(node('p', error.message, 'error')); }); } });
  return section;
}
async function loadTrace(id, box, cursor) {
  const data = await api(`/api/tickets/${id}/trace?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
  if (!cursor) box.replaceChildren(node('p', `共 ${data.total} 条记录；每条保留原始事实。`, 'subtle'));
  for (const event of data.items) {
    const entry = node('details'), names = { authorization:'授权', trigger:'收到的事件', decision:'判断', input:'执行输入', assignment:'派工', thread:'讨论订阅', report:'报告', session:'会话变更', job:'后台任务', verification:'验证', delivery:'交付', deliveryAttempt:'交付操作' };
    entry.append(node('summary', `${names[event.kind] ?? event.kind} · ${date(event.at)}`), node('pre', JSON.stringify(event.value, null, 2)),associationLinks(event.associations)); box.append(entry);
  }
  if (data.nextCursor) { const more = node('button', '继续读取时间线'); more.addEventListener('click', async () => { more.disabled = true; try { await loadTrace(id,box,data.nextCursor); more.remove(); } catch(error) { more.disabled=false; message(error.message,true); } }); box.append(more); }
}
async function loadJobs(id, box, actions) {
  const jobs = await api(`/api/tickets/${id}/jobs`); box.replaceChildren();
  if (!jobs.length) { box.append(node('p','暂无受管理后台任务。','subtle')); return; }
  for (const job of jobs) {
    const entry=node('div',undefined,'timeline'), buttons=node('div',undefined,'buttons');
    entry.append(node('strong',`${job.profileId} · ${job.status}`),node('p',`开始：${date(job.startedAt)} · 截止：${date(job.deadlineAt)}`,'subtle'));
    if(job.previewLease){const lease=job.previewLease;entry.append(node('p',`预览：${lease.status} · 到期 ${date(lease.expiresAt)}`));if(lease.status==='active'){const link=node('a','打开当前预览');link.href=lease.url;link.target='_blank';link.rel='noreferrer noopener';entry.append(link);}}
    if(actions.jobControl) for(const [action,title] of (job.previewLease?.status==='active' ? [['renew','续期 30 分钟'],['close','关闭预览']] : ['pending','running'].includes(job.status) ? [['cancel','停止此任务']] : [])) {
      const button=node('button',title);button.addEventListener('click',()=>act(button,()=>api(`/api/tickets/${id}/jobs/${job.id}/${action}`,action==='renew'?{ttlMs:1800000}:{})));buttons.append(button);
    }
    if(actions.adoption && job.status==='completed' && job.workspace?.snapshotOrigin==='parent-workspace') {
      const review=node('button','审阅子任务差异'); review.addEventListener('click',async()=>{review.disabled=true;try{const plan=await api(`/api/tickets/${id}/jobs/${job.id}/adoption`);const panel=node('div');panel.append(node('pre',JSON.stringify(plan,null,2)));const apply=node('button','采纳此差异；之后需重新验证');apply.addEventListener('click',()=>act(apply,()=>api(`/api/tickets/${id}/jobs/${job.id}/adopt`,{expectedPlanDigest:plan.digest})));panel.append(apply);entry.append(panel);}catch(error){message(error.message,true);}finally{review.disabled=false;}});buttons.append(review);
    }
    if(actions.jobControl&&job.kind==='agent'){
      const inspection=job.recoveryInspection||job.messages?.some(item=>item.status==='inspection'),action=['pending','running'].includes(job.status)?'message':'resume',available=job.controlAvailability?.[action];
      if(inspection||available?.allowed===false)entry.append(node('p',available?.reason??'原子任务需要检查，不能重新发送或重建执行。','question'));
      else if(['pending','running','completed','handed-off'].includes(job.status)){
        const key=`job-message:${id}:${job.id}`,saved=jobDrafts.get(key)??draftStore?.load(key),field=inputField(action==='message'?'追加给子任务':'回复问题或补充接续要求',saved?.text??'','textarea');
        let draft=saved??{text:'',requestId:crypto.randomUUID()};
        jobDrafts.set(key,draft);field.input.maxLength=16000;field.input.addEventListener('input',()=>{if(draft.text!==field.input.value)draft={text:field.input.value,requestId:crypto.randomUUID()};jobDrafts.set(key,draft);if(draft.text)draftStore?.save(key,draft);else draftStore?.remove(key);});
        const send=node('button',action==='message'?'追加消息':'回复并接续');send.disabled=jobSending.has(key);send.addEventListener('click',()=>act(send,async()=>{if(jobSending.has(key))throw new Error('这条子任务消息正在发送。');if(!draft.text.trim())throw new Error('请先填写给子任务的消息。');const sent={...draft};jobSending.add(key);draftStore?.save(key,sent);try{const result=await api(`/api/tickets/${id}/jobs/${job.id}/${action}`,sent);if(!controlNeedsInspection(result)&&same(jobDrafts.get(key),sent)){jobDrafts.delete(key);draftStore?.remove(key);field.input.value='';draft={text:'',requestId:crypto.randomUUID()};}return result;}finally{jobSending.delete(key);}}));entry.append(field.wrapper,send,node('p','接续原子任务会话；宿主会核对执行能力、原归属和剩余额度。结果不明时保留消息编号供核对；确认后再另行发起。','subtle'));
      }
      for(const item of (job.messages??[]).slice(-5))entry.append(node('p',`子任务消息：${({queued:'待读取',running:'处理中',completed:'已处理',inspection:'需要核对'})[item.status]??item.status} · ${item.text??''}`,'subtle'));
    }
    entry.append(buttons,lazySection('任务证据',async detailBox=>detailBox.append(node('pre',JSON.stringify(job,null,2)))));box.append(entry);
  }
}
async function loadAdoptions(id,box){
  const records=await api(`/api/tickets/${id}/adoptions`);box.replaceChildren();
  if(!records.length){box.append(node('p','暂无子任务采纳记录。','subtle'));return;}
  for(const record of records){const entry=node('details');entry.append(node('summary',`${record.id} · ${record.status}`),node('pre',JSON.stringify(record,null,2)));
    if(['pending','applying','interrupted','recovering'].includes(record.status)){entry.append(node('p','先停止当前执行、关闭预览并核对差异。选择恢复原文件或继续已核对的采纳；之后需要重新验证。','subtle'));for(const [mode,title] of [['rollback','恢复采纳前的文件'],['finish','继续完成这次采纳']]){const button=node('button',title);button.addEventListener('click',()=>act(button,()=>api(`/api/tickets/${id}/adoptions/${record.id}/recover`,{mode})));entry.append(button);}}box.append(entry);}
}
async function loadSession(id, box) {
  const data=await api(`/api/tickets/${id}/session`);box.replaceChildren(node('pre',JSON.stringify(data,null,2)));
  const sessionId=data.session?.id??null;
  const availability=data.actionAvailability?.sessionReplace;
  if(!availability?.allowed||availability.expectedSessionId!==sessionId){box.append(node('p',availability?.reason??'当前状态不能替换会话；请刷新并核对执行、预览与交付状态。','subtle'));return;}
  box.append(node('p','替换会话前需暂停处理、停止当前轮次并核对未完成交付。工单和工作区继续保留。','subtle'));
  const key=`${id}:${sessionId}`,saved=draftStore?.load(`session:${key}`),draft=sessionDrafts.get(key)??(saved&&typeof saved.reason==='string'&&typeof saved.adopt==='boolean'?saved:{reason:'',adopt:false});sessionDrafts.set(key,draft);
  const persist=()=>draftStore?.save(`session:${key}`,draft);
  for(const [oldKey,oldDraft] of sessionDrafts)if(oldKey.startsWith(`${id}:`)&&oldKey!==key&&oldDraft.reason){const old=node('details');old.append(node('summary','原会话的未发送草稿（不会自动用于新会话）'),node('pre',oldDraft.reason));box.append(old);}
  const reason=node('textarea');reason.rows=2;reason.placeholder='说明会话损坏、协议变化或需要采用新设置的原因';reason.value=draft.reason;reason.addEventListener('input',()=>{draft.reason=reason.value;persist();});
  const adopt=node('input');adopt.type='checkbox';adopt.checked=draft.adopt;adopt.addEventListener('change',()=>{draft.adopt=adopt.checked;persist();});const label=node('label','采用当前模型、工具和提示词版本 ');label.append(adopt);
  const button=node('button','按以上选择替换会话');button.addEventListener('click',()=>act(button,async()=>{const sent={...draft};const result=await api(`/api/tickets/${id}/session/replace`,{reason:sent.reason,expectedSessionId:sessionId,adoptCurrentSettings:sent.adopt});if(!controlNeedsInspection(result)&&same(draft,sent)){sessionDrafts.delete(key);draftStore?.remove(`session:${key}`);}return result;}));
  box.append(reason,label,button);
}
async function loadIncidents() {
  const records=await api('/api/incidents?limit=100');$('incidents').replaceChildren();
  const items=Array.isArray(records)?records:records.items??[];
  if(!items.length){$('incidents').append(node('p','没有持续异常记录。','subtle'));return;}
  for(const incident of items){const entry=node('details');entry.append(node('summary',`${incident.status==='active'?'待检查':'已恢复'} · ${incident.summary}`),node('p',incident.action),node('pre',JSON.stringify(incident.facts,null,2)),node('p',`${date(incident.startedAt)} → ${date(incident.resolvedAt??incident.updatedAt)}`,'subtle'));if(incident.status==='active'&&!incident.acknowledgedAt){const button=node('button','标记已查看');button.addEventListener('click',()=>act(button,()=>api(`/api/incidents/${incident.id}/ack`,{expectedRevision:incident.revision})));entry.append(button);}$('incidents').append(entry);}
}
async function loadManagement(){
  const currentLoad=beginLoad('management'),data=await api('/api/management');if(!currentLoad())return;
  const box=$('management-records');box.replaceChildren();
  const mutate=(button,path,body)=>act(button,async()=>{try{const result=await api(path,body);await loadManagement();return result;}catch(error){if(error.status===409)await loadManagement();throw error;}});
  for(const item of data.threads??[]){const row=node('div',undefined,'timeline'),button=node('button','取消整个讨论的全部订阅');row.append(node('strong',item.thread),node('p',`关联 ${item.subscriptions?.length??0} 项工单；取消后，这个讨论的新消息不再自动交给这些工单。已有工单和记录继续保留。`,'subtle'));button.addEventListener('click',()=>mutate(button,'/api/threads/unsubscribe',{thread:item.thread,expectedRevision:item.revision}));row.append(button);box.append(row);}
  for(const item of data.decisions??[]){const row=node('details'),button=node('button','撤销此判断');row.append(node('summary',item.decisionId),node('pre',JSON.stringify(item.decision,null,2)));button.addEventListener('click',()=>mutate(button,'/api/decisions/dismiss',{decisionId:item.decisionId,expectedRevision:item.revision}));row.append(button);box.append(row);}
  if(!(data.threads?.length||data.decisions?.length))box.append(node('p','没有可管理的订阅或判断。','subtle'));
}
function renderContext() {
  const resource=contextResource;
  $('context-records').replaceChildren(...contextItems.map(item=>{const entry=node('details');entry.append(node('summary',`${item.id}${item.truncated?' · 摘要已截断':''}`),node('pre',item.preview??JSON.stringify(item.value,null,2)));
    entry.append(associationLinks(item.associations,{resource,id:item.id}),lazySection('读取完整原始记录（已脱敏）',box=>loadContextRecord(resource,item.id,box)));
    if(resource==='triggers'){const button=node('button','重新判断此事件');button.addEventListener('click',()=>act(button,()=>api(`/api/triggers/${encodeURIComponent(item.id)}/reevaluate`,{})));entry.append(button);}return entry;}));
  $('context-more').hidden=!contextCursor;
}
async function loadContextRecord(resource,id,box,page={}){
  try{
    const result=await api(`/api/context/${resource}/record?id=${encodeURIComponent(id)}&limit=8000${page.offset!==undefined?`&offset=${page.offset}&version=${encodeURIComponent(page.version)}`:''}`);
    if(!page.offset)box.replaceChildren(node('p',`完整记录共 ${result.length} 字符；保密字段、凭据和本地路径已脱敏。`,'subtle'),associationLinks(result.associations,{resource,id}));
    box.append(node('pre',result.text));
    if(result.nextOffset!==null){const more=node('button','继续读取原始记录');more.addEventListener('click',async()=>{more.disabled=true;await loadContextRecord(resource,id,box,{offset:result.nextOffset,version:result.version});more.remove();});box.append(more);}
  }catch(error){const retry=node('button','重新读取当前记录');retry.addEventListener('click',()=>loadContextRecord(resource,id,box));box.replaceChildren(node('p',error.status===409?'记录已变化；请重新读取，旧页不能与新页拼接。':error.message,'error'),retry);}
}
async function loadContext(more=false) {
  const currentLoad=beginLoad('context'),resource=$('context-resource').value,query=$('context-search').value.trim();
  if(more&&(resource!==contextResource||query!==contextQuery||!contextCursor))return;
  const result=await api(`/api/context/${resource}?limit=20&q=${encodeURIComponent(query)}${more&&contextCursor?`&cursor=${encodeURIComponent(contextCursor)}`:''}`);
  if(!currentLoad()||resource!==$('context-resource').value||query!==$('context-search').value.trim())return;
  contextItems=more?[...contextItems,...result.items]:result.items;contextCursor=result.nextCursor;contextQuery=query;contextResource=resource;renderContext();
}
function repositoryControls(settings){$('repo-enabled').checked=!!settings.enabled;$('repo-observe').checked=!!settings.observe;for(const key of ['pulls','issues','comments','reviewComments','mentions','defaultBranchCI'])$(`repo-${key}`).checked=!!settings.streams?.[key];}
async function loadOperations(){
  const currentLoad=beginLoad('operations'),[scheduler,recovery]=await Promise.all([api('/api/scheduler'),api('/api/recovery')]);if(!currentLoad())return;schedulerRevision=scheduler.revision??scheduler.settings?.revision??0;recoveryRevision=recovery.revision;
  receiveEditor(editor('scheduler',()=>({maxWorkers:Number($('scheduler-max').value),humanReserve:Number($('scheduler-reserve').value)}),value=>{$('scheduler-max').value=value.maxWorkers;$('scheduler-reserve').value=value.humanReserve;},'save-scheduler'),schedulerRevision,{maxWorkers:scheduler.maxWorkers??scheduler.settings?.maxWorkers??1,humanReserve:scheduler.humanReserve??scheduler.settings?.humanReserve??0});
  receiveEditor(editor('recovery',()=>({autoResume:$('recovery-resume').checked,retryBeforeStart:$('recovery-enabled').checked,maxAttempts:Number($('recovery-attempts').value),initialDelayMs:Number($('recovery-delay').value)}),value=>{$('recovery-resume').checked=value.autoResume??false;$('recovery-enabled').checked=value.retryBeforeStart;$('recovery-attempts').value=value.maxAttempts;$('recovery-delay').value=value.initialDelayMs;},'save-recovery'),recoveryRevision,{autoResume:recovery.autoResume??false,retryBeforeStart:recovery.retryBeforeStart,maxAttempts:recovery.maxAttempts,initialDelayMs:recovery.initialDelayMs});
}
let promptPreviewState;
function promptPreviewInput(){const state=editors.get('prompts');if(!state?.loaded)throw new Error('请先读取提示词设置。');const draft=state.read();return {settings:{sections:draft.sections,overrides:draft.overrides,knowledge:JSON.parse(draft.knowledge)},expectedRevision:state.baseRevision};}
function promptPreviewStale(){
  if(!promptPreviewState)return;
  let current;try{current=JSON.stringify(promptPreviewInput());}catch{}
  if(current!==promptPreviewState.input){$('prompt-preview-status').textContent='草稿或比较基准已变化，请重新组装预览。';$('prompt-preview-result').replaceChildren();promptPreviewState=undefined;}
}
function renderPromptPreview(){
  promptPreviewStale();if(!promptPreviewState)return;
  const role=$('prompt-preview-role').value||'worker',baseline=$('prompt-preview-base').value||'saved',result=promptPreviewState.result;
  const draft=result.draft[role].text,before=result[baseline][role].text,box=$('prompt-preview-result');
  box.replaceChildren(node('p',`草稿${draft===before?'与比较基准一致':'与比较基准不同'} · 基准版本 ${result.revision}`,'subtle'));
  const columns=node('div',undefined,'prompt-comparison');
  for(const [title,text] of [[baseline==='saved'?'已保存组装结果':'当前默认组装结果',before],['未保存草稿组装结果',draft]]){const panel=node('div');panel.append(node('h3',title),node('pre',text));columns.append(panel);}box.append(columns);
  if(draft!==before){const oldLines=before.split('\n'),newLines=draft.split('\n');let start=0,end=0;while(start<Math.min(oldLines.length,newLines.length)&&oldLines[start]===newLines[start])start++;while(end<Math.min(oldLines.length,newLines.length)-start&&oldLines.at(-1-end)===newLines.at(-1-end))end++;
    const diff=node('details');diff.append(node('summary','展开差异'),node('pre',[...oldLines.slice(start,oldLines.length-end).map(line=>`− ${line}`),...newLines.slice(start,newLines.length-end).map(line=>`+ ${line}`)].join('\n')));box.append(diff);}
}
async function previewPrompts(){
  const button=$('prompt-preview'),currentLoad=beginLoad('prompt-preview');button.disabled=true;
  try{const input=promptPreviewInput();if(editors.get('prompts').pending)throw new Error('请先处理提示词草稿的版本冲突。');const signature=JSON.stringify(input);$('prompt-preview-status').textContent='正在组装草稿，仅作预览。';
    const result=await api('/api/prompts/preview',input);if(!currentLoad())return;
    if(JSON.stringify(promptPreviewInput())!==signature){$('prompt-preview-status').textContent='请求期间草稿已变化，请重新组装预览。';$('prompt-preview-result').replaceChildren();return;}
    promptPreviewState={input:signature,result};$('prompt-preview-status').textContent='以下为本次草稿的完整组装结果，尚未保存。';renderPromptPreview();
  }catch(error){if(!currentLoad())return;promptPreviewState=undefined;$('prompt-preview-result').replaceChildren();if(error.status===409)try{await loadPrompts();}catch{}$('prompt-preview-status').textContent=error.message;}
  finally{if(currentLoad())button.disabled=!editors.get('prompts')?.loaded;}
}
function promptDraft(settings,diffs){
  for(const section of ['communication','scope','delivery'])$(`prompt-${section}`).value=settings.sections?.[section]??'';
  $('prompt-knowledge').value=JSON.stringify(settings.knowledge??[],null,2);$('prompt-parts').replaceChildren();
  promptState.draft=structuredClone({sections:settings.sections,overrides:settings.overrides??{},knowledge:settings.knowledge??[]});
  for(const diff of diffs){const box=node('details'),input=node('textarea');input.rows=5;input.value=settings.overrides?.[diff.key]?.text??diff.newDefault;box.append(node('summary',`${diff.key}${diff.changed?' · 默认内容已更新':''}`));if(diff.changed)box.append(node('pre',`旧默认：\n${diff.oldDefault}\n\n新默认：\n${diff.newDefault}`));input.addEventListener('input',()=>{promptState.draft.overrides[diff.key]={text:input.value,base:promptState.draft.overrides[diff.key]?.base??diff.newDefault};});box.append(input);const keep=node('button','保留此文本并确认新默认'),reset=node('button','使用新默认');keep.addEventListener('click',()=>{promptState.draft.overrides[diff.key]={text:input.value,base:diff.newDefault};message('已更新草稿，尚未保存。');});reset.addEventListener('click',()=>{delete promptState.draft.overrides[diff.key];input.value=diff.newDefault;message('已选择新默认，尚未保存。');});box.append(keep,reset);$('prompt-parts').append(box);}
}
async function loadPrompts(){
  const currentLoad=beginLoad('prompts'),data=await api('/api/prompts');if(!currentLoad())return;const previousDraft=promptState?.draft;promptState=data;if(previousDraft)promptState.draft=previousDraft;
  $('prompt-revision').textContent=`服务端版本 ${data.settings.revision} · ${date(data.settings.at)}`;
  const state=editor('prompts',()=>({sections:Object.fromEntries(['communication','scope','delivery'].map(key=>[key,$(`prompt-${key}`).value])),overrides:structuredClone(promptState.draft?.overrides??{}),knowledge:$('prompt-knowledge').value}),value=>{promptDraft({sections:value.sections,overrides:value.overrides,knowledge:[]},data.diff);$('prompt-knowledge').value=value.knowledge;},'save-prompts');
  state.rebase=state.write;
  receiveEditor(state,data.settings.revision,{sections:data.settings.sections,overrides:data.settings.overrides??{},knowledge:JSON.stringify(data.settings.knowledge??[],null,2)});
  $('prompt-assembled').replaceChildren(...Object.entries(data.assembled).map(([role,value])=>{const box=node('details');box.append(node('summary',role==='worker'?'服务端 Worker 实际组装文本':'服务端协调者实际组装文本'),node('pre',value.text??value));return box;}));
  $('prompt-history').replaceChildren(...historyRows(data.history,{sections:data.settings.sections,overrides:data.settings.overrides,knowledge:data.settings.knowledge},item=>({sections:item.sections,overrides:item.overrides,knowledge:item.knowledge}),(draft,historical)=>{promptDraft(draft,data.diff);message(`已载入版本 ${historical} 草稿；保存会创建新版本。`);}));
  promptPreviewStale();
}
$('refresh').addEventListener('click', () => refresh().catch(error => message(error.message, true)));
$('load-background')?.addEventListener('click',()=>loadBackground().catch(error=>message(error.message,true)));
$('load-setup')?.addEventListener('click',()=>loadSetup().catch(error=>message(error.message,true)));
$('diagnostic-load')?.addEventListener('click',()=>loadDiagnostics().catch(error=>message(error.message,true)));
$('diagnostic-more')?.addEventListener('click',()=>loadDiagnostics(true).catch(error=>message(error.message,true)));
for(const id of ['diagnostic-kind','diagnostic-source','diagnostic-query','diagnostic-problems'])$(id)?.addEventListener('change',()=>loadDiagnostics().catch(error=>message(error.message,true)));
$('pause').addEventListener('click', () => act($('pause'), () => api(paused ? '/api/resume' : '/api/pause', paused ? {} : { reason: 'Paused from local management panel' })));
$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>loadTickets().catch(error=>message(error.message,true)),200);});
$('more').addEventListener('click', async () => {
  $('more').disabled = true;
  try { await loadTickets(true); }
  catch (error) { message(error.message, true); }
  finally { $('more').disabled = false; }
});
$('load-settings').addEventListener('click', () => loadSettings().catch(error => message(error.message, true)));
$('settings').addEventListener('input',renderAdmission);
$('policy-add').addEventListener('click',()=>{try{const draft=JSON.parse($('settings').value);draft.policy={...draft.policy,sourceRows:[...(draft.policy?.sourceRows??[]),{id:`source-${crypto.randomUUID().slice(0,8)}`,source:'github',scope:{repository:''},actors:[],bots:[],admission:{listedUnaddressed:'ignore',unlistedAddressed:'ignore',unlistedUnaddressed:'ignore'}}]};writeCoordinatorDraft(JSON.stringify(draft,null,2));persistEditor(editors.get('coordinator'));}catch(error){message(error.message,true);}});
$('settings-panel').addEventListener('toggle', () => { if ($('settings-panel').open && revision === undefined) loadSettings().catch(error => message(error.message, true)); });
$('save-settings').addEventListener('click', () => act($('save-settings'), () => saveEditor('coordinator',(draft,expectedRevision)=>api('/api/coordinator',{settings:JSON.parse(draft),expectedRevision}),loadSettings)));
$('load-worker').addEventListener('click', () => loadWorker().catch(error => message(error.message, true)));
$('worker-panel').addEventListener('toggle', () => { if ($('worker-panel').open && workerRevision === undefined) loadWorker().catch(error => message(error.message, true)); });
$('save-worker').addEventListener('click', () => act($('save-worker'), () => saveEditor('worker',(draft,expectedRevision)=>{const settings=JSON.parse(draft.settings);delete settings.prompt;if(draft.prompt.trim())settings.prompt=draft.prompt;return api('/api/executor',{settings,expectedRevision});},loadWorker)));
$('load-repository').addEventListener('click', () => loadRepository().catch(error => message(error.message, true)));
$('repository-panel').addEventListener('toggle', () => { if ($('repository-panel').open && repositoryRevision === undefined) loadRepository().catch(error => message(error.message, true)); });
$('save-repository').addEventListener('click', () => act($('save-repository'), () => saveEditor('repository',(draft,expectedRevision)=>api('/api/repository',{settings:JSON.parse(draft),expectedRevision}),loadRepository)));
$('coord-mode').addEventListener('change',()=>{try{const draft=JSON.parse($('settings').value);draft.policy={...draft.policy,mode:$('coord-mode').value};$('settings').value=JSON.stringify(draft,null,2);}catch(error){message(error.message,true);}});
for(const field of ['worker-driver','worker-model','worker-timeout','worker-managed','worker-agent-tools'])$(field).addEventListener('change',()=>{
  try{
    const draft=JSON.parse($('worker-settings').value);
    if(field==='worker-driver'){
      if(draft.driver!==$('worker-driver').value){for(const key of workerHarnesses.find(item=>item.id===draft.driver)?.preserveOnSave??[])delete draft[key];delete draft.adapterVersion;}
      draft.driver=$('worker-driver').value;
      const caps=workerHarnesses.find(item=>item.id===draft.driver)?.capabilities;
      if(caps?.backgroundTasks!==true||caps?.subagents!==true)delete draft.enableManagedJobs;
      if(caps?.agentTools!==true)delete draft.enableAgentTools;
    }
    if(field==='worker-model'){if($('worker-model').value.trim())draft.model=$('worker-model').value.trim();else delete draft.model;}
    if(field==='worker-timeout')draft.timeoutMs=Number($('worker-timeout').value)*1000;
    if(field==='worker-managed'){
      const caps=workerHarnesses.find(item=>item.id===draft.driver)?.capabilities;
      if(caps?.backgroundTasks!==true||caps?.subagents!==true)throw new Error('此执行端未声明受管理后台任务能力。');
      draft.enableManagedJobs=$('worker-managed').checked;
    }
    if(field==='worker-agent-tools'){
      if(workerHarnesses.find(item=>item.id===draft.driver)?.capabilities?.agentTools!==true)throw new Error('此执行端未声明业务工具能力。');
      draft.enableAgentTools=$('worker-agent-tools').checked;
    }
    $('worker-settings').value=JSON.stringify(draft,null,2);workerCapabilities(draft);
  }catch(error){message(error.message,true);}
});
$('worker-settings').addEventListener('input',()=>{try{const draft=JSON.parse($('worker-settings').value);$('worker-driver').value=draft.driver;workerCapabilities(draft);}catch{}});
$('repository-controls').addEventListener('change',event=>{try{const draft=JSON.parse($('repository-settings').value),id=event.target.id;if(id==='repo-enabled')draft.enabled=event.target.checked;else if(id==='repo-observe')draft.observe=event.target.checked;else{const key=id.slice(5);if(!['pulls','issues','comments','reviewComments','mentions','defaultBranchCI'].includes(key))return;draft.streams={...draft.streams,[key]:event.target.checked};}$('repository-settings').value=JSON.stringify(draft,null,2);}catch(error){message(error.message,true);}});
$('load-incidents').addEventListener('click',()=>loadIncidents().catch(error=>message(error.message,true)));
$('load-management').addEventListener('click',()=>loadManagement().catch(error=>message(error.message,true)));
$('management-panel').addEventListener('toggle',()=>{if($('management-panel').open)loadManagement().catch(error=>message(error.message,true));});
$('context-load').addEventListener('click',()=>loadContext().catch(error=>message(error.message,true)));
$('context-more').addEventListener('click',()=>loadContext(true).catch(error=>message(error.message,true)));
$('context-resource').addEventListener('change',()=>{contextItems=[];contextCursor=null;contextResource=$('context-resource').value;renderContext();loadContext().catch(error=>message(error.message,true));});
$('context-search').addEventListener('input',()=>{clearTimeout(contextSearchTimer);contextSearchTimer=setTimeout(()=>loadContext().catch(error=>message(error.message,true)),200);});
$('context-panel').addEventListener('toggle',()=>{if($('context-panel').open&&!contextItems.length)loadContext().catch(error=>message(error.message,true));});
$('load-operations').addEventListener('click',()=>loadOperations().catch(error=>message(error.message,true)));
$('operations-panel').addEventListener('toggle',()=>{if($('operations-panel').open&&schedulerRevision===undefined)loadOperations().catch(error=>message(error.message,true));});
$('save-scheduler').addEventListener('click',()=>act($('save-scheduler'),()=>saveEditor('scheduler',(settings,expectedRevision)=>api('/api/scheduler',{settings,expectedRevision}),loadOperations)));
$('save-recovery').addEventListener('click',()=>act($('save-recovery'),()=>saveEditor('recovery',(settings,expectedRevision)=>api('/api/recovery',{settings,expectedRevision}),loadOperations)));
const names = value => [...new Set(String(value??'').split(/[,，\s]+/).map(item=>item.trim().toLowerCase()).filter(Boolean))];
function deliveryDraft() {return {mode:$('delivery-mode').value,automatic:$('delivery-auto').checked,review:{ready:$('review-ready').checked,requestReviewers:$('review-request').checked,resolveThreads:$('review-resolve').checked,reviewers:names($('review-users').value),teams:names($('review-teams').value)},uiEvidence:{mode:$('evidence-mode').value,scenario:$('evidence-scenario').value,theme:$('evidence-theme').value,viewport:{width:Number($('evidence-width').value),height:Number($('evidence-height').value)}}};}
function writeDeliveryDraft(value) {$('delivery-mode').value=value.mode;$('delivery-auto').checked=!!value.automatic;$('review-ready').checked=!!value.review?.ready;$('review-request').checked=!!value.review?.requestReviewers;$('review-resolve').checked=!!value.review?.resolveThreads;$('review-users').value=(value.review?.reviewers??[]).join(', ');$('review-teams').value=(value.review?.teams??[]).join(', ');$('evidence-mode').value=value.uiEvidence?.mode??'auto';$('evidence-scenario').value=value.uiEvidence?.scenario??'default';$('evidence-theme').value=value.uiEvidence?.theme??'light';$('evidence-width').value=value.uiEvidence?.viewport?.width??1280;$('evidence-height').value=value.uiEvidence?.viewport?.height??800;}
async function loadDelivery(){
  const currentLoad=beginLoad('delivery'),data=await api('/api/delivery');if(!currentLoad())return;deliveryRevision=data.revision;
  receiveEditor(editor('delivery',deliveryDraft,writeDeliveryDraft,'save-delivery'),data.revision,{mode:data.mode,automatic:data.automatic,review:{ready:false,requestReviewers:false,resolveThreads:false,reviewers:[],teams:[],...data.review},uiEvidence:{mode:data.uiEvidence?.mode??'auto',scenario:data.uiEvidence?.scenario??'default',theme:data.uiEvidence?.theme??'light',viewport:data.uiEvidence?.viewport??{width:1280,height:800}}});
  $('evidence-capture').textContent=data.uiEvidence?.capture?'本机截图步骤已配置；前后截图使用同一组场景、视口和主题。':'本机尚未配置截图步骤。启用的界面修改必须补齐截图证据后才可完成验收。';
  $('delivery-summary').textContent=`版本 ${data.revision} · ${data.repository??'本地项目'} · 验证配置：${data.verify?'已配置':'未配置'} · 允许路径：${data.allowedPaths?.join('、')??'当前工单范围'}`;
}
$('delivery-panel').addEventListener('toggle',()=>{if($('delivery-panel').open&&deliveryRevision===undefined)loadDelivery().catch(error=>message(error.message,true));});
$('load-delivery').addEventListener('click',()=>loadDelivery().catch(error=>message(error.message,true)));
$('save-delivery').addEventListener('click',()=>act($('save-delivery'),()=>saveEditor('delivery',(settings,expectedRevision)=>api('/api/delivery',{settings,expectedRevision}),loadDelivery)));
$('load-prompts').addEventListener('click',()=>loadPrompts().catch(error=>message(error.message,true)));
$('prompt-preview').addEventListener('click',previewPrompts);
for(const id of ['prompt-preview-role','prompt-preview-base'])$(id).addEventListener('change',renderPromptPreview);
$('prompt-sections-panel').addEventListener('toggle',()=>{if($('prompt-sections-panel').open&&!promptState)loadPrompts().catch(error=>message(error.message,true));});
$('save-prompts').addEventListener('click',()=>act($('save-prompts'),()=>saveEditor('prompts',(draft,expectedRevision)=>api('/api/prompts',{settings:{sections:draft.sections,overrides:draft.overrides,knowledge:JSON.parse(draft.knowledge)},expectedRevision}),loadPrompts)));
window.addEventListener('beforeunload',event=>{if([...replyDrafts.values()].some(draft=>draft.text)||[...jobDrafts.values()].some(draft=>draft.text)||[...sessionDrafts.values()].some(draft=>draft.reason)||[...editors.values()].some(editorDirty)){event.preventDefault();event.returnValue='';}});
(async () => {
  const setupToken = new URLSearchParams(location.hash.slice(1)).get('setup');
  if (location.hash) history.replaceState(null, '', location.pathname);
  if (setupToken) { csrf = null; const result = await api('/auth/session', { setupToken }); csrf = result.csrf; try{sessionStorage.setItem('js-superagent-csrf', csrf);}catch{draftNotice('unavailable');} }
  if (!csrf) throw new Error('请使用本机启动命令提供的一次性工作台链接。');
  await refresh();
})().catch(error => { $('connection').textContent = '未连接'; message(error.message, true); });

$('coordination-text').addEventListener('input',()=>{const text=$('coordination-text').value;if(coordinationDraft?.text!==text)coordinationDraft={id:crypto.randomUUID(),text};if(text)draftStore?.save('coordination',coordinationDraft);else draftStore?.remove('coordination');});
async function loadCoordination(){
  const data=await api('/api/coordination');
  $('coordination-records').replaceChildren(...(data.events??[]).slice(-20).reverse().map(event=>{
    const entry=node('details');entry.append(node('summary',`${({pending:'待处理',completed:'已处理',recorded:'已记录',unsupported:'执行端暂不支持',failed:'需要检查'})[event.status]??event.status} · ${date(event.createdAt)}`),node('pre',event.text));
    if(event.result?.summary)entry.append(node('p',event.result.summary));
    for(const receipt of event.receipts??[])if(receipt.result?.operationId)entry.append(node('p',actionMessage(receipt.result)));
    if(event.error)entry.append(node('p',event.error,'error'));
    if(event.attempts)entry.append(node('p',`已尝试 ${event.attempts} 次${event.status==='pending'&&event.nextAt?`；最早继续 ${date(event.nextAt)}`:''}`,'subtle'));
    if(event.readSet?.length)entry.append(node('p',`已补读 ${event.readSet.length} 组相关记录`,'subtle'));
    if(['failed','unsupported'].includes(event.status)){const retry=node('button','修复后重新入队');retry.addEventListener('click',()=>act(retry,async()=>{const result=await api('/api/coordination/retry',{id:event.id});await loadCoordination();return result;}));entry.append(retry);}
    if(event.history?.length){const history=node('details');history.append(node('summary','处理记录'),node('pre',JSON.stringify(event.history,null,2)));entry.append(history);}
    return entry;
  }));
}
$('coordination-load').addEventListener('click',()=>loadCoordination().catch(error=>message(error.message,true)));
$('coordination-send').addEventListener('click',()=>act($('coordination-send'),async()=>{
  const text=$('coordination-text').value.trim();if(!text)throw new Error('请先填写消息。');
  if(coordinationDraft?.text!==text)coordinationDraft={id:crypto.randomUUID(),text};
  draftStore?.save('coordination',coordinationDraft);
  const sent={...coordinationDraft}, result=await api('/api/coordinate',sent);
  if($('coordination-text').value.trim()===sent.text){$('coordination-text').value='';coordinationDraft=null;draftStore?.remove('coordination');}await loadCoordination();return {...result,queued:true};
}));

$('coord-workflow').addEventListener('change',()=>{try{const draft=JSON.parse($('settings').value);draft.workflowMode=$('coord-workflow').value;$('settings').value=JSON.stringify(draft,null,2);}catch(error){message(error.message,true);}});

$('coord-retry').addEventListener('change',()=>{try{const draft=JSON.parse($('settings').value);draft.workRetry={...draft.workRetry,autoRetry:$('coord-retry').checked};$('settings').value=JSON.stringify(draft,null,2);}catch(error){message(error.message,true);}});

// Delegated changes run after field-specific handlers have updated the draft.
for(const event of ['input','change','click']) document.addEventListener(event,()=>{persistEditors();promptPreviewStale();});
