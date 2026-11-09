/* Corro Run App - club features: leaderboards, challenges, feed, group runs, routes, badges, year wrapped.
   Needs the Firebase compat SDK + firebase-config.js. Uses globals from index.html:
   acts, store, esc, km, fmtT, fmtP, icon, weekStart, tiles, L */
(function(){
'use strict';
const DAY=864e5,HOUR=36e5;
const TEAM_COL=['#ff8a1f','#e8286e','#2d8cff','#2ecc71'];
const isFoot=t=>t==='Run'||t==='Walk'||t==='Hike',isGps=t=>isFoot(t)||t==='Ride';
const KINDS={run:['🏃','Group run'],intervals:['⚡','Intervals'],easy:['🟢','Easy run'],lsd:['🐢','LSD (long slow distance)'],tempo:['🔥','Tempo run'],gym:['🏋️','Gym session']};
function secs(s,d){s=String(s==null||s===''?d:s);const p=s.split(':');return p.length>1?(+p[0]||0)*60+(+p[1]||0):(+p[0]||0)}

/* ================= pure logic (unit-tested) ================= */
function hvs(a,b,c,d){const R=6371000,t=x=>x*Math.PI/180,dl=t(c-a),dn=t(d-b),h=Math.sin(dl/2)**2+Math.cos(t(a))*Math.cos(t(c))*Math.sin(dn/2)**2;return 2*R*Math.asin(Math.sqrt(h))}

// pts: [[lat,lon,ts,flag?],...] -> flat [lat,lon,lat,lon,...] (Firestore has no nested arrays).
// hide=true drops the first and last 150 m so home/start spots are not shared.
function packPoly(pts,hide,maxPts){
  maxPts=maxPts||150;
  if(!pts||pts.length<2)return [];
  const cum=[0];
  for(let i=1;i<pts.length;i++)cum.push(cum[i-1]+hvs(pts[i-1][0],pts[i-1][1],pts[i][0],pts[i][1]));
  const total=cum[cum.length-1];
  let keep=pts.map((p,i)=>i);
  if(hide){if(total<600)return [];keep=keep.filter(i=>cum[i]>=150&&total-cum[i]>=150)}
  if(keep.length<2)return [];
  const step=Math.max(1,Math.ceil(keep.length/maxPts)),out=[];
  for(let i=0;i<keep.length;i+=step)out.push(keep[i]);
  if(out[out.length-1]!==keep[keep.length-1])out.push(keep[keep.length-1]);
  const flat=[];
  out.forEach(i=>flat.push(Math.round(pts[i][0]*1e5)/1e5,Math.round(pts[i][1]*1e5)/1e5));
  return flat;
}
function unpack(flat){const o=[];flat=flat||[];for(let i=0;i+1<flat.length;i+=2)o.push([flat[i],flat[i+1]]);return o}

function dayKey(ts){const d=new Date(ts);return d.getFullYear()*10000+(d.getMonth()+1)*100+d.getDate()}
function keyToDate(k){return new Date(Math.floor(k/10000),Math.floor(k%10000/100)-1,k%100,12)}
function curStreak(set,now){
  const d=new Date(now);d.setHours(12,0,0,0);
  if(!set.has(dayKey(d)))d.setDate(d.getDate()-1);   // streak is still alive until today ends
  let n=0;while(set.has(dayKey(d))){n++;d.setDate(d.getDate()-1)}
  return n;
}
function bestStreak(set){
  const ks=[...set].sort((a,b)=>a-b);let best=0,cur=0,prev=null;
  ks.forEach(k=>{const d=keyToDate(k);if(prev&&Math.round((d-prev)/DAY)===1)cur++;else cur=1;best=Math.max(best,cur);prev=d});
  return best;
}
function streaksByUid(runs,now){
  const sets={};
  runs.forEach(r=>{(sets[r.uid]||(sets[r.uid]=new Set())).add(dayKey(r.start))});
  const out={};Object.keys(sets).forEach(u=>out[u]=curStreak(sets[u],now));
  return out;
}

function agg(runs,from,to){
  const m={};
  runs.forEach(r=>{
    if(r.start<from||r.start>=to||!(r.dist>0))return;
    const o=m[r.uid]||(m[r.uid]={uid:r.uid,name:r.name,dist:0,time:0,n:0,longest:0});
    o.dist+=r.dist;o.time+=r.time;o.n++;o.longest=Math.max(o.longest,r.dist);
  });
  return Object.values(m).sort((a,b)=>b.dist-a.dist);
}
function teamTotals(rows,members,teams){
  const t={};(teams||[]).forEach(x=>t[x]={team:x,dist:0,n:0,people:0,avg:0});
  rows.forEach(r=>{const m=members[r.uid];if(m&&t[m.team]){t[m.team].dist+=r.dist;t[m.team].n+=r.n}});
  Object.values(members).forEach(m=>{if(t[m.team])t[m.team].people++});
  Object.values(t).forEach(x=>x.avg=x.people?x.dist/x.people:0);
  return Object.values(t).sort((a,b)=>b.dist-a.dist);
}
function challengeProgress(runs,ch){
  const list=runs.filter(r=>r.start>=ch.start&&r.start<=ch.end&&r.dist>0).sort((a,b)=>a.start-b.start);
  const tot={},names={};let winner=null;
  list.forEach(r=>{
    tot[r.uid]=(tot[r.uid]||0)+r.dist;names[r.uid]=r.name;
    if(ch.goalKm&&!winner&&tot[r.uid]>=ch.goalKm*1000)winner={uid:r.uid,at:r.start};
  });
  const rows=Object.keys(tot).map(u=>({uid:u,name:names[u],dist:tot[u]})).sort((a,b)=>b.dist-a.dist);
  return {rows,winner};
}
function awards(runs,from,to){
  const rows=agg(runs,from,to);if(!rows.length)return [];
  const by=k=>[...rows].sort((a,b)=>b[k]-a[k])[0];
  return [{id:'km',icon:'🏆',title:'Most kilometers',row:by('dist'),val:'dist'},
          {id:'runs',icon:'🔥',title:'Most runs',row:by('n'),val:'n'},
          {id:'long',icon:'🏔',title:'Longest run',row:by('longest'),val:'longest'}];
}
function badgeList(list){
  const rs=(list||[]).filter(a=>isFoot(a.type));
  const total=rs.reduce((t,a)=>t+a.dist,0)/1000;
  const longest=Math.max(0,...rs.map(a=>a.dist))/1000;
  const bs=bestStreak(new Set(rs.map(a=>dayKey(a.start))));
  const early=rs.some(a=>{const d=new Date(a.start);return a.dist>=1000&&d.getHours()*60+d.getMinutes()<390});
  const fast=rs.some(a=>a.type==='Run'&&a.dist>=3000&&a.time/(a.dist/1000)<300);
  return [
    {id:'first',icon:'👟',name:'First steps',desc:'Log an activity',got:rs.length>=1},
    {id:'k5',icon:'🎯',name:'5K',desc:'5 km in one run',got:longest>=5},
    {id:'k10',icon:'🔥',name:'10K',desc:'10 km in one run',got:longest>=10},
    {id:'half',icon:'🏅',name:'Half marathon',desc:'21.1 km in one run',got:longest>=21.0975},
    {id:'t50',icon:'🥉',name:'50 km club',desc:'50 km in total',got:total>=50},
    {id:'t100',icon:'🥈',name:'100 km club',desc:'100 km in total',got:total>=100},
    {id:'t500',icon:'🥇',name:'500 km club',desc:'500 km in total',got:total>=500},
    {id:'s3',icon:'📆',name:'3-day streak',desc:'Run 3 days in a row',got:bs>=3},
    {id:'s7',icon:'⚡',name:'7-day streak',desc:'Run 7 days in a row',got:bs>=7},
    {id:'early',icon:'🌅',name:'Early bird',desc:'Run before 6:30',got:early},
    {id:'fast',icon:'🚀',name:'Sub-5 pace',desc:'3 km+ under 5:00 /km',got:fast}
  ];
}
function wrapped(list,year){
  const rs=(list||[]).filter(a=>isFoot(a.type)&&new Date(a.start).getFullYear()===year);
  const byMonth=Array(12).fill(0),wd=Array(7).fill(0);
  let dist=0,time=0,longest=0,fastest=null;
  rs.forEach(a=>{
    dist+=a.dist;time+=a.time;longest=Math.max(longest,a.dist);
    const d=new Date(a.start);byMonth[d.getMonth()]+=a.dist;wd[(d.getDay()+6)%7]++;
    if(a.dist>=1000){const p=a.time/(a.dist/1000);if(fastest===null||p<fastest)fastest=p}
  });
  const days=new Set(rs.map(a=>dayKey(a.start)));
  const bm=byMonth.indexOf(Math.max(...byMonth)),fd=wd.indexOf(Math.max(...wd));
  return {n:rs.length,dist,time,longest,fastest,byMonth,wd,activeDays:days.size,
          bestStreak:bestStreak(days),bestMonth:dist?bm:-1,favDay:rs.length?fd:-1};
}
window.ClubLogic={packPoly,unpack,dayKey,curStreak,bestStreak,streaksByUid,agg,teamTotals,challengeProgress,awards,badgeList,wrapped};

if(typeof document==='undefined'||!document.getElementById('clubBox'))return;

/* ================= UI ================= */
const $=s=>document.querySelector(s);
const cfg=window.FIREBASE_CONFIG||{};
const C={cfg:!!(window.firebase&&cfg.apiKey&&!/^PASTE/i.test(cfg.apiKey)),started:false,uid:null,state:'idle',err:'',
  club:null,me:null,members:{},runs:[],events:[],chs:[],routes:[],unsubs:[],tab:'feed',period:'week',draft:{},open:{},cm:{},lookup:null};
const S={auto:store.get('clubAuto',true),hide:store.get('clubHide',true)};
let auth,db,FV;
const WD=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'],MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const dv=k=>esc(C.draft[k]||'');
const isOwner=()=>C.club&&C.club.ownerUid===C.uid;
const base=()=>'clubs/'+C.club.id;
const ucol=u=>{const m=C.members[u],i=m&&C.club?(C.club.teams||[]).indexOf(m.team):-1;return i>=0?TEAM_COL[i%4]:'#8b919b'};
const av=(u,n)=>`<span class="av" style="background:${ucol(u)}">${esc((n||'?').trim().charAt(0).toUpperCase()||'?')}</span>`;
function ago(ts){const s=(Date.now()-ts)/1000;if(s<90)return 'just now';if(s<3600)return Math.round(s/60)+' min ago';if(s<86400)return Math.round(s/3600)+' h ago';if(s<172800)return 'yesterday';return new Date(ts).toLocaleDateString([], {month:'short',day:'numeric'})}
function friendly(e){
  const c=(e&&e.code)||'';
  if(c==='auth/operation-not-allowed'||c==='auth/admin-restricted-operation')return 'Turn on Anonymous sign-in: Firebase console > Authentication > Sign-in method > Anonymous.';
  if(c==='permission-denied'||c==='firestore/permission-denied')return 'Permission denied. Publish the Firestore rules from SETUP-CLUB.md, and check the club code.';
  if(c==='unavailable'||c==='auth/network-request-failed')return 'No connection. Check your internet and try again.';
  return (e&&e.message)||String(e);
}
function svgRoute(flat,col){
  const p=unpack(flat);if(p.length<2)return '';
  let a=1e9,b=-1e9,c=1e9,d=-1e9;
  p.forEach(q=>{a=Math.min(a,q[0]);b=Math.max(b,q[0]);c=Math.min(c,q[1]);d=Math.max(d,q[1])});
  const kx=Math.cos((a+b)/2*Math.PI/180),w=(d-c)*kx,h=b-a,sc=Math.min(88/Math.max(w,1e-9),44/Math.max(h,1e-9));
  const ox=50-w*sc/2,oy=28-h*sc/2;
  const path=p.map((q,i)=>(i?'L':'M')+(ox+(q[1]-c)*kx*sc).toFixed(1)+' '+(oy+(b-q[0])*sc).toFixed(1)).join('');
  return `<svg class="rt" viewBox="0 0 100 56" preserveAspectRatio="xMidYMid meet"><path d="${path}" fill="none" stroke="${col}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/* ----- init / auth / membership ----- */
function init(){
  if(C.started||!C.cfg)return;
  C.started=true;C.state='loading';
  try{
    if(!firebase.apps.length)firebase.initializeApp(cfg);
    auth=firebase.auth();db=firebase.firestore();FV=firebase.firestore.FieldValue;
    try{db.enablePersistence({synchronizeTabs:true}).catch(()=>{})}catch(e){}
  }catch(e){C.state='error';C.err=friendly(e);render();return}
  auth.onAuthStateChanged(u=>{
    if(u){C.uid=u.uid;boot()}
    else auth.signInAnonymously().catch(e=>{C.state='error';C.err=friendly(e);render()});
  });
}
async function boot(){
  const cid=store.get('clubId',null);
  if(!cid){C.state='join';render();checkInviteLink();return}
  try{
    const cs=await db.doc('clubs/'+cid).get();
    let ms=null;
    try{ms=await db.doc(`clubs/${cid}/members/${C.uid}`).get()}catch(e){if((e.code||'').indexOf('permission')<0)throw e}
    if(!cs.exists||!ms||!ms.exists){C.state='rejoin';C.draft.code=cid;render();return}
    C.club=Object.assign({id:cid},cs.data());C.me=ms.data();C.members[C.uid]=C.me;
    C.state='in';C.err='';if(C.pendingEvent){C.tab='events';C.focus=C.pendingEvent;C.pendingEvent=null}subscribe();render();
  }catch(e){C.state='error';C.err=friendly(e);render()}
}
function unsubAll(){C.unsubs.forEach(f=>{try{f()}catch(e){}});C.unsubs=[]}
function subscribe(){
  unsubAll();const p=base();
  const eh=e=>{C.err=friendly(e);dirty()};
  const snap=(q,fn)=>C.unsubs.push(q.onSnapshot(s=>{fn(s);dirty()},eh));
  snap(db.collection(p+'/members'),s=>{C.members={};s.forEach(d=>C.members[d.id]=d.data());if(C.members[C.uid])C.me=C.members[C.uid]});
  snap(db.collection(p+'/runs').where('start','>=',Date.now()-70*DAY).orderBy('start','desc').limit(500),s=>{C.runs=s.docs.map(d=>Object.assign({id:d.id},d.data()))});
  snap(db.collection(p+'/events').where('start','>=',Date.now()-6*HOUR).orderBy('start'),s=>{C.events=s.docs.map(d=>Object.assign({id:d.id},d.data()))});
  snap(db.collection(p+'/challenges').orderBy('start','desc').limit(20),s=>{C.chs=s.docs.map(d=>Object.assign({id:d.id},d.data()))});
  snap(db.collection(p+'/routes').orderBy('createdAt','desc').limit(40),s=>{C.routes=s.docs.map(d=>Object.assign({id:d.id},d.data()))});
}
let rt=0;
function dirty(){
  clearTimeout(rt);
  rt=setTimeout(()=>{
    banner();
    if(!$('#v-club').classList.contains('active'))return;
    const a=document.activeElement;
    if(a&&/INPUT|TEXTAREA|SELECT/.test(a.tagName)&&$('#clubBox').contains(a))return;   // don't wipe what is being typed
    render();
  },60);
}
function checkInviteLink(){
  if(!C.pendingCode)return;
  C.draft.code=C.pendingCode;C.pendingCode=null;
  find().catch(e=>{C.err=friendly(e);render()});
}

/* ----- views ----- */
function render(){const box=$('#clubBox');if(!box)return;box.innerHTML=view();banner()}
function view(){
  if(!C.cfg)return `<div class="card"><h4 class="ch">🏆 Club</h4><p class="mut">${window.firebase?'Club features are not set up yet. Open <b>firebase-config.js</b>, paste your Firebase config, then follow <b>SETUP-CLUB.md</b>.':'Club features need an internet connection to load.'}</p></div>`;
  const err=C.err?`<div class="card cerr">${esc(C.err)} <button class="mini" data-act="retry">Retry</button></div>`:'';
  if(C.state==='idle'||C.state==='loading')return err+'<div class="card mut">Loading club…</div>';
  if(C.state==='error')return err;
  if(C.state==='join'||C.state==='rejoin')return err+(C.state==='rejoin'?'<div class="card mut">You are not signed in to your club on this phone (app data cleared or reinstalled?). Enter the club code to rejoin.</div>':'')+joinView();
  return err+clubView();
}
function joinView(){
  const l=C.lookup;
  return (C.pendingEvent?'<div class="cbanner">👋 You are invited to a coach session. Join the club to see it.</div>':'')+`<div class="card"><h4 class="ch">Join your club</h4>
    <input class="cin" data-k="code" placeholder="Club code" value="${dv('code')}" autocapitalize="characters" maxlength="12">
    ${l?`<p class="mut">Club: <b>${esc(l.name)}</b></p>
      <input class="cin" data-k="jname" placeholder="Your name" value="${esc(C.draft.jname||store.get('clubName',''))}" maxlength="30">
      ${(l.teams||[]).length?`<select class="cin" data-k="jteam">${l.teams.map(t=>`<option${C.draft.jteam===t?' selected':''}>${esc(t)}</option>`).join('')}</select>`:''}
      <button class="btn cbtn" data-act="join">Join club</button>`
    :'<button class="btn cbtn" data-act="find">Find club</button>'}
  </div>
  <div class="card"><h4 class="ch">Start a new club</h4>
    <input class="cin" data-k="cname" placeholder="Club name (e.g. Corro Run Club)" value="${dv('cname')}" maxlength="40">
    <input class="cin" data-k="cyou" placeholder="Your name" value="${esc(C.draft.cyou||store.get('clubName',''))}" maxlength="30">
    <input class="cin" data-k="cteams" placeholder="Teams, comma separated (optional): Orange, Pink" value="${dv('cteams')}">
    <button class="btn cbtn" data-act="create">Create club</button>
  </div>`;
}
function bannerText(){
  const now=Date.now();
  const e=C.events.find(x=>x.rsvps&&x.rsvps[C.uid]&&x.start>now-HOUR&&x.start<now+DAY);
  if(!e)return '';
  const mins=Math.round((e.start-now)/60000);
  const when=mins<=0?'happening now':'in '+(mins>=60?Math.floor(mins/60)+' h '+(mins%60)+' min':mins+' min');
  return `📅 Group run ${when}: ${e.title}${e.place?' @ '+e.place:''}`;
}
function banner(){
  const el=$('#clubBanner');if(!el)return;
  const t=C.state==='in'?bannerText():'';
  el.style.display=t?'block':'none';el.textContent=t;
}
function clubView(){
  const n=Object.keys(C.members).length,bt=bannerText();
  const tabs=[['feed','Feed'],['board','Board'],['events','Runs'],['routes','Routes'],['me','Me']];
  return `<div class="chead"><img src="icon-192.png" alt=""><div><b>${esc(C.club.name)}</b><div class="mut">${n} member${n===1?'':'s'} · code <b>${esc(C.club.id)}</b></div></div><button class="mini pri" data-act="invite">Invite</button></div>
  ${bt?`<div class="cbanner">${esc(bt)}</div>`:''}
  <div class="chips">${tabs.map(t=>`<button class="chip${C.tab===t[0]?' on':''}" data-act="tab" data-v="${t[0]}">${t[1]}</button>`).join('')}</div>
  ${C.tab==='feed'?feedView():C.tab==='board'?boardView():C.tab==='events'?eventsView():C.tab==='routes'?routesView():meView()}`;
}

function feedView(){
  if(!C.runs.length)return '<div class="card mut">No runs shared yet. Finish a run and it shows up here for the whole club. 🏃</div>';
  return C.runs.slice(0,60).map(feedCard).join('');
}
function feedCard(r){
  const m=C.members[r.uid],nm=m?m.name:(r.name||'Runner');
  const ks=Object.keys(r.kudos||{}),mine=ks.indexOf(C.uid)>=0;
  const pace=r.dist>=50?fmtP(r.time/(r.dist/1000)):'–',open=C.open['c'+r.id];
  return `<div class="card"><div class="fh">${av(r.uid,nm)}<div class="fm"><b>${esc(nm)}${r.uid===C.uid?' <span class="you">you</span>':''}</b><div class="mut">${icon(r.type)} ${esc(r.type)} · ${ago(r.start)}</div></div></div>
  <div class="nums">${isGps(r.type)?`<div><b>${km(r.dist)}</b><small>km</small></div><div><b>${pace}</b><small>/km</small></div>`:(r.ns?`<div><b>${r.ns}</b><small>sets</small></div>`:'')+(r.vol?`<div><b>${r.vol}</b><small>kg</small></div>`:'')}<div><b>${fmtT(r.time)}</b><small>time</small></div>${r.avgHr?`<div><b>${r.avgHr}</b><small>bpm</small></div>`:''}</div>
  ${svgRoute(r.poly,ucol(r.uid))}
  <div class="ar"><button class="kb${mine?' on':''}" data-act="kudos" data-id="${esc(r.id)}">👏 ${ks.length||''}</button><button class="kb${open?' on':''}" data-act="cm" data-id="${esc(r.id)}">💬 ${C.cm[r.id]?C.cm[r.id].length:''}</button>${r.uid===C.uid?`<button class="kb" data-act="delrun" data-id="${esc(r.id)}">🗑</button>`:''}</div>
  ${open?commentsHtml(r.id):''}</div>`;
}
function commentsHtml(id){
  const l=C.cm[id]||[];
  return `<div class="cmt">${l.map(c=>`<p><b>${esc(c.name)}</b> ${esc(c.text)}</p>`).join('')||'<p class="mut">No comments yet.</p>'}
  <div class="row2"><input data-k="cm${esc(id)}" placeholder="Write a comment…" maxlength="300" value="${dv('cm'+id)}"><button class="mini pri" data-act="cmsend" data-id="${esc(id)}">Send</button></div></div>`;
}

function range(){
  const n=new Date();let f,t;
  if(C.period==='week'){f=weekStart(Date.now());t=f+7*DAY}
  else if(C.period==='month'){f=new Date(n.getFullYear(),n.getMonth(),1).getTime();t=new Date(n.getFullYear(),n.getMonth()+1,1).getTime()}
  else{f=new Date(n.getFullYear(),n.getMonth()-1,1).getTime();t=new Date(n.getFullYear(),n.getMonth(),1).getTime()}
  return [f,t];
}
function boardView(){
  const [f,t]=range(),rows=agg(C.runs,f,t),st=streaksByUid(C.runs,Date.now()),mx=rows.length?rows[0].dist:0;
  const chips=[['week','This week'],['month','This month'],['last','Last month']].map(p=>`<button class="chip${C.period===p[0]?' on':''}" data-act="period" data-v="${p[0]}">${p[1]}</button>`).join('');
  let h=`<div class="chips">${chips}</div>`;
  h+=`<div class="card">${rows.length?rows.map((r,i)=>{
    const m=C.members[r.uid],nm=m?m.name:r.name,w=mx?Math.max(4,r.dist/mx*100):0;
    return `<div class="lb"><span class="rk">${i<3?['🥇','🥈','🥉'][i]:i+1}</span>${av(r.uid,nm)}<div class="lbm"><div class="lbn">${esc(nm)}${r.uid===C.uid?' <span class="you">you</span>':''}${st[r.uid]>=2?` <span class="fire">🔥${st[r.uid]}</span>`:''}</div><div class="bar"><i style="width:${w}%;background:${ucol(r.uid)}"></i></div></div><div class="lbv"><b>${km(r.dist)}</b><small>km · ${r.n} run${r.n>1?'s':''}</small></div></div>`}).join(''):'<p class="mut">Nobody has run in this period yet.</p>'}</div>`;
  if((C.club.teams||[]).length>1){
    const tt=teamTotals(rows,C.members,C.club.teams),tm=tt[0]?tt[0].dist:0;
    h+=`<div class="card"><h4 class="ch">Team vs team</h4>${tt.map(x=>`<div class="lb"><span class="av" style="background:${TEAM_COL[C.club.teams.indexOf(x.team)%4]}">${esc(x.team.charAt(0).toUpperCase())}</span><div class="lbm"><div class="lbn">${esc(x.team)}</div><div class="bar"><i style="width:${tm?Math.max(4,x.dist/tm*100):0}%;background:${TEAM_COL[C.club.teams.indexOf(x.team)%4]}"></i></div></div><div class="lbv"><b>${km(x.dist)}</b><small>${x.people} member${x.people===1?'':'s'} · avg ${km(x.avg)}</small></div></div>`).join('')}</div>`;
  }
  if(C.period==='last'){
    const aw=awards(C.runs,f,t);
    h+=`<div class="card"><h4 class="ch">🏆 Awards for last month</h4>${aw.length?aw.map(a=>{const m=C.members[a.row.uid],nm=m?m.name:a.row.name,v=a.val==='n'?a.row.n+' runs':km(a.row[a.val])+' km';return `<div class="aw"><span class="tr">${a.icon}</span><div><b>${esc(nm)}</b><div class="mut">${a.title} · ${v}</div></div></div>`}).join(''):'<p class="mut">No runs last month.</p>'}</div>`;
  }
  h+=chView();
  return h;
}
function chView(){
  let h=`<h3>Challenges</h3>`;
  if(!C.chs.length)h+='<div class="card mut">No challenges yet.'+(isOwner()?' Create one below.':' The club owner can create them.')+'</div>';
  C.chs.forEach(ch=>{
    const p=challengeProgress(C.runs,ch),goal=ch.goalKm?ch.goalKm*1000:0,top=p.rows.slice(0,5),mx=goal||(top[0]?top[0].dist:0),now=Date.now();
    const status=now>ch.end?'Finished':now<ch.start?'Starts soon':'Active';
    const wm=p.winner&&(C.members[p.winner.uid]||{name:(p.rows.find(r=>r.uid===p.winner.uid)||{}).name});
    h+=`<div class="card"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(ch.title)}</b><span class="tag${status==='Active'?' on':''}">${status}</span></div>
    <div class="mut">${goal?'First to '+ch.goalKm+' km':'Most km'} · ${new Date(ch.start).toLocaleDateString([], {month:'short',day:'numeric'})} – ${new Date(ch.end).toLocaleDateString([], {month:'short',day:'numeric'})}</div>
    ${p.winner?`<div class="aw"><span class="tr">🏁</span><div><b>${esc(wm.name||'Runner')}</b> reached ${ch.goalKm} km first<div class="mut">${new Date(p.winner.at).toLocaleDateString([], {month:'short',day:'numeric'})}</div></div></div>`:''}
    ${top.map(r=>{const m=C.members[r.uid],nm=m?m.name:r.name,pc=mx?Math.min(100,r.dist/mx*100):0;return `<div class="lb"><div class="lbm"><div class="lbn">${esc(nm)}${r.uid===C.uid?' <span class="you">you</span>':''}</div><div class="bar"><i style="width:${Math.max(3,pc)}%;background:${ucol(r.uid)}"></i></div></div><div class="lbv"><b>${km(r.dist)}</b><small>km</small></div></div>`}).join('')||'<p class="mut">No runs counted yet.</p>'}
    ${isOwner()?`<button class="mini red" data-act="chdel" data-id="${esc(ch.id)}">Delete</button>`:''}</div>`;
  });
  if(isOwner()){
    const end=C.draft.chend||new Date(Date.now()+30*DAY).toISOString().slice(0,10);
    h+=C.open.ch?`<div class="card"><h4 class="ch">New challenge</h4>
      <input class="cin" data-k="chtitle" placeholder="Title (e.g. First to 100 km)" value="${dv('chtitle')}" maxlength="50">
      <input class="cin" data-k="chgoal" type="number" inputmode="decimal" placeholder="Goal in km (empty = most km wins)" value="${dv('chgoal')}">
      <label class="mut">Ends on (max 2 months)</label><input class="cin" data-k="chend" type="date" value="${esc(end)}">
      <button class="btn cbtn" data-act="chsave">Start challenge</button></div>`
      :`<button class="mini pri" data-act="chform">+ New challenge</button>`;
  }
  return h;
}

function eventsView(){
  let h='';
  const now=Date.now(),up=C.events.filter(e=>e.start>now-3*HOUR).sort((a,b)=>(b.id===C.focus)-(a.id===C.focus)||a.start-b.start);
  if(!up.length)h+='<div class="card mut">No sessions scheduled. Post one below.</div>';
  up.forEach(e=>{
    const d=new Date(e.start),when=d.toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
    const rs=e.rsvps||{},mine=rs[C.uid],groups=e.groups||[],going=Object.keys(rs).map(u=>rs[u]),K=KINDS[e.kind]||KINDS.run,pt=planTxt(e.plan),inv=e.id===C.focus;
    const btn=(g,label)=>`<button class="chip${mine&&mine.g===g?' on':''}" data-act="rsvp" data-id="${esc(e.id)}" data-g="${esc(g)}">${esc(label)}</button>`;
    const lnk=e.lat!=null?`https://www.google.com/maps?q=${e.lat},${e.lng}`:'';
    h+=`<div class="card"${inv?' style="border:1px solid #ff8a1f"':''}>${inv?'<div class="cbanner">👋 You are invited. Tap I\'m in to join.</div>':''}
    <div class="mut">${K[0]} ${esc(K[1])}${e.byName?' · coach '+esc(e.byName):''}</div><div class="evt">${esc(e.title)}</div><div class="mut">📅 ${when}</div>
    ${pt?`<div style="margin-top:4px"><b>${esc(pt)}</b></div>`:''}
    ${e.place?`<div>📍 ${lnk?`<a style="color:#ff8a1f" target="_blank" rel="noopener" href="${lnk}">${esc(e.place)}</a>`:esc(e.place)}</div>`:(lnk?`<div>📍 <a style="color:#ff8a1f" target="_blank" rel="noopener" href="${lnk}">Open meeting point</a></div>`:'')}
    ${e.notes?`<div class="mut" style="margin-top:4px;white-space:pre-line">${esc(e.notes)}</div>`:''}
    <div style="margin:10px 0 4px" class="chips">${groups.length?groups.map(g=>btn(g,g+' /km')).join(''):btn('',"I'm in")}</div>
    <div class="mut">${going.length?'Going ('+going.length+'): '+going.map(x=>esc(x.name)+(x.g?' ('+esc(x.g)+')':'')).join(', '):'Nobody yet. Be the first!'}</div>
    <div class="ar" style="flex-wrap:wrap"><button class="mini pri" data-act="sstart" data-id="${esc(e.id)}">▶ Start session</button><button class="mini" data-act="evshare" data-id="${esc(e.id)}">🔗 Share link</button><button class="mini" data-act="ics" data-id="${esc(e.id)}">Add to calendar</button>${e.createdBy===C.uid||isOwner()?`<button class="mini red" data-act="evdel" data-id="${esc(e.id)}">Delete</button>`:''}</div></div>`;
  });
  if(C.open.ev){
    const k=C.draft.evkind||'run',def=C.draft.evwhen||new Date(Date.now()+DAY-new Date().getTimezoneOffset()*60000).toISOString().slice(0,11)+'06:00';
    h+=`<div class="card"><h4 class="ch">Post a session</h4>
    <select class="cin" data-act="evkind">${Object.keys(KINDS).map(x=>`<option value="${x}"${x===k?' selected':''}>${KINDS[x][0]} ${esc(KINDS[x][1])}</option>`).join('')}</select>
    <input class="cin" data-k="evtitle" placeholder="Title (optional, e.g. Tuesday track night)" value="${dv('evtitle')}" maxlength="60">
    <input class="cin" data-k="evwhen" type="datetime-local" value="${esc(def)}">
    <input class="cin" data-k="evplace" placeholder="Meeting point (e.g. Main gate, City Park)" value="${dv('evplace')}" maxlength="80">
    <button class="mini" data-act="evloc">${C.draft.evlat!=null?'📍 Location pinned ✓':'📍 Pin my current location'}</button>
    <div style="height:8px"></div>
    ${k==='intervals'?`<div class="row2"><input data-k="evreps" type="number" inputmode="numeric" placeholder="Reps (6)" value="${dv('evreps')}"><input data-k="evwork" placeholder="Work m:ss (2:00)" value="${dv('evwork')}"><input data-k="evrest" placeholder="Rest m:ss (1:00)" value="${dv('evrest')}"></div>
      <div class="row2"><input data-k="evwarm" type="number" inputmode="numeric" placeholder="Warm-up min (10)" value="${dv('evwarm')}"><input data-k="evcool" type="number" inputmode="numeric" placeholder="Cool-down min (5)" value="${dv('evcool')}"></div>`
    :k==='gym'?`<textarea class="cin" rows="5" data-k="evnotes" placeholder="Exercises, one per line (e.g. Squat, Bench press, Pull-up)" maxlength="400">${dv('evnotes')}</textarea>`
    :`<div class="row2"><input data-k="evdist" type="number" inputmode="decimal" placeholder="Target km" value="${dv('evdist')}"><input data-k="evpace" placeholder="Pace e.g. 6:30-7:00" value="${dv('evpace')}"></div>`}
    <input class="cin" data-k="evgroups" placeholder="Pace groups, comma separated (optional): 5:00, 5:30, 6:00" value="${dv('evgroups')}">
    ${k==='gym'?'':`<input class="cin" data-k="evnotes" placeholder="Notes (route, bring water…)" value="${dv('evnotes')}" maxlength="200">`}
    <button class="btn cbtn" data-act="evsave">Post session</button></div>`;
  }else h+=`<button class="mini pri" data-act="evform">+ Post a session (coach)</button>`;
  return h;
}

function routesView(){
  if(!C.routes.length)return '<div class="card mut">No club routes yet. Open one of your activities and tap <b>Save as club route</b>.</div>';
  return C.routes.map(r=>`<div class="card"><div style="display:flex;justify-content:space-between;gap:8px"><b>${esc(r.name)}</b><b>${km(r.dist)} km</b></div><div class="mut">by ${esc(r.byName||'a member')}</div>${svgRoute(r.poly,'#ff8a1f')}
  <div class="ar"><button class="mini pri" data-act="route" data-id="${esc(r.id)}">View map</button>${r.createdBy===C.uid||isOwner()?`<button class="mini red" data-act="routedel" data-id="${esc(r.id)}">Delete</button>`:''}</div></div>`).join('');
}

function meView(){
  const m=C.me||{},teams=C.club.teams||[],bl=badgeList(acts),got=bl.filter(b=>b.got).length;
  const years=[...new Set(acts.map(a=>new Date(a.start).getFullYear()).concat([new Date().getFullYear()]))].sort((a,b)=>b-a);
  const unshared=acts.filter(a=>!a.shared&&a.start>Date.now()-70*DAY&&a.dist>=100).length;
  return `<div class="card"><h4 class="ch">Your profile</h4>
    <input class="cin" data-k="myname" value="${esc(C.draft.myname!=null?C.draft.myname:(m.name||''))}" maxlength="30">
    ${teams.length?`<select class="cin" data-act="setteam">${teams.map(t=>`<option${m.team===t?' selected':''}>${esc(t)}</option>`).join('')}</select>`:''}
    <button class="mini pri" data-act="savename">Save name</button>
    <label class="tgl"><input type="checkbox" data-act="auto"${S.auto?' checked':''}> Auto-share my runs to the club</label>
    <label class="tgl"><input type="checkbox" data-act="hide"${S.hide?' checked':''}> Hide the first and last 150 m of shared routes</label>
    ${unshared?`<button class="mini" data-act="shareold">Share my ${unshared} recent run${unshared>1?'s':''}</button>`:''}</div>
  <div class="card"><h4 class="ch">Badges <span class="mut">${got}/${bl.length}</span></h4><div class="badges">${bl.map(b=>`<div class="bd${b.got?'':' off'}"><div class="bi">${b.icon}</div><b>${esc(b.name)}</b><small>${esc(b.desc)}</small></div>`).join('')}</div></div>
  <div class="card"><h4 class="ch">Year wrapped</h4><div class="chips">${years.map(y=>`<button class="chip" data-act="wrapped" data-y="${y}">${y}</button>`).join('')}</div></div>
  <div class="card"><h4 class="ch">Invite & club</h4><p class="mut">Club code <b>${esc(C.club.id)}</b></p><button class="mini pri" data-act="invite">Share invite link</button> <button class="mini red" data-act="leave">Leave club</button></div>`;
}

/* ----- overlay (route viewer, wrapped) ----- */
let omap=null;
function overlay(html,after){
  let o=$('#cmodal');if(!o){o=document.createElement('div');o.id='cmodal';document.body.appendChild(o)}
  o.innerHTML=`<div style="text-align:right"><button class="mini" id="cmClose">Close</button></div>`+html;
  o.style.display='block';o.scrollTop=0;$('#cmClose').onclick=closeOverlay;if(after)after();
}
function closeOverlay(){const o=$('#cmodal');if(o)o.style.display='none';if(omap){omap.remove();omap=null}}
function viewRoute(r){
  overlay(`<h3 style="color:var(--tx);text-transform:none;font-size:20px">${esc(r.name)}</h3><div class="mut">${km(r.dist)} km · by ${esc(r.byName||'a member')}</div><div id="rmap" style="height:60vh;border-radius:14px;margin-top:10px;overflow:hidden"></div>`,()=>{
    omap=L.map('rmap',{zoomControl:false});tiles().addTo(omap);
    const pts=unpack(r.poly);if(pts.length>1){const pl=L.polyline(pts,{color:'#ff8a1f',weight:5}).addTo(omap);omap.fitBounds(pl.getBounds(),{padding:[20,20]})}else omap.setView([0,0],2);
  });
}
function showWrapped(y){
  const w=wrapped(acts,y);
  if(!w.n){overlay(`<div class="wr"><div class="wr-h">YOUR ${y}</div><p class="mut">No runs or walks logged in ${y} yet.</p></div>`);return}
  const mx=Math.max(...w.byMonth,1);
  overlay(`<div class="wr"><div class="wr-h">YOUR ${y}</div><div class="wr-sub">WITH CORRO RUN</div>
  <div class="wr-big">${km(w.dist)}<small> km</small></div>
  <div class="grid">
    <div class="card"><b>${w.n}</b><span class="mut">runs & walks</span></div>
    <div class="card"><b>${fmtT(w.time)}</b><span class="mut">time moving</span></div>
    <div class="card"><b>${km(w.longest)} km</b><span class="mut">longest</span></div>
    <div class="card"><b>${w.fastest?fmtP(w.fastest):'–'}</b><span class="mut">fastest avg pace</span></div>
    <div class="card"><b>${w.activeDays}</b><span class="mut">active days</span></div>
    <div class="card"><b>${w.bestStreak}</b><span class="mut">best streak (days)</span></div>
    <div class="card"><b>${w.bestMonth>=0?MON[w.bestMonth]:'–'}</b><span class="mut">biggest month</span></div>
    <div class="card"><b>${w.favDay>=0?WD[w.favDay]:'–'}</b><span class="mut">favourite day</span></div></div>
  <div class="wbars">${w.byMonth.map((v,i)=>`<div><i style="height:${v/mx*70}px"></i>${MON[i].charAt(0)}</div>`).join('')}</div></div>`);
}

/* ----- actions ----- */
async function find(){
  const code=(C.draft.code||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(!code)throw new Error('Enter the club code');
  const s=await db.doc('clubs/'+code).get();
  if(!s.exists)throw new Error('No club found with that code');
  C.draft.code=code;C.lookup=Object.assign({id:code},s.data());C.err='';render();
}
async function doJoin(){
  const l=C.lookup,name=(C.draft.jname||store.get('clubName','')).trim().slice(0,30);
  if(!name)throw new Error('Enter your name');
  const team=(l.teams||[]).length?(C.draft.jteam||l.teams[0]):'';
  await db.doc(`clubs/${l.id}/members/${C.uid}`).set({name,team,joinedAt:Date.now()});
  store.set('clubId',l.id);store.set('clubName',name);C.draft={};C.lookup=null;await boot();
}
function genCode(){const a='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<6;i++)s+=a[Math.floor(Math.random()*a.length)];return s}
async function doCreate(){
  const name=(C.draft.cname||'').trim(),you=(C.draft.cyou||store.get('clubName','')).trim().slice(0,30);
  if(!name)throw new Error('Enter a club name');if(!you)throw new Error('Enter your name');
  const teams=(C.draft.cteams||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,4),code=genCode();
  await db.doc('clubs/'+code).set({name:name.slice(0,40),teams,ownerUid:C.uid,createdAt:Date.now()});
  await db.doc(`clubs/${code}/members/${C.uid}`).set({name:you,team:teams[0]||'',joinedAt:Date.now()});
  store.set('clubId',code);store.set('clubName',you);C.draft={};await boot();
}
async function kudos(id){
  const r=C.runs.find(x=>x.id===id);if(!r)return;
  const has=r.kudos&&r.kudos[C.uid];
  await db.doc(`${base()}/runs/${id}`).update({['kudos.'+C.uid]:has?FV.delete():true});
}
async function toggleComments(id){
  C.open['c'+id]=!C.open['c'+id];
  if(C.open['c'+id]&&!C.cm[id]){const s=await db.collection(`${base()}/runs/${id}/comments`).orderBy('at').get();C.cm[id]=s.docs.map(d=>Object.assign({id:d.id},d.data()))}
  render();
}
async function sendComment(id){
  const text=(C.draft['cm'+id]||'').trim();if(!text)return;
  const c={uid:C.uid,name:(C.me&&C.me.name)||'Runner',text:text.slice(0,300),at:Date.now()};
  await db.collection(`${base()}/runs/${id}/comments`).add(c);
  (C.cm[id]||(C.cm[id]=[])).push(c);C.draft['cm'+id]='';render();
}
function localAct(runId){const i=runId.indexOf('_');return acts.find(a=>String(a.id)===runId.slice(i+1))}
async function shareRun(a){
  const me=C.members[C.uid]||C.me||{};
  await db.doc(`${base()}/runs/${C.uid}_${a.id}`).set({uid:C.uid,name:me.name||'Runner',type:a.type,dist:Math.round(a.dist),time:a.time,start:a.start,poly:packPoly(a.pts,S.hide),avgHr:a.avgHr||null,ns:nsets(a),vol:Math.round(vol(a)),kudos:{}},{merge:true});
  a.shared=true;store.set('acts',acts);
}
async function unshareRun(a){await db.doc(`${base()}/runs/${C.uid}_${a.id}`).delete();a.shared=false;store.set('acts',acts)}
function ics(e){
  const f=t=>new Date(t).toISOString().replace(/[-:]|\.\d{3}/g,''),x=s=>String(s||'').replace(/[\\;,]/g,m=>'\\'+m).replace(/\n/g,'\\n');
  const t=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Corro Run App//EN','BEGIN:VEVENT','UID:'+e.id+'@corro-run','DTSTAMP:'+f(Date.now()),'DTSTART:'+f(e.start),'DTEND:'+f(e.start+90*60000),
    'SUMMARY:'+x(e.title),'LOCATION:'+x(e.place),'DESCRIPTION:'+x(e.notes),'BEGIN:VALARM','TRIGGER:-PT1H','ACTION:DISPLAY','DESCRIPTION:Group run in 1 hour','END:VALARM','END:VEVENT','END:VCALENDAR'].join('\r\n');
  const u=URL.createObjectURL(new Blob([t],{type:'text/calendar'})),l=document.createElement('a');l.href=u;l.download='group-run.ics';l.click();setTimeout(()=>URL.revokeObjectURL(u),2000);
}
async function invite(){
  const root=(window.CLUB_WEB_URL||(location.origin+location.pathname)).replace(/\?.*$/,'');
  const url=root+(root.indexOf('?')<0?'?club=':'&club=')+C.club.id,text=`Join ${C.club.name} on Corro Run App. Club code: ${C.club.id}`;
  if(navigator.share){try{await navigator.share({title:C.club.name,text,url});return}catch(e){if(e&&e.name==='AbortError')return}}
  try{await navigator.clipboard.writeText(text+'\n'+url);alert('Invite copied:\n'+url)}catch(e){prompt('Copy this invite link:',url)}
}

async function shareEvent(e){
  const root=(window.CLUB_WEB_URL||(location.origin+location.pathname)).replace(/\?.*$/,'');
  const url=root+'?club='+C.club.id+'&event='+e.id,K=KINDS[e.kind]||KINDS.run;
  const text=`${K[0]} ${e.title} · ${new Date(e.start).toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}${e.place?' @ '+e.place:''}. Join ${C.club.name} on Corro Run App (club code ${C.club.id}).`;
  if(navigator.share){try{await navigator.share({title:e.title,text,url});return}catch(x){if(x&&x.name==='AbortError')return}}
  try{await navigator.clipboard.writeText(text+'\n'+url);alert('Session link copied:\n'+url)}catch(x){prompt('Copy this session link:',url)}
}

async function act(name,t){
  const d=t.dataset||{};
  try{
    switch(name){
      case 'tab':C.tab=d.v;render();break;
      case 'period':C.period=d.v;render();break;
      case 'retry':C.err='';if(C.state==='error'){C.started=false;init()}else if(C.club){subscribe();render()}else boot();render();break;
      case 'find':await find();break;
      case 'join':await doJoin();break;
      case 'create':await doCreate();break;
      case 'kudos':await kudos(d.id);break;
      case 'cm':await toggleComments(d.id);break;
      case 'cmsend':await sendComment(d.id);break;
      case 'delrun':{if(!confirm('Remove this run from the club feed?'))break;await db.doc(`${base()}/runs/${d.id}`).delete();const a=localAct(d.id);if(a){a.shared=false;store.set('acts',acts)}break}
      case 'chform':C.open.ch=!C.open.ch;render();break;
      case 'chsave':{
        const title=(C.draft.chtitle||'').trim(),goal=parseFloat(C.draft.chgoal)||0;
        const s=new Date();s.setHours(0,0,0,0);const e=new Date((C.draft.chend||new Date(Date.now()+30*DAY).toISOString().slice(0,10))+'T23:59:59').getTime();
        if(!title)throw new Error('Give the challenge a title');
        if(!(e>s.getTime()))throw new Error('Pick an end date in the future');
        if(e-s.getTime()>63*DAY)throw new Error('Challenges can last up to 2 months');
        await db.collection(base()+'/challenges').add({title:title.slice(0,50),goalKm:goal,start:s.getTime(),end:e,createdBy:C.uid});
        C.open.ch=false;C.draft.chtitle=C.draft.chgoal='';render();break}
      case 'chdel':if(confirm('Delete this challenge?'))await db.doc(`${base()}/challenges/${d.id}`).delete();break;
      case 'evform':C.open.ev=!C.open.ev;render();break;
      case 'evloc':{
        if(!navigator.geolocation)throw new Error('Location not available');
        await new Promise((ok,no)=>navigator.geolocation.getCurrentPosition(p=>{C.draft.evlat=p.coords.latitude;C.draft.evlng=p.coords.longitude;ok()},e=>no(new Error('Could not get location: '+e.message)),{enableHighAccuracy:true,timeout:15000}));
        render();break}
      case 'evsave':{
        const k=C.draft.evkind||'run',title=((C.draft.evtitle||'').trim()||KINDS[k][1]).slice(0,60);
        const def=new Date(Date.now()+DAY-new Date().getTimezoneOffset()*60000).toISOString().slice(0,11)+'06:00';
        const when=new Date(C.draft.evwhen||def).getTime();
        if(isNaN(when))throw new Error('Pick a date and time');
        const groups=(C.draft.evgroups||'').split(',').map(s=>s.trim()).filter(Boolean).slice(0,6);
        const num=(x,d)=>{const v=parseFloat(x);return isNaN(v)?d:v},plan={k};
        if(k==='intervals'){plan.reps=Math.min(30,Math.max(1,Math.round(num(C.draft.evreps,6))));plan.work=Math.max(10,secs(C.draft.evwork,'2:00'));plan.rest=Math.max(0,secs(C.draft.evrest,'1:00'));plan.warm=Math.max(0,Math.round(num(C.draft.evwarm,10)));plan.cool=Math.max(0,Math.round(num(C.draft.evcool,5)))}
        else if(k!=='gym'){const dk=num(C.draft.evdist,0);if(dk>0)plan.dist=dk;const pc=(C.draft.evpace||'').trim().slice(0,30);if(pc)plan.pace=pc}
        await db.collection(base()+'/events').add({title,kind:k,plan,start:when,place:(C.draft.evplace||'').trim().slice(0,80),notes:(C.draft.evnotes||'').trim().slice(0,k==='gym'?400:200),groups,
          lat:C.draft.evlat!=null?C.draft.evlat:null,lng:C.draft.evlng!=null?C.draft.evlng:null,createdBy:C.uid,byName:(C.me&&C.me.name)||'',rsvps:{},createdAt:Date.now()});
        ['evkind','evtitle','evwhen','evplace','evnotes','evgroups','evlat','evlng','evreps','evwork','evrest','evwarm','evcool','evdist','evpace'].forEach(k=>delete C.draft[k]);C.open.ev=false;render();break}
      case 'evkind':C.draft.evkind=t.value;render();break;
      case 'sstart':{const e=C.events.find(x=>x.id===d.id);if(e&&window.guideStart&&window.guideStart(e)){const b=document.querySelector('nav button[data-v="rec"]');if(b)b.click()}break}
      case 'evshare':{const e=C.events.find(x=>x.id===d.id);if(e)await shareEvent(e);break}
      case 'evdel':if(confirm('Delete this group run?'))await db.doc(`${base()}/events/${d.id}`).delete();break;
      case 'rsvp':{
        const e=C.events.find(x=>x.id===d.id);if(!e)break;
        const cur=(e.rsvps||{})[C.uid],g=d.g||'';
        await db.doc(`${base()}/events/${d.id}`).update({['rsvps.'+C.uid]:cur&&cur.g===g?FV.delete():{name:(C.me&&C.me.name)||'Runner',g}});break}
      case 'ics':{const e=C.events.find(x=>x.id===d.id);if(e)ics(e);break}
      case 'route':{const r=C.routes.find(x=>x.id===d.id);if(r)viewRoute(r);break}
      case 'routedel':if(confirm('Delete this route?'))await db.doc(`${base()}/routes/${d.id}`).delete();break;
      case 'savename':{const n=(C.draft.myname!=null?C.draft.myname:(C.me&&C.me.name)||'').trim().slice(0,30);if(!n)throw new Error('Enter a name');
        await db.doc(`${base()}/members/${C.uid}`).update({name:n});store.set('clubName',n);delete C.draft.myname;render();break}
      case 'setteam':await db.doc(`${base()}/members/${C.uid}`).update({team:t.value});break;
      case 'auto':S.auto=t.checked;store.set('clubAuto',S.auto);break;
      case 'hide':S.hide=t.checked;store.set('clubHide',S.hide);break;
      case 'shareold':{
        const l=acts.filter(a=>!a.shared&&a.start>Date.now()-70*DAY&&a.dist>=100);
        for(const a of l)await shareRun(a);
        alert('Shared '+l.length+' run'+(l.length>1?'s':'')+' with the club.');render();break}
      case 'wrapped':showWrapped(+d.y);break;
      case 'invite':await invite();break;
      case 'leave':{
        if(!confirm('Leave this club? Your shared runs stay in the feed unless you delete them first.'))break;
        await db.doc(`${base()}/members/${C.uid}`).delete();
        unsubAll();store.del('clubId');C.club=null;C.me=null;C.members={};C.runs=[];C.events=[];C.chs=[];C.routes=[];C.state='join';render();break}
    }
  }catch(e){C.err=friendly(e);render()}
}
const box=$('#clubBox');
box.addEventListener('click',e=>{
  const t=e.target.closest('[data-act]');if(!t||!box.contains(t))return;
  if(t.tagName==='SELECT')return;   // selects are handled on 'change'
  act(t.dataset.act,t);
});
box.addEventListener('change',e=>{
  const t=e.target;
  if(t.dataset&&t.dataset.act&&(t.tagName==='SELECT'))act(t.dataset.act,t);
  if(t.dataset&&t.dataset.k)C.draft[t.dataset.k]=t.value;
});
box.addEventListener('input',e=>{const k=e.target.dataset&&e.target.dataset.k;if(k)C.draft[k]=e.target.value});

/* ----- hooks used by index.html ----- */
window.renderClub=function(){if(C.cfg)init();render()};
window.clubAfterFinish=function(a){
  if(C.state!=='in'||!S.auto)return;
  shareRun(a).catch(e=>{C.err=friendly(e);dirty()});
};
window.clubDetail=function(a){
  if(C.state!=='in')return;
  const g=$('#mGpx')||$('#mDel'),row=g&&g.parentElement;if(!row)return;
  row.style.flexWrap='wrap';
  const mk=(label,fn)=>{const b=document.createElement('button');b.className='btn s';b.style.cssText='padding:10px;font-size:14px;flex:1 1 40%';b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await fn(b)}catch(e){alert(friendly(e))}b.disabled=false};row.appendChild(b);return b};
  const sb=mk(a.shared?'Remove from club':'🏆 Share to club',async b=>{if(a.shared){await unshareRun(a);b.textContent='🏆 Share to club'}else{await shareRun(a);b.textContent='Remove from club'}});
  if(isGps(a.type))mk('📍 Save as club route',async()=>{
    const name=prompt('Route name (e.g. Riverside 5K loop)');if(!name||!name.trim())return;
    const poly=packPoly(a.pts,false);if(poly.length<4)throw new Error('This activity has no GPS route to save');
    await db.collection(base()+'/routes').add({name:name.trim().slice(0,60),dist:Math.round(a.dist),poly,createdBy:C.uid,byName:(C.me&&C.me.name)||'',createdAt:Date.now()});
    alert('Saved to club routes.');
  });
};

/* ----- start ----- */
try{
  const sp=new URLSearchParams(location.search),q=sp.get('club'),ev=(sp.get('event')||'').replace(/[^A-Za-z0-9]/g,'');
  if(q){C.pendingCode=q.toUpperCase().replace(/[^A-Z0-9]/g,'');if(ev)C.pendingEvent=ev;
    try{history.replaceState(null,'',location.pathname)}catch(e){}
    if(!store.get('clubId',null)||ev){const b=document.querySelector('nav button[data-v="club"]');if(b)setTimeout(()=>b.click(),0)}}
}catch(e){}
if(C.cfg&&(store.get('clubId',null)||C.pendingCode))init();
setInterval(banner,60000);
})();
