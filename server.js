// server.js — Servidor autoritativo simples p/ 1v1
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 8080;
const TICK_MS = 50; // 20 Hz
const ARENA = { w:1280, h:720, wall:40 };
function clamp(v,a,b){ return Math.max(a, Math.min(b, v)); }

const ROOSTERS = {
  cavaleiro:{hp:120,speed:2.8,range:62,atk:16,cd:260,abilityCd:3600,id:'cavaleiro'},
  ciborgue:{hp:95,speed:3.1,range:200,atk:10,cd:330,abilityCd:4200,id:'ciborgue'},
  arqueiro:{hp:100,speed:3.2,range:240,atk:9,cd:250,abilityCd:4800,id:'arqueiro'},
  samurai:{hp:105,speed:3.6,range:60,atk:14,cd:210,abilityCd:3600,id:'samurai'},
  xama:{hp:110,speed:2.9,range:150,atk:11,cd:320,abilityCd:5600,id:'xama'},
};

function createFighter(tpl, x,y, pid){
  return {
    ...tpl, x,y, r:18, dir:0, vx:0, vy:0,
    hp: tpl.hp, maxhp: tpl.hp,
    lastAtk: -9999, lastAbility: -9999,
    pid, buffs:{speed:0,damage:0,shield:0}, alive:true
  };
}

const rooms = new Map(); // roomId -> {players:[ws,ws], state, inputs:{pid:{seq,keys}}, started:boolean}

function newRoom(){
  return {
    players:[],
    state:{
      round:1, bestOf:3,
      P1:null, P2:null,
      projectiles:[], powerups:[], obstacles:[],
      running:false
    },
    inputs: {}, // pid -> {seq, keys:{w,a,s,d,j,k}}
    started:false,
    loop:null
  };
}

function spawnObstacles(st){
  st.obstacles = [
    {x:ARENA.w*0.5,y:ARENA.h*0.5,r:38},
    {x:ARENA.w*0.25,y:ARENA.h*0.35,r:28},
    {x:ARENA.w*0.75,y:ARENA.h*0.65,r:32},
  ];
}

function resetRound(st){
  spawnObstacles(st);
  const p1 = st.P1, p2 = st.P2;
  Object.assign(p1, {x:ARENA.wall+80, y:ARENA.h/2, hp:p1.maxhp, vx:0,vy:0, lastAtk:-9999,lastAbility:-9999, alive:true});
  Object.assign(p2, {x:ARENA.w-ARENA.wall-80, y:ARENA.h/2, hp:p2.maxhp, vx:0,vy:0, lastAtk:-9999,lastAbility:-9999, alive:true});
  st.projectiles = []; st.powerups = [];
  st.running = true;
}

function circleHit(a,b){ const dx=a.x-b.x, dy=a.y-b.y; return dx*dx+dy*dy <= (a.r+b.r)*(a.r+b.r); }

function applyDamage(st, target, amount){
  let dmg = amount;
  if(target.buffs.shield>0){
    const absorb = Math.min(target.buffs.shield, dmg);
    target.buffs.shield -= absorb; dmg -= absorb;
  }
  if(dmg<=0) return;
  target.hp = Math.max(0, target.hp - dmg);
  if(target.hp<=0){ target.alive=false; st.running=false; }
}

function doAttack(st, from, to){
  const bonus = from.buffs.damage>0 ? 1.35 : 1.0;
  const now = Date.now();
  if(now - from.lastAtk < from.cd) return;
  from.lastAtk = now;
  if(from.range<=70){
    const ang=Math.atan2(to.y-from.y,to.x-from.x);
    from.x+=Math.cos(ang)*8; from.y+=Math.sin(ang)*8;
    if(Math.hypot(to.x-from.x,to.y-from.y) < from.r+30)
      applyDamage(st, to, from.atk*bonus);
  } else {
    const ang=Math.atan2(to.y-from.y,to.x-from.x);
    st.projectiles.push({
      x:from.x+Math.cos(ang)*22, y:from.y+Math.sin(ang)*22,
      vx:Math.cos(ang)*(from.id==='ciborgue'?5.0:5.6),
      vy:Math.sin(ang)*(from.id==='ciborgue'?5.0:5.6),
      r:(from.id==='ciborgue'?7:5), dmg:from.atk*bonus,
      until:Date.now()+1600, team:from.pid, kind:(from.id==='arqueiro'?'arrow':(from.id==='ciborgue'?'rocket':'generic'))
    });
  }
}

function doAbility(st, from, to){
  const now=Date.now(); if(now-from.lastAbility<from.abilityCd) return; from.lastAbility=now;
  const id=from.id; const bonus= from.buffs.damage>0?1.25:1.0;
  if(id==='cavaleiro'){
    const ang=Math.atan2(to.y-from.y,to.x-from.x);
    from.x+=Math.cos(ang)*12*8; from.y+=Math.sin(ang)*12*8;
    if(Math.hypot(to.x-from.x,to.y-from.y)< from.r+40){ applyDamage(st,to,(from.atk+14)*bonus); }
    from.buffs.shield+=12;
  }
  if(id==='ciborgue'){
    const ang=Math.atan2(to.y-from.y,to.x-from.x), spread=0.14;
    for(let i=-2;i<=2;i++){
      st.projectiles.push({
        x:from.x+Math.cos(ang)*22, y:from.y+Math.sin(ang)*22,
        vx:Math.cos(ang+i*spread)*7.8, vy:Math.sin(ang+i*spread)*7.8,
        r:5, dmg:(from.atk*0.9)*bonus, until:Date.now()+1300, team:from.pid, kind:'rocket', pierce:true
      });
    }
  }
  if(id==='arqueiro'){
    const cx=to.x, cy=to.y;
    for(let k=0;k<12;k++){
      const x=cx+(Math.random()*2-1)*60, y=cy+(Math.random()*2-1)*60;
      st.projectiles.push({x, y:y-160, vx:0, vy:7, r:5, dmg:(from.atk*0.9)*bonus, until:Date.now()+1700, team:from.pid, kind:'arrow'});
    }
  }
  if(id==='samurai'){
    if(Math.hypot(to.x-from.x,to.y-from.y)<90){ applyDamage(st,to,(from.atk+12)*bonus); }
  }
  if(id==='xama'){
    from.hp = Math.min(from.maxhp, from.hp+16);
  }
}

function step(st, inputs){
  const now = Date.now();
  const p1 = st.P1, p2 = st.P2;

  [p1,p2].forEach(p=>{
    const inp = inputs[p.pid]?.keys || {};
    const sp = p.speed * (p.buffs.speed>0?1.4:1);
    let vx = ((inp.d?1:0)-(inp.a?1:0)), vy = ((inp.s?1:0)-(inp.w?1:0));
    const len=Math.hypot(vx,vy)||1; vx/=len; vy/=len;
    p.vx = vx*sp; p.vy = vy*sp;
    if(vx||vy) p.dir=Math.atan2(p.vy,p.vx);
    p.x = clamp(p.x+p.vx, ARENA.wall, ARENA.w-ARENA.wall);
    p.y = clamp(p.y+p.vy, ARENA.wall, ARENA.h-ARENA.wall);

    if(inp.j) doAttack(st, p, p.pid===1? p2 : p1);
    if(inp.k) doAbility(st, p, p.pid===1? p2 : p1);
  });

  for(let i=st.projectiles.length-1;i>=0;i--){
    const pr = st.projectiles[i];
    pr.x+=pr.vx; pr.y+=pr.vy;
    if(now>pr.until){ st.projectiles.splice(i,1); continue; }
    if(pr.x<pr.r+ARENA.wall||pr.x>ARENA.w-ARENA.wall-pr.r){ pr.vx*=-1; pr.x=clamp(pr.x, pr.r+ARENA.wall, ARENA.w-ARENA.wall-pr.r); }
    if(pr.y<pr.r+ARENA.wall||pr.y>ARENA.h-ARENA.wall-pr.r){ pr.vy*=-1; pr.y=clamp(pr.y, pr.r+ARENA.wall, ARENA.h-ARENA.wall-pr.r); }
    const tgt = pr.team===1? p2 : p1;
    if(circleHit(pr,tgt)){
      applyDamage(st, tgt, pr.dmg);
      if(!pr.pierce) st.projectiles.splice(i,1); else pr.dmg*=0.75;
    }
  }
}

function makeSnapshot(room){
  const st = room.state;
  return JSON.stringify({
    type:'snapshot',
    t: Date.now(),
    round: st.round, running: st.running, bestOf: st.bestOf,
    P1: (({x,y,hp,maxhp,dir,id})=>({x,y,hp,maxhp,dir,id}))(st.P1),
    P2: (({x,y,hp,maxhp,dir,id})=>({x,y,hp,maxhp,dir,id}))(st.P2),
    projectiles: st.projectiles.map(p=>({x:p.x,y:p.y,r:p.r,kind:p.kind,team:p.team}))
  });
}

const server = http.createServer((req,res)=>{
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Galos WS server running");
});
const wss = new WebSocket.Server({ server });

wss.on("connection", (ws)=>{
  // única sala "default"
  let room = rooms.get("default");
  if(!room) { room = newRoom(); rooms.set("default", room); }

  if(room.players.length>=2){ ws.send(JSON.stringify({type:'full'})); ws.close(); return; }

  const pid = room.players.length===0? 1 : 2;
  room.players.push(ws);

  // personagem inicial padrão (pode mudar via 'select')
  const tpl = ROOSTERS[pid===1? 'cavaleiro':'samurai'];
  if(pid===1) room.state.P1 = createFighter(tpl, ARENA.wall+80, ARENA.h/2, 1);
  else room.state.P2 = createFighter(tpl, ARENA.w-ARENA.wall-80, ARENA.h/2, 2);

  room.inputs[pid] = {seq:0, keys:{}};

  ws.send(JSON.stringify({type:'hello', pid, arena:ARENA}));

  // quando dois jogadores conectarem, inicia o loop
  if(room.players.length===2 && !room.started){
    room.started = true; room.state.round=1; resetRound(room.state);
    room.loop = setInterval(()=>{
      if(room.state.running) step(room.state, room.inputs);
      const snap = makeSnapshot(room);
      room.players.forEach(p=>{ if(p.readyState===WebSocket.OPEN) p.send(snap); });
    }, TICK_MS);
  }

  ws.on("message",(msg)=>{
    try{
      const data = JSON.parse(msg);
      if(data.type==='input'){
        room.inputs[pid] = {seq:data.seq||0, keys:data.keys||{}};
      }
      if(data.type==='select' && ROOSTERS[data.id]){
        const tplSel = ROOSTERS[data.id];
        if(pid===1) Object.assign(room.state.P1, tplSel, {id:data.id, maxhp:tplSel.hp, hp:tplSel.hp});
        else Object.assign(room.state.P2, tplSel, {id:data.id, maxhp:tplSel.hp, hp:tplSel.hp});
      }
    }catch(e){}
  });

  ws.on("close", ()=>{
    const idx = room.players.indexOf(ws);
    if(idx>=0) room.players.splice(idx,1);
    if(room.players.length===0){
      if(room.loop) clearInterval(room.loop);
      rooms.delete("default");
    }
  });
});

server.listen(PORT, ()=>console.log(`WS on ws://localhost:${PORT}`));
