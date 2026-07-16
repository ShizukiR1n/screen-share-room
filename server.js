'use strict';

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_MEMBERS = 3;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// TURN 中继配置，按优先级支持三种方式（都不配置时返回空列表，前端回退纯 STUN）：
// 1. 自建 coturn（国内 VPS）：TURN_HOST + TURN_SECRET（use-auth-secret 模式，凭据 12h 过期）
// 2. 静态凭据（如 ExpressTURN）：TURN_URLS（逗号分隔）+ TURN_USERNAME + TURN_CREDENTIAL
// 3. Cloudflare 临时凭据：CF_TURN_KEY_ID + CF_TURN_API_TOKEN
const TURN_HOST = process.env.TURN_HOST;
const TURN_SECRET = process.env.TURN_SECRET;
// coturn 中继端口。443/udp（QUIC 端口，校园/公司网不敢限速）已让给 OBS 推流的
// 媒体端口（见下方 MediaMTX 配置），浏览器共享模式的中继回到标准 3478
const TURN_PORT = process.env.TURN_PORT || 3478;
const TURN_URLS = process.env.TURN_URLS;
const TURN_USERNAME = process.env.TURN_USERNAME;
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL;
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID;
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN;
let iceCache = { until: 0, servers: [] };

// OBS 推流模式（全 TCP，绕开运营商对高速率 UDP 的限速）：
//   上传：OBS 用 RTMP（TCP 1935）把画面推到自建 MediaMTX（与 coturn 同一台服务器）
//   观看：浏览器用 HLS（HTTP/TCP）从 MediaMTX 拉流，经本服务代理（页面是 HTTPS，
//        直连 MediaMTX 的 HTTP 会被浏览器按混合内容拦掉；代理同时注入鉴权、隐藏媒体服务器）
// 之所以放弃 WHIP/WHEP(WebRTC/UDP)：实测移动宽带把 6Mbps 的上行 UDP 掐到 1Mbps
// （TCP 却有 58Mbps），换 TCP 后任何网络都能高码率，代价是 HLS 有 1~3 秒延迟。
const MTX_PUBLISH_PASS = process.env.MTX_PUBLISH_PASS; // OBS RTMP 推流密码
const MTX_READ_PASS = process.env.MTX_READ_PASS;       // HLS 拉流密码（仅代理内部使用）
const MTX_HLS_PORT = process.env.MTX_HLS_PORT || 8888;
const MTX_RTMP_PORT = process.env.MTX_RTMP_PORT || 1935;
const MTX_PATH = process.env.MTX_PATH || 'beam';
// 观看端直连 MediaMTX 的 HTTPS 地址（如 https://8-134-66-167.sslip.io:8888）。
// 实测经 Render 中转只有 ~2Mbps（跨境链路），直连国内服务器可达 60Mbps+，
// 高码率（6~8Mbps）必须直连才放得动；未配置时回退到 /hls 代理（低码率可用）。
// 直连路径（MTX_PATH）应设为长随机串当访问口令：读权限对该路径匿名开放
// （Safari 原生 HLS 播放器带不了鉴权头），路径本身就是秘密。
const MTX_HLS_PUBLIC = (process.env.MTX_HLS_PUBLIC || '').replace(/\/+$/, '');
const OBS_ENABLED = !!(TURN_HOST && MTX_PUBLISH_PASS && MTX_READ_PASS);
// 给演示者显示的 RTMP 推流地址（含推流密码，仅下发给拿到共享权的本人）
const RTMP_URL = OBS_ENABLED
  ? `rtmp://${TURN_HOST}:${MTX_RTMP_PORT}/${MTX_PATH}?user=publisher&pass=${MTX_PUBLISH_PASS}`
  : '';
// 下发给房间成员的直连播放地址（仅进入 OBS 直播模式的房间成员可拿到）
const HLS_DIRECT_URL = OBS_ENABLED && MTX_HLS_PUBLIC
  ? `${MTX_HLS_PUBLIC}/${MTX_PATH}/index.m3u8`
  : '';

app.get('/api/ice', async (req, res) => {
  if (TURN_HOST && TURN_SECRET) {
    // coturn use-auth-secret：用户名为过期时间戳，凭据为 HMAC-SHA1 签名
    const username = String(Math.floor(Date.now() / 1000) + 12 * 3600);
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    // 只提供 UDP 中继（TCP 中继会导致拥塞控制死亡螺旋，绝不使用）
    const ports = [...new Set([Number(TURN_PORT), 3478])];
    return res.json({
      iceServers: ports.map((p) => ({
        urls: [`turn:${TURN_HOST}:${p}?transport=udp`],
        username,
        credential,
      })),
    });
  }
  if (TURN_URLS && TURN_USERNAME && TURN_CREDENTIAL) {
    return res.json({
      iceServers: [{
        urls: TURN_URLS.split(',').map((u) => u.trim()).filter(Boolean),
        username: TURN_USERNAME,
        credential: TURN_CREDENTIAL,
      }],
    });
  }
  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) return res.json({ iceServers: [] });
  if (Date.now() < iceCache.until) return res.json({ iceServers: iceCache.servers });
  try {
    const r = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${CF_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${CF_TURN_API_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 86400 }),
      }
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    let servers = data.iceServers || [];
    if (!Array.isArray(servers)) servers = [servers];
    // 凭据有效期 24h，缓存 6h
    iceCache = { until: Date.now() + 6 * 3600 * 1000, servers };
    res.json({ iceServers: servers });
  } catch (err) {
    console.error('获取 Cloudflare TURN 凭据失败:', err.message);
    res.json({ iceServers: [] });
  }
});

/* ================= OBS 推流观看（HLS 代理，全 TCP） ================= */

// 观看端 HLS 拉流：浏览器请求 /hls/<房间码>/<文件>，本服务带鉴权转发到 MediaMTX。
// MediaMTX 全局只有一条推流路径（MTX_PATH），所有房间共用；房间码只用来校验
// 该房间确实处于 OBS 直播中（防止拿到 IP 的陌生人直接扒流）。
// m3u8 里的分片名是相对路径，浏览器会自动带上 /hls/<房间码>/ 前缀再打回本代理。
app.get('/hls/:room/*', async (req, res) => {
  if (!OBS_ENABLED) return res.status(503).end();
  const room = rooms.get(String(req.params.room || '').trim().toUpperCase());
  if (!room || room.presenterMode !== 'obs') return res.status(404).end();
  const file = req.params[0]; // index.m3u8 / 子播放列表 / 分片文件名
  // 保留原始查询串（低延迟 HLS 的 _HLS_msn/_HLS_part 阻塞式拉取要靠它）
  const qi = req.originalUrl.indexOf('?');
  const qs = qi >= 0 ? req.originalUrl.slice(qi) : '';
  // MediaMTX 的 HLS 鉴权只认 HTTP Basic（查询参数 user/pass 会被拒 401）
  const auth = 'Basic ' + Buffer.from(`viewer:${MTX_READ_PASS}`).toString('base64');
  // 开启直连（MediaMTX 转 HTTPS）后，上游也走 HTTPS 域名（证书按域名校验）
  const upstream = MTX_HLS_PUBLIC || `http://${TURN_HOST}:${MTX_HLS_PORT}`;
  try {
    const r = await fetch(`${upstream}/${MTX_PATH}/${file}${qs}`, {
      headers: { Authorization: auth },
    });
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type');
    if (ct) res.set('Content-Type', ct);
    // m3u8 播放列表禁止缓存（低延迟直播每秒都在变），分片可短缓存
    res.set('Cache-Control', file.endsWith('.m3u8') ? 'no-cache, no-store' : 'max-age=10');
    res.status(r.status).end(buf);
  } catch (err) {
    console.error('代理 HLS 失败:', err.message);
    res.status(502).end();
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// code -> { code, members: Map<id, {id, name, ws}>, presenterId, presenterMode }
// presenterMode: 'p2p'（浏览器共享）| 'obs'（OBS 推流）| null
const rooms = new Map();

// 去掉易混淆字符（0/O、1/I）的房间码字母表
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function genRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

function cleanName(name) {
  return String(name || '').trim().slice(0, 16) || '访客';
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  for (const m of room.members.values()) {
    if (m.id !== exceptId) send(m.ws, msg);
  }
}

function memberList(room) {
  return [...room.members.values()].map((m) => ({ id: m.id, name: m.name }));
}

// 以新成员身份把连接加入房间；token 用于断线后恢复身份
function addMember(ws, room, name) {
  const member = { id: genId(), name, ws, token: genId() + genId() };
  room.members.set(member.id, member);
  return member;
}

function sendJoined(ws, room, member) {
  send(ws, {
    type: 'joined',
    roomCode: room.code,
    selfId: member.id,
    token: member.token,
    members: memberList(room),
    presenterId: room.presenterId,
    presenterMode: room.presenterMode || null,
    obsAvailable: OBS_ENABLED,
    hlsDirect: HLS_DIRECT_URL,
  });
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // 本连接对应的成员信息，加入房间后填充
  let self = null;

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }

    switch (msg.type) {
      case 'create-room': {
        if (self) return;
        const room = { code: genRoomCode(), members: new Map(), presenterId: null, presenterMode: null };
        rooms.set(room.code, room);
        const member = addMember(ws, room, cleanName(msg.name));
        self = { id: member.id, name: member.name, room };
        sendJoined(ws, room, member);
        break;
      }

      case 'join-room': {
        if (self) return;
        const code = String(msg.roomCode || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) return send(ws, { type: 'error', code: 'room-not-found' });
        if (room.members.size >= MAX_MEMBERS) return send(ws, { type: 'error', code: 'room-full' });
        const member = addMember(ws, room, cleanName(msg.name));
        self = { id: member.id, name: member.name, room };
        sendJoined(ws, room, member);
        broadcast(room, { type: 'peer-joined', member: { id: self.id, name: self.name } }, self.id);
        break;
      }

      case 'resume': {
        // 断线重连：凭 token 接管原身份，媒体连接与共享状态不受影响
        if (self) return;
        const code = String(msg.roomCode || '').trim().toUpperCase();
        const room = rooms.get(code);
        if (!room) return send(ws, { type: 'error', code: 'room-not-found' });
        const m = room.members.get(msg.memberId);
        if (m && msg.token && m.token === msg.token) {
          if (m.ws !== ws) {
            try { m.ws.terminate(); } catch { /* 旧连接可能已死 */ }
          }
          m.ws = ws;
          self = { id: m.id, name: m.name, room };
          sendJoined(ws, room, m);
          return;
        }
        // 原身份已被清理：按普通加入处理
        if (room.members.size >= MAX_MEMBERS) return send(ws, { type: 'error', code: 'room-full' });
        const member = addMember(ws, room, cleanName(msg.name));
        self = { id: member.id, name: member.name, room };
        sendJoined(ws, room, member);
        broadcast(room, { type: 'peer-joined', member: { id: self.id, name: self.name } }, self.id);
        break;
      }

      case 'ping': {
        // 应用层心跳：保持客户端→服务器方向有数据，防代理按"入向空闲"掐连接
        send(ws, { type: 'pong' });
        break;
      }

      case 'request-share': {
        if (!self) return;
        const room = self.room;
        const mode = msg.mode === 'obs' ? 'obs' : 'p2p';
        if (room.presenterId && room.presenterId !== self.id) {
          return send(ws, { type: 'share-denied' });
        }
        if (mode === 'obs') {
          if (!OBS_ENABLED) return send(ws, { type: 'share-denied', reason: 'obs-unavailable' });
          // MediaMTX 上只有一条固定推流路径，同一时间只能有一个房间用 OBS 直播
          for (const r of rooms.values()) {
            if (r !== room && r.presenterMode === 'obs') {
              return send(ws, { type: 'share-denied', reason: 'obs-busy' });
            }
          }
        }
        room.presenterId = self.id;
        room.presenterMode = mode;
        send(ws, {
          type: 'share-granted',
          mode,
          ...(mode === 'obs' ? { rtmpUrl: RTMP_URL } : {}),
        });
        broadcast(room, { type: 'presenter-changed', presenterId: self.id, mode });
        break;
      }

      case 'stop-share': {
        if (!self) return;
        const room = self.room;
        if (room.presenterId !== self.id) return;
        room.presenterId = null;
        room.presenterMode = null;
        broadcast(room, { type: 'presenter-changed', presenterId: null });
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice-candidate': {
        if (!self) return;
        const target = self.room.members.get(msg.to);
        if (!target) return;
        send(target.ws, { ...msg, to: undefined, from: self.id });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!self) return;
    const room = self.room;
    const cur = room.members.get(self.id);
    // 身份已被新连接接管（resume）：旧连接关闭不得移除成员
    if (!cur || cur.ws !== ws) return;
    room.members.delete(self.id);
    if (room.presenterId === self.id) {
      room.presenterId = null;
      room.presenterMode = null;
      broadcast(room, { type: 'presenter-changed', presenterId: null });
    }
    broadcast(room, { type: 'peer-left', id: self.id });
    if (room.members.size === 0) rooms.delete(room.code);
    self = null;
  });
});

// 心跳：清理断掉但未触发 close 的连接
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log(`聚幕直播间已启动: http://localhost:${PORT}`);
});
