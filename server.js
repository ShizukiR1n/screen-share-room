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
const TURN_PORT = process.env.TURN_PORT || 3478;
const TURN_URLS = process.env.TURN_URLS;
const TURN_USERNAME = process.env.TURN_USERNAME;
const TURN_CREDENTIAL = process.env.TURN_CREDENTIAL;
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID;
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN;
let iceCache = { until: 0, servers: [] };

app.get('/api/ice', async (req, res) => {
  if (TURN_HOST && TURN_SECRET) {
    // coturn use-auth-secret：用户名为过期时间戳，凭据为 HMAC-SHA1 签名
    const username = String(Math.floor(Date.now() / 1000) + 12 * 3600);
    const credential = crypto.createHmac('sha1', TURN_SECRET).update(username).digest('base64');
    return res.json({
      iceServers: [{
        urls: [
          `turn:${TURN_HOST}:${TURN_PORT}?transport=udp`,
          `turn:${TURN_HOST}:${TURN_PORT}?transport=tcp`,
        ],
        username,
        credential,
      }],
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// code -> { code, members: Map<id, {id, name, ws}>, presenterId }
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
        const room = { code: genRoomCode(), members: new Map(), presenterId: null };
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

      case 'request-share': {
        if (!self) return;
        const room = self.room;
        if (room.presenterId && room.presenterId !== self.id) {
          return send(ws, { type: 'share-denied' });
        }
        room.presenterId = self.id;
        send(ws, { type: 'share-granted' });
        broadcast(room, { type: 'presenter-changed', presenterId: self.id });
        break;
      }

      case 'stop-share': {
        if (!self) return;
        const room = self.room;
        if (room.presenterId !== self.id) return;
        room.presenterId = null;
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
