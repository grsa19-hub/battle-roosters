// server/server.js - Socket.IO autoritativo simples 1v1
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 8080;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*'},
  path: '/socket.io' // padrão
});

const TICK_MS = 50; // 20 Hz
const ARENA = { w:1280, h:720, wall:40 };
const clamp = (v,a,b)=>Math.max(a,Math.min(b,v));
const circleHit=(a,b)=>{const dx=a.x-b.x,dy=a.y-b.y;return dx*dx+dy*dy <= (a.r+b.r)*(a.r+b.r)};

const ROOSTERS = {
  cavaleiro:{hp:120,speed:2.8,range:62,atk:16,cd:260,abilityCd:3600,id:'cavaleiro'},
  ciborgue:{hp:95,speed:3.1,range:200,atk:10,cd:330,abilityCd:4200,id:'ciborgue'},
  arqueiro:{hp:100,speed:3.2,range:240,atk:9,cd:250,abilityCd:4800,id:'arqueiro'},
  samurai:{hp:105,speed:3.6,range:60,atk:14,cd:210,abilityCd:3600,id:'samurai'},
  xama:{hp:110,speed:2.9,range:150,atk:11,cd:320,abilityCd:5600,id:'xama'},
};
function createFighter(tpl,x,y,pid){ return {...tpl,x,y,r:18,dir:0,vx:0,vy:0,hp:tpl.hp,maxhp:tpl.hp,lastAtk:-9999,lastAbility:-9999,pid,buffs:{speed:0,damage:0,shield:0},alive:true}; }

const rooms = new Map(); // roomId -> {players:[socketId], sockets:{}, inputs:{pid:{keys}}, state, loop, started}

function newRoom(){
  return {
    players:[],
    sockets:{},
    inputs:{},
    state:{
      round:1, bestOf:3, running:false,
      P1:null, P2:null, projectiles:[]
    },
    loop:null,
    started:false
  };
}

function resetRound(st){
  const p1=st.P1, p2=st.P2;
  Object.assign(p1,{x:ARENA.wall+80,y:ARENA.h/2,hp:p1.maxhp,vx:0,vy:0,lastAtk:-9999,lastAbility:-9999,alive:true});
  Object.assign(p2,{x:ARENA.w-ARENA.wall-80,y:ARENA.h/2,hp:p2.maxhp,vx:0,vy:0,lastAtk:-9999,lastAbility:-9999,alive:true});
  st.projectiles=[]; st.running=true;
}

function applyDamage(st,target,amount){
  let dmg=amount;
  if(target.buffs.shield>0){ const absorb=Math.min(target.buffs.shield,dmg); target.buffs.shield-=absorb; dmg-=absorb; }
  if(dmg<=0) return;
  target.hp=Math.max(0,target.hp-dmg);
  if(target.hp<=0){ target.alive=false; st.running=false; }
}

function doAttack(st,from,to){
  const bonus=from.buffs.damage>0?1.35:1.0; const now=Date.now();
  if(now-from.lastAtk<from.cd) return; from.lastAtk=now;
  if(from.range<=70){
    const ang=Math.atan2(to.y-from.y,to.x-from.x);
    from.x+=Math.cos(ang)*8; from.y+=Math.sin(ang)*8;
    if(Math.hypot(to.x-from.x,to.y-from.y)<from.r+30) applyDamage(st,to,from.atk*bonus);
  }else{
    const ang=Math.atan2(to.y-from.y,to.x-from.x);
    st.projectiles.push({
      x:from.x+Math.cos(ang)*22, y:from.y+Math.sin(ang)*22,
      vx:Math.cos(ang)*(from.id==='ciborgue'?5.0:5.6),
      vy:Math.sin(ang)*(from.id==='ciborgue'?5.0:5.6),
      r:(from.id==='ciborgue'?7:5), dmg:from.atk*bonus, until:Date.now()+1600, team:from.pid, kind:'shot'
    });
  }
}
function doAbility(st,from,to){
  const now=Date.now(); if(now-from.lastAbility<from.abilityCd) return; from.lastAbility=now;
  const id=from.id, bonus=from.buffs.damage>0?1.25:1.0;
  if(id==='samurai'){ if(Math.hypot(to.x-from.x,to.y-from.y)<90) applyDamage(st,to,(from.atk+12)*bonus); }
  if(id==='cavaleiro'){ const a=Math.atan2(to.y-from.y,to.x-from.x); from.x+=Math.cos(a)*12*8; from.y+=Math.sin(a)*12*8; if(Math.hypot(to.x-from.x,to.y-from.y)<from.r+40) applyDamage(st,to,(from.atk+14)*bonus); from.buffs.shield+=12; }
  if(id==='ciborgue'){ const a=Math.atan2(to.y-from.y,to.x-from.x), s=0.14; for(let i=-2;i<=2;i++){ st.projectiles.push({x:from.x+Math.cos(a)*22,y:from.y+Math.sin(a)*22,vx:Math.cos(a+i*s)*7.8,vy:Math.sin(a+i*s)*7.8,r:5,dmg:(from.atk*0.9)*bonus,until:Date.now()+1300,team:from.pid,kind:'rocket',pierce:true}); } }
  if(id==='arqueiro'){ const cx=to.x,cy=to.y; for(let k=0;k<12;k++){ const x=cx+(Math.random()*2-1)*60, y=cy+(Math.random()*2-1)*60; st.projectiles.push({x,y:y-160,vx:0,vy:7,r:5,dmg:(from.atk*0.9)*bonus,until:Date.now()+1700,team:from.pid,kind:'arrow'});} }
  if(id==='xama'){ from.hp=Math.min(from.maxhp,from.hp+16); }
}

function step(st,inputs){
  const now=Date.now();
  const p1=st.P1, p2=st.P2;
  [p1,p2].forEach(p=>{
    const k=inputs[p.pid]?.keys||{};
    const sp=p.speed*(p.buffs.speed>0?1.4:1);
    let vx=((k.d?1:0)-(k.a?1:0)), vy=((k.s?1:0)-(k.w?1:0)); const len=Math.hypot(vx,vy)||1; vx=vx/len*sp; vy=vy/len*sp;
    p.vx=vx; p.vy=vy;
    if(vx||vy) p.dir=Math.atan2(vy,vx);
    p.x=clamp(p.x+vx,ARENA.wall,ARENA.w-ARENA.wall);
    p.y=clamp(p.y+vy,ARENA.wall,ARENA.h-ARENA.wall);
    if(k.j) doAttack(st,p,p.pid===1?p2:p1);
    if(k.k) doAbility(st,p,p.pid===1?p2:p1);
  });

  for(let i=st.projectiles.length-1;i>=0;i--){
    const pr=st.projectiles[i];
    pr.x+=pr.vx; pr.y+=pr.vy;
    if(now>pr.until){ st.projectiles.splice(i,1); continue; }
    if(pr.x<pr.r+ARENA.wall||pr.x>ARENA.w-ARENA.wall-pr.r){ pr.vx*=-1; pr.x=clamp(pr.x,pr.r+ARENA.wall,ARENA.w-ARENA.wall-pr.r); }
    if(pr.y<pr.r+ARENA.wall||pr.y>ARENA.h-ARENA.wall-pr.r){ pr.vy*=-1; pr.y=clamp(pr.y,pr.r+ARENA.wall,ARENA.h-ARENA.wall-pr.r); }
    const tgt=pr.team===1?p2:p1;
    if(circleHit(pr,tgt)){
      applyDamage(st,tgt,pr.dmg);
      if(!pr.pierce) st.projectiles.splice(i,1); else pr.dmg*=0.75;
    }
  }
}

function makeSnapshot(st){
  return {
    t:Date.now(), round:st.round, running:st.running, bestOf:st.bestOf,
    P1:(({x,y,hp,maxhp,dir,id})=>({x,y,hp,maxhp,dir,id}))(st.P1),
    P2:(({x,y,hp,maxhp,dir,id})=>({x,y,hp,maxhp,dir,id}))(st.P2),
    projectiles: st.projectiles.map(p=>({x:p.x,y:p.y,r:p.r,kind:p.kind,team:p.team}))
  };
}

// ---- Servidor ----
app.get('/',(_req,res)=>res.send('Socket.IO Galos online'));

io.on('connection',(socket)=>{
  let room=rooms.get('default'); if(!room){ room=newRoom(); rooms.set('default',room); }
  if(room.players.length>=2){ socket.emit('full'); socket.disconnect(true); return; }

  const pid = room.players.length===0?1:2;
  room.players.push(socket.id);
  room.sockets[pid]=socket;
  room.inputs[pid]={keys:{}};

  const tpl = ROOSTERS[pid===1?'cavaleiro':'samurai'];
  if(pid===1) room.state.P1=createFighter(tpl,ARENA.wall+80,ARENA.h/2,1);
  else room.state.P2=createFighter(tpl,ARENA.w-ARENA.wall-80,ARENA.h/2,2);

  socket.emit('hello',{pid,arena:ARENA});

  if(room.players.length===2 && !room.started){
    room.started=true; room.state.round=1; resetRound(room.state);
    room.loop=setInterval(()=>{
      if(room.state.running) step(room.state,room.inputs);
      const snap=makeSnapshot(room.state);
      room.players.forEach(id=>{ const s=io.sockets.sockets.get(id); if(s) s.emit('snapshot',snap); });
    }, TICK_MS);
  }

  socket.on('input',data=>{ room.inputs[pid]={keys:data?.keys||{}}; });
  socket.on('select',data=>{
    const id=data?.id; if(ROOSTERS[id]){
      const tplSel=ROOSTERS[id];
      if(pid===1) Object.assign(room.state.P1,tplSel,{id,maxhp:tplSel.hp,hp:tplSel.hp});
      else Object.assign(room.state.P2,tplSel,{id,maxhp:tplSel.hp,hp:tplSel.hp});
    }
  });

  socket.on('disconnect',()=>{
    const idx=room.players.indexOf(socket.id);
    if(idx>=0) room.players.splice(idx,1);
    if(room.players.length===0){ if(room.loop) clearInterval(room.loop); rooms.delete('default'); }
  });
});

server.listen(PORT, ()=>console.log('Socket.IO listening on :' + PORT));
