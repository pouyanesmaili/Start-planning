/* Life OS — Vanilla ES6. IndexedDB-first storage with safe local fallback. */
(() => {
'use strict';
// Supabase public project configuration. The publishable key is intended for browser use;
// row-level security on both tables is required and is already configured for auth.uid().
const SUPABASE_URL='https://nzwxlnidemfhvdutyuyu.supabase.co';
const SUPABASE_PUBLISHABLE_KEY='sb_publishable_naBfzGTBDRbcbk2xMMfREQ_IbtRCOFw';
let cloudClient=null, cloudUser=null, cloudBusy=false, cloudSyncTimer=null, cloudSyncingAgain=false, cloudApplyingRemote=false;
const SYNC_QUEUE_KEY='life-cloud-tombstones-v1', SYNC_SNAPSHOT_KEY='life-cloud-snapshot-v1';
const DB_NAME='life-os-db', DB_VERSION=1, STORE='records';
let db=null, records=[], chartRefs={}, currentMonth=new Date(), timer=null, timerSeconds=1500, timerRunning=false, timerIsBreak=false, deferredInstall=null;
const $=id=>document.getElementById(id), localDateKey=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`, today=()=>localDateKey(new Date());
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();deferredInstall=event;const button=document.getElementById('installBtn');if(button)button.hidden=false});
window.addEventListener('appinstalled',()=>{const status=document.getElementById('pwaStatus'),button=document.getElementById('installBtn');if(status)status.textContent=uiText('برنامه با موفقیت نصب شد.');if(button)button.hidden=true});
const configs={
 tasks:{type:'task',title:'title',meta:r=>`${r.date||'بدون تاریخ'} · ${r.start||'—'} تا ${r.end||'—'}${r.start&&r.end?' · '+durationBetween(r.start,r.end):''} · ${priorityLabel(r.priority)}${r.repeat&&r.repeat!=='none'?' · تکرار '+(r.repeat==='daily'?'روزانه':'هفتگی'):''}`},
 events:{type:'event',title:'title',meta:r=>`${r.date} ${r.time||''} · ${r.kind||''}`},
 habits:{type:'habit',title:'title',meta:r=>`${r.frequency} · هدف ${r.target||1} بار`},
 goals:{type:'goal',title:'title',meta:r=>`${r.horizon} · مهلت ${r.deadline||'—'}`},
 notes:{type:'note',title:'title',meta:r=>`${r.category} · ${r.status||''}`},
 finance:{type:'finance',title:'category',meta:r=>`${r.type==='income'?'درآمد':'هزینه'} · ${fmt(r.amount)} · ${r.date||''}`},
 health:{type:'health',title:'label',meta:r=>`${r.kind==='sleep'&&r.sleepStart&&r.wakeTime?r.sleepStart+' تا '+r.wakeTime+' · ':''}${r.value} · ${r.date||today()}`},
 times:{type:'time',title:'activity',meta:r=>`${r.minutes} دقیقه · ${r.date||today()}`}
};
function priorityLabel(p){return ({low:'کم',medium:'متوسط',high:'زیاد',urgent:'فوری'})[p]||'متوسط'}
function durationBetween(start,end){if(!start||!end)return '';let a=Number(start.slice(0,2))*60+Number(start.slice(3)),b=Number(end.slice(0,2))*60+Number(end.slice(3));if(b<=a)b+=1440;const m=b-a;return m>=60?`${Math.floor(m/60)} ساعت${m%60?' و '+(m%60)+' دقیقه':''}`:`${m} دقیقه`}
function fmt(n){const lang=localStorage.getItem('life-lang')||'fa',cur=localStorage.getItem('life-currency')||'تومان';const currency=lang==='en'?({'تومان':'Toman','ریال':'Rial','€':'EUR','$':'USD'}[cur]||cur):cur;return Number(n||0).toLocaleString(lang==='en'?'en-US':'fa-IR')+' '+currency}
function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,8)}
function uiText(value){let text=String(value??'');if((localStorage.getItem('life-lang')||'fa')!=='en'||typeof translations==='undefined')return text;for(const key of Object.keys(translations).sort((a,b)=>b.length-a.length)){if(key.length>=4&&text.includes(key))text=text.split(key).join(translations[key])}return translations[text]||text}
function toast(msg){const el=$('toast');el.textContent=uiText(msg);el.classList.add('show');setTimeout(()=>el.classList.remove('show'),2400)}
function openDB(){return new Promise((resolve,reject)=>{if(!('indexedDB'in window)){resolve(null);return}const req=indexedDB.open(DB_NAME,DB_VERSION);req.onupgradeneeded=()=>{const d=req.result;if(!d.objectStoreNames.contains(STORE))d.createObjectStore(STORE,{keyPath:'id'})};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
async function load(){try{db=await openDB();if(db){records=await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readonly'),q=tx.objectStore(STORE).getAll();q.onsuccess=()=>res(q.result||[]);q.onerror=()=>rej(q.error)});$('storageStatus').textContent='ذخیره‌سازی IndexedDB فعال'}else throw Error('no indexeddb')}catch(e){records=JSON.parse(localStorage.getItem('life-records')||'[]');$('storageStatus').textContent='ذخیره‌سازی محلی فعال'}if(!localStorage.getItem(SYNC_SNAPSHOT_KEY))localStorage.setItem(SYNC_SNAPSHOT_KEY,JSON.stringify(Object.fromEntries(records.map(r=>[String(r.id),r]))))}
function readTombstones(){try{return JSON.parse(localStorage.getItem(SYNC_QUEUE_KEY)||'{}')}catch{return {}}}
function queueCloudSync(){if(cloudApplyingRemote||!cloudUser)return;clearTimeout(cloudSyncTimer);cloudMessage('تغییرات ذخیره شد؛ همگام‌سازی خودکار در صف است.');cloudSyncTimer=setTimeout(()=>cloudSyncNow(),1100)}
async function persist(options={}){
 const payload=JSON.stringify(records);
 if(!options.remote&&!cloudApplyingRemote){let snapshot={};try{snapshot=JSON.parse(localStorage.getItem(SYNC_SNAPSHOT_KEY)||'{}')}catch{}const current=Object.fromEntries(records.map(r=>[String(r.id),r]));const tombstones=readTombstones();const now=new Date().toISOString();for(const [id,r] of Object.entries(current)){const before=snapshot[id];if(!before||JSON.stringify({...before,updatedAt:undefined})!==JSON.stringify({...r,updatedAt:undefined})){if(!r.updatedAt||r.updatedAt===before?.updatedAt)r.updatedAt=now}}for(const id of Object.keys(snapshot)){if(!current[id])tombstones[id]={targetId:id,updatedAt:now}}localStorage.setItem(SYNC_QUEUE_KEY,JSON.stringify(tombstones));localStorage.setItem(SYNC_SNAPSHOT_KEY,JSON.stringify(Object.fromEntries(records.map(r=>[String(r.id),r]))))}
 if(db){try{await new Promise((res,rej)=>{const tx=db.transaction(STORE,'readwrite');tx.objectStore(STORE).clear();records.forEach(r=>tx.objectStore(STORE).put(r));tx.oncomplete=res;tx.onerror=()=>rej(tx.error||new Error('IndexedDB write failed'));tx.onabort=()=>rej(tx.error||new Error('IndexedDB transaction aborted'))})}catch(error){console.warn('IndexedDB unavailable; switching to local storage.',error);db=null}}
 if(!db){try{localStorage.setItem('life-records',payload)}catch(error){throw new Error('فضای ذخیره‌سازی دستگاه کافی نیست. از بخش تنظیمات پشتیبان بگیر و کمی فضا خالی کن.')}}
 if(!options.remote)queueCloudSync();
}
async function add(type,data){const record={id:uid(),type,createdAt:new Date().toISOString(),...data};records.unshift(record);try{await persist()}catch(error){records=records.filter(item=>item.id!==record.id);toast(error.message||'ذخیره اطلاعات انجام نشد');return false}try{renderAll()}catch(error){console.error('Render after save failed:',error)}toast('اطلاعات ذخیره شد');return true}
async function update(id,patch){const r=records.find(x=>x.id===id);if(r){Object.assign(r,patch);await persist();renderAll()}}
async function remove(id){if(!confirm(uiText('این مورد حذف شود؟')))return;const previous=records;records=records.filter(r=>r.id!==id);try{await persist();try{renderAll()}catch(error){console.error('Render after delete failed:',error)}toast('حذف شد')}catch(error){records=previous;toast(error.message||'حذف انجام نشد؛ دوباره تلاش کن.')}}
function list(type){return records.filter(r=>r.type===type)}
function formData(form){return Object.fromEntries(new FormData(form).entries())}
function bindForm(id,type,mapper){const f=$(id);if(!f)return;f.addEventListener('submit',async e=>{e.preventDefault();const raw=formData(f);const data=mapper?mapper(raw):raw;const saved=await add(type,data);if(saved){f.reset();if(f.elements.date)f.elements.date.value=today()}})}
function empty(msg='هنوز موردی ثبت نشده است.'){return `<div class="empty">${msg}</div>`}
function card(r,title,meta,actions=''){return `<article class="data-card"><div class="data-main"><strong>${esc(title||'بدون عنوان')}</strong><small>${esc(meta||'')}</small></div><div class="data-actions">${actions}<button class="delete" data-delete="${r.id}" aria-label="حذف">حذف</button></div></article>`}
function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function renderList(el,type,opts={}){const arr=list(type).filter(opts.filter||(()=>true));$(el).innerHTML=arr.length?arr.map(r=>card(r,opts.title?opts.title(r):r.title||r.label||r.category||r.activity,opts.meta?opts.meta(r):(configs[type]?.meta(r)||''),opts.actions?opts.actions(r):'')).join(''):empty();$(el).querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete))}
function renderTasks(){let a=list('task');const filter=$('taskFilter')?.value||'all';if(filter==='open')a=a.filter(x=>!x.done);if(filter==='done')a=a.filter(x=>x.done);$('taskCount').textContent=`${a.length} مورد`;const el=$('taskList');el.innerHTML=a.length?a.map(r=>card(r,r.title,`${r.date||'بدون تاریخ'} · ${r.start||'—'} تا ${r.end||'—'}${r.start&&r.end?' · '+durationBetween(r.start,r.end):''} · ${priorityLabel(r.priority)}${r.repeat&&r.repeat!=='none'?' · تکرار '+(r.repeat==='daily'?'روزانه':'هفتگی'):''}`,`<button data-done="${r.id}">${r.done?'بازکردن':'انجام شد'}</button><button data-task-edit="${r.id}">ویرایش</button>`).replace('<strong>',`<strong class="${r.done?'done':''}">`)).join(''):empty();el.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete));el.querySelectorAll('[data-done]').forEach(b=>b.onclick=async()=>{const task=records.find(r=>r.id===b.dataset.done);if(!task)return;const wasDone=!!task.done;task.done=!wasDone;if(!wasDone&&task.repeat&&task.repeat!=='none'){const next=new Date((task.date||today())+'T12:00:00');next.setDate(next.getDate()+(task.repeat==='daily'?1:7));records.unshift({...task,id:uid(),date:next.toISOString().slice(0,10),done:false,createdAt:new Date().toISOString()})}await persist();renderAll()});el.querySelectorAll('[data-task-edit]').forEach(b=>b.onclick=async()=>{const task=records.find(r=>r.id===b.dataset.taskEdit);if(!task)return;const title=prompt(uiText('عنوان کار'),task.title);if(title===null)return;if(!title.trim()){toast('عنوان را وارد کن');return}const priority=prompt(uiText('اولویت: کم، متوسط، زیاد یا فوری'),task.priority||'medium');if(priority===null)return;const map={'کم':'low','متوسط':'medium','زیاد':'high','فوری':'urgent','low':'low','medium':'medium','high':'high','urgent':'urgent'};if(!map[priority.trim()]){toast('اولویت معتبر نیست');return}task.title=title.trim();task.priority=map[priority.trim()];await persist();renderAll()})}
function habitCountForPeriod(r){const logs=r.logs||[],freq=r.frequency||'روزانه',target=Math.max(1,Number(r.target)||1);if(freq==='هفتگی'){const d=new Date();const day=(d.getDay()+6)%7;d.setDate(d.getDate()-day);const start=isoDate(d);const end=isoDate(new Date(d.getTime()+6*86400000));return {count:logs.filter(x=>String(x).slice(0,10)>=start&&String(x).slice(0,10)<=end).length,target,label:'این هفته'}}return {count:logs.filter(x=>String(x).slice(0,10)===today()).length,target,label:'امروز'}}
function renderHabits(){const en=(localStorage.getItem('life-lang')||'fa')==='en',L=(fa,eng)=>en?eng:fa,a=list('habit'),el=$('habitList');el.innerHTML=a.length?a.map(r=>{const period=habitCountForPeriod(r),logs=r.logs||[],streak=calcStreak([...new Set(logs.map(x=>String(x).slice(0,10)))]),pct=Math.min(100,Math.round(period.count/period.target*100)),freq=en?(r.frequency==='هفتگی'?'Weekly':'Daily'):r.frequency||'روزانه';return `<article class="data-card"><div class="data-main"><strong>${esc(r.title)}</strong><small>${freq} · ${L('هدف','Target')} ${period.target} ${L('بار','times')} ${period.label==='امروز'?L('در روز','per day'):L('در هفته','per week')} · ${period.count} ${L('از','of')} ${period.target} · 🔥 ${streak} ${L('روز متوالی','day streak')}</small><div class="progress"><span style="width:${pct}%"></span></div></div><div class="data-actions"><button data-habit-add="${r.id}">＋ ${L('ثبت یک نوبت','Log session')}</button><button data-habit-undo="${r.id}">− ${L('اصلاح','Undo')}</button><button data-habit-edit="${r.id}">${L('ویرایش','Edit')}</button><button class="delete" data-delete="${r.id}">${L('حذف','Delete')}</button></div></article>`}).join(''):empty(L('هنوز عادتی نساخته‌ای.','No habits created yet.'));el.querySelectorAll('[data-habit-add]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.habitAdd);if(!r)return;r.logs=r.logs||[];r.logs.push(today()+'T'+new Date().toTimeString().slice(0,8));await persist();renderAll()});el.querySelectorAll('[data-habit-undo]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.habitUndo);if(!r)return;r.logs=r.logs||[];const period=habitCountForPeriod(r);let allowed=r.logs.map((x,i)=>({x,i}));if(period.label==='امروز')allowed=allowed.filter(o=>String(o.x).slice(0,10)===today());else{const d=new Date();d.setDate(d.getDate()-((d.getDay()+6)%7));const ws=isoDate(d),we=isoDate(new Date(d.getTime()+6*86400000));allowed=allowed.filter(o=>String(o.x).slice(0,10)>=ws&&String(o.x).slice(0,10)<=we)}const idx=allowed.pop()?.i;if(idx!==undefined)r.logs.splice(idx,1);await persist();renderAll()});el.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete));el.querySelectorAll('[data-habit-edit]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.habitEdit);if(!r)return;const title=prompt(uiText('عنوان عادت'),r.title);if(title===null||!title.trim())return;const target=prompt(uiText('تعداد دفعات در روز یا هفته'),String(r.target||1));if(target===null)return;const n=Number(target);if(!Number.isInteger(n)||n<1){toast('هدف باید عددی بزرگ‌تر از صفر باشد');return}r.title=title.trim();r.target=n;await persist();renderAll()})}

function calcStreak(logs){let n=0,d=new Date();while(logs.includes(isoDate(d))){n++;d.setDate(d.getDate()-1)}return n}
function renderGoals(){const a=list('goal'),el=$('goalList');el.innerHTML=a.length?a.map(r=>{const total=Number(r.steps||1),done=Number(r.doneSteps||0),pct=Math.round(done/total*100);return `<article class="data-card"><div class="data-main"><strong>${esc(r.title)}</strong><small>${esc(r.horizon)} · ${done}/${total} مرحله · ${pct}% · مهلت ${r.deadline||'—'}</small><div class="progress"><span style="width:${pct}%"></span></div></div><div class="data-actions"><button data-step="${r.id}">＋ مرحله</button><button data-step-back="${r.id}">− مرحله</button><button data-goal-edit="${r.id}">ویرایش</button><button data-delete="${r.id}" class="delete">حذف</button></div></article>`}).join(''):empty();el.querySelectorAll('[data-step]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.step);r.doneSteps=Math.min(Number(r.steps||1),Number(r.doneSteps||0)+1);await persist();renderAll()});el.querySelectorAll('[data-step-back]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.stepBack);if(r){r.doneSteps=Math.max(0,Number(r.doneSteps||0)-1);await persist();renderAll()}});el.querySelectorAll('[data-goal-edit]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.goalEdit);if(!r)return;const title=prompt(uiText('عنوان هدف'),r.title);if(title===null)return;if(!title.trim())return;const deadline=prompt(uiText('مهلت (YYYY-MM-DD)'),r.deadline||'');if(deadline===null)return;r.title=title.trim();r.deadline=deadline.trim();await persist();renderAll()});el.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete));const xp=list('task').filter(x=>x.done).length*10+list('habit').reduce((s,h)=>s+(h.logs||[]).length*5,0)+list('goal').reduce((s,g)=>s+(g.doneSteps||0)*20,0),en=(localStorage.getItem('life-lang')||'fa')==='en';$('xpPanel').innerHTML=`<strong>${xp.toLocaleString(en?'en-US':'fa-IR')} XP</strong> · ${en?'Level':'سطح'} ${Math.floor(xp/100)+1}<div class="progress"><span style="width:${xp%100}%"></span></div><small class="muted">${en?'To next level:':'تا سطح بعدی:'} ${100-xp%100} XP</small>`}
function renderNotes(){const q=($('noteSearch').value||'').toLowerCase();const a=list('note').filter(r=>(r.title+' '+r.body+' '+r.category).toLowerCase().includes(q));$('noteList').innerHTML=a.length?a.map(r=>card(r,r.title,`${r.category||'یادداشت'} · ${(r.body||'').slice(0,110)}${r.favorite?' · ★ محبوب':''}` ,`<button data-favorite="${r.id}">${r.favorite?'★':'☆'}</button><button data-view="${r.id}">بازکردن</button>`)).join(''):empty();$('noteList').querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete));$('noteList').querySelectorAll('[data-view]').forEach(b=>b.onclick=()=>{const r=records.find(x=>x.id===b.dataset.view);alert(`${r.title}\n\n${r.body||''}`)});$('noteList').querySelectorAll('[data-favorite]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.favorite);if(r){r.favorite=!r.favorite;await persist();renderNotes()}})}
function getMainAccount(){
 let account=null;
 try{account=JSON.parse(localStorage.getItem('life-main-account')||'null')}catch(e){}
 if(account&&typeof account==='object')return account;
 // Migrate the previous multi-account setup into one combined account without losing balances.
 let old=[];try{old=JSON.parse(localStorage.getItem('life-accounts')||'[]')}catch(e){}
 let legacy={};try{legacy=JSON.parse(localStorage.getItem('life-account-settings')||'{}')}catch(e){}
 const oldOpening=old.reduce((sum,a)=>sum+Math.max(0,Number(a.opening)||0),0);
 const opening=Math.max(oldOpening,Math.max(0,Number(legacy.openingBalance)||0));
 account={id:'main-account',name:(old[0]?.name||legacy.name||'حساب من'),opening,createdAt:new Date().toISOString()};
 localStorage.setItem('life-main-account',JSON.stringify(account));
 localStorage.setItem('life-accounts',JSON.stringify([account]));
 records.forEach(r=>{if(r.type==='finance')r.accountId='main-account'});
 return account;
}
function accountBalance(){
 const account=getMainAccount();
 const transactions=list('finance');
 const adjustments=list('balanceAdjustment');
 const income=transactions.filter(r=>r.type==='income').reduce((s,r)=>s+Math.max(0,Number(r.amount)||0),0);
 const expenses=transactions.filter(r=>r.type==='expense').reduce((s,r)=>s+Math.max(0,Number(r.amount)||0),0);
 const deposits=adjustments.filter(r=>r.direction==='deposit').reduce((s,r)=>s+Math.max(0,Number(r.amount)||0),0);
 const withdrawals=adjustments.filter(r=>r.direction==='withdraw').reduce((s,r)=>s+Math.max(0,Number(r.amount)||0),0);
 const savings=list('savings').reduce((s,r)=>s+Math.max(0,Number(r.amount)||0),0);
 return {...account,balance:Number(account.opening||0)+income-expenses+deposits-withdrawals-savings,income,expenses,deposits,withdrawals,savings};
}
function renderFinance(){const account=accountBalance(),lang=localStorage.getItem('life-lang')||'fa',label=(fa,en)=>lang==='en'?en:fa;const tx=list('finance'),adj=list('balanceAdjustment'),savings=list('savings'),savedTotal=savings.reduce((s,x)=>s+Number(x.amount||0),0);const income=tx.filter(x=>x.type==='income').reduce((s,x)=>s+Number(x.amount||0),0),legacyOut=tx.filter(x=>x.type==='expense').reduce((s,x)=>s+Number(x.amount||0),0),deposits=adj.filter(x=>x.direction==='deposit').reduce((s,x)=>s+Number(x.amount||0),0),withdrawals=adj.filter(x=>x.direction==='withdraw').reduce((s,x)=>s+Number(x.amount||0),0);$('financeStats').innerHTML=stat(label('موجودی قابل‌خرج','Available balance'),fmt(account.balance),'◈')+stat(label('کل واریزها','Total deposits'),fmt(income+deposits),'↗')+stat(label('کل برداشت‌ها','Total withdrawals'),fmt(legacyOut+withdrawals),'↘')+stat(label('پس‌انداز','Savings'),fmt(savedTotal),'🐷');const summary=$('accountSummary');if(summary)summary.innerHTML=`<div class="account-current"><small>${label('موجودی فعلی حساب','Current account balance')}</small><strong>${fmt(account.balance)}</strong></div><div class="account-breakdown"><div><small>${label('موجودی اولیه','Opening balance')}</small><strong>${fmt(account.opening)}</strong></div><div><small>${label('واریزها','Deposits')}</small><strong>${fmt(income+deposits)}</strong></div><div><small>${label('برداشت‌ها','Withdrawals')}</small><strong>${fmt(legacyOut+withdrawals)}</strong></div><div><small>${label('پس‌انداز','Savings')}</small><strong>${fmt(savedTotal)}</strong></div></div>`;const accountForm=$('accountForm');if(accountForm&&document.activeElement?.form!==accountForm)accountForm.elements.accountName.value=account.name||'';const rows=[...tx.map(r=>({...r,direction:r.type==='income'?'deposit':'withdraw'})),...adj.map(r=>({...r,type:'adjustment'})),...savings.map(r=>({...r,type:'savings',direction:'savings'}))].sort((a,b)=>String(b.date||b.createdAt).localeCompare(String(a.date||a.createdAt)));const el=$('transactionList');el.innerHTML=rows.length?rows.map(r=>`<article class="data-card"><div class="data-main"><strong>${esc(r.category||r.title||'تراکنش')}</strong><small>${r.direction==='deposit'?label('واریز','Deposit'):r.direction==='savings'?label('پس‌انداز','Savings'):label('برداشت','Withdrawal')} · ${fmt(r.amount)} · ${esc(r.date||'')} ${esc(r.memo||'')}</small></div><div class="data-actions"><button class="delete" data-tx-delete="${r.id}">${label('حذف','Delete')}</button></div></article>`).join(''):empty(label('هنوز تراکنشی ثبت نشده است.','No transactions yet.'));el.querySelectorAll('[data-tx-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.txDelete));const savingsSummary=$('savingsSummary');if(savingsSummary)savingsSummary.textContent=label('مجموع پس‌انداز ثبت‌شده: ','Total savings recorded: ')+fmt(savedTotal);const dailyLimit=Number(localStorage.getItem('life-daily-limit')||0),todaySpent=tx.filter(x=>x.type==='expense'&&(x.date||today())===today()).reduce((s,x)=>s+Number(x.amount||0),0);if(dailyLimit&&todaySpent>dailyLimit&&localStorage.getItem('life-limit-warning-'+today())!=='shown'){localStorage.setItem('life-limit-warning-'+today(),'shown');toast(label('از سقف خرج روزانه عبور کردی.','Daily spending limit exceeded.'))}}

function renderHealth(){const a=list('health'),en=(localStorage.getItem('life-lang')||'fa')==='en';renderList('healthList','health',{title:r=>r.label,meta:r=>{if(r.kind==='sleep'){const hours=Number(r.minutes?Number(r.minutes)/60:parseFloat(r.value)||0),status=hours<7?(en?'Too little sleep':'کم‌خوابی'):hours<=9?(en?'Healthy sleep duration':'خواب کافی'):(en?'Too much sleep':'خواب‌بیش‌ازحد');return `${r.sleepStart&&r.wakeTime?r.sleepStart+' – '+r.wakeTime+' · ':''}${hours.toFixed(1)} ${en?'hours':'ساعت'} · ${status} · ${r.date||today()}`}return `${r.value} · ${r.date||today()}`}});const water=a.filter(x=>x.kind==='water'&&(x.date||today())===today()).reduce((s,x)=>s+Number(x.amount),0),target=Number(localStorage.getItem('life-water-target')||2000);$('waterSummary').innerHTML=`<small>${water} / ${target} ml (${Math.min(100,Math.round(water/target*100))}%)</small><div class="progress"><span style="width:${Math.min(100,water/target*100)}%"></span></div>`}

function renderCalendar(){const y=currentMonth.getFullYear(),m=currentMonth.getMonth(),first=new Date(y,m,1),days=new Date(y,m+1,0).getDate(),offset=(first.getDay()+6)%7,lang=localStorage.getItem('life-lang')||'fa';const names=lang==='en'?['Mon','Tue','Wed','Thu','Fri','Sat','Sun']:['د','س','چ','پ','ج','ش','ی'];let html=names.map(x=>`<span class="weekday">${x}</span>`).join('');for(let i=0;i<offset;i++)html+='<span></span>';for(let d=1;d<=days;d++){const date=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;html+=`<span class="${date===today()?'today':''}">${d.toLocaleString(lang==='en'?'en-US':'fa-IR')}</span>`}$('calendarGrid').innerHTML=html;$('monthLabel').textContent=new Intl.DateTimeFormat(lang==='en'?'en-US':'fa-IR',{month:'long',year:'numeric'}).format(first);renderList('eventList','event')}
function stat(label,value,icon){return `<div class="stat-card"><span class="stat-icon">${icon}</span><small>${label}</small><strong>${value}</strong></div>`}
const motivationalQuotes=[
 ['امروز لازم نیست عالی باشی؛ فقط یک قدم جلوتر برو.','You do not have to be perfect today. Just take one step forward.'],
 ['هر موفقیت بزرگی با یک شروع کوچک ساخته می‌شود.','Every great achievement begins with a small start.'],
 ['به خودت فرصت بده؛ رشد کردن زمان می‌برد.','Give yourself time. Growth takes time.'],
 ['کاری که امروز انجام می‌دهی، آینده‌ات را می‌سازد.','What you do today shapes your future.'],
 ['حتی قدم‌های کوچک هم تو را به مقصد می‌رسانند.','Even small steps move you toward your destination.'],
 ['به جای منتظر ماندن برای انگیزه، شروع کن.','Start instead of waiting for motivation.'],
 ['اشتباه کردن بخشی از یادگیری است؛ ادامه بده.','Making mistakes is part of learning. Keep going.'],
 ['تو از چیزی که فکر می‌کنی توانمندتری.','You are more capable than you think.'],
 ['امروز را با یک تصمیم خوب شروع کن.','Start today with one good decision.'],
 ['پیشرفت آرام، بهتر از توقف طولانی است.','Slow progress is better than standing still.'],
 ['برای هدف‌هایت وقت بساز؛ منتظر وقت خالی نمان.','Make time for your goals. Do not wait for free time.'],
 ['هر روز فرصتی تازه برای بهتر شدن است.','Every day is a new chance to improve.'],
 ['روی چیزی تمرکز کن که می‌توانی تغییرش بدهی.','Focus on what you can change.'],
 ['به قولی که به خودت داده‌ای وفادار بمان.','Keep the promises you make to yourself.'],
 ['یک کار کوچک را همین حالا تمام کن.','Finish one small task right now.'],
 ['آینده از همین لحظه‌های ساده ساخته می‌شود.','The future is built from these simple moments.'],
 ['خودت را با دیروزت مقایسه کن، نه با دیگران.','Compare yourself with yesterday, not with others.'],
 ['استراحت کن، دوباره نفس بگیر و ادامه بده.','Rest, take a breath, and keep going.'],
 ['شجاعت یعنی با وجود ترس، قدم اول را برداری.','Courage means taking the first step despite fear.'],
 ['به مسیرت اعتماد کن و پیوسته ادامه بده.','Trust your path and stay consistent.']
];
function renderDailyQuote(){const el=$('dailyQuote');if(!el)return;const lang=localStorage.getItem('life-lang')||'fa';let idx=Math.floor(Math.random()*motivationalQuotes.length),last=-1;try{last=Number(sessionStorage.getItem('life-last-quote')||-1)}catch(e){}if(motivationalQuotes.length>1&&idx===last)idx=(idx+1)%motivationalQuotes.length;try{sessionStorage.setItem('life-last-quote',String(idx))}catch(e){}el.textContent=motivationalQuotes[idx][lang==='en'?1:0];}

function renderDashboard(){renderDailyQuote();const en=(localStorage.getItem('life-lang')||'fa')==='en',L=(fa,eng)=>en?eng:fa,tasks=list('task'),todayTasks=tasks.filter(x=>x.date===today()),habits=list('habit'),xp=tasks.filter(x=>x.done).length*10+habits.reduce((sum,h)=>sum+(h.logs||[]).length*5,0);$('dashboardStats').innerHTML=stat(L('کارهای امروز',"Today's tasks"),`${todayTasks.filter(x=>!x.done).length} ${L('باقی‌مانده','remaining')}`,'▦')+stat(L('عادت‌های فعال','Active habits'),habits.length,'◷')+stat('XP',xp,'✦')+stat(L('یادداشت‌ها','Notes'),list('note').length,'✎');const doneTasks=tasks.filter(x=>x.done).length,habitHits=habits.reduce((n,h)=>n+habitCountForPeriod(h).count,0);$('homePerformance').innerHTML=stat(L('کارهای تکمیل‌شده','Completed tasks'),doneTasks,'✓')+stat(L('نوبت عادت‌ها','Habit sessions'),habitHits,'🔥')+stat(L('جلسات مطالعه','Study sessions'),list('study').length,'📚')+stat(L('تراکنش‌های مالی','Transactions'),list('finance').length+list('balanceAdjustment').length,'◈');$('todayTaskList').innerHTML=todayTasks.length?todayTasks.slice(0,5).map(t=>`<div class="compact-item"><span class="${t.done?'done':''}">${esc(t.title)}</span><span class="badge">${t.start||'—'}</span></div>`).join(''):empty(L('برای امروز کاری ثبت نشده است.','No tasks scheduled for today.'));$('todayHabitList').innerHTML=habits.length?habits.map(h=>{const p=habitCountForPeriod(h);return `<div class="compact-item"><span>${esc(h.title)}</span><span class="badge">${p.count}/${p.target} · ${p.count>=p.target?L('تکمیل','Done'):L('در انتظار','Pending')}</span></div>`}).join(''):empty(L('هنوز عادتی نساخته‌ای.','No habits created yet.'));drawChart('weeklyChart','bar',en?['Mon','Tue','Wed','Thu','Fri','Sat','Sun']:['ش','ی','د','س','چ','پ','ج'],weeklyCounts(),en?'Activity':'فعالیت')}

function weeklyCounts(){const days=[];for(let i=6;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const key=isoDate(d);days.push(records.filter(r=>(r.date||r.createdAt?.slice(0,10))===key).length)}return days}
function drawChart(id,type,labels,data,label){const el=$(id);if(!el||!window.Chart)return;if(chartRefs[id])chartRefs[id].destroy();chartRefs[id]=new Chart(el,{type,data:{labels,datasets:[{label,data,borderWidth:2,borderRadius:5,tension:.35,backgroundColor:'rgba(139,156,251,.45)',borderColor:'#8b9cfb'}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,ticks:{precision:0}}}}})}
function renderReports(){const en=(localStorage.getItem('life-lang')||'fa')==='en',L=(fa,eng)=>en?eng:fa,done=list('task').filter(x=>x.done).length,all=list('task').length,logs=list('habit').reduce((s,h)=>s+(h.logs||[]).length,0),study=list('study').length,activity=list('time').length,tx=list('finance'),adj=list('balanceAdjustment'),inc=tx.filter(x=>x.type==='income').reduce((s,x)=>s+Number(x.amount||0),0)+adj.filter(x=>x.direction==='deposit').reduce((s,x)=>s+Number(x.amount||0),0),out=tx.filter(x=>x.type==='expense').reduce((s,x)=>s+Number(x.amount||0),0)+adj.filter(x=>x.direction==='withdraw').reduce((s,x)=>s+Number(x.amount||0),0),saved=list('savings').reduce((s,x)=>s+Number(x.amount||0),0);$('reportStats').innerHTML=stat(L('کارهای تکمیل‌شده','Completed tasks'),`${done} / ${all}`,'✓')+stat(L('نرخ تکمیل کارها','Task completion rate'),all?Math.round(done/all*100)+'%':'0%','◉')+stat(L('نوبت‌های عادت','Habit sessions'),logs,'🔥')+stat(L('جلسات مطالعه','Study sessions'),study,'📚')+stat(L('زمان‌های ثبت‌شده','Time logs'),activity,'◷')+stat(L('پس‌انداز ثبت‌شده','Savings recorded'),fmt(saved),'🐷');$('reportPeriodLabel').textContent=L('آمار کل داده‌های ثبت‌شده','All recorded data');drawChart('moneyChart','bar',en?['Deposits','Withdrawals']:['واریزها','برداشت‌ها'],[inc,out],en?'Finance':'مالی');drawChart('activityChart','line',en?['Mon','Tue','Wed','Thu','Fri','Sat','Sun']:['د','س','چ','پ','ج','ش','ی'],weeklyCounts(),en?'Activity':'فعالیت');const heat=$('heatmap');heat.innerHTML='';for(let i=29;i>=0;i--){const d=new Date();d.setDate(d.getDate()-i);const key=localDateKey(d),n=records.filter(r=>(r.date||r.createdAt?.slice(0,10))===key).length,cell=document.createElement('span');cell.className='heat-cell '+(n>=8?'l4':n>=5?'l3':n>=2?'l2':n?'l1':'');cell.title=`${key}: ${n} ${L('فعالیت','activities')}`;heat.appendChild(cell)}}

function renderReading(){const a=list('reading');$('readingList').innerHTML=a.length?a.map(r=>{const pct=Math.min(100,Math.round(Number(r.currentPage||0)/Math.max(1,Number(r.pages))*100));return `<article class="data-card"><div class="data-main"><strong>${esc(r.title)}</strong><small>${esc(r.author||'')} · صفحه ${Number(r.currentPage||0)} از ${Number(r.pages)}</small><div class="progress"><span style="width:${pct}%"></span></div><small>${pct}% تکمیل</small></div><div class="data-actions"><button data-read="${r.id}">+۱۰ صفحه</button><button class="delete" data-delete="${r.id}">حذف</button></div></article>`}).join(''):empty('هنوز کتابی ثبت نشده است.');$('readingList').querySelectorAll('[data-read]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.read);if(r){r.currentPage=Math.min(Number(r.pages),Number(r.currentPage||0)+10);await persist();renderReading()}});$('readingList').querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete))}
function renderGratitude(){const a=list('gratitude');$('gratitudeList').innerHTML=a.length?a.slice(0,12).map(r=>card(r,r.title,r.date||today())).join(''):empty('هنوز چیزی ثبت نکرده‌ای.');$('gratitudeList').querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete))}
function renderSavings(){const a=list('saving');$('savingList').innerHTML=a.length?a.map(r=>{const pct=Math.min(100,Math.round(Number(r.saved||0)/Math.max(1,Number(r.target))*100));return `<article class="data-card"><div class="data-main"><strong>${esc(r.title)}</strong><small>${fmt(r.saved)} از ${fmt(r.target)} · ${pct}%</small><div class="progress"><span style="width:${pct}%"></span></div></div><div class="data-actions"><button data-saving="${r.id}">＋ افزودن مبلغ</button><button class="delete" data-delete="${r.id}">حذف</button></div></article>`}).join(''):empty('هدف پس‌اندازی نساخته‌ای.');$('savingList').querySelectorAll('[data-saving]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.saving);if(!r)return;const value=prompt(uiText('چه مبلغی به پس‌انداز اضافه شود؟'));if(value===null)return;const amount=Number(value);if(!Number.isFinite(amount)||amount<=0){toast('مبلغ معتبر وارد کن');return}r.saved=Number(r.saved||0)+amount;await persist();renderSavings()});$('savingList').querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete))}
function renderSubscriptions(){const a=list('subscription');$('subscriptionList').innerHTML=a.length?a.map(r=>card(r,r.title,`${fmt(r.amount)} · ${r.cycle} · پرداخت بعدی: ${r.nextDate||'نامشخص'}`)).join(''):empty('اشتراکی ثبت نشده است.');$('subscriptionList').querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete))}
function renderMoodMeals(){const moods=list('mood');$('moodList').innerHTML=moods.length?moods.slice(0,7).map(r=>card(r,r.mood,`${r.date||today()} · ${r.note||''}`)).join(''):empty('هنوز حال روحی ثبت نشده است.');$('moodList').querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete));const meals=list('meal');$('mealList').innerHTML=meals.length?meals.slice(0,10).map(r=>card(r,r.title,`${r.meal} · ${r.date||today()}`)).join(''):empty('هنوز وعده‌ای ثبت نشده است.');$('mealList').querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete))}
function renderShopping(){const a=list('shopping');const done=a.filter(r=>r.bought).length;$('shoppingSummary').textContent=(localStorage.getItem('life-lang')||'fa')==='en'?`${done} of ${a.length} items purchased`:`${done} از ${a.length} مورد خریداری شده`;$('shoppingList').innerHTML=a.length?a.map(r=>`<article class="data-card ${r.bought?'bought':''}"><div class="data-main"><strong class="${r.bought?'done':''}">${esc(r.title)}</strong><small>${esc(r.category||'')} · ${esc(r.quantity||'')}</small></div><div class="data-actions"><button data-bought="${r.id}">${r.bought?'برگرداندن':'خریداری شد'}</button><button class="delete" data-delete="${r.id}">حذف</button></div></article>`).join(''):empty('لیست خریدت خالی است.');$('shoppingList').querySelectorAll('[data-bought]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.bought);if(r){r.bought=!r.bought;await persist();renderShopping()}});$('shoppingList').querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete))}
function setupEventReminders(){if(!('Notification'in window))return;setInterval(()=>{if(Notification.permission!=='granted')return;const now=Date.now();records.filter(r=>r.type==='event'&&r.remind==='yes'&&!r.notified&&r.date&&r.time).forEach(async r=>{const at=new Date(`${r.date}T${r.time}`).getTime();if(at<=now&&at>now-65000){r.notified=true;await persist();new Notification('یادآوری: '+r.title,{body:r.detail||'زمان رویداد رسیده است.'})}})},30000)}


// Start Planning v8: ten practical modules, stored in the same IndexedDB record store.
function isoDate(d){return localDateKey(d)}
function priorityRank(p){return ({urgent:0,high:1,medium:2,low:3})[p]??2}
function renderSmartPlan(){const el=$('smartPlanList');if(!el)return;const lang=localStorage.getItem('life-lang')||'fa';const tasks=list('task').filter(t=>!t.done&&(!t.date||t.date<=today()));const rank={urgent:4,high:3,medium:2,low:1};const score=t=>{let value=(rank[t.priority]||2)*10;if(t.date===today())value+=12;else if(t.date&&t.date<today())value+=30;if(t.start)value+=Math.max(0,12-parseInt(t.start.slice(0,2),10));return value};tasks.sort((a,b)=>score(b)-score(a)||(a.start||'99:99').localeCompare(b.start||'99:99'));if(!tasks.length){el.innerHTML=empty(lang==='en'?'No open tasks are due today. Add a task or choose a date up to today.':'کار باز و سررسیدشده‌ای نداری. از بخش کارها یک فعالیت اضافه کن.');return}el.innerHTML=tasks.map((t,i)=>{const reason=t.date&&t.date<today()?(lang==='en'?'Overdue':'از موعد گذشته'):t.priority==='urgent'?(lang==='en'?'Urgent priority':'اولویت فوری'):t.priority==='high'?(lang==='en'?'High priority':'اولویت زیاد'):(lang==='en'?'Suggested next step':'پیشنهاد بعدی');return `<article class="data-card"><div class="data-main"><strong>${i+1}. ${esc(t.title)}</strong><small>${esc(reason)} · ${esc(t.start|| (lang==='en'?'No time set':'بدون ساعت'))}</small></div><div class="data-actions"><button data-smart-done="${t.id}">${lang==='en'?'Mark done':'انجام شد'}</button></div></article>`}).join('');el.querySelectorAll('[data-smart-done]').forEach(b=>b.onclick=async()=>{const task=records.find(r=>r.id===b.dataset.smartDone);if(!task)return;task.done=true;await persist();renderAll();toast(lang==='en'?'Task completed.':'کار انجام‌شده ثبت شد.')})}
function renderWeekPlan(){const el=$('weekPlanList');if(!el)return;const start=new Date();start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+7);const rows=[];for(let i=0;i<7;i++){const d=new Date(start);d.setDate(d.getDate()+i);const key=isoDate(d);const tasks=list('task').filter(x=>x.date===key);const events=list('event').filter(x=>x.date===key);rows.push(`<article class="data-card week-day"><div class="data-main"><strong>${d.toLocaleDateString(localStorage.getItem('life-lang')==='en'?'en-US':'fa-IR',{weekday:'long',month:'short',day:'numeric'})}</strong><small>${tasks.length} کار · ${events.length} رویداد</small>${tasks.concat(events).map(x=>`<div class="compact-item"><span>${esc(x.title)}</span><span class="badge">${esc(x.start||x.time||'')}</span></div>`).join('')||'<small class="muted">چیزی ثبت نشده</small>'}</div></article>`)}el.innerHTML=rows.join('')}
function renderReminders(){const el=$('reminderList');if(!el)return;const a=list('reminder').sort((x,y)=>x.when.localeCompare(y.when));el.innerHTML=a.length?a.map(r=>card(r,r.title,`${new Date(r.when).toLocaleString(localStorage.getItem('life-lang')==='en'?'en-US':'fa-IR')} · ${r.done?'انجام شد':r.detail||'یادآور'}`,`<button data-reminder-done="${r.id}">${r.done?'بازکردن':'انجام شد'}</button>`)).join(''):empty('هنوز یادآوری نساخته‌ای.');el.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete));el.querySelectorAll('[data-reminder-done]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.reminderDone);if(r){r.done=!r.done;await persist();renderReminders()}})}
function renderChallenges(){const el=$('challengeList');if(!el)return;const en=(localStorage.getItem('life-lang')||'fa')==='en',L=(fa,eng)=>en?eng:fa,a=list('challenge');el.innerHTML=a.length?a.map(r=>{const duration=Math.max(1,Number(r.duration)||30),days=r.days||[],done=new Set(days).size,pct=Math.min(100,Math.round(done/duration*100)),start=new Date((r.startDate||today())+'T12:00:00');let dayButtons='';for(let i=0;i<duration;i++){const d=new Date(start);d.setDate(d.getDate()+i);const key=isoDate(d),isDone=days.includes(key),available=key<=today();dayButtons+=`<button type="button" class="challenge-day ${isDone?'is-done':''}" data-challenge-day="${r.id}" data-day="${key}" ${(!available||isDone)?'disabled':''} title="${key}">${isDone?'✓':i+1}</button>`}return `<article class="data-card challenge-card"><div class="data-main"><strong>${esc(r.title)}</strong><small>${done} ${L('از','of')} ${duration} ${L('روز ثبت‌شده','days logged')} · ${L('شروع','Start')} ${esc(r.startDate||'')}</small><div class="progress"><span style="width:${pct}%"></span></div><div class="challenge-days">${dayButtons}</div></div><div class="data-actions"><button class="delete" data-delete="${r.id}">${L('حذف','Delete')}</button></div></article>`}).join(''):empty(L('اولین چالش خودت را بساز.','Create your first challenge.'));el.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete));el.querySelectorAll('[data-challenge-day]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.challengeDay);if(!r)return;r.days=r.days||[];const day=b.dataset.day;if(day<=today()&&!r.days.includes(day)){r.days.push(day);await persist();renderChallenges();toast(L('پیشرفت این روز ثبت شد','Progress for this day saved'))}})}

function renderDailyLimit(){const el=$('dailyLimitSummary');if(!el)return;const en=(localStorage.getItem('life-lang')||'fa')==='en',L=(fa,eng)=>en?eng:fa,limit=Number(localStorage.getItem('life-daily-limit')||0),spent=list('finance').filter(x=>x.type==='expense'&&(x.date||today())===today()).reduce((s,x)=>s+Number(x.amount||0),0),pct=limit?Math.min(100,spent/limit*100):0;el.innerHTML=limit?`<p>${L('امروز','Today')} ${fmt(spent)} ${L('از','of')} ${fmt(limit)} ${L('خرج کرده‌ای.','spent.')}</p><div class="progress"><span style="width:${pct}%"></span></div><p class="${spent>limit?'limit-warning':'muted'}">${spent>limit?L('از سقف روزانه عبور کرده‌ای.','You have exceeded your daily limit.'):L('هنوز در محدوده بودجه روزانه هستی.','You are still within your daily limit.')}</p>`:`<p class="muted">${L('هنوز سقف خرجی تعیین نکرده‌ای.','You have not set a spending limit yet.')}</p>`;const input=$('dailyLimitForm')?.elements.amount;if(input&&limit)input.value=limit}
function renderWishlist(){const el=$('wishlistList');if(!el)return;const a=list('wishlist');el.innerHTML=a.length?a.map(r=>card(r,r.title,`${r.price?fmt(r.price):'قیمت مشخص نشده'} · ${r.priority==='important'?'مهم':r.priority==='later'?'برای بعد':'معمولی'} · ${r.bought?'خریداری شده':'در انتظار خرید'}`,`<button data-wish-bought="${r.id}">${r.bought?'برگرداندن':'خریدم'}</button>`)).join(''):empty('لیست آرزوها هنوز خالی است.');el.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete));el.querySelectorAll('[data-wish-bought]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.wishBought);if(r){r.bought=!r.bought;await persist();renderWishlist()}})}
const PERSIAN_MONTHS=['فروردین','اردیبهشت','خرداد','تیر','مرداد','شهریور','مهر','آبان','آذر','دی','بهمن','اسفند'];
function persianDateParts(date){
 const parts=new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn',{year:'numeric',month:'numeric',day:'numeric'}).formatToParts(date);
 const get=t=>Number(parts.find(x=>x.type===t)?.value||0);
 return {year:get('year'),month:get('month'),day:get('day')};
}
function persianMonthRange(year,month){
 const start=new Date(year+621,2,15,12), end=new Date(year+622,3,10,12);
 let first=null,last=null;
 for(let d=new Date(start);d<=end;d.setDate(d.getDate()+1)){
  const parts=persianDateParts(d);
  if(parts.year===year&&parts.month===month){
   if(!first)first=new Date(d);
   last=new Date(d);
  }else if(first)break;
 }
 if(!first||!last)throw new Error('Persian calendar month could not be resolved');
 const iso=d=>localDateKey(d);
 return {start:iso(first),end:iso(last),first,last};
}
function selectedPersianMonth(){
 const year=Number($('monthlyYear')?.value),month=Number($('monthlyMonthSelect')?.value);
 const now=persianDateParts(new Date());
 return {year:year||now.year,month:month||now.month};
}
function setupMonthlyPicker(){
 const yearSelect=$('monthlyYear'),monthSelect=$('monthlyMonthSelect');
 if(!yearSelect||!monthSelect)return;
 const now=persianDateParts(new Date()),years=new Set();
 for(let y=now.year-10;y<=now.year+2;y++)years.add(y);
 for(const r of records){
  const value=String(r.date||r.createdAt||'').slice(0,10);
  if(/^\\d{4}-\\d{2}-\\d{2}$/.test(value)){
   const d=new Date(value+'T12:00:00');
   if(!Number.isNaN(d.getTime()))years.add(persianDateParts(d).year);
  }
 }
 yearSelect.innerHTML=[...years].sort((a,b)=>b-a).map(y=>`<option value="${y}">${y.toLocaleString('fa-IR')}</option>`).join('');
 monthSelect.innerHTML=PERSIAN_MONTHS.map((name,i)=>`<option value="${i+1}">${name}</option>`).join('');
 yearSelect.value=String(now.year);monthSelect.value=String(now.month);
 yearSelect.onchange=renderMonthly;monthSelect.onchange=renderMonthly;
}
function renderMonthly(){
 const el=$('monthlySummary');if(!el)return;
 const {year,month}=selectedPersianMonth(),range=persianMonthRange(year,month);
 const fmtMonth=(date,locale)=>new Intl.DateTimeFormat(locale,{year:'numeric',month:'long'}).format(date);
 const faLabel=`${PERSIAN_MONTHS[month-1]} ${year.toLocaleString('fa-IR')}`;
 const enLabel=`${fmtMonth(range.first,'en-US')} – ${fmtMonth(range.last,'en-US')}`;
 $('monthlyDateLabel').textContent=`${faLabel} · ${enLabel} · ${range.start} تا ${range.end}`;
 const inMonth=r=>{const value=String(r.date||r.createdAt||'').slice(0,10);return value>=range.start&&value<=range.end};
 const tx=list('finance').filter(inMonth);
 const savings=list('savings').filter(inMonth).reduce((s,x)=>s+Number(x.amount||0),0);
 const income=tx.filter(x=>x.type==='income').reduce((s,x)=>s+Number(x.amount||0),0)+list('balanceAdjustment').filter(x=>x.direction==='deposit'&&inMonth(x)).reduce((s,x)=>s+Number(x.amount||0),0);
 const expense=tx.filter(x=>x.type==='expense').reduce((s,x)=>s+Number(x.amount||0),0)+list('balanceAdjustment').filter(x=>x.direction==='withdraw'&&inMonth(x)).reduce((s,x)=>s+Number(x.amount||0),0);
 const done=list('task').filter(x=>x.done&&inMonth(x)).length,created=list('task').filter(inMonth).length;
 const study=list('study').filter(inMonth).reduce((s,x)=>s+Number(x.minutes||0),0);
 const habitLogs=list('habit').reduce((s,h)=>s+(h.logs||[]).filter(x=>{const d=String(x).slice(0,10);return d>=range.start&&d<=range.end}).length,0);
 const activities=list('time').filter(inMonth).reduce((s,x)=>s+Number(x.minutes||0),0);
 const en=(localStorage.getItem('life-lang')||'fa')==='en',L=(fa,eng)=>en?eng:fa;
 el.innerHTML=stat(L('درآمد و واریز','Income and deposits'),fmt(income),'↗')+
 stat(L('هزینه و برداشت','Expenses and withdrawals'),fmt(expense),'↘')+
 stat(L('کارهای انجام‌شده','Completed tasks'),done,'✓')+
 stat(L('نرخ تکمیل کارها','Task completion rate'),created?Math.round(done/created*100)+'%':'0%','◉')+
 stat(L('ثبت عادت‌ها','Habit entries'),habitLogs,'🔥')+
 stat(L('زمان مطالعه','Study time'),`${study} ${L('دقیقه','min')}`,'📚')+
 stat(L('زمان فعالیت','Activity time'),`${activities} ${L('دقیقه','min')}`,'◷')+
 stat(L('پس‌انداز','Savings'),fmt(savings),'🐷');
 const balance=income-expense-savings;
 $('monthlyDetails').innerHTML=`<div class="empty">${L('مانده پس از هزینه و پس‌انداز:','Balance after expenses and savings:')} <strong>${fmt(balance)}</strong><br><small>${range.start} – ${range.end} · ${range.first.toLocaleDateString('fa-IR-u-ca-persian')} – ${range.last.toLocaleDateString('fa-IR-u-ca-persian')}</small></div>`;
}

function renderSkills(){const el=$('skillList');if(!el)return;const a=list('skill');el.innerHTML=a.length?a.map(r=>{const mins=Number(r.minutes||0),target=Number(r.targetHours||1)*60,pct=Math.min(100,Math.round(mins/target*100));return `<article class="data-card"><div class="data-main"><strong>${esc(r.title)}</strong><small>${(mins/60).toFixed(1)} از ${r.targetHours} ساعت · ${pct}%</small><div class="progress"><span style="width:${pct}%"></span></div></div><div class="data-actions"><button data-skill-add="${r.id}">＋ ۳۰ دقیقه تمرین</button><button class="delete" data-delete="${r.id}">حذف</button></div></article>`}).join(''):empty('یک مهارت برای یادگیری انتخاب کن.');el.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete));el.querySelectorAll('[data-skill-add]').forEach(b=>b.onclick=async()=>{const r=records.find(x=>x.id===b.dataset.skillAdd);if(r){r.minutes=Number(r.minutes||0)+30;await persist();renderSkills();toast('۳۰ دقیقه تمرین ثبت شد')}})}
async function hashPin(pin){if(!window.crypto?.subtle)throw new Error('برای ساخت قفل، برنامه را در HTTPS یا localhost باز کن.');const bytes=new TextEncoder().encode(pin);const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('')}
function showLock(){const layer=$('lockScreen');if(layer){layer.hidden=false;document.body.classList.add('is-locked');layer.querySelector('input[name="pin"]').focus()}}
function hideLock(){const layer=$('lockScreen');if(layer){layer.hidden=true;document.body.classList.remove('is-locked');$('unlockError').textContent='';$('unlockForm').reset()}}
function setupAppLock(){const pinForm=$('pinForm');if(!pinForm)return;const stored=localStorage.getItem('life-pin-hash');$('pinStatus').textContent=stored?'قفل فعال است.':'هنوز رمزی تنظیم نشده است.';pinForm.onsubmit=async e=>{e.preventDefault();const pin=pinForm.elements.pin.value;if(!/^\d{4,8}$/.test(pin)){toast('رمز باید ۴ تا ۸ رقم باشد.');return}try{localStorage.setItem('life-pin-hash',await hashPin(pin));$('pinStatus').textContent='رمز ذخیره شد. دفعه بعد هنگام بازشدن برنامه قفل نمایش داده می‌شود.';pinForm.reset();toast('رمز برنامه تنظیم شد')}catch(err){toast(err.message)}};$('lockNow').onclick=()=>{if(!localStorage.getItem('life-pin-hash')){toast('اول یک رمز بساز.');return}showLock()};$('disablePin').onclick=()=>{if(confirm(uiText('قفل برنامه برداشته شود؟'))){localStorage.removeItem('life-pin-hash');$('pinStatus').textContent='قفل غیرفعال شد.';toast('قفل برداشته شد')}};$('unlockForm').onsubmit=async e=>{e.preventDefault();try{const hash=await hashPin(e.currentTarget.elements.pin.value);if(hash===localStorage.getItem('life-pin-hash')){hideLock();window.dispatchEvent(new Event('app-unlocked'));}else $('unlockError').textContent=uiText('رمز درست نیست. دوباره تلاش کن.')}catch(err){$('unlockError').textContent=err.message}};if(stored)showLock()}
function bindNewModules(){
 bindForm('reminderForm','reminder',r=>({...r,done:false,notified:false}));
 bindForm('challengeForm','challenge',r=>({...r,duration:Number(r.duration)||3,startDate:r.startDate||today(),days:[]}));
 bindForm('studyForm','study',r=>({...r,minutes:Number(r.minutes),date:today()}));
 bindForm('wishlistForm','wishlist',r=>({...r,price:Number(r.price)||0,bought:false}));
 bindForm('skillForm','skill',r=>({...r,targetHours:Number(r.targetHours),minutes:0}));
 $('dailyLimitForm').onsubmit=e=>{e.preventDefault();localStorage.setItem('life-daily-limit',String(Number(e.currentTarget.elements.amount.value)));renderDailyLimit();toast('سقف خرج روزانه ذخیره شد')};
 const weekRefresh=$('refreshWeek');if(weekRefresh)weekRefresh.onclick=renderWeekPlan;setupMonthlyPicker();renderMonthly();
 $('enableNotifications').onclick=async()=>{if(!('Notification'in window)){toast('این مرورگر از اعلان پشتیبانی نمی‌کند.');return}const result=await Notification.requestPermission();toast(result==='granted'?'اعلان‌ها فعال شدند.':'اجازه اعلان داده نشد.')};
 if('Notification'in window){setInterval(async()=>{if(Notification.permission!=='granted')return;const now=Date.now();for(const r of list('reminder')){if(!r.done&&!r.notified&&new Date(r.when).getTime()<=now){r.notified=true;await persist();new Notification('Start Planning',{body:r.title});renderReminders()}}},20000)}
 setupAppLock();
}

function renderAll(){renderDashboard();renderTasks();renderHabits();renderGoals();renderNotes();renderFinance();renderHealth();renderCalendar();renderReports();renderTimes();renderReading();renderGratitude();renderMoodMeals();renderShopping();renderSmartPlan();renderWeekPlan();renderReminders();renderChallenges();renderStudy();renderDailyLimit();renderWishlist();renderMonthly();renderSkills()}
function renderStudy(){
 const listEl=$('studyList'),summary=$('studySummary');
 if(!listEl||!summary)return;
 const en=(localStorage.getItem('life-lang')||'fa')==='en',L=(fa,eng)=>en?eng:fa;
 const sessions=list('study').slice().sort((a,b)=>String(b.date||b.createdAt||'').localeCompare(String(a.date||a.createdAt||'')));
 const total=sessions.reduce((sum,r)=>sum+Math.max(0,Number(r.minutes)||0),0);
 const upcoming=sessions.filter(r=>r.examDate&&r.examDate>=today()).sort((a,b)=>a.examDate.localeCompare(b.examDate));
 summary.innerHTML=stat(L('جلسات ثبت‌شده','Sessions logged'),sessions.length,'📚')+
  stat(L('مجموع زمان مطالعه','Total study time'),`${Math.floor(total/60)} ${L('ساعت','hr')} ${total%60} ${L('دقیقه','min')}`,'◷')+
  stat(L('امتحان‌های پیش‌رو','Upcoming exams'),upcoming.length,'▣');
 listEl.innerHTML=sessions.length?sessions.map(r=>{
  const exam=r.examDate?` · ${L('امتحان','Exam')}: ${esc(r.examDate)}`:'';
  const note=r.note?` · ${esc(r.note)}`:'';
  return `<article class="data-card"><div class="data-main"><strong>${esc(r.subject||L('جلسه مطالعه','Study session'))}</strong><small>${esc(r.date||'')} · ${Number(r.minutes)||0} ${L('دقیقه','min')}${exam}${note}</small></div><div class="data-actions"><button class="delete" data-delete="${esc(r.id)}">${L('حذف','Delete')}</button></div></article>`;
 }).join(''):empty(L('هنوز جلسه‌ای ثبت نکرده‌ای.','No study sessions logged yet.'));
 listEl.querySelectorAll('[data-delete]').forEach(b=>b.onclick=()=>remove(b.dataset.delete));
} 
function renderTimes(){renderList('timeList','time')}
let currentPage='dashboard';
function showPage(page){
 const target=document.getElementById(`page-${page}`);
 if(!target)return;
 currentPage=page;
 document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p===target));
 document.querySelectorAll('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
 refreshGroupedNavigation();
 const titles={
  fa:{dashboard:'داشبورد',planner:'کارها',calendar:'تقویم',habits:'عادت‌ها',goals:'اهداف',notes:'یادداشت‌ها',finance:'مدیریت مالی',health:'سلامت',focus:'تمرکز',reports:'گزارش‌ها',settings:'تنظیمات',shopping:'لیست خرید',more:'همه بخش‌ها',weekplan:'برنامه هفتگی',reminders:'یادآورها',challenges:'چالش‌ها',study:'مطالعه',spending:'سقف خرج روزانه',wishlist:'لیست آرزوها',monthly:'گزارش ماهانه',skills:'مهارت‌ها',applock:'قفل برنامه'},
  en:{dashboard:'Dashboard',planner:'Tasks',calendar:'Calendar',habits:'Habits',goals:'Goals',notes:'Notes',finance:'Finance',health:'Health',focus:'Focus',reports:'Reports',settings:'Settings',shopping:'Shopping list',more:'All sections',weekplan:'Weekly plan',reminders:'Reminders',challenges:'Challenges',study:'Study',spending:'Daily spending limit',wishlist:'Wishlist',monthly:'Monthly report',skills:'Skills',applock:'App lock'}
 };
 const lang=localStorage.getItem('life-lang')||'fa';
 $('pageTitle').textContent=titles[lang][page]||titles.fa[page]||'شروع برنامه‌ریزی';
 $('sidebar')?.classList.remove('open');
 if(page==='reports')renderReports();
 if(lang==='en')translatePage('en');
 window.scrollTo({top:0,behavior:'smooth'});
}
const navGroups={
 home:{fa:'خانه',en:'Home',items:[['dashboard','داشبورد','Dashboard']]},
 plan:{fa:'برنامه‌ریزی',en:'Plan',items:[['planner','کارها','Tasks'],['calendar','تقویم و رویدادها','Calendar & events'],['weekplan','برنامه هفتگی','Weekly plan'],['reminders','یادآورها','Reminders'],['study','درس و امتحان','Study & exams']]},
 life:{fa:'زندگی',en:'Life',items:[['habits','عادت‌ها','Habits'],['goals','اهداف','Goals'],['challenges','چالش‌ها','Challenges'],['skills','مهارت‌ها','Skills'],['health','سلامت','Health'],['focus','تمرکز و زمان','Focus & time']]},
 notes:{fa:'یادداشت‌ها',en:'Notes',items:[['notes','یادداشت‌ها و کتابخانه','Notes & library']]},
 money:{fa:'مالی',en:'Money',items:[['finance','درآمد و هزینه','Income & expenses'],['spending','سقف خرج','Spending limit'],['shopping','لیست خرید','Shopping list'],['wishlist','لیست آرزوها','Wishlist'],['monthly','گزارش ماهانه','Monthly review'],['reports','گزارش‌ها','Reports']]},
 settings:{fa:'تنظیمات',en:'Settings',items:[['settings','تنظیمات','Settings'],['applock','قفل برنامه','App lock']]}
};
function pageGroup(page){return Object.keys(navGroups).find(k=>navGroups[k].items.some(item=>item[0]===page))||'home'}
function closeNavGroup(){const panel=$('navGroupPanel');if(panel){panel.hidden=true;panel.innerHTML=''}document.querySelectorAll('.bottom-nav-item').forEach(b=>b.classList.remove('group-open'))}
function openNavGroup(group){const panel=$('navGroupPanel');const data=navGroups[group];if(!panel||!data)return;if(!panel.hidden&&panel.dataset.group===group){closeNavGroup();return}const lang=localStorage.getItem('life-lang')||'fa';panel.dataset.group=group;panel.innerHTML=data.items.map(([page,fa,en])=>`<button type="button" class="nav-subitem ${currentPage===page?'active':''}" data-subpage="${page}">${lang==='fa'?fa:en}</button>`).join('');panel.hidden=false;document.querySelectorAll('.bottom-nav-item').forEach(b=>b.classList.toggle('group-open',b.dataset.group===group));panel.querySelectorAll('[data-subpage]').forEach(b=>b.addEventListener('click',()=>{showPage(b.dataset.subpage);closeNavGroup()}))}
function setupGroupedNavigation(){document.querySelectorAll('.bottom-nav-item[data-group]').forEach(b=>b.addEventListener('click',()=>{const group=b.dataset.group;if(group==='home'){showPage('dashboard');closeNavGroup()}else openNavGroup(group)}));document.addEventListener('click',e=>{if(!e.target.closest('#bottomNav')&&!e.target.closest('#navGroupPanel'))closeNavGroup()});document.addEventListener('keydown',e=>{if(e.key==='Escape')closeNavGroup()});refreshGroupedNavigation()}
function refreshGroupedNavigation(){const group=pageGroup(currentPage);document.querySelectorAll('.bottom-nav-item[data-group]').forEach(b=>b.classList.toggle('active',b.dataset.group===group));const panel=$('navGroupPanel');if(panel&&!panel.hidden){const lang=localStorage.getItem('life-lang')||'fa',data=navGroups[panel.dataset.group];if(data)panel.innerHTML=data.items.map(([page,fa,en])=>`<button type="button" class="nav-subitem ${currentPage===page?'active':''}" data-subpage="${page}">${lang==='fa'?fa:en}</button>`).join('');panel.querySelectorAll('[data-subpage]').forEach(b=>b.addEventListener('click',()=>{showPage(b.dataset.subpage);closeNavGroup()}))}}

function setupCalendar(){ $('prevMonth').onclick=()=>{currentMonth.setMonth(currentMonth.getMonth()-1);renderCalendar()};$('nextMonth').onclick=()=>{currentMonth.setMonth(currentMonth.getMonth()+1);renderCalendar()}}
function setupTimer(){const display=$('timerDisplay');function paint(){display.textContent=`${String(Math.floor(timerSeconds/60)).padStart(2,'0')}:${String(timerSeconds%60).padStart(2,'0')}`}function stop(){clearInterval(timer);timer=null;timerRunning=false}$('timerStart').onclick=()=>{if(timerRunning)return;timerRunning=true;timer=setInterval(()=>{timerSeconds--;paint();if(timerSeconds<=0){stop();timerIsBreak=!timerIsBreak;timerSeconds=(Number($(timerIsBreak?'breakMinutes':'focusMinutes').value)||5)*60;$('timerMode').textContent=timerIsBreak?'زمان استراحت':'زمان تمرکز';toast(timerIsBreak?'جلسه تمرکز تمام شد؛ استراحت کن.':'استراحت تمام شد؛ آماده تمرکز شو.');if(!timerIsBreak)add('time',{activity:'جلسه پومودورو',minutes:Number($('focusMinutes').value)||25,date:today()});paint()}},1000)};$('timerPause').onclick=stop;$('timerReset').onclick=()=>{stop();timerIsBreak=false;timerSeconds=(Number($('focusMinutes').value)||25)*60;paint();$('timerMode').textContent='زمان تمرکز'};$('focusMinutes').onchange=$('timerReset').onclick;paint()}
function setupSearch(){
 const input=$('globalSearch');if(!input)return;
 const pageFor={task:'planner',event:'calendar',habit:'habits',goal:'goals',note:'notes',finance:'finance',health:'health',time:'focus',reading:'notes',study:'study',reminder:'reminders',challenge:'challenges',shopping:'shopping',wishlist:'wishlist',skill:'skills',gratitude:'notes',mood:'health',meal:'health'};
 const close=()=>document.getElementById('searchResults')?.remove();
 input.addEventListener('input',e=>{
  const q=e.target.value.trim().toLocaleLowerCase();close();if(!q)return;
  const hits=records.filter(r=>JSON.stringify(r).toLocaleLowerCase().includes(q)).slice(0,15);
  const en=(localStorage.getItem('life-lang')||'fa')==='en',L=(fa,eng)=>en?eng:fa;
  const box=document.createElement('div');box.id='searchResults';box.className='panel search-results';
  box.innerHTML=`<div class="panel-head"><strong>${L('نتایج جست‌وجو','Search results')} (${hits.length})</strong><button type="button" class="text-btn" id="closeSearch">${L('بستن','Close')}</button></div>`+
   (hits.length?hits.map((r,i)=>`<button type="button" class="search-result" data-result-index="${i}"><strong>${esc(r.title||r.subject||r.label||r.category||r.activity||L('مورد','Item'))}</strong><small>${esc(r.type||'')} · ${esc(r.date||r.createdAt?.slice(0,10)||'')}</small></button>`).join(''):`<div class="empty">${L('نتیجه‌ای پیدا نشد','No results found')}</div>`);
  box._hits=hits;document.body.appendChild(box);
  $('closeSearch').onclick=close;
  box.querySelectorAll('[data-result-index]').forEach(btn=>btn.addEventListener('click',()=>{const record=hits[Number(btn.dataset.resultIndex)];close();const page=pageFor[record?.type];if(page)showPage(page);else toast(L('بخش این مورد پیدا نشد.','The section for this item was not found.'))}));
 });
 input.addEventListener('keydown',e=>{if(e.key==='Escape')close()});
 document.addEventListener('click',e=>{if(!e.target.closest('#searchResults')&&!e.target.closest('#globalSearch'))close()});
}
function setupSettings(){const theme=localStorage.getItem('life-theme')||'dark',lang=localStorage.getItem('life-lang')||'fa',accent=localStorage.getItem('life-accent')||'violet';document.body.classList.toggle('light',theme==='light');setAccent(accent);$('themeSelect').value=theme;$('accentSelect').value=accent;$('languageSelect').value=lang;$('currencySelect').value=localStorage.getItem('life-currency')||'تومان';$('waterTarget').value=localStorage.getItem('life-water-target')||2000;$('themeToggle').onclick=()=>{const t=document.body.classList.contains('light')?'dark':'light';setTheme(t);$('themeSelect').value=t};$('langToggle').onclick=()=>setLanguage(localStorage.getItem('life-lang')==='fa'?'en':'fa');$('languageSelect').onchange=()=>setLanguage($('languageSelect').value);$('saveSettings').onclick=()=>{setTheme($('themeSelect').value);setAccent($('accentSelect').value);setLanguage($('languageSelect').value);localStorage.setItem('life-currency',$('currencySelect').value);localStorage.setItem('life-water-target',$('waterTarget').value);renderAll();toast('تنظیمات ذخیره شد')}}
function setTheme(t){document.body.classList.toggle('light',t==='light');localStorage.setItem('life-theme',t)}
function setAccent(a){const allowed=['violet','blue','green','rose','amber','coral','teal'];const value=allowed.includes(a)?a:'violet';document.body.dataset.accent=value;localStorage.setItem('life-accent',value)}
const translations={
'داشبورد':'Dashboard','برنامه‌ریزی':'Planner','تقویم و رویدادها':'Calendar & events','عادت‌ها':'Habits','اهداف و پروژه‌ها':'Goals & projects','یادداشت‌ها و کتابخانه':'Notes & library','مدیریت مالی':'Finance','سلامتی':'Health','تمرکز و زمان':'Focus & time','گزارش‌ها':'Reports','گزارش':'Reports','تنظیمات و پشتیبان':'Settings & backup','لیست خرید':'Shopping list','فضای مدیریت شخصی':'PERSONAL WORKSPACE','نمای کلی امروز':"TODAY'S OVERVIEW",'کارهای امروز':"Today's tasks",'پیشرفت عادت‌ها':'Habit progress','فعالیت هفتگی':'Weekly activity','دسترسی سریع':'Quick access','مشاهده همه':'View all','مدیریت عادت‌ها':'Manage habits','امروز را هدفمند بساز.':'Make today count.','ذخیره‌سازی فعال':'Storage is active','جست‌وجو در همه اطلاعات...':'Search all your data...','جست‌وجوی سراسری':'Search all data','تغییر تم':'Toggle theme','منو':'Menu','کارها':'Tasks','تقویم':'Calendar','مالی':'Finance','خرید':'Shopping','یادداشت‌ها':'Notes','تمرکز':'Focus','اهداف':'Goals','تنظیمات':'Settings','کار جدید':'New task','یادداشت':'Note','هزینه':'Expense','ثبت آب':'Log water','برنامه‌ریزی و مدیریت وظایف':'Plan and manage tasks','کارهای روزانه‌ات را ثبت کن، زمان بده و بعد از انجام، تیک بزن.':'Add tasks, set a time, and check them off when done.','افزودن فعالیت':'Add an activity','عنوان کار':'Task title','اولویت متوسط':'Medium priority','کم':'Low','زیاد':'High','فوری':'Urgent','نام پروژه (اختیاری)':'Project name (optional)','بدون تکرار':'No repeat','تکرار روزانه':'Repeat daily','تکرار هفتگی':'Repeat weekly','افزودن کار':'Add task','همه کارها':'All tasks','انجام‌نشده':'To do','انجام‌شده':'Completed','تقویم و رویدادها':'Calendar & events','قرارها و مناسبت‌ها را ثبت کن تا زمانشان را فراموش نکنی.':'Add appointments and events so you do not forget them.','عنوان رویداد':'Event title','توضیحات':'Details','یادآوری با اعلان':'Notify me','ثبت رویداد':'Add event','نمای تقویم':'Calendar view','رویدادهای ثبت‌شده':'Saved events','ردیاب عادت‌ها':'Habit tracker','عادت دلخواهت را اضافه کن و هر روز که انجامش دادی ثبت کن.':'Add a habit and mark it each day you complete it.','مثلاً مطالعه ۲۰ دقیقه':'e.g. Read for 20 minutes','روزانه':'Daily','هفتگی':'Weekly','هدف در روز/هفته':'Daily/weekly target','ساخت عادت':'Create habit','اهداف و پروژه‌ها':'Goals & projects','هدفت را بنویس، مرحله‌ها را مشخص کن و قدم‌به‌قدم جلو برو.':'Write a goal, break it into steps, and make progress.','عنوان هدف':'Goal title','تعداد مراحل':'Number of steps','کوتاه‌مدت':'Short-term','بلندمدت':'Long-term','ایجاد هدف':'Create goal','سطح و امتیاز تجربه':'Level and experience points','یادداشت‌ها و کتابخانه':'Notes & library','هر چیزی را که می‌خواهی نگه داری اینجا بنویس؛ از ایده تا خاطره و کتاب.':'Save anything here: ideas, memories, and books.','عنوان':'Title','متن یا توضیحات...':'Text or details...','نویسنده (برای کتاب)':'Author (for a book)','در حال مطالعه':'Reading','خوانده‌شده':'Finished','برای بعد':'Read later','ذخیره':'Save','پیگیری مطالعه کتاب':'Reading progress','مالی':'Finance','سلامتی':'Health','تمرکز':'Focus','گزارش‌ها':'Reports','گزارش':'Reports','تنظیمات':'Settings','ظاهر و زبان':'Appearance and language','تم برنامه':'App theme','تاریک':'Dark','روشن':'Light','رنگ اصلی':'Accent color','بنفش شاد':'Bright purple','آبی آسمانی':'Sky blue','سبز نعنایی':'Mint green','صورتی':'Pink','نارنجی':'Orange','مرجانی':'Coral','فیروزه‌ای':'Teal','زبان':'Language','فارسی':'Persian','واحد پول':'Currency','هدف روزانه آب (ml)':'Daily water goal (ml)','ذخیره تنظیمات':'Save settings','پشتیبان‌گیری و بازیابی':'Backup and restore','از تمام داده‌ها یک فایل JSON تهیه کن یا نسخه پشتیبان را بازیابی کن.':'Download all your data as a JSON file or restore a backup.','دریافت پشتیبان JSON':'Download JSON backup','بازیابی JSON':'Restore JSON','پاک‌کردن همه اطلاعات':'Delete all data','نصب و وضعیت برنامه':'Install and app status','بررسی وضعیت نصب...':'Checking installation status...','نصب اپلیکیشن':'Install app','همه بخش‌ها':'All sections','برای ورود، فقط یک‌بار روی کارت موردنظر بزن.':'Tap a card once to open that section.','برنامه‌ریزی':'Planner','کارها و پروژه‌ها':'Tasks and projects','رویدادها و زمان‌بندی':'Events and schedule','پیگیری روزانه':'Daily tracking','مراحل و پیشرفت':'Milestones and progress','خاطرات و کتاب‌ها':'Memories and books','درآمد و هزینه':'Income and expenses','آب، خواب و ورزش':'Water, sleep and exercise','پومودورو و زمان':'Pomodoro and time','آمار و نمودارها':'Stats and charts','شخصی‌سازی ظاهر و پشتیبان‌گیری':'Customize the look and back up your data','تکرار خودکار کارها':'Repeat tasks automatically','یادآوری رویدادها با اعلان':'Event notifications','نشان‌کردن یادداشت‌های مهم':'Pin important notes','پیشرفت مطالعه کتاب':'Book reading progress','دفتر قدردانی روزانه':'Daily gratitude journal','اهداف پس‌انداز':'Savings goals','مدیریت اشتراک‌ها':'Manage subscriptions','ثبت حال روحی':'Mood tracker','ثبت وعده‌های غذایی':'Meal log','لیست خرید':'Shopping list','جلسه تمرکز تمام شد؛ استراحت کن.':'Focus session complete. Take a break.','استراحت تمام شد؛ آماده تمرکز شو.':'Break is over. Ready to focus?','نتیجه‌ای پیدا نشد':'No results found','نتایج جست‌وجو':'Search results','بستن':'Close','تنظیمات ذخیره شد':'Settings saved','فایل پشتیبان آماده شد.':'Backup file is ready.','بازیابی با موفقیت انجام شد.':'Backup restored successfully.','فایل پشتیبان معتبر نیست':'Invalid backup file','اطلاعات پاک شد':'All data was deleted','موارد خریداری‌شده پاک شدند':'Purchased items were cleared','فرم مربوطه را تکمیل کن':'Complete the form in this section','مورد':'Item','امروز':'Today','ثبت شد':'Saved','حذف':'Delete','ویرایش':'Edit','انجام شد':'Done','لغو':'Cancel','مقدار':'Amount','تاریخ':'Date','ساعت':'Time','نوع':'Type','توضیحات':'Description','جست‌وجو':'Search','افزودن':'Add','ثبت':'Save','ماه':'Month','روز':'Day','هفته':'Week','درآمد':'Income','هزینه':'Expense','موجودی':'Balance','بودجه':'Budget','هدف':'Goal','پیشرفت':'Progress','خواب':'Sleep','آب':'Water','ورزش':'Workout','وزن':'Weight','حال روحی':'Mood','وعده غذایی':'Meal','خرید':'Shopping','مورد جدید':'New item','نام کتاب':'Book title','صفحه فعلی':'Current page','تعداد صفحات':'Total pages','تعداد کل صفحات':'Total pages','میلی‌لیتر':'milliliters','نام اشتراک':'Subscription name','مبلغ':'Amount','هر ماه':'Monthly','هر سال':'Yearly','فعال':'Active','غیرفعال':'Inactive','نصب روی گوشی یا کامپیوتر':'Install on your phone or computer','اندروید و کامپیوتر: از منوی مرورگر گزینه Install app یا نصب برنامه را انتخاب کن.':'Android and desktop: open the browser menu and choose Install app.','آیفون و آیپد: در Safari دکمه Share را بزن و Add to Home Screen را انتخاب کن.':'iPhone and iPad: in Safari, tap Share, then choose Add to Home Screen.',
'شخصی':'Personal','کاری':'Work','مناسبت':'Occasion','یادآوری':'Reminder','نمایش روزها بر اساس تقویم میلادی؛ تاریخ شمسی نیز در فهرست رویدادها درج می‌شود.':'Calendar dates are shown in Gregorian format; Persian dates are also listed with events.','ثبت کتاب':'Add book','دفتر قدردانی روزانه':'Daily gratitude journal','ثبت حس خوب':'Add a gratitude note','درآمد، هزینه، بودجه و روند پس‌انداز.':'Track income, expenses, budgets, and savings.','ثبت تراکنش':'Add transaction','ذخیره بودجه':'Save budget','هدف پس‌انداز':'Savings goal','اشتراک‌ها و پرداخت‌های دوره‌ای':'Subscriptions and recurring payments','ثبت اشتراک':'Add subscription','سلامتی و سبک زندگی':'Health and lifestyle','آب، خواب، ورزش و روند تغییر وزن را ثبت کن.':'Track water, sleep, exercise, and weight changes.','آب مصرفی':'Water intake','ثبت تمرین':'Log workout','ثبت حال روحی':'Track mood','عالی':'Great','خوب':'Good','معمولی':'Okay','خسته':'Tired','پراسترس':'Stressed','ثبت حال امروز':'Save today’s mood','ثبت وعده غذایی':'Log a meal','صبحانه':'Breakfast','ناهار':'Lunch','شام':'Dinner','میان‌وعده':'Snack','ثبت وعده':'Save meal','سوابق سلامتی':'Health history','تمرکز و مدیریت زمان':'Focus and time management','جلسه تمرکز اجرا کن و زمان صرف‌شده برای فعالیت‌ها را ثبت کن.':'Start a focus session and track time spent on activities.','تمرکز':'Focus','استراحت':'Break','شروع':'Start','مکث':'Pause','بازنشانی':'Reset','زمان تمرکز':'Focus duration','ثبت زمان فعالیت':'Log activity time','ثبت زمان':'Log time','گزارش‌ها و تحلیل عملکرد':'Reports and insights','تصویر کلی از فعالیت‌ها، امور مالی و تداوم عادت‌ها.':'See an overview of activity, finances, and habit consistency.','درآمد و هزینه':'Income and expenses','فعالیت‌ها در هفته':'Weekly activity','نقشه فعالیت (۳۰ روز اخیر)':'Activity map (last 30 days)','موارد موردنیاز را اضافه کن و پس از خرید علامت بزن.':'Add what you need and check it off after buying.','خوراکی':'Groceries','خانه':'Home','دیجیتال':'Digital','سایر':'Other','افزودن به لیست':'Add to list','پاک‌کردن خریدهای انجام‌شده':'Clear purchased items','تنظیمات و پشتیبان‌گیری':'Settings and backup','شخصی‌سازی ظاهر، زبان و مدیریت داده‌های شخصی.':'Customize the appearance, language, and your personal data.','ذخیره‌سازی فعال':'Storage is active','ذخیره تنظیمات':'Save settings','داده‌ها روی همین دستگاه ذخیره می‌شوند.':'Your data is stored on this device.','یادداشت':'Note','خاطره':'Memory','ایده':'Idea','کتاب':'Book','نویسنده':'Author','توضیحات':'Details','عنوان رویداد':'Event title','تاریخ':'Date','ساعت':'Time','مثلاً مطالعه ۲۰ دقیقه':'e.g. Read for 20 minutes','هدف در روز/هفته':'Daily/weekly goal','هدف روزانه آب (ml)':'Daily water goal (ml)','پشتیبانی از PWA فعال است. برای نصب، از منوی مرورگر استفاده کن.':'PWA is supported. Use your browser menu to install.','مرورگر از Service Worker پشتیبانی نمی‌کند.':'This browser does not support service workers.','ثبت سرویس‌ورکر ناموفق بود؛ برنامه در حالت وب قابل استفاده است.':'Service worker registration failed. The web app is still available.','برنامه روی دستگاه نصب شده است.':'The app is installed on this device.','برای نصب در آیفون: Safari → Share → Add to Home Screen':'To install on iPhone: Safari → Share → Add to Home Screen','برای نصب از منوی مرورگر گزینه Install app را انتخاب کن.':'Choose Install app from your browser menu.','برنامه با موفقیت نصب شد.':'The app was installed successfully.',
"ابزارهای مدیریت پول":"Money management tools",
"از کجا رسید؟ مثلاً پول توجیبی":"Where did it come from? e.g. allowance",
"انتخاب ماه":"Choose month",
"باز کردن برنامه":"Open app",
"بخش‌های بیشتر":"More sections",
"برای ورود به هر قسمت، کارت آن را انتخاب کن.":"Choose a card to open a section.",
"برای ورود یک رمز ساده بگذار":"Set a simple passcode to enter",
"برای چه چیزی؟":"What was it for?",
"برای چیزی که می‌خواهی بخری، کم‌کم پول کنار بگذار.":"Save a little at a time for something you want to buy.",
"برداشتن رمز":"Remove passcode",
"به‌روزرسانی":"Update",
"بیشتر":"More",
"توضیح کوتاه (اختیاری)":"Short note (optional)",
"تومان":"Toman",
"ثبت وزن":"Log weight",
"ثبت پرداخت تکراری":"Add recurring payment",
"حریم خصوصی":"Privacy",
"درس و امتحان":"Study & exams",
"دلار ($)":"US Dollar ($)",
"دلیل یا توضیح کوتاه":"Reason or short note",
"ردیاب مهارت‌ها":"Skills tracker",
"رمز ورود":"Passcode",
"رمز ۴ تا ۸ رقمی":"4–8 digit passcode",
"ریال":"Rial",
"زمان تمرین مهارت‌ها را ثبت کن":"Track the time you spend practicing skills",
"سالانه":"Yearly",
"قفل برنامه":"App lock",
"قفل‌کردن همین حالا":"Lock now",
"قیمت تقریبی (اختیاری)":"Estimated price (optional)",
"لیست آرزوها":"Wishlist",
"ماهانه":"Monthly",
"مثلاً تماس با دوست":"e.g. Call a friend",
"مثلاً روزی ۱۵ دقیقه مطالعه":"e.g. Read 15 minutes a day",
"مدت (دقیقه)":"Duration (minutes)",
"مدیریت آگاهانه زمان، انرژی و زندگی":"Manage your time, energy, and life",
"مدیریت پول":"Money management",
"مشخص کن این ماه حداکثر چقدر می‌خواهی خرج کنی.":"Set the maximum amount you want to spend this month.",
"مهارتی را که می‌خواهی یاد بگیری اضافه کن و زمان تمرینت را ثبت کن.":"Add a skill you want to learn and track your practice time.",
"مهم":"Important",
"نام درس یا موضوع":"Subject or topic",
"نام سرویس یا پرداخت":"Service or payment name",
"نام غذا یا وعده":"Meal or food name",
"نام کالا":"Item name",
"ناوبری اصلی":"Main navigation",
"نوع تمرین":"Practice type",
"هر پولی که می‌گیری یا خرج می‌کنی، در جای خودش ثبت کن.":"Record money you receive or spend in the right section.",
"هفت روز آینده":"Next 7 days",
"وزن (کیلوگرم)":"Weight (kg)",
"پرداخت‌های تکراری":"Recurring payments",
"پولی که به دستت می‌رسد؛ مثل پول توجیبی یا حقوق.":"Money you receive, such as allowance or pay.",
"چالش ۳۰ روزه":"30-day challenge",
"چقدر جمع کرده‌ای؟":"How much have you saved?",
"چقدر خرج کردی؟":"How much did you spend?",
"چند دقیقه مطالعه کردی؟":"How many minutes did you study?",
"چه چیزی خواندی؟ (اختیاری)":"What did you read? (optional)",
"چه چیزی می‌خواهی؟":"What do you want?",
"چیزهایی را که دوست داری بخری ثبت کن و بعد از تهیه، علامت بزن.":"List things you want to buy and check them off when purchased.",
"چیزهایی که باید بخری":"Things to buy",
"یادآورها":"Reminders",
"یادگیری مهارت":"Skill learning",
"یک رمز ۴ تا ۸ رقمی بگذار تا هنگام بازشدن برنامه، صفحه قفل نمایش داده شود. این قفل ساده است و جای رمزگذاری فایل‌ها یا امنیت بانکی را نمی‌گیرد.":"Set a 4–8 digit passcode to show a lock screen when the app opens. This is a simple screen lock, not file encryption or banking-level security.",
"یک عادت را یک ماه تمرین کن":"Practice one habit for a month",
"یک کار کوچک انتخاب کن و هر روز انجامش دادی علامت بزن. لازم نیست کامل باشی؛ فقط ادامه بده.":"Choose one small action and check it off each day. You do not need to be perfect; just keep going.",
"۳. خوراک و خوردوخوراک":"3. Food and groceries",
"۴. پس‌انداز برای هدفم":"4. Savings goal",
"＋ ثبت جلسه مطالعه":"+ Log study session",
"اجازه اعلان داده نشد":"Notification permission was not granted.",
"از":"From",
"اشتراکی ثبت نشده است":"No recurring payments yet.",
"اول از همه":"First things first",
"اول یک رمز بساز.":"Create a passcode first.",
"اولین چالش ۳۰ روزه‌ات را بساز.":"Create your first 30-day challenge.",
"این مرورگر از اعلان پشتیبانی نمی‌کند.":"This browser does not support notifications.",
"برای ساخت قفل، برنامه را در HTTPS یا localhost باز کن.":"Open the app over HTTPS or localhost to set a lock.",
"برای نصب در آیفون: صفحه را در Safari باز کن، Share و سپس Add to Home Screen را بزن.":"To install on iPhone: open this page in Safari, tap Share, then Add to Home Screen.",
"برای نصب، پروژه را روی یک آدرس HTTPS منتشر کن. اجرای فایل با file:// برای نصب کافی نیست.":"Publish the project at an HTTPS address to install it. Opening a file:// URL is not enough.",
"برای ورود، رمزت را وارد کن.":"Enter your passcode to continue.",
"تکرار":"Repeat",
"تکمیل":"Complete",
"ثبت سرویس‌ورکر ناموفق بود. آدرس و دسترسی فایل sw.js را بررسی کن.":"Service worker registration failed. Check the sw.js URL and access.",
"جلسه پومودورو":"Pomodoro session",
"جلسه‌های مطالعه":"Study sessions",
"حذف شد":"Deleted",
"در انتظار":"Pending",
"در صف":"Queued",
"رمز باید ۴ تا ۸ رقم باشد.":"Passcode must contain 4 to 8 digits.",
"رمز برنامه تنظیم شد":"App passcode saved",
"رمز درست نیست. دوباره تلاش کن.":"Incorrect passcode. Try again.",
"روز متوالی":"day streak",
"رویداد":"Event",
"زمان رویداد رسیده است.":"Your event is due.",
"زمان مطالعه":"Study time",
"ساخت یادآور":"Create reminder",
"صفحه":"Page",
"فا":"FA",
"قفل برداشته شد":"App lock removed",
"قفل برنامه برداشته شود؟":"Remove the app lock?",
"قفل نمایشی":"Screen lock",
"قیمت مشخص نشده":"No price set",
"لیست آرزوها هنوز خالی است.":"Your wishlist is empty.",
"مانده این ماه:":"Remaining this month:",
"مانده پول":"Remaining balance",
"مرحله":"Step",
"مصرف آب":"Water intake",
"مهلت":"Deadline",
"نامشخص":"Not specified",
"نرخ تکمیل":"Completion rate",
"دقیقه":"minutes",
"پرداخت بعدی:":"Next payment:",
"مانده این ماه":"Remaining this month",
"جلسات زمان":"Time sessions",
"هنوز جلسه‌ای ثبت نکرده‌ای.":"No sessions recorded yet.",
"هنوز رمزی تنظیم نشده است.":"No passcode has been set.",
"هنوز سقف خرجی تعیین نکرده‌ای.":"You have not set a spending limit yet.",
"هنوز عادتی نساخته‌ای.":"You have not created a habit yet.",
"هنوز وعده‌ای ثبت نشده است.":"No meals logged yet.",
"هنوز چیزی ثبت نکرده‌ای.":"You have not added anything yet.",
"وظایف تکمیل‌شده":"Completed tasks",
"پرداخت بعدی":"Next payment",
"یک مهارت برای یادگیری انتخاب کن.":"Choose a skill to learn.",
"＋ ۳۰ دقیقه تمرین":"+ 30 minutes practice",
"باقی‌مانده":"Remaining",
"برگرداندن":"Restore",
"بعدی":"Next",
"درصد تکمیل":"Completion",
"میانگین":"Average",
"بازکردن":"Open",
"یادآور":"Reminder",
"جلسه تمرکز":"Focus session",
"ثبت جلسه":"Log session",
"ثبت شد":"Saved",
"فعال":"Active",
"غیرفعال":"Inactive",
"نام کتاب":"Book title",
"صفحه فعلی":"Current page",
"تعداد صفحات":"Total pages",
"مبلغ دریافتی":"Amount received",
"هزینه خوراکی":"Food cost",
"هزینه‌های دیگر":"Other expenses",
"هزینه خوراک":"Food expenses",
"درآمد کل":"Total income",
"برای امروز کاری ثبت نشده است.":"No tasks added for today.",
"هنوز موردی ثبت نشده است.":"Nothing added yet.",
"خریدهای آینده را نگه دار":"Save things you want to buy later",
"برای خرج امروز حد تعیین کن":"Set a spending limit for today",
"کنترل خرج و برنامه خرید":"Track spending and plan purchases"
,
"آرزوها":"Wishlist",
"برنامه هوشمند":"Smart plan",
"سقف خرج":"Spending limit",
"سلامت":"Health",
"قفل":"Lock",
"مطالعه":"Study",
"مهارت‌ها":"Skills",
"چالش‌ها":"Challenges",
"یورو (€)":"Euro (€)",
"⚖ وزن":"⚖ Weight",
"🙂 خوب":"🙂 Good",
"مبلغ دریافتی":"Amount received",
"ثبت جلسه مطالعه":"Log study session",
"مانده این ماه:":"Remaining this month:",
"XP کسب‌شده":"XP earned",
"تا سطح بعدی:":"To next level:",
"درصد تکمیل":"Completion percentage",
"جلسه تمرکز تمام شد؛ استراحت کن.":"Focus session complete; take a break.",
"استراحت تمام شد؛ آماده تمرکز شو.":"Break is over; ready to focus?",
"اولین چالش ۳۰ روزه‌ات را بساز.":"Create your first 30-day challenge.",
"رمز درست نیست. دوباره تلاش کن.":"Incorrect passcode. Try again.",
"قفل برداشته شد":"Lock removed",
"قفل برنامه برداشته شود؟":"Remove the app lock?",
"مانده پول":"Remaining balance",
"تکمیل‌شده":"Completed",
"مورد خریداری‌شده پاک شدند":"Purchased items were cleared",
"موارد خریداری‌شده پاک شدند":"Purchased items were cleared",
"نصب و وضعیت برنامه":"Install and app status",
"بررسی وضعیت نصب...":"Checking installation status...",
"نصب روی گوشی یا کامپیوتر":"Install on your phone or computer",
"اندروید و کامپیوتر: از منوی مرورگر گزینه Install app یا نصب برنامه را انتخاب کن.":"Android and desktop: open the browser menu and choose Install app.",
"آیفون و آیپد: در Safari دکمه Share را بزن و Add to Home Screen را انتخاب کن.":"iPhone and iPad: in Safari, tap Share, then choose Add to Home Screen.",
"نسخه 1.2.0 · اطلاعات روی همین دستگاه ذخیره می‌شوند.":"Version 1.2.0 · Your data is stored on this device.",
"مدیریت آگاهانه زمان، انرژی و زندگی":"Manage your time, energy, and life.",
"ذخیره‌سازی IndexedDB فعال":"IndexedDB storage is active",
"ذخیره‌سازی محلی فعال":"Local storage is active",
"برنامه روی دستگاه نصب شده است.":"The app is installed on this device.",
"برای نصب در آیفون: صفحه را در Safari باز کن، Share و سپس Add to Home Screen را بزن.":"On iPhone: open this page in Safari, tap Share, then Add to Home Screen.",
"صفحه از آدرس امن اجرا شده است. از منوی Chrome گزینه Install app را انتخاب کن.":"This page is running securely. Choose Install app from the Chrome menu.",
"برنامه با موفقیت نصب شد.":"The app was installed successfully.",
"این مورد حذف شود؟":"Delete this item?",
"اطلاعات ذخیره شد":"Information saved",
"حذف شد":"Deleted",
"هیچ نتیجه‌ای پیدا نشد":"No results found",
"نتیجه‌ای پیدا نشد":"No results found",
"نامشخص":"Not specified",
"قیمت مشخص نشده":"No price set",
"اشتراکی ثبت نشده است":"No recurring payments yet.",
"هنوز موردی ثبت نشده است.":"Nothing added yet.",
"هنوز چیزی ثبت نکرده‌ای.":"You have not added anything yet.",
"هنوز جلسه‌ای ثبت نکرده‌ای.":"You have not logged a session yet.",
"هنوز وعده‌ای ثبت نشده است.":"No meals logged yet.",
"هنوز سقف خرجی تعیین نکرده‌ای.":"You have not set a spending limit yet.",
"هنوز رمزی تنظیم نشده است.":"No passcode has been set.",
"هنوز عادتی نساخته‌ای.":"You have not created a habit yet.",
"چیزی ثبت نشده":"Nothing recorded",
"از":"From",
"پرداخت بعدی:":"Next payment:",
"برای ساخت قفل، برنامه را در HTTPS یا localhost باز کن.":"Open the app over HTTPS or localhost to set a lock.",
"رمز ۴ تا ۸ رقمی":"4–8 digit passcode",
"رمز باید ۴ تا ۸ رقم باشد.":"Passcode must contain 4 to 8 digits.",
"قفل نمایشی":"Screen lock",
"تومان":"Toman",
"ریال":"Rial",
"دلار ($)":"US Dollar ($)"
,
"تمام اطلاعات این برنامه برای همیشه حذف شود؟ ابتدا از اطلاعات پشتیبان بگیر.":"Permanently delete all app data? Back up your data first.",
"★ محبوب":"★ Favorite",
"امتحان:":"Exam:",
"هدف":"Goal",
"متوسط":"Medium"
};
Object.assign(translations,{"Life OS | مدیریت زندگی": "Life OS | Life management", "ذخیره‌سازی فعال": "Storage active", "کارها": "Tasks", "خرید": "Shopping", "یادداشت‌ها": "Notes", "＋ کار جدید": "＋ New task", "✎ یادداشت": "✎ Note", "－ هزینه": "－ Expense", "💧 ثبت آب": "💧 Log water", "افزودن فعالیت": "Add task", "شخصی": "Personal", "کاری": "Work", "مناسبت": "Occasion", "یادآوری": "Reminder", "نمایش روزها بر اساس تقویم میلادی؛ تاریخ شمسی نیز در فهرست رویدادها درج می‌شود.": "Calendar days use the Gregorian calendar; Persian dates are also shown in the event list.", "ثبت کتاب": "Add book", "ثبت حس خوب": "Add gratitude entry", "درآمد، هزینه، بودجه و روند پس‌انداز.": "Track income, expenses, budgets, and savings.", "ثبت تراکنش": "Add transaction", "ذخیره بودجه": "Save budget", "ایجاد هدف": "Create goal", "ماهانه": "Monthly", "سالانه": "Yearly", "ثبت اشتراک": "Add subscription", "سلامتی و سبک زندگی": "Health and lifestyle", "آب، خواب، ورزش و روند تغییر وزن را ثبت کن.": "Track water, sleep, exercise, and weight changes.", "ثبت تمرین": "Log workout", "ثبت وزن": "Log weight", "ثبت حال امروز": "Log today's mood", "عالی": "Great", "خوب": "Good", "معمولی": "Okay", "خسته": "Tired", "پراسترس": "Stressed", "ثبت وعده غذایی": "Meal tracker", "صبحانه": "Breakfast", "ناهار": "Lunch", "شام": "Dinner", "میان‌وعده": "Snack", "ثبت وعده": "Save meal", "سوابق سلامتی": "Health history", "استراحت": "Break", "شروع": "Start", "مکث": "Pause", "بازنشانی": "Reset", "زمان تمرکز": "Focus time", "ثبت زمان فعالیت": "Log activity time", "ثبت زمان": "Log time", "گزارش‌ها و تحلیل عملکرد": "Reports and insights", "تصویر کلی از فعالیت‌ها، امور مالی و تداوم عادت‌ها.": "An overview of activity, finances, and habit consistency.", "درآمد و هزینه": "Income and expenses", "فعالیت‌ها در هفته": "Weekly activity", "نقشه فعالیت (۳۰ روز اخیر)": "Activity map (last 30 days)", "موارد موردنیاز را اضافه کن و پس از خرید علامت بزن.": "Add items and check them off after shopping.", "خوراکی": "Groceries", "خانه": "Home", "دیجیتال": "Digital", "سایر": "Other", "＋ افزودن به لیست": "＋ Add to list", "پاک‌کردن خریدهای انجام‌شده": "Clear purchased items", "تنظیمات و پشتیبان‌گیری": "Settings and backup", "شخصی‌سازی ظاهر، زبان و مدیریت داده‌های شخصی.": "Customize appearance, language, and personal data.", "هدف روزانه آب (ml)": "Daily water goal (ml)", "ذخیره تنظیمات": "Save settings", "از تمام داده‌ها یک فایل JSON تهیه کن یا نسخه پشتیبان را بازیابی کن.": "Export all your data to a JSON file or restore a backup.", "↓ دریافت پشتیبان JSON": "↓ Download JSON backup", "↑ بازیابی JSON": "↑ Restore JSON", "پاک‌کردن همه اطلاعات": "Delete all data", "نصب و وضعیت برنامه": "App installation and status", "بررسی وضعیت نصب...": "Checking installation status...", "نصب اپلیکیشن": "Install app", "نسخه 1.1.0 · اطلاعات روی همین دستگاه ذخیره می‌شوند.": "Version 1.1.0 · Your data is stored on this device.", "نصب روی گوشی یا کامپیوتر": "Install on a phone or computer", "اندروید و کامپیوتر: از منوی مرورگر گزینه Install app یا نصب برنامه را انتخاب کن.": "Android and desktop: choose Install app from your browser menu.", "آیفون و آیپد: در Safari دکمه Share را بزن و Add to Home Screen را انتخاب کن.": "iPhone and iPad: in Safari, tap Share, then Add to Home Screen.", "مدیریت آگاهانه زمان، انرژی و زندگی": "Manage time, energy, and life intentionally", "ثبت حال روحی": "Mood tracker", "دفتر قدردانی روزانه": "Daily gratitude journal", "هدف پس‌انداز": "Savings goal", "اشتراک‌ها و پرداخت‌های دوره‌ای": "Subscriptions and recurring payments", "یادآوری با اعلان": "Send a notification reminder", "＋ ثبت رویداد": "＋ Add event", "＋ ساخت عادت": "＋ Create habit", "＋ افزودن کار": "＋ Add task", "＋ ایجاد هدف": "＋ Create goal", "＋ ذخیره": "＋ Save", "آب مصرفی": "Water intake", "خواب": "Sleep", "ورزش": "Exercise", "وزن": "Weight", "هدف در روز/هفته": "Daily/weekly target", "تعداد مراحل": "Number of steps", "عنوان هدف": "Goal title", "عنوان رویداد": "Event title", "توضیحات": "Details", "عنوان کار": "Task title", "عنوان": "Title", "متن یا توضیحات...": "Text or details...", "نویسنده (برای کتاب)": "Author (for a book)", "واحد پول": "Currency", "برای امروز کاری ثبت نشده است.": "No tasks added for today.", "هنوز عادتی نساخته‌ای.": "You haven't created any habits yet.", "برای امروز کاری ثبت نشده است": "No tasks added for today", "هنوز عادتی نساخته‌ای": "You haven't created any habits yet", "ذخیره شد.": "Saved.", "عملیات با موفقیت انجام شد.": "Done successfully."});
Object.assign(translations,{"متوسط": "Medium", "ذخیره‌سازی IndexedDB فعال": "IndexedDB storage active", "ذخیره‌سازی محلی فعال": "Local storage active", "اطلاعات ذخیره شد": "Data saved", "این مورد حذف شود؟": "Delete this item?", "حذف شد": "Deleted", "هنوز موردی ثبت نشده است.": "Nothing has been added yet.", "هدف": "Target", "بار": "times", "مهلت": "Deadline", "روز متوالی": "day streak", "ثبت": "entries", "انجام شد": "Done", "ثبت شده ✓": "Completed ✓", "بازکردن": "Reopen", "مرحله": "Step", "مراحل": "steps", "صفحه": "Page", "از": "of", "تکمیل": "complete", "افزودن مبلغ": "Add amount", "برگرداندن": "Undo", "خریداری شد": "Purchased", "بستن": "Close", "نتایج جست‌وجو": "Search results", "دقیقه": "minutes", "درآمد": "Income", "هزینه": "Expense", "تومان": "Toman", "یورو": "Euro", "ریال": "Rial", "ذخیره‌سازی فعال": "Storage active", "برای امروز کاری ثبت نشده است.": "No tasks added for today.", "هنوز عادتی نساخته‌ای.": "You haven't created any habits yet.", "برای امروز کاری ثبت نشده است": "No tasks added for today"});
Object.assign(translations,{"بیشتر": "More", "همه بخش‌ها": "All sections", "بخش‌های بیشتر": "More sections", "برای ورود به هر قسمت، کارت آن را انتخاب کن.": "Choose a card to open a section.", "هدف‌ها و قدم‌های پیشرفتت": "Your goals and next steps", "یادداشت، خاطره و کتاب": "Notes, memories, and books", "درآمد، هزینه و پس‌انداز": "Income, expenses, and savings", "آب، خواب، ورزش و حال روحی": "Water, sleep, exercise, and mood", "تایمر تمرکز و ثبت زمان": "Focus timer and time tracking", "آمار و روند پیشرفت": "Statistics and progress", "چیزهایی که باید بخری": "Things you need to buy", "زبان، رنگ و نسخه پشتیبان": "Language, colors, and backup", "شروع برنامه‌ریزی": "Start Planning", "مدیریت آگاهانه زمان، انرژی و زندگی": "Manage your time, energy, and life", "اولویت کم": "Low priority", "اولویت زیاد": "High priority", "اولویت فوری": "Urgent priority", "عنوان هدف": "Goal title", "تعداد مراحل": "Number of steps", "عنوان": "Title", "نویسنده (برای کتاب)": "Author (for a book)", "نام فعالیت": "Activity name", "مدت (دقیقه)": "Duration (minutes)", "مصرف آب": "Water intake", "خواب": "Sleep", "وزن": "Weight", "ورزش: ": "Workout: ", "ساعت": "Time", "تاریخ": "Date", "نوع": "Type", "مبلغ": "Amount", "بودجه": "Budget", "مانده": "Balance", "درآمد کل": "Total income", "هزینه کل": "Total expenses", "تراکنش‌ها": "Transactions", "هنوز بودجه‌ای برای ماه ثبت نشده است.": "No budget has been set for this month.", "نمایش روزها بر اساس تقویم میلادی؛ تاریخ شمسی نیز در فهرست رویدادها درج می‌شود.": "Days use the Gregorian calendar. Persian dates are also shown in the event list.", "شخصی": "Personal", "کاری": "Work", "مناسبت": "Occasion", "یادآوری": "Reminder", "روزانه": "Daily", "هفتگی": "Weekly", "کوتاه‌مدت": "Short-term", "بلندمدت": "Long-term", "در حال مطالعه": "Reading", "خوانده‌شده": "Finished", "برای بعد": "To read", "یادداشت": "Note", "خاطره": "Memory", "ایده": "Idea", "کتاب": "Book", "ماهانه": "Monthly", "سالانه": "Yearly", "صبحانه": "Breakfast", "ناهار": "Lunch", "شام": "Dinner", "میان‌وعده": "Snack", "عالی": "Great", "خوب": "Good", "معمولی": "Okay", "خسته": "Tired", "پراسترس": "Stressed", "زمان استراحت": "Break time", "زمان تمرکز": "Focus time", "جلسه تمرکز تمام شد؛ استراحت کن.": "Focus session finished. Take a break.", "استراحت تمام شد؛ آماده تمرکز شو.": "Break finished. Get ready to focus.", "نتیجه‌ای پیدا نشد": "No results found", "نتایج جست‌وجو": "Search results", "بستن": "Close", "ذخیره تنظیمات": "Save settings", "تنظیمات ذخیره شد": "Settings saved", "فایل پشتیبان آماده شد.": "Backup file is ready.", "بازیابی با موفقیت انجام شد.": "Backup restored successfully.", "فایل پشتیبان معتبر نیست": "The backup file is invalid.", "اطلاعات پاک شد": "Data deleted.", "موارد خریداری‌شده پاک شدند": "Purchased items cleared.", "فرم مربوطه را تکمیل کن": "Complete the form in that section.", "چه مبلغی به پس‌انداز اضافه شود؟": "How much would you like to add to savings?", "مبلغ معتبر وارد کن": "Enter a valid amount.", "هدف پس‌اندازی نساخته‌ای.": "You have not created a savings goal yet.", "اشتراکی ثبت نشده است.": "No subscriptions added yet.", "هنوز حال روحی ثبت نشده است.": "No mood entries yet.", "هنوز وعده‌ای ثبت نشده است.": "No meals recorded yet.", "لیست خریدت خالی است.": "Your shopping list is empty.", "هنوز کتابی ثبت نشده است.": "No books added yet.", "هنوز چیزی ثبت نکرده‌ای.": "Nothing has been added yet.", "هنوز عادتی نساخته‌ای.": "You have not created a habit yet.", "برای امروز کاری ثبت نشده است.": "No tasks added for today.", "در انتظار": "Pending", "انجام شد": "Done", "بازکردن": "Reopen", "ثبت شده ✓": "Completed ✓", "خریداری شد": "Purchased", "برگرداندن": "Undo", "حذف": "Delete", "مورد": "item", "مورد جدید": "New item", "صفحه": "Page", "از": "of", "مرحله": "Step", "مراحل": "steps", "روز متوالی": "day streak", "ثبت": "entries", "بار": "times", "مهلت": "Deadline", "تا سطح بعدی: ": "To next level: ", "سطح ": "Level ", "تکمیل": "complete", "فعالیت": "Activity", "مالی": "Finance", "جلسات زمان": "Time sessions", "وظایف تکمیل‌شده": "Completed tasks", "نرخ تکمیل": "Completion rate", "ثبت عادت‌ها": "Habit entries", "ثبت شده": "Saved", "ذخیره شد.": "Saved.", "عملیات با موفقیت انجام شد.": "Completed successfully.", "اطلاعات ذخیره شد": "Data saved", "ذخیره‌سازی IndexedDB فعال": "IndexedDB storage active", "ذخیره‌سازی محلی فعال": "Local storage active", "این مورد حذف شود؟": "Delete this item?", "حذف شد": "Deleted", "هنوز موردی ثبت نشده است.": "Nothing added yet.", "بدون تاریخ": "No date", "تکرار ": "Repeat ", "صفحه فعلی": "Current page", "تعداد صفحات": "Total pages", "نام اشتراک": "Subscription name", "هر ماه": "Every month", "هر سال": "Every year", "فعال": "Active", "غیرفعال": "Inactive", "درآمد": "Income", "هزینه": "Expense", "تومان": "Toman", "یورو": "Euro", "ریال": "Rial", "دلار": "Dollar", "ثبت وزن": "Log weight", "ثبت تمرین": "Log workout", "ثبت حال امروز": "Log today’s mood", "ثبت وعده": "Log meal", "ثبت زمان": "Log time", "افزودن مبلغ": "Add amount", "ثبت کتاب": "Add book", "ثبت حس خوب": "Save gratitude", "ذخیره بودجه": "Save budget", "ایجاد هدف": "Create goal", "ساخت عادت": "Create habit", "ثبت رویداد": "Add event", "افزودن کار": "Add task", "ذخیره": "Save", "مکث": "Pause", "بازنشانی": "Reset", "شروع": "Start", "فوری": "Urgent", "کم": "Low", "متوسط": "Medium", "زیاد": "High"});

Object.assign(translations,{
'مدیریت پول':'Money management','هر پولی که می‌گیری یا خرج می‌کنی، در جای خودش ثبت کن.':'Record money you receive or spend in the right place.',
'۱. درآمد من':'1. My income','پولی که به دستت می‌رسد؛ مثل پول توجیبی یا حقوق.':'Money you receive, such as allowance, gifts, or pay.',
'۲. هزینه‌های من':'2. My expenses','خریدها و خرج‌های غیرخوراکی مثل رفت‌وآمد یا لباس.':'Things you pay for, such as transport, clothes, or games.',
'۳. خوراک و خوردوخوراک':'3. Food and snacks','هزینه غذا، خوراکی، نوشیدنی و خریدهای سوپرمارکتی.':'Money spent on meals, snacks, drinks, and groceries.',
'۴. پس‌انداز برای هدفم':'4. Savings for my goal','برای چیزی که می‌خواهی بخری، کم‌کم پول کنار بگذار.':'Put a little money aside for something you want to buy.',
'درآمد کل':'Total income','هزینه‌های دیگر':'Other expenses','هزینه خوراک':'Food spending','مانده پول':'Money left',
'ثبت درآمد':'Add income','ثبت هزینه':'Add expense','ثبت هزینه خوراک':'Add food expense','ساخت هدف پس‌انداز':'Create savings goal',
'مبلغ دریافتی':'Amount received','از کجا رسید؟ مثلاً پول توجیبی':'Where did it come from? e.g. allowance',
'چقدر خرج کردی؟':'How much did you spend?','برای چه چیزی؟':'What was it for?','هزینه خوراکی':'Food cost','مثلاً ناهار یا سوپرمارکت':'e.g. lunch or groceries',
'یادداشت کوتاه (اختیاری)':'Short note (optional)','مثلاً خرید دوچرخه':'e.g. Buy a bicycle','مبلغی که لازم داری':'How much do you need?',
'چقدر جمع کرده‌ای؟':'How much have you saved?','بودجه ماهانه':'Monthly budget','مشخص کن این ماه حداکثر چقدر می‌خواهی خرج کنی.':'Set the most you want to spend this month.',
'مبلغ بودجه':'Budget amount','پرداخت‌های تکراری':'Recurring payments','مثل اشتراک ماهانه یا هزینه‌ای که مرتب پرداخت می‌کنی.':'Payments you make regularly, such as a monthly subscription.',
'نام سرویس یا پرداخت':'Service or payment name','ثبت پرداخت تکراری':'Add recurring payment','ذخیره بودجه':'Save budget',
'هنوز بودجه‌ای برای ماه ثبت نشده است.':'No budget has been set for this month yet.',
'تومان':'Toman','ریال':'Rial','ماهانه':'Monthly','سالانه':'Yearly','هفتگی':'Weekly',
'باقی‌مانده':'left','عادت‌های فعال':'Active habits','یادداشت‌ها':'Notes','XP کسب‌شده':'XP earned',
'برای امروز کاری ثبت نشده است.':'No tasks added for today.','هنوز عادتی نساخته‌ای.':'You have not added a habit yet.',
'هنوز موردی ثبت نشده است.':'Nothing here yet.','بدون عنوان':'Untitled','بدون تاریخ':'No date',
'افزودن به لیست':'Add to list','نام کالا':'Item name','تعداد یا مقدار (اختیاری)':'Quantity (optional)',
'مثلاً مطالعه ۲۰ دقیقه':'e.g. Read for 20 minutes','عنوان رویداد':'Event title','عنوان کار':'Task title',
'عنوان هدف':'Goal title','نام کتاب':'Book title','نویسنده':'Author','متن یا توضیحات...':'Write a note or details...',
'امروز بابت چه چیزی قدردانی می‌کنی؟':'What are you grateful for today?',
'نام غذا یا وعده':'Meal or food name','نوع تمرین':'Workout type','مدت (دقیقه)':'Duration (minutes)',
'ساعت خواب':'Hours of sleep','وزن (کیلوگرم)':'Weight (kg)','دلیل یا توضیح کوتاه':'A short note or reason',
'نام فعالیت':'Activity name','مدت (دقیقه)':'Duration (minutes)','هدف روزانه آب (ml)':'Daily water goal (ml)',
'جست‌وجو در یادداشت‌ها...':'Search notes...','جست‌وجو در همه اطلاعات...':'Search all your data...',
'موردی پیدا نشد':'No items found','مشاهده همه':'View all','مدیریت عادت‌ها':'Manage habits',
'بستن':'Close','حذف':'Delete','انجام شد':'Done','بازکردن':'Reopen','ثبت شده ✓':'Saved ✓',
'این مورد حذف شود؟':'Delete this item?','اطلاعات ذخیره شد':'Saved successfully','حذف شد':'Deleted',
'شخصی':'Personal','کاری':'Work','مناسبت':'Occasion','یادآوری':'Reminder','خوراکی':'Groceries',
'صبحانه':'Breakfast','ناهار':'Lunch','شام':'Dinner','میان‌وعده':'Snack',
'عالی':'Great','خوب':'Good','معمولی':'Okay','خسته':'Tired','پراسترس':'Stressed',
'افزودن فعالیت':'Add task','اولویت متوسط':'Medium priority','بدون تکرار':'No repeat','تکرار روزانه':'Repeat daily','تکرار هفتگی':'Repeat weekly',
'همه کارها':'All tasks','انجام‌نشده':'To do','انجام‌شده':'Completed','ذخیره شد.':'Saved.',
'برای نصب در آیفون: Safari → Share → Add to Home Screen':'On iPhone: Safari → Share → Add to Home Screen',
'برای نصب از منوی مرورگر گزینه Install app را انتخاب کن.':'Choose Install app from your browser menu.'
});

Object.assign(translations,{
'روز متوالی':'day streak','ثبت':'entry','مرحله':'step','مهلت':'Due','صفحه':'Page','از':'of','تکمیل':'complete',
'برگرداندن':'Undo','خریداری شد':'Bought','+۱۰ صفحه':'+10 pages','＋ افزودن مبلغ':'＋ Add money',
'هنوز کتابی ثبت نشده است.':'No books added yet.','هنوز چیزی ثبت نکرده‌ای.':'You have not added anything yet.',
'هدف پس‌اندازی نساخته‌ای.':'You have not created a savings goal yet.','اشتراکی ثبت نشده است.':'No subscriptions added yet.',
'هنوز حال روحی ثبت نشده است.':'No mood entries yet.','هنوز وعده‌ای ثبت نشده است.':'No meals added yet.',
'لیست خریدت خالی است.':'Your shopping list is empty.','مبلغ معتبر وارد کن':'Enter a valid amount.',
'چه مبلغی به پس‌انداز اضافه شود؟':'How much would you like to add to savings?',
'مصرف آب':'Water intake','خواب':'Sleep','ورزش: ':'Workout: ','دقیقه':'minutes','ساعت':'hours',
'درصد تکمیل':'Completion','تکرار':'Repeat','نامشخص':'Not set','پرداخت بعدی:':'Next payment:',
'امروز':'Today','در انتظار':'Not yet','انجام شد':'Done','ثبت شده ✓':'Done ✓',
'روزانه':'Daily','هفتگی':'Weekly','کوتاه‌مدت':'Short-term','بلندمدت':'Long-term',
'فعالیت':'Activity','نتیجه‌ای پیدا نشد':'No results found','مورد':'item','مورد خریداری شده':'items purchased'
});


Object.assign(translations,{
'برنامه هوشمند روزانه':'Smart daily plan','کارهای امروزت را بر اساس فوریت، اولویت و ساعت مرتب می‌کند. این ابزار خودش کاری را انجام نمی‌دهد؛ فقط پیشنهاد می‌دهد از کجا شروع کنی.':'Sorts today’s tasks by urgency, priority, and time. It suggests where to start; it does not do tasks for you.','پیشنهاد ترتیب کارهای امروز':'Suggested order for today','ساخت برنامه امروز':'Build today’s plan','برنامه هفتگی':'Weekly plan','هفت روز آینده':'Next seven days','به‌روزرسانی':'Refresh','کارها':'tasks','رویداد':'events','یادآورها':'Reminders','برای کارهای مهم یک زمان بگذار. اعلان‌ها وقتی برنامه باز باشد یا مرورگر اجازه اجرای پس‌زمینه بدهد قابل اتکاترند.':'Set a time for important things. Notifications are more reliable while the app is open or when the browser allows background activity.','مثلاً تماس با دوست':'e.g. Call a friend','توضیح کوتاه (اختیاری)':'Short note (optional)','ساخت یادآور':'Create reminder','فعال‌کردن اجازه اعلان':'Allow notifications','انجام شد':'Done','بازکردن':'Undo','یادآور':'Reminder','چالش ۳۰ روزه':'30-day challenge','یک کار کوچک انتخاب کن و هر روز انجامش دادی علامت بزن. لازم نیست کامل باشی؛ فقط ادامه بده.':'Choose one small habit and check it off each day. You do not need to be perfect; just keep going.','مثلاً روزی ۱۵ دقیقه مطالعه':'e.g. Read 15 minutes a day','شروع چالش':'Start challenge','ثبت امروز':'Check in today','پیشرفت امروز ثبت شد':'Today’s progress saved','درس و امتحان':'Study & exams','زمان مطالعه‌ات را ثبت کن و تاریخ امتحان‌ها را فراموش نکن.':'Track your study time and keep exam dates in view.','نام درس یا موضوع':'Subject or topic','چند دقیقه مطالعه کردی؟':'How many minutes did you study?','چه چیزی خواندی؟ (اختیاری)':'What did you study? (optional)','ثبت جلسه مطالعه':'Log study session','جلسه‌های مطالعه':'Study sessions','زمان مطالعه':'Study time','سقف خرج روزانه':'Daily spending limit','مشخص کن در یک روز بیشتر از چه مبلغی خرج نکنی. این بخش خرج‌های ثبت‌شده در قسمت مالی را جمع می‌زند.':'Choose the most you want to spend in one day. This section totals expenses saved in Finance.','حداکثر خرج روزانه':'Daily spending cap','ذخیره سقف روزانه':'Save daily limit','امروز':'Today','از سقف روزانه عبور کرده‌ای.':'You are over your daily limit.','هنوز در محدوده بودجه روزانه هستی.':'You are within your daily budget.','لیست آرزوها':'Wishlist','چیزهایی را که دوست داری بخری ثبت کن و بعد از تهیه، علامت بزن.':'Save things you would like to buy and check them off when you get them.','چه چیزی می‌خواهی؟':'What would you like?','قیمت تقریبی (اختیاری)':'Estimated price (optional)','معمولی':'Normal','مهم':'Important','برای بعد':'Later','افزودن به آرزوها':'Add to wishlist','خریدم':'Got it','گزارش ماهانه':'Monthly report','ببین این ماه چه کارهایی انجام دادی، چقدر خرج کردی و چقدر پیشرفت داشتی.':'See what you completed, spent, and learned this month.','انتخاب ماه':'Choose month','درآمد':'Income','هزینه':'Expenses','کارهای انجام‌شده':'Tasks completed','مانده این ماه:':'Balance this month:','ردیاب مهارت‌ها':'Skills tracker','مهارتی را که می‌خواهی یاد بگیری اضافه کن و زمان تمرینت را ثبت کن.':'Add a skill you want to learn and track your practice time.','مثلاً زبان انگلیسی یا طراحی':'e.g. English or design','هدف ساعت تمرین':'Target practice hours','افزودن مهارت':'Add skill','ساعت':'hours','＋ ۳۰ دقیقه تمرین':'+ 30 min practice','۳۰ دقیقه تمرین ثبت شد':'30 minutes of practice saved','قفل برنامه':'App lock','یک رمز ۴ تا ۸ رقمی بگذار تا هنگام بازشدن برنامه، صفحه قفل نمایش داده شود. این قفل ساده است و جای رمزگذاری فایل‌ها یا امنیت بانکی را نمی‌گیرد.':'Set a 4–8 digit PIN to show a lock screen when the app opens. This is a simple privacy lock, not file encryption or banking-grade security.','رمز ۴ تا ۸ رقمی':'4–8 digit PIN','ذخیره رمز':'Save PIN','قفل‌کردن همین حالا':'Lock now','برداشتن رمز':'Remove PIN','رمز فعال است.':'A PIN is active.','هنوز رمزی تنظیم نشده است.':'No PIN is set yet.','رمز ذخیره شد. دفعه بعد هنگام بازشدن برنامه قفل نمایش داده می‌شود.':'PIN saved. The lock screen will appear the next time the app opens.','رمز برنامه تنظیم شد':'App PIN saved','قفل غیرفعال شد.':'The lock is disabled.','قفل برداشته شد':'PIN removed','برای ورود، رمزت را وارد کن.':'Enter your PIN to continue.','رمز ورود':'Enter PIN','باز کردن برنامه':'Unlock app','رمز درست نیست. دوباره تلاش کن.':'Incorrect PIN. Try again.','قفل برنامه برداشته شود؟':'Remove the app lock?','اول یک رمز بساز.':'Set a PIN first.','برای ساخت قفل، برنامه را در HTTPS یا localhost باز کن.':'Open the app over HTTPS or localhost to set a PIN.','این مرورگر از اعلان پشتیبانی نمی‌کند.':'This browser does not support notifications.','اجازه اعلان داده نشد.':'Notification permission was not granted.','اعلان‌ها فعال شدند.':'Notifications are enabled.','سقف خرج روزانه ذخیره شد':'Daily spending limit saved','برای امروز کار باز نداری. از بخش کارها یک کار تازه اضافه کن.':'No open tasks for today. Add a task in the Tasks section.','اولین چالش ۳۰ روزه‌ات را بساز.':'Create your first 30-day challenge.','هنوز جلسه‌ای ثبت نکرده‌ای.':'No study sessions yet.','هنوز سقف خرجی تعیین نکرده‌ای.':'You have not set a daily limit yet.','لیست آرزوها هنوز خالی است.':'Your wishlist is empty.','یک مهارت برای یادگیری انتخاب کن.':'Choose a skill to learn.','رمز باید ۴ تا ۸ رقم باشد.':'PIN must contain 4 to 8 digits.','قفل نمایشی':'Simple privacy lock'
});

Object.assign(translations,{"آب، خواب، ورزش و حال روحی": "Water, sleep, exercise, and mood", "آمار و روند پیشرفت": "Statistics and progress", "بخش‌های بیشتر": "More sections", "برای ورود به هر قسمت، کارت آن را انتخاب کن.": "Choose a card to open a section.", "بیشتر": "More", "تایمر تمرکز و ثبت زمان": "Focus timer and time tracking", "تومان": "Toman", "ثبت خواب": "Log sleep", "درآمد، هزینه و پس‌انداز": "Income, expenses, and savings", "دلار ($)": "US dollars ($)", "ریال": "Rials", "زبان، رنگ و نسخه پشتیبان": "Language, colors, and backup", "نمای کلی امروز": "Today’s overview", "هدف‌ها و قدم‌های پیشرفتت": "Your goals and next steps", "چیزهایی که باید بخری": "Things you need to buy", "کارهای امروز": "Today’s tasks", "یادداشت، خاطره و کتاب": "Notes, memories, and books", "یورو (€)": "Euros (€)", "⌁ ورزش": "⌁ Workout", "☾ خواب": "☾ Sleep", "⚖ وزن": "⚖ Weight", "＋ ثبت تراکنش": "＋ Add transaction", "🌼 دفتر قدردانی روزانه": "🌼 Daily gratitude journal", "🐷 هدف پس‌انداز": "🐷 Savings goal", "💧 آب مصرفی": "💧 Water intake", "📚 پیگیری مطالعه کتاب": "📚 Reading tracker", "🔁 اشتراک‌ها و پرداخت‌های دوره‌ای": "🔁 Subscriptions and recurring payments", "😄 عالی": "😄 Great", "😊 ثبت حال روحی": "😊 Mood tracker", "😐 معمولی": "😐 Okay", "😣 پراسترس": "😣 Stressed", "😴 خسته": "😴 Tired", "🙂 خوب": "🙂 Good", "🥗 ثبت وعده غذایی": "🥗 Meal tracker", "ثبت حال روحی": "Mood tracker", "ثبت تراکنش": "Add transaction", "ثبت حس خوب": "Save gratitude", "هدف پس‌انداز": "Savings goal", "اشتراک‌ها و پرداخت‌های دوره‌ای": "Subscriptions and recurring payments", "آب مصرفی": "Water intake", "پیگیری مطالعه کتاب": "Reading tracker", "دفتر قدردانی روزانه": "Daily gratitude journal", "ثبت وزن": "Log weight", "ثبت تمرین": "Log workout", "ثبت حال امروز": "Log today’s mood", "ثبت وعده غذایی": "Meal tracker", "ثبت وعده": "Save meal", "ظاهر و زبان": "Appearance and language", "رنگ اصلی": "Accent color", "تم برنامه": "App theme", "تاریک": "Dark", "روشن": "Light", "فارسی": "Persian", "واحد پول": "Currency", "هدف روزانه آب (ml)": "Daily water goal (ml)", "پشتیبان‌گیری و بازیابی": "Backup and restore", "از تمام داده‌ها یک فایل JSON تهیه کن یا نسخه پشتیبان را بازیابی کن.": "Export all your data to a JSON file or restore a backup.", "نصب و وضعیت برنامه": "Installation and app status", "بررسی وضعیت نصب...": "Checking installation status...", "نصب اپلیکیشن": "Install app", "نصب روی گوشی یا کامپیوتر": "Install on your phone or computer", "مدیریت آگاهانه زمان، انرژی و زندگی": "Manage your time, energy, and life"});
Object.assign(translations,{"این مورد حذف شود؟": "Delete this item?", "چه مبلغی به پس‌انداز اضافه شود؟": "How much would you like to add to savings?", "تمام اطلاعات این برنامه برای همیشه حذف شود؟ ابتدا از اطلاعات پشتیبان بگیر.": "Delete all app data permanently? Back up your data first.", "داده‌های فعلی جایگزین می‌شوند.": "Your current data will be replaced.", "بازیابی": "Restore", "رکورد؟": "records?", "فایل پشتیبان معتبر نیست": "The backup file is invalid."});

Object.assign(translations,{
'ابزارهای برنامه‌ریزی':'Planning tools','امکانات مرتبط با کارها':'Tools related to your tasks','برنامه هوشمند امروز':'Smart plan for today','پیشنهاد ترتیب انجام کارها':'Suggested order for your tasks','دیدن کارهای هفت روز آینده':'See your tasks for the next seven days','برای کارهای مهم زمان بگذار':'Set a time for important tasks','ثبت زمان مطالعه و امتحان‌ها':'Track study time and exam dates','تمرین و پیشرفت بیشتر':'Practice and make progress','گزارش دقیق‌تر':'More detailed reports','جمع‌بندی کارها، مطالعه و پول':'A summary of tasks, study, and money','کارها و رویدادهای این هفته را یک‌جا ببین.':'See this week’s tasks and events in one place.','＋ ساخت یادآور':'＋ Create reminder','＋ شروع چالش':'＋ Start challenge','＋ افزودن به آرزوها':'＋ Add to wishlist','＋ افزودن مهارت':'＋ Add skill','نسخه 1.3.0 · اطلاعات روی همین دستگاه ذخیره می‌شوند.':'Version 1.3.0 · Your data is stored on this device.','برنامه‌ریزی':'Plan','رشد فردی':'Growth','زندگی':'Life','یادداشت‌ها':'Notes','سلامت':'Wellness','مالی':'Money','تنظیمات':'Settings',
'شروع برنامه‌ریزی':'Start Planning','فضای مدیریت شخصی':'PERSONAL WORKSPACE','قفل برنامه':'App lock','برای ورود، رمزت را وارد کن.':'Enter your passcode to continue.','رمز ورود':'Passcode','باز کردن برنامه':'Unlock app','رمز ۴ تا ۸ رقمی':'4–8 digit passcode','برای نصب، پروژه را روی یک آدرس HTTPS منتشر کن. اجرای فایل با file:// برای نصب کافی نیست.':'To install, publish the app at an HTTPS address. Opening a file with file:// is not enough.','برای نصب در آیفون: صفحه را در Safari باز کن، Share و سپس Add to Home Screen را بزن.':'To install on iPhone: open this page in Safari, tap Share, then Add to Home Screen.','صفحه از آدرس امن اجرا شده است. از منوی Chrome گزینه Install app را انتخاب کن.':'This page is running from a secure address. In Chrome, choose Install app from the menu.','برنامه روی دستگاه نصب شده است.':'The app is installed on this device.','برنامه با موفقیت نصب شد.':'The app was installed successfully.','ثبت سرویس‌ورکر ناموفق بود. آدرس و دسترسی فایل sw.js را بررسی کن.':'Service worker registration failed. Check the sw.js file path and access.','بررسی وضعیت نصب...':'Checking installation status...','نصب اپلیکیشن':'Install app','برای نصب از منوی مرورگر گزینه Install app را انتخاب کن.':'Choose Install app from your browser menu.'
});

Object.assign(translations,{
'هنوز رمزی تنظیم نشده است.':'No passcode has been set yet.','هنوز سقف خرجی تعیین نکرده‌ای.':'You have not set a spending limit yet.','هنوز عادتی نساخته‌ای.':'You have not created a habit yet.','هنوز وعده‌ای ثبت نشده است.':'No meals have been logged yet.','هنوز چیزی ثبت نکرده‌ای.':'You have not added anything yet.','هنوز کتابی ثبت نشده است.':'No books have been added yet.','هنوز حال روحی ثبت نشده است.':'No mood entries yet.','اشتراکی ثبت نشده است.':'No subscriptions added yet.','هدف پس‌اندازی نساخته‌ای.':'You have not created a savings goal yet.','لیست خریدت خالی است.':'Your shopping list is empty.','برای امروز کاری ثبت نشده است.':'No tasks added for today.','ذخیره شد':'Saved','ثبت شد':'Saved','حذف شد':'Deleted','اطلاعات ذخیره شد':'Data saved','اطلاعات پاک شد':'Data deleted','مبلغ معتبر وارد کن':'Enter a valid amount','عنوان':'Title','نام':'Name','تاریخ':'Date','زمان':'Time','توضیحات':'Details','مقدار':'Amount','تعداد':'Quantity','انتخاب ماه':'Choose month','بدون عنوان':'Untitled','بدون تاریخ':'No date','درآمد':'Income','هزینه':'Expense','خوراکی':'Groceries','پس‌انداز':'Savings','خرید':'Shopping','در حال انجام':'In progress','انجام نشده':'Not completed','تکمیل شده':'Completed','روزانه':'Daily','هفتگی':'Weekly','ماهانه':'Monthly','سالانه':'Yearly','کم':'Low','متوسط':'Medium','زیاد':'High','فوری':'Urgent','شخصی':'Personal','کاری':'Work','مناسبت':'Occasion','یادآوری':'Reminder','یادداشت':'Note','خاطره':'Memory','ایده':'Idea','کتاب':'Book','صبحانه':'Breakfast','ناهار':'Lunch','شام':'Dinner','میان‌وعده':'Snack','عالی':'Great','خوب':'Good','معمولی':'Okay','خسته':'Tired','پراسترس':'Stressed','شروع':'Start','مکث':'Pause','بازنشانی':'Reset','ثبت':'Save','ذخیره':'Save','حذف':'Delete','ویرایش':'Edit','بستن':'Close','لغو':'Cancel','فعال':'Active','غیرفعال':'Inactive','مورد':'Item','موارد':'Items','صفحه':'Page','از':'of','مرحله':'Step','مراحل':'Steps','دقیقه':'Minutes','ساعت':'Hours','روز':'Day','هفته':'Week','ماه':'Month','سال':'Year','سطح':'Level','پیشرفت':'Progress','هدف':'Goal','مانده':'Remaining','موجودی':'Balance','بودجه':'Budget','تومان':'Toman','ریال':'Rial','یورو (€)':'Euro (€)','دلار ($)':'US Dollar ($)',
'خرج کرده‌ای.':'spent.','هزینه این ماه':'Expenses this month',' از ':' of ',' تا ':' to ',' ساعت مشخص نشده':'Time not set',' روز متوالی ':' day streak ',' مورد خریداری شده':' items purchased','قفل فعال است.':'App lock is active.','هنوز یادآوری نساخته‌ای.':'No reminders created yet.','برای امروز کار باز نداری. از بخش کارها یک کار تازه اضافه کن.':'No open tasks for today. Add a new task in the Tasks section.','اول از همه':'First','بعدی':'Next','در صف':'Up next','از سقف روزانه عبور کرده‌ای.':'You have exceeded your daily limit.','هنوز در محدوده بودجه روزانه هستی.':'You are still within your daily budget.','۳۰ دقیقه تمرین ثبت شد':'30 minutes of practice logged','رمز ذخیره شد. دفعه بعد هنگام بازشدن برنامه قفل نمایش داده می‌شود.':'Passcode saved. The app will ask for it next time you open it.','رمز برنامه تنظیم شد':'App passcode set','قفل غیرفعال شد.':'App lock disabled.','قفل برداشته شد':'Passcode removed','رمز باید ۴ تا ۸ رقم باشد.':'Your passcode must be 4 to 8 digits.','اول یک رمز بساز.':'Set a passcode first.','رمز درست نیست. دوباره تلاش کن.':'Incorrect passcode. Try again.'
});
Object.assign(translations,{'ساعت مشخص نشده':'Time not set','خریداری شده':'Purchased','✓ انجام شد':'✓ Done','۳۰ روز':'30 days',' ثبت':' entries',' کار · ':' tasks · ',' رویداد':' events','چیزی ثبت نشده':'Nothing recorded','خریدم':'Purchased','در انتظار خرید':'Not purchased yet','قیمت مشخص نشده':'No price set','معمولی':'Normal'});

Object.assign(translations,{
 'افزایش یا کاهش موجودی':'Add or subtract from balance','برای پولی که جدا از درآمد و هزینه روزانه به حسابت اضافه یا از آن کم می‌شود.':'For money added to or taken from your account outside regular income and expenses.',
 'واریز به حساب':'Deposit','برداشت از حساب':'Withdrawal','علت؛ مثلاً پول نقد یا هدیه':'Reason, e.g. cash or a gift','ثبت واریز / برداشت':'Save deposit / withdrawal','موجودی فعلی حساب من':'My current balance','موجودی اولیه':'Opening balance','مجموع درآمد':'Total income','مجموع هزینه‌ها':'Total expenses','واریزهای دستی':'Manual deposits','برداشت‌های دستی':'Manual withdrawals','نام حساب؛ مثلاً کیف پول':'Account name, e.g. wallet','ذخیره اطلاعات حساب':'Save account details','حساب من':'My account','موجودی حساب':'Account balance','افزودن کار':'Add task','عنوان کار':'Task title','اولویت: کم، متوسط، زیاد یا فوری':'Priority: low, medium, high, or urgent','مدت تقریبی (دقیقه)':'Estimated duration (minutes)','زمان تقریبی انجام کار':'Estimated task duration','کار انجام‌شده ثبت شد.':'Task marked as completed.','کار باز و سررسیدشده‌ای نداری. از بخش کارها یک فعالیت اضافه کن.':'No open tasks are due. Add a task in the Tasks section.','از موعد گذشته':'Overdue','اولویت فوری':'Urgent priority','اولویت زیاد':'High priority','پیشنهاد بعدی':'Suggested next step','بدون ساعت':'No time set','انجام شد':'Mark done','ویرایش':'Edit','حذف':'Delete','عنوان را وارد کن':'Enter a title','اولویت معتبر نیست':'Invalid priority','حساب برای این برداشت موجودی کافی ندارد.':'There is not enough balance for this withdrawal.','عنوان عادت':'Habit name','هدف روزانه یا هفتگی':'Daily or weekly target','هدف باید عددی بزرگ‌تر از صفر باشد':'The target must be a number greater than zero.','عنوان هدف':'Goal title','مهلت (YYYY-MM-DD)':'Deadline (YYYY-MM-DD)','− مرحله':'− Step'
});
Object.assign(translations,{
 'حساب کاربری و همگام‌سازی ابری':'Account and cloud sync',
 'برای استفاده از ذخیره‌سازی ابری، با ایمیل خود وارد شو.':'Sign in with your email to use cloud storage.',
 'ایمیل':'Email','رمز عبور (حداقل ۸ نویسه)':'Password (at least 8 characters)',
 'ورود':'Sign in','ایجاد حساب':'Create account','همگام‌سازی اکنون':'Sync now','خروج از حساب':'Sign out',
 'اطلاعات محلی روی این دستگاه باقی می‌مانند. برای انتقال به دستگاه دیگر، پس از ورود از گزینه همگام‌سازی استفاده کن.':'Your local data stays on this device. To transfer data to another device, sign in and use Sync.',
 'تم برنامه':'App theme','رنگ اصلی':'Accent color','زبان':'Language','واحد پول':'Currency',
 'ذخیره تنظیمات':'Save settings','▶ اجرای دوباره راهنمای برنامه':'▶ Replay app tour',
 'پشتیبان‌گیری و بازیابی':'Backup and restore','از تمام داده‌ها یک فایل JSON تهیه کن یا نسخه پشتیبان را بازیابی کن.':'Export all your data as a JSON file or restore a backup.',
 '↓ دریافت پشتیبان JSON':'↓ Download JSON backup','↑ بازیابی JSON':'↑ Restore JSON','پاک‌کردن همه اطلاعات':'Delete all data',
 'نصب و وضعیت برنامه':'App installation and status','بررسی وضعیت نصب...':'Checking installation status...','نصب اپلیکیشن':'Install app',
 'نسخه 23.4 · اصلاح ورود ابری · اطلاعات روی همین دستگاه ذخیره می‌شوند.':'Version 25.0 · Automatic cloud sync and change management.',
 'نصب روی گوشی یا کامپیوتر':'Install on a phone or computer',
 'اندروید و کامپیوتر: از منوی مرورگر گزینه Install app یا نصب برنامه را انتخاب کن.':'Android and desktop: open the browser menu and choose Install app.',
 'آیفون و آیپد: در Safari دکمه Share را بزن و Add to Home Screen را انتخاب کن.':'iPhone and iPad: in Safari, tap Share, then choose Add to Home Screen.',
 'ظاهر و زبان':'Appearance and language','حریم خصوصی':'Privacy','قفل برنامه':'App lock',
 'درس و امتحان':'Study and exams','زمان مطالعه‌ات را ثبت کن و تاریخ امتحان‌ها را فراموش نکن.':'Log your study time and keep track of exam dates.',
 'جلسات ثبت‌شده':'Sessions logged','مجموع زمان مطالعه':'Total study time','امتحان‌های پیش‌رو':'Upcoming exams',
 'هنوز جلسه‌ای ثبت نکرده‌ای.':'No study sessions logged yet.','امتحان':'Exam','جلسه مطالعه':'Study session',
 'برای ذخیره‌سازی ابری، وارد حساب شو یا حساب جدید بساز. اطلاعات محلی تغییر نمی‌کنند.':'Sign in or create an account to use cloud storage. Your local data will remain unchanged.',
 'در حال بررسی و همگام‌سازی اطلاعات…':'Checking and syncing your data…',
 'برنامه روی دستگاه نصب شده است.':'The app is installed on this device.',
 'برای نصب، سایت باید با HTTPS باز شود؛ فایل محلی برای نصب کافی نیست.':'The site must be opened over HTTPS to install. A local file is not sufficient.',
 'در آیفون: سایت را در Safari باز کن، Share و سپس Add to Home Screen را بزن.':'On iPhone, open the site in Safari, tap Share, then Add to Home Screen.',
 'برای نصب مستقل، از منوی Chrome گزینه Install app را انتخاب کن؛ گزینه Create shortcut فقط میان‌بر می‌سازد.':'To install the app, choose Install app from the Chrome menu. Create shortcut only makes a shortcut.',
 'اگر دکمه نصب فعال نشد، از منوی Chrome گزینه Install app را انتخاب کن؛ Create shortcut را انتخاب نکن.':'If the install button is unavailable, choose Install app from the Chrome menu, not Create shortcut.',
 'ثبت سرویس‌ورکر ناموفق بود. فایل sw.js باید در ریشه سایت منتشر شده باشد.':'Service worker registration failed. Make sure sw.js is published in the site root.',
 'در حال ورود…':'Signing in…','در حال ساخت حساب…':'Creating your account…','در حال خروج…':'Signing out…','لطفاً صبر کن…':'Please wait…',
 'همگام‌سازی انجام شد. ':'Sync completed. ',' رکورد روی این دستگاه موجود است.':' records are available on this device.',
 'همگام‌سازی انجام نشد: ':'Sync failed: ','ورود انجام نشد: ':'Sign-in failed: ','ثبت‌نام انجام نشد: ':'Sign-up failed: ','خروج انجام نشد: ':'Sign-out failed: ',
 'ورود موفق بود: ':'Signed in successfully: ','. همگام‌سازی خودکار فعال شد.':'. Run sync manually to transfer your data.',
 'وارد شده‌ای: ':'Signed in as: ',' · همگام‌سازی خودکار فعال است.':' · Automatic sync is enabled.',
   'تغییرات ذخیره شد؛ همگام‌سازی خودکار در صف است.':'Changes saved; automatic sync is queued.',
   'همگام‌سازی خودکار با موفقیت انجام شد. ':'Automatic sync completed. ',
   'همگام‌سازی انجام نشد؛ تغییرات روی دستگاه در صف می‌مانند: ':'Sync failed; changes remain queued on this device: ',
 'درخواست ثبت‌نام ثبت شد. ایمیل تأیید را باز کن؛ پس از تأیید، برنامه باید حساب را تشخیص دهد. اگر حساب وارد نشد، از همین صفحه با همان ایمیل و رمز وارد شو.':'Your sign-up request was received. Open the confirmation email. After confirming, sign in here with the same email and password.'
});
const originalTextNodes=new Map();
Object.assign(translations,{
 'انرژی امروز':'Daily motivation','هر روز یک قدم به هدفت نزدیک‌تر شو.':'Take one step closer to your goal every day.','موجودی شروع':'Starting balance','نام حساب؛ مثلاً کیف پول':'Account name, e.g. Wallet','حساب‌های من':'My accounts','حساب اصلی':'Main account','مقدار معتبر وارد کن':'Enter a valid value.','حساب‌ها و مبلغ انتقال را بررسی کن':'Check the accounts and transfer amount.','حساب مبدأ':'From account','حساب مقصد':'To account','از حساب':'From account','به حساب':'To account','حساب مورد استفاده':'Account to use','تراکنشی پیدا نشد':'No transactions found.','انتقال پول':'Money transfer','حساب‌های من':'My accounts','برای پول نقد و حساب‌های بانکی، حساب جدا بساز.':'Create separate accounts for cash and bank balances.','افزودن حساب':'Add account','موجودی شروع':'Starting balance','انتقال بین حساب‌ها':'Transfer between accounts','پول را از یک حساب به حساب دیگر جابه‌جا کن.':'Move money from one account to another.','مبلغ انتقال':'Transfer amount','انتقال پول':'Transfer money','جست‌وجوی تراکنش‌ها':'Search transactions','جست‌وجو بر اساس عنوان یا مبلغ...':'Search by title or amount...','مجموع موجودی حساب‌ها':'Total account balance','موجودی فعلی':'Current balance','حساب مبدأ':'From account','حساب مقصد':'To account','از حساب':'From account','به حساب':'To account','حساب مورد استفاده':'Account to use','موجودی حساب کافی نیست':'Insufficient account balance','از سقف خرج روزانه عبور کردی.':'You exceeded your daily spending limit.','نام حساب':'Account name','موجودی اولیه':'Opening balance','مبلغ':'Amount','عنوان':'Title',
 'موجودی حساب':'Account balance',
 'موجودی اولیه را وارد کن؛ بعد از آن درآمدها و هزینه‌های ثبت‌شده به‌صورت خودکار محاسبه می‌شوند.':'Enter your starting balance. Your saved income and expenses will update the balance automatically.',
 'نام حساب؛ مثلاً کیف پول':'Account name, e.g. Wallet',
 'موجودی اولیه':'Opening balance',
 'ذخیره اطلاعات حساب':'Save account details',
 'موجودی فعلی = موجودی اولیه + درآمدها − هزینه‌ها و خوراک ثبت‌شده.':'Current balance = opening balance + income − recorded expenses and food costs.',
 'موجودی اولیه معتبر وارد کن':'Enter a valid opening balance',
 'اطلاعات حساب ذخیره شد':'Account details saved',
 'نام حساب':'Account name',
 'درآمد ثبت‌شده':'Recorded income',
 'هزینه و خوراک':'Expenses and food',
 'درآمد کل':'Total income',
 'هزینه‌های دیگر':'Other expenses',
 'هزینه خوراک':'Food expenses',
 'موجودی فعلی':'Current balance',
 'هزینه این ماه':'Spent this month',
 'هنوز بودجه‌ای برای ماه ثبت نشده است.':'No budget has been set for this month yet.'
});

function translateTextNode(node,lang){if(!originalTextNodes.has(node))originalTextNodes.set(node,node.nodeValue);const original=originalTextNodes.get(node);const trimmed=original.trim();if(!trimmed)return;if(lang==='fa'){if(node.nodeValue!==original)node.nodeValue=original;return}let translated=translations[trimmed];if(!translated){translated=trimmed;const keys=Object.keys(translations).sort((a,b)=>b.length-a.length);for(const key of keys){if(key.length>=4&&translated.includes(key))translated=translated.split(key).join(translations[key]);}}const leading=original.match(/^\s*/)?.[0]||'';const trailing=original.match(/\s*$/)?.[0]||'';node.nodeValue=leading+translated+trailing}
function translateAttributes(root,lang){const attrs=['placeholder','title','aria-label'];const nodes=[...(root.nodeType===1?[root]:[]),...root.querySelectorAll?.('*')||[]];for(const el of nodes){for(const attr of attrs){const value=el.getAttribute?.(attr);if(!value)continue;const key='data-original-'+attr;if(!el.hasAttribute(key))el.setAttribute(key,value);const original=el.getAttribute(key);el.setAttribute(attr,lang==='en'?(translations[original]||original):original)}}}
function translatePage(lang){const root=document.body;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode()))translateTextNode(node,lang);const keyed={workspace:['فضای مدیریت شخصی','PERSONAL WORKSPACE'],todayOverview:['نمای کلی امروز',"TODAY'S OVERVIEW"],dailyMotivation:['انرژی امروز','DAILY MOTIVATION'],todayTasks:['کارهای امروز',"Today's tasks"],habitProgress:['پیشرفت عادت‌ها','Habit progress'],weeklyActivity:['فعالیت هفتگی','Weekly activity'],quickActions:['دسترسی سریع','Quick actions'],financeTitle:['مدیریت پول','Money management'],financeIntro:['هر پولی که می‌گیری یا خرج می‌کنی، در جای خودش ثبت کن.','Record money you receive or spend in the right place.'],accountBalanceTitle:['موجودی حساب','Account balance'],footerTagline:['مدیریت آگاهانه زمان، انرژی و زندگی','Manage time, energy, and life intentionally']};document.querySelectorAll('[data-i18n]').forEach(el=>{const pair=keyed[el.dataset.i18n];if(pair)el.textContent=pair[lang==='en'?1:0]});document.querySelectorAll('[data-fa][data-en]').forEach(el=>{el.textContent=el.dataset[lang]||el.dataset.fa});translateAttributes(root,lang);document.documentElement.lang=lang;document.documentElement.dir=lang==='fa'?'rtl':'ltr';$('langToggle').textContent=lang==='fa'?'EN':'فا';document.querySelectorAll('.bottom-nav-label').forEach(label=>{label.textContent=label.dataset[lang]||label.dataset.fa});refreshGroupedNavigation();const titles={fa:{dashboard:'داشبورد',planner:'برنامه‌ریزی',calendar:'تقویم و رویدادها',habits:'عادت‌ها',goals:'اهداف و پروژه‌ها',notes:'یادداشت‌ها و کتابخانه',finance:'مدیریت مالی',health:'سلامتی',focus:'تمرکز و زمان',reports:'گزارش‌ها',settings:'تنظیمات',shopping:'لیست خرید',more:'بیشتر',weekplan:'برنامه هفتگی',reminders:'یادآورها',challenges:'چالش‌ها',study:'درس و امتحان',spending:'سقف خرج روزانه',wishlist:'لیست آرزوها',monthly:'گزارش ماهانه',skills:'ردیاب مهارت‌ها',applock:'قفل برنامه'},en:{dashboard:'Dashboard',planner:'Tasks',calendar:'Calendar',habits:'Habits',goals:'Goals & projects',notes:'Notes & library',finance:'Finance',health:'Health',focus:'Focus & time',reports:'Reports',settings:'Settings',shopping:'Shopping list',more:'More',weekplan:'Weekly plan',reminders:'Reminders',challenges:'Challenges',study:'Study & exams',spending:'Daily spending limit',wishlist:'Wishlist',monthly:'Monthly report',skills:'Skills tracker',applock:'App lock'}};$('pageTitle').textContent=titles[lang][currentPage]||'Start Planning';document.title=lang==='fa'?'شروع برنامه‌ریزی | Start Planning':'Start Planning | Personal Planner';const appleTitle=document.querySelector('meta[name="apple-mobile-web-app-title"]');if(appleTitle)appleTitle.content=lang==='fa'?'شروع برنامه‌ریزی':'Start Planning';const description=document.querySelector('meta[name="description"]');if(description)description.content=lang==='fa'?'شروع برنامه‌ریزی؛ دستیار ساده برای مدیریت کارها، عادت‌ها و زندگی':'Start Planning — a simple personal planner for tasks, habits, and everyday life';document.querySelectorAll('[data-brand]').forEach(el=>el.textContent=lang==='fa'?'شروع برنامه‌ریزی':'Start Planning')}
Object.assign(translations,{
 'خلاصه عملکرد':'Performance overview','گزارش کامل':'Full report','افزودن فعالیت':'Add activity','ثبت یک نوبت':'Log one session','＋ ثبت یک نوبت':'＋ Log one session','− اصلاح':'− Undo one entry','تعداد دفعات در روز یا هفته':'Times per day or week','هدف روزانه یا هفتگی':'Daily or weekly target','ثبت تراکنش':'Add transaction','هر واریز یا برداشتی را با عنوان و تاریخ ثبت کن.':'Record each deposit or withdrawal with a title and date.','عنوان؛ مثلاً حقوق، خرید یا خوراک':'Title, e.g. salary, shopping, or food','موجودی اولیه را ثبت کن؛ واریزها و برداشت‌های بعدی به‌صورت جداگانه روی آن اعمال می‌شوند.':'Set your opening balance; later deposits and withdrawals are applied separately.','موجودی فعلی = موجودی اولیه + واریزها − برداشت‌ها.':'Current balance = opening balance + deposits − withdrawals.','ذخیره موجودی اولیه':'Save opening balance','تاریخچه تراکنش‌ها':'Transaction history','جدیدترین موارد در ابتدا':'Newest entries first','هنوز تراکنشی ثبت نشده است.':'No transactions have been recorded yet.','ساعت خوابیدن':'Bedtime','ساعت بیدارشدن':'Wake-up time','اگر بعد از نیمه‌شب بیدار می‌شوی، تاریخ همان روزی را انتخاب کن که از خواب بیدار شده‌ای.':'If you wake up after midnight, select the date you woke up.','محاسبه و ثبت خواب':'Calculate and save sleep','کم‌خوابی':'Too little sleep','خواب کافی':'Healthy sleep duration','خواب‌بیش‌ازحد':'Too much sleep','چالش روزانه':'Daily challenge','روز ثبت‌شده':'days logged','از':'of','شروع چالش':'Start challenge','۳ روزه':'3 days','۷ روزه':'7 days','۳۰ روزه':'30 days','مانده خالص این ماه:':'Net balance this month:','درآمد و واریز':'Income and deposits','هزینه و برداشت':'Expenses and withdrawals','نوبت عادت‌ها':'Habit sessions','تراکنش‌های مالی':'Financial transactions','جلسات مطالعه':'Study sessions','زمان فعالیت':'Activity time','موجودی فعلی':'Current balance','کل واریزها':'Total deposits','کل برداشت‌ها':'Total withdrawals','واریز به حساب':'Deposit','برداشت از حساب':'Withdrawal','ثبت خواب':'Log sleep','چالش‌ها':'Challenges','روزانه':'Daily','هفتگی':'Weekly','خاطره':'Memory','ایده':'Idea'
});
function setLanguage(lang){const value=lang==='en'?'en':'fa';localStorage.setItem('life-lang',value);translatePage(value);if(typeof renderAll==='function')renderAll();if(typeof cloudUi==='function')cloudUi();if(typeof setupPWA==='function')setupPWA();}
let languageObserver;
function startLanguageObserver(){if(languageObserver)languageObserver.disconnect();languageObserver=new MutationObserver(changes=>{const lang=localStorage.getItem('life-lang')||'fa';for(const change of changes){for(const node of change.addedNodes){if(node.nodeType===Node.TEXT_NODE)translateTextNode(node,lang);else if(node.nodeType===Node.ELEMENT_NODE){const walker=document.createTreeWalker(node,NodeFilter.SHOW_TEXT);let textNode;while((textNode=walker.nextNode()))translateTextNode(textNode,lang);translateAttributes(node,lang)}}}});languageObserver.observe(document.body,{childList:true,subtree:true});}
function setupBackup(){$('exportBtn').onclick=()=>{const payload={app:'Start Planning',version:1,exportedAt:new Date().toISOString(),records,settings:{theme:localStorage.getItem('life-theme'),lang:localStorage.getItem('life-lang'),currency:localStorage.getItem('life-currency'),accent:localStorage.getItem('life-accent'),waterTarget:localStorage.getItem('life-water-target'),accounts:localStorage.getItem('life-accounts'),mainAccount:localStorage.getItem('life-main-account'),accountSettings:localStorage.getItem('life-account-settings')}};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=`life-os-backup-${today()}.json`;a.click();URL.revokeObjectURL(url);$('backupStatus').textContent='فایل پشتیبان آماده شد.'};$('importFile').onchange=async e=>{const file=e.target.files[0];if(!file)return;try{const data=JSON.parse(await file.text());if(!Array.isArray(data.records))throw Error('invalid');if(!confirm(uiText(`بازیابی ${data.records.length} رکورد؟ داده‌های فعلی جایگزین می‌شوند.`)))return;records=data.records;await persist();const s=data.settings||{};Object.entries({'life-theme':s.theme,'life-lang':s.lang,'life-currency':s.currency,'life-accent':s.accent,'life-water-target':s.waterTarget,'life-accounts':s.accounts,'life-main-account':s.mainAccount,'life-account-settings':s.accountSettings}).forEach(([k,v])=>{if(v!==null&&v!==undefined)localStorage.setItem(k,v)});setupSettings();renderAll();$('backupStatus').textContent='بازیابی با موفقیت انجام شد.'}catch(err){toast('فایل پشتیبان معتبر نیست')}e.target.value=''};$('clearData').onclick=async()=>{if(!confirm(uiText('تمام اطلاعات این برنامه برای همیشه حذف شود؟ ابتدا از اطلاعات پشتیبان بگیر.')))return;records=[];await persist();localStorage.removeItem('life-accounts');localStorage.removeItem('life-main-account');localStorage.removeItem('life-account-settings');renderAll();toast('اطلاعات پاک شد')}}
function setupPWA(){
 const isIOS=/iphone|ipad|ipod/i.test(navigator.userAgent);
 const isStandalone=window.matchMedia('(display-mode: standalone)').matches||window.navigator.standalone===true;
 const isLocalhost=['localhost','127.0.0.1','[::1]'].includes(location.hostname);
 const secure=location.protocol==='https:'||isLocalhost;
 const status=$('pwaStatus'),button=$('installBtn');
 if(isStandalone)status.textContent=uiText('برنامه روی دستگاه نصب شده است.');
 else if(!secure){status.textContent=uiText('برای نصب، سایت باید با HTTPS باز شود؛ فایل محلی برای نصب کافی نیست.');button.hidden=true}
 else if(isIOS){status.textContent=uiText('در آیفون: سایت را در Safari باز کن، Share و سپس Add to Home Screen را بزن.');button.hidden=true}
 else status.textContent=uiText('برای نصب مستقل، از منوی Chrome گزینه Install app را انتخاب کن؛ گزینه Create shortcut فقط میان‌بر می‌سازد.');
 if(deferredInstall)button.hidden=false;
 button.onclick=async()=>{if(!deferredInstall){status.textContent=uiText('اگر دکمه نصب فعال نشد، از منوی Chrome گزینه Install app را انتخاب کن؛ Create shortcut را انتخاب نکن.');return}deferredInstall.prompt();const choice=await deferredInstall.userChoice;status.textContent=uiText(choice?.outcome==='accepted'?'درخواست نصب پذیرفته شد.':'نصب انجام نشد؛ از منوی Chrome گزینه Install app را بررسی کن.');deferredInstall=null;button.hidden=true};
 if('serviceWorker'in navigator&&secure){navigator.serviceWorker.register('./sw.js',{scope:'./'}).then(reg=>reg.update()).catch(err=>{console.error('Service worker registration failed',err);status.textContent=uiText('ثبت سرویس‌ورکر ناموفق بود. فایل sw.js باید در ریشه سایت منتشر شده باشد.')})}
}
function bindFinanceForms(){const savingsForm=$('savingsForm');if(savingsForm)savingsForm.addEventListener('submit',async e=>{e.preventDefault();const d=formData(savingsForm),amount=Number(d.amount);if(!Number.isFinite(amount)||amount<=0){toast('مبلغ پس‌انداز معتبر وارد کن');return}if(accountBalance().balance<amount){toast('موجودی قابل‌خرج برای این پس‌انداز کافی نیست');return}const saved=await add('savings',{title:String(d.title||'پس‌انداز').trim(),amount,date:d.date||today()});if(saved){savingsForm.reset();if(savingsForm.elements.date)savingsForm.elements.date.value=today()}});const form=$('transactionForm');if(!form)return;form.addEventListener('submit',async e=>{e.preventDefault();const d=formData(form),amount=Number(d.amount),direction=d.direction;if(!Number.isFinite(amount)||amount<=0||!['deposit','withdraw'].includes(direction)){toast('نوع تراکنش و مبلغ را بررسی کن');return}if(!String(d.category||'').trim()){toast('عنوان تراکنش را وارد کن');return}if(direction==='withdraw'&&accountBalance().balance<amount){toast('موجودی حساب برای این برداشت کافی نیست');return}const saved=await add('balanceAdjustment',{direction,amount,category:String(d.category).trim(),date:d.date||today(),memo:String(d.memo||'').trim()});if(saved){form.reset();if(form.elements.date)form.elements.date.value=today()}})}

function bindAll(){bindForm('taskForm','task',r=>({...r,done:false,estimatedMinutes:undefined}));bindForm('eventForm','event');bindForm('habitForm','habit',r=>({...r,target:Number(r.target)||1,logs:[]}));bindForm('goalForm','goal',r=>({...r,steps:Number(r.steps)||1,doneSteps:0}));bindForm('noteForm','note');bindFinanceForms();
const accountForm=$('accountForm');if(accountForm)accountForm.addEventListener('submit',async e=>{e.preventDefault();const d=formData(accountForm),opening=Number(d.openingBalance);if(!d.accountName.trim()||!Number.isFinite(opening)||opening<0){toast('نام حساب و موجودی اولیه معتبر وارد کن');return}const account=getMainAccount();account.name=d.accountName.trim();account.opening=opening;localStorage.setItem('life-main-account',JSON.stringify(account));localStorage.setItem('life-accounts',JSON.stringify([account]));renderAll();accountForm.elements.openingBalance.value='';toast('موجودی اولیه ذخیره شد')});
const balanceActionForm=$('balanceActionForm');if(balanceActionForm)balanceActionForm.addEventListener('submit',async e=>{e.preventDefault();const d=formData(balanceActionForm),amount=Number(d.amount),direction=d.direction;if(!Number.isFinite(amount)||amount<=0||!['deposit','withdraw'].includes(direction)){toast('نوع عملیات و مبلغ را بررسی کن');return}if(direction==='withdraw'&&accountBalance().balance<amount){toast('موجودی حساب برای این برداشت کافی نیست');return}const saved=await add('balanceAdjustment',{direction,amount,category:(d.category||'').trim(),date:d.date||today(),memo:(d.memo||'').trim()});if(saved){balanceActionForm.reset();if(balanceActionForm.elements.date)balanceActionForm.elements.date.value=today()}});
bindForm('waterForm','health',r=>({kind:'water',label:'مصرف آب',value:`${r.ml} ml`,amount:Number(r.ml),date:today()}));$('sleepForm').addEventListener('submit',async e=>{e.preventDefault();const f=e.currentTarget,start=f.elements.sleepStart.value,end=f.elements.wakeTime.value;if(!start||!end){toast('ساعت خواب و بیداری را وارد کن');return}let a=Number(start.slice(0,2))*60+Number(start.slice(3)),b=Number(end.slice(0,2))*60+Number(end.slice(3));if(b<=a)b+=1440;const minutes=b-a,hours=minutes/60,status=hours<7?'کم‌خوابی':hours<=9?'خواب کافی':'خواب بیش‌ازحد';const saved=await add('health',{kind:'sleep',label:'خواب',sleepStart:start,wakeTime:end,minutes,value:`${hours.toFixed(1)} ساعت · ${status}`,date:f.elements.date.value||today()});if(saved){f.reset();if(f.elements.date)f.elements.date.value=today()}});bindForm('workoutForm','health',r=>({kind:'workout',label:'ورزش: '+r.activity,value:`${r.minutes} دقیقه`,date:r.date||today()}));bindForm('weightForm','health',r=>({kind:'weight',label:'وزن',value:`${r.kg} kg`,date:r.date||today()}));bindForm('timeForm','time',r=>({...r,minutes:Number(r.minutes),date:r.date||today()}));
bindForm('readingForm','reading',r=>({...r,pages:Number(r.pages),currentPage:Math.min(Number(r.pages),Number(r.currentPage)||0)}));
bindForm('gratitudeForm','gratitude',r=>({...r,date:r.date||today()}));
bindForm('moodForm','mood',r=>({...r,date:r.date||today()}));
bindForm('mealForm','meal',r=>({...r,date:r.date||today()}));
bindForm('shoppingForm','shopping',r=>({...r,bought:false}));
$('eventForm').addEventListener('submit',()=>{const cb=$('eventForm').elements.remind;if(cb&&cb.checked&&'Notification'in window&&Notification.permission==='default')Notification.requestPermission()});
$('clearBought').onclick=async()=>{records=records.filter(r=>!(r.type==='shopping'&&r.bought));await persist();renderShopping();toast('موارد خریداری‌شده پاک شدند')};
$('taskFilter').onchange=renderTasks;$('noteSearch').oninput=renderNotes;document.querySelectorAll('#mainNav [data-page]').forEach(b=>b.onclick=()=>showPage(b.dataset.page));setupGroupedNavigation();document.querySelectorAll('[data-go]').forEach(b=>b.onclick=()=>showPage(b.dataset.go));$('menuToggle').onclick=()=>$('sidebar').classList.toggle('open');document.querySelectorAll('[data-quick]').forEach(b=>b.onclick=()=>{const map={task:'planner',note:'notes',expense:'finance',water:'health'};showPage(map[b.dataset.quick]);toast('فرم مربوطه را تکمیل کن')});bindNewModules();}
function clock(){const now=new Date(),lang=localStorage.getItem('life-lang')||'fa',faDate=now.toLocaleDateString('fa-IR-u-ca-persian',{weekday:'long',year:'numeric',month:'long',day:'numeric'}),enDate=now.toLocaleDateString('en-GB',{weekday:'long',year:'numeric',month:'long',day:'numeric'}),clockEl=$('liveClock'),dateEl=$('todayDate'),greetingEl=$('greeting');if(clockEl)clockEl.textContent=now.toLocaleTimeString(lang==='fa'?'fa-IR':'en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'});if(greetingEl)greetingEl.textContent=lang==='fa'?'امروز':'Today';if(dateEl)dateEl.textContent=lang==='fa'?`شمسی: ${faDate}  |  میلادی: ${enDate}`:`Persian: ${faDate}  |  Gregorian: ${enDate}`;}
const onboardingMenuSteps=[
 {group:'home',icon:'⌂',faTitle:'منوی خانه',faBody:'برای دیدن نمای کلی برنامه و کارهای امروز وارد خانه شو.',enTitle:'Home menu',enBody:'Open Home to see your overview and today’s tasks.'},
 {group:'plan',icon:'▦',faTitle:'منوی برنامه‌ریزی',faBody:'کارها، تقویم، برنامه هفتگی، یادآورها و مطالعه اینجاست.',enTitle:'Plan menu',enBody:'Tasks, calendar, weekly plan, reminders, and study are here.'},
 {group:'life',icon:'✦',faTitle:'منوی زندگی',faBody:'عادت‌ها، اهداف، چالش‌ها، مهارت‌ها، سلامت و تمرکز را اینجا پیدا می‌کنی.',enTitle:'Life menu',enBody:'Find habits, goals, challenges, skills, health, and focus here.'},
 {group:'notes',icon:'✎',faTitle:'منوی یادداشت‌ها',faBody:'برای نوشتن و نگهداری یادداشت‌ها وارد این منو شو.',enTitle:'Notes menu',enBody:'Open this menu to write and keep your notes.'},
 {group:'money',icon:'◈',faTitle:'منوی مالی',faBody:'درآمد و هزینه، سقف خرج، خریدها و گزارش‌های مالی اینجاست.',enTitle:'Money menu',enBody:'Income, expenses, spending limits, shopping, and financial reports are here.'},
 {group:'settings',icon:'⚙',faTitle:'منوی تنظیمات',faBody:'زبان، ظاهر برنامه، پشتیبان‌گیری و قفل برنامه را از اینجا مدیریت کن.',enTitle:'Settings menu',enBody:'Manage language, appearance, backups, and app lock here.'}
];
const onboardingSteps=[
  {page:'dashboard',target:'.hero-card',faTitle:'خانه و نمای کلی',faBody:'این صفحه نقطه شروع برنامه است. بالای صفحه تاریخ شمسی و میلادی و ساعت زنده را می‌بینی. پایین‌تر، کارهای امروز، پیشرفت عادت‌ها، فعالیت هفتگی و میان‌برهای ثبت سریع قرار دارند. برای شروع روز، ابتدا کارهای امروز را مرور کن و از میان‌برها برای ثبت سریع استفاده کن.',enTitle:'Home & overview',enBody:'This is your starting point. The live clock and both calendar dates appear at the top. Below them you can review today’s tasks, habit progress, weekly activity, and quick actions. Start by checking today’s tasks, then use the shortcuts to add a task, note, expense, or water entry.'},
  {page:'planner',target:'#taskForm',faTitle:'کارها و برنامه‌ریزی',faBody:'در این فرم عنوان کار، اولویت، تاریخ، ساعت شروع و پایان و در صورت نیاز نام پروژه را وارد کن. مدت کار از روی ساعت شروع و پایان محاسبه می‌شود. بعد از ثبت، کار در فهرست پایین صفحه قرار می‌گیرد؛ می‌توانی آن را انجام‌شده علامت بزنی یا ویرایش و حذف کنی.',enTitle:'Tasks & planning',enBody:'Use this form to enter a task title, priority, date, start and end times, and an optional project. The duration is calculated from the start and end times. Saved tasks appear below, where you can complete, edit, or delete them.'},
  {page:'calendar',target:'#eventForm',faTitle:'تقویم و رویدادها',faBody:'برای قرارها و مناسبت‌ها عنوان و تاریخ وارد کن و در صورت نیاز ساعت، نوع رویداد و توضیحات را هم بنویس. اگر اعلان را فعال کنی، مرورگر در صورت پشتیبانی و داشتن مجوز می‌تواند یادآوری کند. تقویم و فهرست رویدادهای ثبت‌شده در پایین همین صفحه‌اند.',enTitle:'Calendar & events',enBody:'Add appointments and events by entering a title and date, then optionally set a time, category, and details. Enable notifications if you want browser reminders and have granted permission. The calendar and your saved event list are shown below the form.'},
  {page:'weekplan',target:'.panel',faTitle:'برنامه هفتگی',faBody:'در این بخش برنامه هفت روز آینده را یک‌جا مرور می‌کنی. کارها و رویدادهای نزدیک را کنار هم ببین تا تداخل زمانی را تشخیص بدهی و برای روزهای پیش رو برنامه‌ریزی کنی.',enTitle:'Weekly plan',enBody:'Review your upcoming seven days in one place. Tasks and nearby events are brought together so you can spot scheduling conflicts and plan the days ahead.'},
  {page:'reminders',target:'.panel',faTitle:'یادآورها',faBody:'برای کاری که نباید فراموش شود، عنوان و زمان یادآوری را ثبت کن. یادآورها در فهرست همین صفحه نمایش داده می‌شوند. برای دریافت اعلان، مجوز اعلان مرورگر باید فعال باشد.',enTitle:'Reminders',enBody:'Create a reminder by entering what you need to remember and when it should alert you. Your reminders appear in the list on this page. Browser notification permission must be enabled to receive alerts.'},
  {page:'study',target:'.panel',faTitle:'مطالعه و درس',faBody:'جلسه‌های مطالعه را با موضوع، مدت و تاریخ ثبت کن و در صورت نیاز تاریخ امتحان‌ها را هم نگه دار. فهرست این صفحه به تو کمک می‌کند سابقه مطالعه و برنامه درسی‌ات را مرور کنی.',enTitle:'Study & exams',enBody:'Log study sessions with a subject, duration, and date, and keep exam dates when needed. The lists on this page help you review your study history and upcoming academic plans.'},
  {page:'habits',target:'#habitForm',faTitle:'ردیاب عادت‌ها',faBody:'نام عادت را بنویس، مشخص کن روزانه است یا هفتگی و تعداد دفعات موردنظر را تعیین کن؛ مثلاً مطالعه سه نوبت در روز. پس از ساخت عادت، هر بار انجام آن را با «ثبت یک نوبت» جداگانه ثبت کن. شمارنده و نوار پیشرفت، میزان انجام هدف را نشان می‌دهند.',enTitle:'Habits',enBody:'Name the habit, choose daily or weekly frequency, and set a target count—for example, three reading sessions per day. After creating it, tap “Log session” each time you complete it. The counter and progress bar show how close you are to the target.'},
  {page:'goals',target:'#goalForm',faTitle:'اهداف و پروژه‌ها',faBody:'هدف را با یک عنوان روشن ثبت کن، در صورت تمایل مهلت و تعداد مرحله‌ها را مشخص کن و نوع هدف را انتخاب کن. بعد از ساخت، با دکمه‌های افزودن یا کم‌کردن مرحله میزان پیشرفت را به‌روز کن. نوار پیشرفت و امتیاز تجربه در همین صفحه وضعیتت را نشان می‌دهند.',enTitle:'Goals & projects',enBody:'Create a goal with a clear title, optional deadline, number of milestones, and time horizon. After saving it, use the milestone controls to update progress. The progress bar and experience panel help you see how far you have come.'},
  {page:'challenges',target:'.panel',faTitle:'چالش‌ها',faBody:'برای خودت یک چالش با مدت و هدف مشخص بساز. پیشرفت هر روز را جداگانه ثبت کن تا حتی چالش‌های کوتاه چندروزه هم قابل پیگیری باشند. وضعیت روزهای انجام‌شده در کارت همان چالش دیده می‌شود.',enTitle:'Challenges',enBody:'Create a challenge with a clear goal and duration. Log each day separately, so short challenges lasting only a few days are tracked correctly. Completed days are shown on the challenge card.'},
  {page:'skills',target:'.panel',faTitle:'مهارت‌ها',faBody:'مهارت‌هایی را که در حال یادگیری هستی ثبت کن و برای تمرین آن‌ها زمان بگذار. با به‌روزرسانی میزان تمرین می‌توانی روند یادگیری و مهارت‌هایی را که روی آن‌ها کار می‌کنی دنبال کنی.',enTitle:'Skills',enBody:'Add the skills you are learning and record time spent practicing them. Update your practice entries to follow your learning progress and see which skills you are actively developing.'},
  {page:'health',target:'#waterForm',faTitle:'سلامت و سبک زندگی',faBody:'در این بخش می‌توانی آب مصرفی، خواب، ورزش و وزن را ثبت کنی. هر فرم برای یک نوع ثبت طراحی شده است؛ برای خواب ساعت خواب و بیداری را وارد کن تا مدت آن محاسبه شود. ثبت‌های قبلی در فهرست‌های همین صفحه نمایش داده می‌شوند.',enTitle:'Health & wellbeing',enBody:'Use this section to track water intake, sleep, exercise, and weight. Each form records a different type of wellness activity. For sleep, enter your bedtime and wake-up time so the duration can be calculated. Previous entries appear in the lists on this page.'},
  {page:'focus',target:'.timer-panel',faTitle:'تمرکز و مدیریت زمان',faBody:'با تایمر پومودورو مدت تمرکز و استراحت را تنظیم و جلسه را شروع کن؛ هر زمان لازم بود مکث یا بازنشانی را بزن. در پنل کنار تایمر نیز می‌توانی مدت زمانی را که برای یک فعالیت صرف کرده‌ای با نام و تاریخ ثبت کنی.',enTitle:'Focus & time management',enBody:'Set your focus and break durations in the Pomodoro timer, then start a session. Pause or reset it whenever needed. In the adjacent panel, log time spent on an activity by entering its name, duration, and date.'},
  {page:'notes',target:'#noteForm',faTitle:'یادداشت‌ها و کتابخانه',faBody:'برای نگهداری ایده‌ها، خاطره‌ها و اطلاعات مهم، عنوان و دسته‌بندی انتخاب کن و متن را در کادر یادداشت بنویس. همین صفحه ابزار جداگانه‌ای برای ثبت کتاب و پیگیری صفحه فعلی، دفتر قدردانی و جست‌وجوی یادداشت‌ها دارد.',enTitle:'Notes & library',enBody:'Save ideas, memories, and useful information by entering a title, choosing a category, and writing the note. This page also includes a separate book tracker with page progress, a daily gratitude journal, and note search.'},
  {page:'finance',target:'#transactionForm',faTitle:'مدیریت مالی',faBody:'ابتدا موجودی اولیه حساب را در بخش موجودی حساب تنظیم کن. سپس هر دریافت یا پرداخت را از فرم تراکنش با نوع، مبلغ، عنوان و تاریخ ثبت کن. موجودی و گزارش تراکنش‌ها با ثبت هر عملیات به‌روزرسانی می‌شوند؛ پس از ثبت، فهرست تراکنش‌ها را برای بررسی یا اصلاح ببین.',enTitle:'Finance',enBody:'First set your opening balance in the account section. Then record each deposit or withdrawal using the transaction form, including its amount, label, and date. Your balance and transaction history update as you add entries; review the list below to inspect or correct them.'},
  {page:'spending',target:'.panel',faTitle:'سقف خرج روزانه',faBody:'محدودیت هزینه روزانه را تعیین کن تا بتوانی خرج‌های ثبت‌شده را با آن مقایسه کنی. این ابزار برای کنترل روند هزینه‌هاست و جای ثبت تراکنش در بخش مالی را نمی‌گیرد.',enTitle:'Daily spending limit',enBody:'Set a daily spending limit and compare it with your recorded expenses. This tool helps you monitor spending; it does not replace recording transactions in the Finance section.'},
  {page:'shopping',target:'#shoppingForm',faTitle:'لیست خرید',faBody:'نام کالا را وارد کن و در صورت نیاز مقدار و دسته‌بندی آن را مشخص کن. پس از افزودن، کالا در فهرست پایین صفحه قرار می‌گیرد؛ بعد از خرید آن را علامت بزن. می‌توانی موارد خریداری‌شده را یک‌جا پاک کنی.',enTitle:'Shopping list',enBody:'Enter an item name and optionally add its quantity and category. Saved items appear in the list below. Check an item off after purchasing it, or clear all purchased items together.'},
  {page:'wishlist',target:'.panel',faTitle:'لیست آرزوها',faBody:'چیزهایی را که قصد خرید یا تهیه آن‌ها را داری ذخیره کن. برای هر مورد می‌توانی عنوان و اولویت مشخص کنی و بعداً فهرست را مرور یا موارد انجام‌شده را مدیریت کنی.',enTitle:'Wishlist',enBody:'Save items you may want to buy or obtain later. Add a title and priority for each item, then revisit the list and manage items as your plans change.'},
  {page:'monthly',target:'.panel',faTitle:'گزارش ماهانه',faBody:'سال و ماه موردنظر را از انتخاب‌گر شمسی مشخص کن و گزارش همان بازه را ببین. این صفحه برای مرور ماه‌به‌ماه فعالیت‌ها و شاخص‌های ثبت‌شده است؛ با تغییر ماه، گزارش به‌روز می‌شود.',enTitle:'Monthly report',enBody:'Choose the Persian year and month you want to review, then inspect the report for that exact period. This page summarizes recorded activity and metrics month by month; changing the selection refreshes the report.'},
  {page:'reports',target:'.report-overview',faTitle:'گزارش‌ها و تحلیل عملکرد',faBody:'این صفحه نمای کلی عملکرد را در کارها، عادت‌ها و فعالیت‌ها خلاصه می‌کند. نمودارها وضعیت مالی و ریتم فعالیت هفتگی را نشان می‌دهند و نقشه پیوستگی، روزهای فعال را مشخص می‌کند. برای بررسی جزئیات هر ماه، از دکمه گزارش ماهانه استفاده کن.',enTitle:'Reports & performance',enBody:'This page summarizes your tasks, habits, and activity. Charts show your financial overview and weekly activity rhythm, while the consistency map highlights active days. Use the Monthly report button when you want to inspect a specific month in more detail.'},
  {page:'settings',target:'.settings-grid',faTitle:'تنظیمات و پشتیبان‌گیری',faBody:'از این صفحه زبان فارسی یا انگلیسی، تم روشن یا تاریک، رنگ اصلی و واحد پول را انتخاب کن. همچنین می‌توانی از اطلاعاتت نسخه پشتیبان بگیری یا آن را بازیابی کنی و راهنمای برنامه را دوباره اجرا کنی.',enTitle:'Settings & backup',enBody:'Choose Persian or English, light or dark theme, an accent color, and your currency here. You can also back up or restore your data and replay this app guide whenever you need it.'},
  {page:'applock',target:'.panel',faTitle:'قفل برنامه',faBody:'اگر می‌خواهی دسترسی به برنامه محدود باشد، از این بخش یک رمز ورود تنظیم یا مدیریت کن. رمز را در جای امنی نگه دار؛ این قفل ساده برای محافظت محلی از ورود به برنامه است.',enTitle:'App lock',enBody:'If you want to restrict access to the app, set or manage a passcode here. Keep the passcode somewhere safe; this is a basic local access lock.'},
 ];
onboardingSteps.forEach(step=>step.icon=({dashboard:'🏠',planner:'📝',calendar:'📅',weekplan:'🗓️',reminders:'🔔',study:'📖',habits:'🔁',goals:'🎯',challenges:'🏆',skills:'🧠',health:'💧',focus:'⏱️',notes:'📚',finance:'💳',spending:'💰',shopping:'🛒',wishlist:'⭐',monthly:'📆',reports:'📊',settings:'⚙️',applock:'🔒'})[step.page]||'🧭');
let onboardingIndex=0;
let onboardingActive=false;
function onboardingText(step,index,lang){
 if(step?.kind==='menu')return {title:lang==='en'?step.enTitle:step.faTitle,body:lang==='en'?step.enBody:step.faBody};
 const isFirst=index===0, pageStep=step;
 const title=lang==='en'?(isFirst?'Welcome to Start Planning':pageStep.enTitle):(isFirst?'به شروع برنامه‌ریزی خوش آمدی':pageStep.faTitle);
 const body=lang==='en'?(isFirst?'First, let’s look at the main menus. Then we’ll visit the sections inside them.':pageStep.enBody):(isFirst?'اول منوهای اصلی را می‌بینیم؛ بعد بخش‌های داخل هر منو را یکی‌یکی مرور می‌کنیم.':pageStep.faBody);
 return {title,body};
}
function onboardingTarget(page,step){
 if(step?.kind==='menu'){
  const nav=document.querySelector(`.bottom-nav-item[data-group="${step.group}"]`);
  const panel=$('navGroupPanel');
  return nav?{menu:true,nav,panel:step.group==='home'?null:panel}:null;
 }
 const root=document.getElementById('page-'+page);
 if(!root)return null;
 const found=step?.target?root.querySelector(step.target):null;
 return found||root.querySelector('.hero-card, .section-intro, .panel, form')||root;
}
function renderOnboarding(){
 const overlay=$('onboardingGuide'); if(!overlay||!onboardingActive)return;
 const lang=localStorage.getItem('life-lang')||'fa';
 const menuCount=onboardingMenuSteps.length,total=menuCount+onboardingSteps.length;
 const isMenu=onboardingIndex<menuCount;
 const step=isMenu?{...onboardingMenuSteps[onboardingIndex],kind:'menu'}:onboardingSteps[onboardingIndex-menuCount];
 const page=isMenu?'dashboard':step?.page||'dashboard';
 if(!isMenu&&currentPage!==page)showPage(page);
 document.querySelectorAll('.tour-highlight').forEach(el=>el.classList.remove('tour-highlight'));
 if(isMenu){if(step.group==='home')closeNavGroup();else openNavGroup(step.group)}else closeNavGroup();
 const target=onboardingTarget(page,step),spotlight=$('onboardingSpotlight'),card=$('onboardingCard');
 const copy=onboardingText(step,onboardingIndex,lang);
 $('onboardingTitle').textContent=copy.title;$('onboardingBody').textContent=copy.body;$('onboardingIcon').textContent=step?.icon||'🧭';
 $('onboardingProgress').textContent=lang==='en'?`${onboardingIndex+1} of ${total}`:`${onboardingIndex+1} از ${total}`;
 $('onboardingPrev').textContent=lang==='en'?'Previous':'قبلی';
 $('onboardingNext').textContent=onboardingIndex===total-1?(lang==='en'?'Finish':'پایان'):(lang==='en'?'Next':'بعدی');
 $('onboardingSkip').textContent=lang==='en'?'Skip':'رد کردن';$('onboardingPrev').disabled=onboardingIndex===0;
 overlay.hidden=false;overlay.setAttribute('dir',lang==='en'?'ltr':'rtl');spotlight.hidden=!target;card.style.transform='none';
 requestAnimationFrame(()=>{
  if(!target){card.style.left='12px';card.style.right='12px';card.style.top='50%';card.style.bottom='auto';card.style.transform='translateY(-50%)';return;}
  if(target.menu){
   const a=target.nav.getBoundingClientRect(),b=target.panel?.hidden?null:target.panel?.getBoundingClientRect();
   const left=Math.min(a.left,b?.left??a.left),top=Math.min(a.top,b?.top??a.top),right=Math.max(a.right,b?.right??a.right),bottom=Math.max(a.bottom,b?.bottom??a.bottom);
   const r={left,top,right,bottom,width:right-left,height:bottom-top};
   const ch=card.offsetHeight||150,gap=12;let cardTop=r.top>=ch+gap+8?r.top-ch-gap:Math.max(8,Math.min(innerHeight-ch-8,r.bottom+gap));
   spotlight.style.left=Math.max(4,r.left-4)+'px';spotlight.style.top=Math.max(4,r.top-4)+'px';spotlight.style.width=Math.min(innerWidth-8,r.width+8)+'px';spotlight.style.height=Math.min(innerHeight-8,r.height+8)+'px';
   card.style.top=cardTop+'px';card.style.bottom='auto';card.style.left='10px';card.style.right='10px';return;
  }
  target.scrollIntoView({behavior:'auto',block:'center',inline:'nearest'});
  requestAnimationFrame(()=>{
   const r=target.getBoundingClientRect(),pad=7;spotlight.style.left=Math.max(5,r.left-pad)+'px';spotlight.style.top=Math.max(5,r.top-pad)+'px';spotlight.style.width=Math.min(innerWidth-10,r.width+pad*2)+'px';spotlight.style.height=Math.min(innerHeight-10,r.height+pad*2)+'px';
   const ch=card.offsetHeight||160,gap=12;let top=r.top>=ch+gap+10?Math.max(8,r.top-ch-gap):innerHeight-r.bottom>=ch+gap+10?Math.min(innerHeight-ch-8,r.bottom+gap):(r.top>innerHeight-r.bottom?8:Math.max(8,innerHeight-ch-8));
   card.style.top=top+'px';card.style.bottom='auto';card.style.left='10px';card.style.right='10px';
  });
 });
}

function closeOnboarding(){
 onboardingActive=false;
 $('onboardingGuide')?.setAttribute('hidden','');
 document.querySelectorAll('.tour-highlight').forEach(el=>el.classList.remove('tour-highlight'));
 localStorage.setItem('life-onboarding-done','1');
}
function startOnboarding(force=false,stepIndex=-1,sectionOnly=false){
 if(!force&&localStorage.getItem('life-onboarding-done')==='1')return;
 onboardingIndex=stepIndex>=0?onboardingMenuSteps.length+stepIndex:(sectionOnly?onboardingMenuSteps.length:0);onboardingActive=true;renderOnboarding();
}
function setupOnboarding(){
 $('onboardingNext')?.addEventListener('click',()=>{if(onboardingIndex>=onboardingMenuSteps.length+onboardingSteps.length-1){closeOnboarding();return;}onboardingIndex++;renderOnboarding();});
 $('onboardingPrev')?.addEventListener('click',()=>{if(onboardingIndex>0){onboardingIndex--;renderOnboarding();}});
 $('onboardingSkip')?.addEventListener('click',closeOnboarding);
 $('replayGuide')?.addEventListener('click',()=>startOnboarding(true));
 document.addEventListener('keydown',e=>{if(onboardingActive&&e.key==='Escape')closeOnboarding();});
 document.querySelectorAll('[data-page]').forEach(()=>{});
 onboardingSteps.forEach((step,index)=>{
  const root=$('page-'+step.page); if(!root||root.querySelector('.section-help-button'))return;
  const btn=document.createElement('button'); btn.type='button'; btn.className='section-help-button'; btn.textContent='?';
  btn.setAttribute('aria-label',localStorage.getItem('life-lang')==='en'?'Explain this section':'راهنمای این بخش');
  btn.addEventListener('click',()=>startOnboarding(true,index,true)); root.appendChild(btn);
 });
 const tryFirstRun=()=>{if(localStorage.getItem('life-onboarding-done')!=='1'&&$('lockScreen')?.hidden!==false)startOnboarding(false);};
 if(localStorage.getItem('life-onboarding-done')!=='1')setTimeout(tryFirstRun,1400);
 window.addEventListener('app-unlocked',()=>setTimeout(tryFirstRun,250));
}

Object.assign(translations,{'موجودی فعلی حساب':'Current account balance','نام حساب؛ مثلاً حساب شخصی':'Account name, e.g. personal account','موجودی فعلی = موجودی اولیه + واریزها − برداشت‌ها.':'Available balance = opening balance + deposits − withdrawals − savings.','ذخیره موجودی اولیه':'Save opening balance','تاریخچه تراکنش‌ها':'Transaction history','جدیدترین موارد در ابتدا':'Newest entries first','موجودی اولیه را ثبت کن؛ واریزها و برداشت‌های بعدی به‌صورت جداگانه روی آن اعمال می‌شوند.':'Set your opening balance; later deposits and withdrawals are applied separately.','مانده پس از هزینه و پس‌انداز:':'Balance after expenses and savings:','موجودی قابل‌خرج':'Available balance','مجموع پس‌انداز ثبت‌شده: ':'Total savings recorded: ','پس‌انداز':'Savings','مبلغی را که کنار می‌گذاری ثبت کن؛ از موجودی قابل‌خرج کم می‌شود اما هزینه محسوب نمی‌شود.':'Log money set aside. It reduces spendable balance but is not counted as an expense.','عنوان پس‌انداز؛ مثلاً سفر یا خرید لپ‌تاپ':'Savings label, e.g. trip or laptop','مبلغ پس‌انداز':'Savings amount','＋ ثبت پس‌انداز':'＋ Add savings','مجموع پس‌انداز ثبت‌شده: ':'Total savings recorded: ','گزارش‌ها و تحلیل عملکرد':'Reports and performance','پیشرفتت را در کارها، عادت‌ها، زمان و امور مالی یک‌جا بررسی کن.':'Review your tasks, habits, time, and finances in one place.','عملکرد کلی':'Overall performance','گزارش ماهانه':'Monthly report','وضعیت مالی':'Financial overview','مقایسه مجموع واریزها و برداشت‌ها':'Compare total deposits and withdrawals','ریتم فعالیت هفتگی':'Weekly activity rhythm','تعداد فعالیت‌های ثبت‌شده در هفت روز اخیر':'Recorded activities over the last seven days','پیوستگی فعالیت':'Activity consistency','۳۰ روز اخیر':'Last 30 days','آمار کل داده‌های ثبت‌شده':'All recorded data','کارهای تکمیل‌شده':'Completed tasks','نرخ تکمیل کارها':'Task completion rate','نوبت‌های عادت':'Habit sessions','جلسات مطالعه':'Study sessions','زمان‌های ثبت‌شده':'Time logs','واریزها':'Deposits','برداشت‌ها':'Withdrawals','فعالیت':'activities','خلاصه عملکرد':'Performance overview'});

Object.assign(translations,{
 'امروز':'Today','شمسی:':'Persian:','میلادی:':'Gregorian:','سال شمسی':'Persian year','ماه شمسی':'Persian month',
 'انتخاب ماه':'Select month','فروردین':'Farvardin','اردیبهشت':'Ordibehesht','خرداد':'Khordad','تیر':'Tir','مرداد':'Mordad','شهریور':'Shahrivar','مهر':'Mehr','آبان':'Aban','آذر':'Azar','دی':'Dey','بهمن':'Bahman','اسفند':'Esfand'
});

Object.assign(translations,{
 'برای هر عادت تعداد دفعات موردنظر در روز یا هفته را تعیین کن و هر نوبت را جداگانه ثبت کن.':'Set the target number of times per day or week for each habit, and log every session separately.',
 'یک هدف را چند روز پیگیری کن':'Track one goal over several days.',
 'موجودی قابل‌خرج = موجودی اولیه + واریزها − برداشت‌ها − پس‌انداز.':'Spendable balance = opening balance + deposits − withdrawals − savings.',
 '☾ ثبت خواب':'☾ Log sleep',
 'یک هدف انتخاب کن و پیشرفت هر روز را جداگانه ثبت کن؛ روزهای آینده تا رسیدن تاریخشان غیرفعال می‌مانند.':'Choose a goal and log progress each day. Future days stay locked until their dates arrive.',
 '▶ اجرای دوباره راهنمای برنامه':'▶ Replay app guide',
 'نسخه 1.8.0 · اطلاعات روی همین دستگاه ذخیره می‌شوند.':'Version 1.8.0 · Your data is stored on this device.',
 'رد کردن راهنما':'Skip guide','قبلی':'Previous','بعدی':'Next'
});

Object.assign(translations,{
 'زمان شروع':'Start time','زمان پایان':'End time','توضیح اختیاری':'Optional note','متن یادداشت...':'Note text...',
 'فضای ذخیره‌سازی دستگاه کافی نیست. از بخش تنظیمات پشتیبان بگیر و کمی فضا خالی کن.':'Not enough device storage. Export a backup in Settings and free up some space.',
 'حذف انجام نشد؛ دوباره تلاش کن.':'Could not delete. Please try again.',
 'ذخیره اطلاعات انجام نشد':'Could not save data',
 'مجموع پس‌انداز ثبت‌شده:':'Total savings recorded:'
});

Object.assign(translations,{
 'مرحله':'Step','مهلت':'Deadline','خریداری شد':'Purchased','برگرداندن':'Undo','از سقف روزانه عبور کرده‌ای.':'You have exceeded your daily limit.',
 'هنوز در محدوده بودجه روزانه هستی.':'You are still within your daily limit.','هنوز سقف خرجی تعیین نکرده‌ای.':'You have not set a spending limit yet.',
 'خریداری شده':'purchased','روز متوالی':'day streak','صفحه فعلی':'Current page','تا سطح بعدی:':'To next level:'
});
function cloudMessage(message){
 const el=$('cloudStatus');if(!el)return;
 const en=(localStorage.getItem('life-lang')||'fa')==='en';
 if(en){
  const exact={
   'برای استفاده از ذخیره‌سازی ابری، با ایمیل خود وارد شو.':'Sign in with your email to use cloud storage.',
   'برای ذخیره‌سازی ابری، وارد حساب شو یا حساب جدید بساز. اطلاعات محلی تغییر نمی‌کنند.':'Sign in or create an account to use cloud storage. Your local data will remain unchanged.',
   'کتابخانه اتصال ابری بارگذاری نشد. اینترنت و بارگذاری صفحه را بررسی کن.':'The cloud library could not be loaded. Check your connection and reload the page.',
   'در حال ورود…':'Signing in…','در حال ساخت حساب…':'Creating your account…','در حال خروج…':'Signing out…',
   'لطفاً صبر کن…':'Please wait…','ورود':'Sign in','ایجاد حساب':'Create account',
   'همگام‌سازی انجام نشد: ':'Sync failed: ','ورود انجام نشد: ':'Sign-in failed: ','ثبت‌نام انجام نشد: ':'Sign-up failed: ','خروج انجام نشد: ':'Sign-out failed: ',
   'همگام‌سازی انجام شد. ':'Sync completed. ',' رکورد روی این دستگاه موجود است.':' records are available on this device.',
   'در حال بررسی و همگام‌سازی اطلاعات…':'Checking and syncing your data…',
   'ورود موفق بود: ':'Signed in successfully: ','. همگام‌سازی خودکار فعال شد.':'. Run sync manually to transfer your data.',
   'وارد شده‌ای: ':'Signed in as: ',' · همگام‌سازی خودکار فعال است.':' · Automatic sync is enabled.',
   'تغییرات ذخیره شد؛ همگام‌سازی خودکار در صف است.':'Changes saved; automatic sync is queued.',
   'همگام‌سازی خودکار با موفقیت انجام شد. ':'Automatic sync completed. ',
   'همگام‌سازی انجام نشد؛ تغییرات روی دستگاه در صف می‌مانند: ':'Sync failed; changes remain queued on this device: ',
   'درخواست ثبت‌نام ثبت شد. ایمیل تأیید را باز کن؛ پس از تأیید، برنامه باید حساب را تشخیص دهد. اگر حساب وارد نشد، از همین صفحه با همان ایمیل و رمز وارد شو.':'Your sign-up request was received. Open the confirmation email. After confirming, sign in here with the same email and password.',
   'درخواست نصب پذیرفته شد.':'Install request accepted.','نصب انجام نشد؛ از منوی Chrome گزینه Install app را بررسی کن.':'Installation was not completed. Check Install app in the Chrome menu.'
  };
  let translated=exact[message];
  if(!translated){translated=message;for(const [fa,enText] of Object.entries(exact)){if(fa.length>8&&translated.includes(fa))translated=translated.split(fa).join(enText)}}
  el.textContent=translated;
 }else el.textContent=message;
}
function cloudSettings(){return {theme:localStorage.getItem('life-theme'),lang:localStorage.getItem('life-lang'),currency:localStorage.getItem('life-currency'),accent:localStorage.getItem('life-accent'),waterTarget:localStorage.getItem('life-water-target'),accounts:localStorage.getItem('life-accounts'),mainAccount:localStorage.getItem('life-main-account'),accountSettings:localStorage.getItem('life-account-settings')}}
function applyCloudSettings(s){if(!s)return;const map={'life-theme':s.theme,'life-lang':s.lang,'life-currency':s.currency,'life-accent':s.accent,'life-water-target':s.waterTarget,'life-accounts':s.accounts,'life-main-account':s.mainAccount,'life-account-settings':s.accountSettings};Object.entries(map).forEach(([k,v])=>{if(v!==null&&v!==undefined)localStorage.setItem(k,v)});setupSettings();if(s.lang)setLanguage(s.lang);renderAll()}
function cloudUi(){const form=$('cloudAuthForm'),actions=$('cloudActions');if(!form||!actions)return;form.hidden=!!cloudUser;actions.hidden=!cloudUser;$('cloudEmail').disabled=!!cloudUser;$('cloudPassword').disabled=!!cloudUser;if(cloudUser)cloudMessage('وارد شده‌ای: '+cloudUser.email+' · همگام‌سازی خودکار فعال است.');else cloudMessage('برای ذخیره‌سازی ابری، وارد حساب شو یا حساب جدید بساز. اطلاعات محلی تغییر نمی‌کنند.')}
async function cloudSyncNow(){if(!cloudClient||!cloudUser)return;if(cloudBusy){cloudSyncingAgain=true;return}cloudBusy=true;$('cloudSync').disabled=true;cloudMessage('در حال بررسی و همگام‌سازی اطلاعات…');try{
 const userId=cloudUser.id;
 const {data:remoteRows,error:readError}=await cloudClient.from('user_records').select('record_id,record_type,data,updated_at').eq('user_id',userId);if(readError)throw readError;
 const remoteRecords=new Map(),remoteDeletes=new Map();for(const row of(remoteRows||[])){if(row.record_type==='__tombstone__'){const target=row.data?.targetId;if(target)remoteDeletes.set(String(target),row.data?.updatedAt||row.updated_at||'')}else{const item={...(row.data||{}),id:String(row.record_id),type:row.record_type,updatedAt:row.updated_at||row.data?.updatedAt||row.data?.createdAt||''};remoteRecords.set(item.id,item)}}
 const tombstones=readTombstones();const localById=new Map(records.map(r=>[String(r.id),r]));
 for(const [id,deletedAt] of remoteDeletes){const local=localById.get(id);if(!local||(Date.parse(deletedAt)||0)>=(Date.parse(local.updatedAt||local.createdAt||0)||0))localById.delete(id)}
 for(const [id,remote] of remoteRecords){const deletedAt=tombstones[id]?.updatedAt||remoteDeletes.get(id);if(deletedAt&&(Date.parse(deletedAt)||0)>=(Date.parse(remote.updatedAt||remote.createdAt||0)||0))continue;const local=localById.get(id);if(!local)localById.set(id,remote);else{const lt=Date.parse(local.updatedAt||local.createdAt||0)||0,rt=Date.parse(remote.updatedAt||remote.createdAt||0)||0;if(rt>lt)localById.set(id,remote)}}
 records=Array.from(localById.values());cloudApplyingRemote=true;await persist({remote:true});cloudApplyingRemote=false;
 const payload=records.map(r=>({user_id:userId,record_id:String(r.id),record_type:String(r.type||'record'),data:r,updated_at:r.updatedAt||r.createdAt||new Date().toISOString()}));for(const [id,t] of Object.entries(tombstones))payload.push({user_id:userId,record_id:'__deleted__:'+id,record_type:'__tombstone__',data:t,updated_at:t.updatedAt});
 if(payload.length){const {error}=await cloudClient.from('user_records').upsert(payload,{onConflict:'user_id,record_id'});if(error)throw error}
 const {data:settingsRow,error:settingsReadError}=await cloudClient.from('user_settings').select('settings').eq('user_id',userId).maybeSingle();if(settingsReadError)throw settingsReadError;const localSettings=cloudSettings();if(!settingsRow){const {error}=await cloudClient.from('user_settings').upsert({user_id:userId,settings:localSettings,updated_at:new Date().toISOString()},{onConflict:'user_id'});if(error)throw error}else{applyCloudSettings(settingsRow.settings);const {error}=await cloudClient.from('user_settings').upsert({user_id:userId,settings:cloudSettings(),updated_at:new Date().toISOString()},{onConflict:'user_id'});if(error)throw error}
 localStorage.setItem(SYNC_SNAPSHOT_KEY,JSON.stringify(Object.fromEntries(records.map(r=>[String(r.id),r]))));localStorage.setItem(SYNC_QUEUE_KEY,JSON.stringify({}));renderAll();cloudMessage('همگام‌سازی خودکار با موفقیت انجام شد. '+records.length+' رکورد روی این دستگاه موجود است.');
 }catch(error){cloudApplyingRemote=false;console.error('Cloud sync failed',error);cloudMessage('همگام‌سازی انجام نشد؛ تغییرات روی دستگاه در صف می‌مانند: '+(error.message||'خطای ارتباط یا دسترسی جداول'))}finally{cloudBusy=false;$('cloudSync').disabled=false;if(cloudSyncingAgain){cloudSyncingAgain=false;queueCloudSync()}}}

function setupCloud(){
 if(!window.supabase?.createClient){cloudMessage('کتابخانه اتصال ابری بارگذاری نشد. اینترنت و بارگذاری صفحه را بررسی کن.');return}
 try{
  cloudClient=window.supabase.createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY,{auth:{autoRefreshToken:true,persistSession:true,detectSessionInUrl:true,flowType:'implicit'}});
 }catch(error){console.error('Supabase client initialization failed',error);cloudMessage('راه‌اندازی اتصال ابری ناموفق بود: '+(error.message||'خطای ناشناخته'));return}
 const email=()=>$('cloudEmail').value.trim(),password=()=>$('cloudPassword').value;
 const signIn=$('cloudSignIn'),signUp=$('cloudSignUp'),signOut=$('cloudSignOut');
 let authBusy=false;
 const setAuthBusy=busy=>{authBusy=busy;signIn.disabled=busy;signUp.disabled=busy;const en=(localStorage.getItem('life-lang')||'fa')==='en';signIn.textContent=busy?(en?'Please wait…':'لطفاً صبر کن…'):(en?'Sign in':'ورود');signUp.textContent=busy?(en?'Please wait…':'لطفاً صبر کن…'):(en?'Create account':'ایجاد حساب')};
 signIn.onclick=async()=>{
  if(authBusy||!$('cloudAuthForm').reportValidity())return;
  setAuthBusy(true);cloudMessage('در حال ورود…');
  try{const {data,error}=await cloudClient.auth.signInWithPassword({email:email(),password:password()});if(error)throw error;cloudUser=data.user||data.session?.user||null;cloudUi()}
  catch(error){console.error('Supabase sign-in failed',error);cloudMessage('ورود انجام نشد: '+(error.message||'خطای ارتباط با سرویس احراز هویت'))}
  finally{setAuthBusy(false)}
 };
 signUp.onclick=async()=>{
  if(authBusy||!$('cloudAuthForm').reportValidity())return;
  setAuthBusy(true);cloudMessage('در حال ساخت حساب…');
  try{
   const {data,error}=await cloudClient.auth.signUp({email:email(),password:password(),options:{emailRedirectTo:'https://pouyanesmaili.github.io/Start-planning/'}});
   if(error)throw error;
   if(data.session){cloudUser=data.user||data.session.user;cloudUi()}
   else cloudMessage('درخواست ثبت‌نام ثبت شد. ایمیل تأیید را باز کن؛ پس از تأیید، برنامه باید حساب را تشخیص دهد. اگر حساب وارد نشد، از همین صفحه با همان ایمیل و رمز وارد شو.')
  }catch(error){console.error('Supabase sign-up failed',error);cloudMessage('ثبت‌نام انجام نشد: '+(error.message||'خطای ارتباط با سرویس احراز هویت'))}
  finally{setAuthBusy(false)}
 };
 $('cloudSync').onclick=cloudSyncNow;
 signOut.onclick=async()=>{if(authBusy)return;signOut.disabled=true;cloudMessage('در حال خروج…');try{const {error}=await cloudClient.auth.signOut();if(error)throw error;cloudUser=null;cloudUi()}catch(error){console.error('Supabase sign-out failed',error);cloudMessage('خروج انجام نشد: '+(error.message||'خطای ناشناخته'))}finally{signOut.disabled=false}};
 // Supabase emits INITIAL_SESSION after it restores storage or processes an email-confirmation redirect.
 cloudClient.auth.onAuthStateChange((event,session)=>{
  if(['INITIAL_SESSION','SIGNED_IN','SIGNED_OUT','TOKEN_REFRESHED','USER_UPDATED'].includes(event)){
   cloudUser=session?.user||null;cloudUi();
   if(event==='SIGNED_IN'||event==='INITIAL_SESSION'){if(cloudUser)queueCloudSync();if(event==='SIGNED_IN')cloudMessage('ورود موفق بود: '+(cloudUser?.email||'حساب کاربری')+'. همگام‌سازی خودکار فعال شد.')}
  }
 });
 cloudUi();
}
window.addEventListener('online',()=>{if(cloudUser)queueCloudSync()});document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&cloudUser)queueCloudSync()});
async function init(){await load();startLanguageObserver();clock();setInterval(clock,1000);setupOnboarding();bindAll();setupCalendar();setupTimer();setupSearch();setupSettings();setupBackup();setupCloud();setupPWA();setupEventReminders();if(localStorage.getItem('life-lang'))setLanguage(localStorage.getItem('life-lang'));renderAll();document.querySelectorAll('form [name=date]').forEach(i=>{if(!i.value)i.value=today()})}
document.addEventListener('DOMContentLoaded',init);
})();

