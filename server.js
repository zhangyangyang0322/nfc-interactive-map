/**
 * NFC 碰一碰 · 桥接服务器（含打卡数据后台）
 * -------------------------------------------------------------
 * 作用：
 *   1. 接收手机(Web NFC)/ESP32 上报的点位事件，WebSocket 推送给浏览器大屏点亮；
 *   2. 服务端累计统计：总人次、参与总人数(按 participant 去重)、完成人数、各点位热度；
 *   3. 提供后台管理页 /admin，实时查看"碰完的总人数"等数据。
 *
 * 启动：
 *   npm init -y && npm i ws
 *   node server.js                     # 默认端口 3000
 *   TOTAL_POINTS=8 node server.js      # 设置总点位(用于计算"完成人数")，默认 8
 *
 * 接口：
 *   GET  /health            → {"ok":true}
 *   GET  /api/stats         → {total, unique, completed, points:{id:{count,people}}}
 *   POST /api/tap           body:{"point":3,"participant":"uid123"}   participant 必填用于统计总人数
 *   GET  /admin             → 后台数据看板(浏览器打开)
 *   WS   ws://<ip>:3000     → {type:"nfc",point} 与 {type:"stats",...}
 *
 * 说明：
 *   - "总人数"按 participant(每人一个唯一ID)去重；同一人重复碰只计 1 人，但人次照常累加。
 *   - participant 由前端浏览器生成并持久保存(每人一个)，详见 HTML 侧。
 *   - 数据落盘到 checkins.json；事件流仅存内存(最近50条)。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const TOTAL_POINTS = Number(process.env.TOTAL_POINTS || 8); // 总点位，用于"完成人数"
const DATA_FILE = path.join(__dirname, "checkins.json");

// ---- 数据存储 ----
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    return { total: 0, points: {}, pointPeople: {}, participants: {} };
  }
}
let DATA = loadData();
let EVENTS = []; // 内存事件流(最近50条)

function saveData() {
  fs.writeFile(DATA_FILE, JSON.stringify(DATA), () => {});
}
function broadcast(obj) {
  const s = JSON.stringify(obj);
  let n = 0;
  wss.clients.forEach(c => { if (c.readyState === 1) { c.send(s); n++; } });
  return n;
}
function statsPayload() {
  const uids = Object.keys(DATA.participants || {});
  let completed = 0;
  uids.forEach(uid => { if ((DATA.participants[uid] || []).length >= TOTAL_POINTS) completed++; });
  const points = {};
  Object.keys(DATA.points || {}).forEach(id => {
    points[id] = {
      count: DATA.points[id],
      people: (DATA.pointPeople[id] || []).length
    };
  });
  return { type: "stats", total: DATA.total, unique: uids.length, completed, points };
}

// ---- HTTP ----
const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = req.url.split("?")[0];

  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  if (req.method === "GET" && url === "/api/stats") {
    const p = statsPayload();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(p));
  }

  if (req.method === "GET" && url === "/api/events") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(EVENTS));
  }

  if (req.method === "POST" && url === "/api/tap") {
    let body = "";
    req.on("data", c => { body += c; if (body.length > 1e4) req.destroy(); });
    req.on("end", () => {
      let point = null, participant = null;
      try { const b = JSON.parse(body); point = Number(b.point); participant = (b.participant || "").toString().trim(); } catch (e) {}
      if (!Number.isInteger(point) || point <= 0) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ ok: false, error: "point 必须是正整数" }));
      }
      const pid = String(point);
      // 累计人次
      DATA.total += 1;
      DATA.points[pid] = (DATA.points[pid] || 0) + 1;
      // 参与人数去重(participant 必填才算人；缺省仅计入人次)
      if (participant) {
        DATA.pointPeople[pid] = DATA.pointPeople[pid] || [];
        if (DATA.pointPeople[pid].indexOf(participant) === -1) DATA.pointPeople[pid].push(participant);
        DATA.participants[participant] = DATA.participants[participant] || [];
        if (DATA.participants[participant].indexOf(point) === -1) DATA.participants[participant].push(point);
      }
      saveData();
      // 事件流
      EVENTS.unshift({ t: Date.now(), point, participant: participant || null });
      if (EVENTS.length > 50) EVENTS.pop();

      const st = statsPayload();
      broadcast(JSON.stringify({ type: "nfc", point }));
      broadcast(JSON.stringify(st));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, ...st }));
    });
    return;
  }

  if (req.method === "GET" && url === "/admin") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(adminHtml());
  }

  res.writeHead(404); res.end("not found");
});

// ---- WebSocket ----
const wss = new WebSocketServer({ server });
wss.on("connection", ws => {
  ws.send(JSON.stringify(statsPayload()));
  ws.on("close", () => {});
});

server.listen(PORT, () => {
  console.log("NFC 打卡后台已启动:");
  console.log("  数据后台   http://<本机IP>:" + PORT + "/admin");
  console.log("  统计接口   curl http://localhost:" + PORT + "/api/stats");
  console.log("  WS 广播    ws://<本机IP>:" + PORT + "   总点位=" + TOTAL_POINTS + " 已累计=" + DATA.total);
});

// ---- 后台管理页 ----
function adminHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230e1520'/%3E%3Ccircle cx='16' cy='16' r='6' fill='%23e8a33d'/%3E%3C/svg%3E">
<title>NFC 打卡数据后台</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#0c1118;color:#f2ecdc;min-height:100vh;padding:22px}
.wrap{max-width:1080px;margin:0 auto}
h1{font-size:20px;letter-spacing:2px;margin-bottom:4px}
.sub{color:#8a8474;font-size:12.5px;margin-bottom:22px}
.cards{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:22px}
.card{background:linear-gradient(180deg,#151e2e,#0f1724);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:18px}
.card .k{font-size:12px;color:#8a8474;letter-spacing:1px}
.card .v{font-family:Georgia,serif;font-size:40px;font-weight:700;color:#ffcf6e;margin-top:8px}
.card .u{font-size:11px;color:#8a8474;margin-top:4px}
.card.accent .v{color:#59b7a8}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
.panel{background:linear-gradient(180deg,#151e2e,#0f1724);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:18px}
.panel h2{font-size:13.5px;color:#ffcf6e;letter-spacing:1px;margin-bottom:14px}
.row{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.row .nm{flex:none;width:120px;font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{flex:1;height:14px;background:rgba(255,255,255,.05);border-radius:7px;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#e8a33d,#ffcf6e);border-radius:7px;transition:width .6s}
.row .num{flex:none;width:74px;text-align:right;font-size:12px;color:#8a8474}
.feed{max-height:300px;overflow-y:auto}
.feed .it{display:flex;gap:10px;align-items:center;padding:8px 0;border-bottom:1px dashed rgba(255,255,255,.07);font-size:12.5px}
.feed .it .t{color:#8a8474;font-variant-numeric:tabular-nums;flex:none}
.feed .it .p{color:#ffcf6e;flex:none}
.feed .it .who{color:#8a8474;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.muted{color:#5b5666;font-size:11.5px;text-align:center;padding:20px 0}
@media(max-width:720px){.cards{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}
</style></head><body>
<div class="wrap">
<h1>NFC 打卡数据后台</h1>
<div class="sub">实时统计 · 每 2.5 秒自动刷新</div>
<div class="cards">
  <div class="card"><div class="k">碰完总人数</div><div class="v" id="nUnique">0</div><div class="u">按人去重 · 同一人只计一次</div></div>
  <div class="card"><div class="k">累计打卡</div><div class="v" id="nTotal">0</div><div class="u">总人次</div></div>
  <div class="card accent"><div class="k">完成人数</div><div class="v" id="nDone">0</div><div class="u">集齐全部点位</div></div>
  <div class="card"><div class="k">总点位</div><div class="v" id="nPoints">0</div><div class="u">地图点位数量</div></div>
</div>
<div class="grid">
  <div class="panel"><h2>点位热度（按参与人数）</h2><div id="pointsList"></div></div>
  <div class="panel"><h2>最近打卡动态</h2><div class="feed" id="feed"><div class="muted">等待打卡…</div></div></div>
</div>
</div>
<script>
const POINT_NAMES=${JSON.stringify(pointNames())};
const TOT=${TOTAL_POINTS};
function shortUid(u){return u?u.slice(0,8):"—";}
function fmt(ms){const d=new Date(ms);return ("0"+d.getHours()).slice(-2)+":"+("0"+d.getMinutes()).slice(-2)+":"+("0"+d.getSeconds()).slice(-2);}
async function load(){
  try{
    const r=await fetch("/api/stats");const d=await r.json();
    document.getElementById("nUnique").textContent=d.unique;
    document.getElementById("nTotal").textContent=d.total;
    document.getElementById("nDone").textContent=d.completed;
    document.getElementById("nPoints").textContent=TOT;
    const pl=document.getElementById("pointsList");pl.innerHTML="";
    let max=1;const ids=Object.keys(d.points||{});
    ids.forEach(i=>{if(d.points[i].people>max)max=d.points[i].people;});
    if(ids.length===0){pl.innerHTML='<div class="muted">暂无打卡</div>';}
    ids.forEach(i=>{
      const nm=POINT_NAMES[i]||("点位"+i);const v=d.points[i];
      const row=document.createElement("div");row.className="row";
      row.innerHTML='<span class="nm" title="'+nm+'">'+nm+'</span><div class="bar"><i style="width:'+(v.people/max*100)+'%"></i></div><span class="num">'+v.people+' 人 / '+v.count+' 次</span>';
      pl.appendChild(row);
    });
  }catch(e){}
}
async function feed(){
  try{const r=await fetch("/api/events");const ev=await r.json();
    const f=document.getElementById("feed");
    if(ev.length===0){f.innerHTML='<div class="muted">等待打卡…</div>';return;}
    f.innerHTML=ev.map(e=>'<div class="it"><span class="t">'+fmt(e.t)+'</span><span class="p">'+(POINT_NAMES[e.point]||("点位"+e.point))+'</span><span class="who">'+shortUid(e.participant)+'</span></div>').join("");
  }catch(e){}
}
load();feed();setInterval(load,2500);setInterval(feed,2500);
</script>
</body></html>`;
}

// 点位名称映射：与前端 HTML 的 POINTS 保持一致，可按需增改
function pointNames() {
  return {
    "1":"运河天地","2":"桥西历史文化街区","3":"小河直街","4":"小河公园",
    "5":"大兜路历史文化街区","6":"富义仓","7":"运河映巷","8":"运河湾"
  };
}
