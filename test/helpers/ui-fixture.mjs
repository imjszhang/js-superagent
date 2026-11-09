// A deterministic DOM/HTTP harness, not a real-browser acceptance test.
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';

export function deferred() { let resolve, reject; const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject}; }
class Element {
  constructor(tag) { this.tagName=tag.toUpperCase();this.children=[];this.listeners=new Map();this.value='';this.checked=false;this.disabled=false;this.hidden=false;this.id='';this._text=''; }
  set textContent(value) { this._text=String(value);this.replaceChildren(); }
  get textContent() { return this._text+this.children.map(child=>child.textContent).join(''); }
  append(...children) { for(const child of children){child.parentNode=this;this.children.push(child);} }
  replaceChildren(...children) { for(const child of this.children)child.parentNode=null;this.children=[];this.append(...children); }
  remove() { if(this.parentNode){const p=this.parentNode;p.children=p.children.filter(child=>child!==this);this.parentNode=null;} }
  addEventListener(type, listener) { const list=this.listeners.get(type)??[];list.push(listener);this.listeners.set(type,list); }
  async emit(type,event={}) { const current={type,target:this,...event};await Promise.all((this.listeners.get(type)??[]).map(listener=>listener(current)));if(this.parentNode&&['input','change','click'].includes(type))await this.parentNode.emit(type,current); }
}
export function descendants(root) { return [root,...root.children.flatMap(descendants)]; }
export const ticket = (id, status='waiting') => ({id,status,text:`Task ${id}`,scope:`Only ${id}`,updatedAt:'2026-11-01T00:00:00Z',reports:[],messages:[]});
export const status = () => ({projectId:'fixture-project',runtime:{paused:false,running:false,active:false},ingress:{configured:false},queue:{count:0,oldestDueAgeMs:null},notifications:{pending:0},capabilities:{}});
export async function uiFixture(handler=()=>undefined,{storage=new Map([['js-superagent-csrf','fixture-csrf']])}={}) {
  const root=new Element('body'),window=new Element('window'),requests=[];
  const html=readFileSync(new URL('../../src/ui/index.html',import.meta.url),'utf8');
  for(const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)){const element=new Element(match[1]);element.id=match[2];element.disabled=/\sdisabled(?:\s|=|>)/.test(match[0]);root.append(element);}
  const $=id=>descendants(root).find(element=>element.id===id)??null;
  $('context-resource').value='triggers';
  let route=handler;
  const fetch=async(path,options={})=>{
    const request={path,method:options.method??'GET',body:options.body?JSON.parse(options.body):undefined};requests.push(request);
    let result=await route(request);
    if(result===undefined){
      if(path==='/api/status')result={body:status()};
      else if(path.startsWith('/api/tickets?'))result={body:{items:[ticket('A'),ticket('B')],nextOffset:null}};
      else if(/^\/api\/tickets\/[^/]+\/details$/.test(path))result={body:{ticket:ticket(path.split('/')[3]),stage:'work',managementActions:{}}};
      else result={body:{}};
    }
    return {ok:(result.status??200)<400,status:result.status??200,json:async()=>structuredClone(result.body)};
  };
  const context={document:{createElement:tag=>new Element(tag),getElementById:$,addEventListener:(...args)=>root.addEventListener(...args)},window,fetch,structuredClone,URL,URLSearchParams,setTimeout,clearTimeout,crypto:{randomUUID},
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},location:{hash:'',pathname:'/'},history:{replaceState(){}},console};
  runInNewContext(readFileSync(new URL('../../src/ui/drafts.js',import.meta.url),'utf8')+'\n'+readFileSync(new URL('../../src/ui/app.js',import.meta.url),'utf8')+'\nglobalThis.ui={detail,refresh,act,sendReply,loadPrompts,loadSettings,loadWorker,loadRepository,loadOperations,loadDelivery,loadSession,loadContext,loadTickets,loadContextRecord,loadJobs};',context);
  await new Promise(resolve=>setImmediate(resolve));
  return {root,window,$,ui:context.ui,requests,storage,setHandler:next=>{route=next;},
    buttons:(text,within=root)=>descendants(within).filter(element=>element.tagName==='BUTTON'&&element.textContent===text),
    input:async(id,value)=>{const element=$(id);if(element.disabled)throw new Error('Control is disabled');element.value=value;await element.emit('input');return element;}};
}
