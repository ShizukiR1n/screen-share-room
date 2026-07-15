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

// OBS 推流模式：OBS 用 WHIP 把编码好的画面推到自建 MediaMTX（与 coturn 同一台服务器），
// 观看端用 WHEP 从 MediaMTX 拉流。本服务只代理信令（SDP 交换，每次几 KB），
// 媒体流量直接走 浏览器/OBS ↔ MediaMTX 的 UDP，不经过这里。
// 走代理的原因：页面是 HTTPS，浏览器直连 MediaMTX 的 HTTP 接口会被拦（混合内容）；
// 代理还能统一注入鉴权、对外隐藏媒体服务器地址。
const MTX_PUBLISH_PASS = process.env.MTX_PUBLISH_PASS; // OBS 推流密码（兼作推流地址里的令牌）
const MTX_READ_PASS = process.env.MTX_READ_PASS;       // 观看端拉流密码（仅代理内部使用）
const MTX_HTTP_PORT = process.env.MTX_HTTP_PORT || 8889;
const MTX_PATH = process.env.MTX_PATH || 'beam';
// MediaMTX 媒体端口 443/udp 的备用入口：个别网络出不去 443/udp（实测遇到过），
// 服务器 iptables 把 8189/udp 转发到 443，代理往 SDP answer 里补一份 8189 候选兜底
const MTX_UDP_FALLBACK_PORT = 8189;
const OBS_ENABLED = !!(TURN_HOST && MTX_PUBLISH_PASS && MTX_READ_PASS);

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

/* ================= OBS 推流（WHIP/WHEP 信令代理） ================= */

// WHIP/WHEP 的信令就是普通 HTTP：POST 一份 SDP offer，返回 SDP answer 和会话地址
const sdpBody = express.text({
  type: ['application/sdp', 'application/trickle-ice-sdpfrag'],
  limit: '1mb',
});

function mtxAuth(kind) {
  const user = kind === 'whip' ? 'publisher' : 'viewer';
  const pass = kind === 'whip' ? MTX_PUBLISH_PASS : MTX_READ_PASS;
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

function mtxUrl(tail) {
  return `http://${TURN_HOST}:${MTX_HTTP_PORT}/${MTX_PATH}/${tail}`;
}

// 给 SDP answer 里服务器的 443 候选补一份低优先级的备用端口副本：
// 个别网络出不去 443/udp，ICE 会自动改走备用端口（与中继双端口是同一个教训）
function addFallbackCandidates(sdp) {
  return sdp.split('\r\n').flatMap((line) => {
    const m = line.match(/^a=candidate:(\S+) (\d+) (udp|UDP) (\d+) (\S+) 443 (typ host.*)$/i);
    if (!m) return [line];
    const prio = Math.max(1, Number(m[4]) - 1);
    return [line, `a=candidate:${m[1]}9 ${m[2]} ${m[3]} ${prio} ${m[5]} ${MTX_UDP_FALLBACK_PORT} ${m[6]}`];
  }).join('\r\n');
}

// 建立会话：转发 SDP offer，把 MediaMTX 返回的会话地址改写成本站路径
async function proxyMtxPost(req, res, kind) {
  if (!OBS_ENABLED) return res.status(503).end('OBS mode not configured');
  try {
    const r = await fetch(mtxUrl(kind), {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp', Authorization: mtxAuth(kind) },
      body: req.body,
    });
    const text = await r.text();
    if (r.status !== 201) return res.status(r.status).end(text);
    const sid = String(r.headers.get('location') || '').split('/').filter(Boolean).pop();
    res.status(201)
      .set('Content-Type', 'application/sdp')
      .set('Location', `/${kind}-session/${sid}`)
      .end(addFallbackCandidates(text));
  } catch (err) {
    console.error(`代理 ${kind} 失败:`, err.message);
    res.status(502).end('media server unreachable');
  }
}

// 会话内操作：PATCH（补发 ICE 候选）与 DELETE（结束会话）原样转发
async function proxyMtxSession(req, res, kind) {
  if (!OBS_ENABLED) return res.status(503).end();
  try {
    const r = await fetch(mtxUrl(`${kind}/${encodeURIComponent(req.params.sid)}`), {
      method: req.method,
      headers: {
        Authorization: mtxAuth(kind),
        ...(req.method === 'PATCH' ? { 'Content-Type': 'application/trickle-ice-sdpfrag' } : {}),
      },
      body: req.method === 'PATCH' ? req.body : undefined,
    });
    res.status(r.status).end(await r.text());
  } catch {
    res.status(502).end();
  }
}

// OBS 推流入口：地址里带令牌，防陌生人往房间里推画面
app.post('/whip/:token', sdpBody, (req, res) => {
  if (!OBS_ENABLED || req.params.token !== MTX_PUBLISH_PASS) return res.status(401).end();
  proxyMtxPost(req, res, 'whip');
});
app.patch('/whip-session/:sid', sdpBody, (req, res) => proxyMtxSession(req, res, 'whip'));
app.delete('/whip-session/:sid', (req, res) => proxyMtxSession(req, res, 'whip'));

// 观看端拉流入口：需报上自己所在的房间，且该房间正处于 OBS 直播中
app.post('/whep', sdpBody, (req, res) => {
  const room = rooms.get(String(req.get('X-Room') || '').trim().toUpperCase());
  if (!room || room.presenterMode !== 'obs') return res.status(404).end();
  proxyMtxPost(req, res, 'whep');
});
app.patch('/whep-session/:sid', sdpBody, (req, res) => proxyMtxSession(req, res, 'whep'));
app.delete('/whep-session/:sid', (req, res) => proxyMtxSession(req, res, 'whep'));

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
          ...(mode === 'obs' ? { whipPath: `/whip/${MTX_PUBLISH_PASS}` } : {}),
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
