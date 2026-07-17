'use strict';

/* ================= 配置 ================= */

// STUN：全部经过国内直连实测可用（2026-07）
const STUN_SERVERS = [
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.chat.bilibili.com:3478' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
];

// TURN 中继：从服务器获取凭据（自建阿里云中继优先）。
// 拿到中继后强制所有媒体流量走中继——国内服务器线路稳定，
// 避免 WebRTC 默认"优先直连"选中质量差的直连路径导致卡顿/受限
let iceServers = [...STUN_SERVERS];
let hasRelay = false;

async function loadIceServers() {
  try {
    const r = await fetch('/api/ice');
    const data = await r.json();
    if (Array.isArray(data.iceServers) && data.iceServers.length) {
      iceServers = [...STUN_SERVERS, ...data.iceServers];
      hasRelay = data.iceServers.some((s) => JSON.stringify(s.urls || '').includes('turn'));
    }
  } catch { /* 拿不到就用纯 STUN */ }
}

// 设备能力：手机/平板浏览器不支持屏幕采集，只能观看
const CAN_SHARE = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
// iPadOS 13+ 会伪装成 Mac，用触点数辨别
const IS_IOS = /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const AVATAR_COLORS = [
  'linear-gradient(135deg, #6d6bfb, #8f5cf7)',
  'linear-gradient(135deg, #f2994a, #f2555a)',
  'linear-gradient(135deg, #2fbf8f, #1d9bf0)',
];

/* ================= 状态 ================= */

const state = {
  ws: null,
  selfId: null,
  token: null,          // 断线恢复身份用的会话令牌
  name: '',
  roomCode: null,
  members: new Map(),        // id -> { id, name }
  presenterId: null,
  presenterMode: null,       // 'p2p'（浏览器共享）| 'obs'（OBS 推流）| null
  obsAvailable: false,       // 服务器是否配置了 OBS 推流
  rtmpUrl: null,             // OBS RTMP 推流地址（仅当自己是 OBS 演示者时下发）
  hlsDirect: null,           // 直连媒体服务器的播放地址（快，跨境代理只有 ~2Mbps）
  peers: new Map(),          // peerId -> { pc, pending: [candidate] }
  localStream: null,
  remoteStream: null,
  intentionalLeave: false,
  reconnectAttempts: 0,
};

/* ================= DOM ================= */

const $ = (id) => document.getElementById(id);

const el = {
  viewHome: $('view-home'),
  viewRoom: $('view-room'),
  nameInput: $('name-input'),
  codeInput: $('code-input'),
  createBtn: $('create-btn'),
  joinBtn: $('join-btn'),
  roomCodeLabel: $('room-code-label'),
  copyLinkBtn: $('copy-link-btn'),
  memberCount: $('member-count'),
  leaveBtn: $('leave-btn'),
  stage: $('stage'),
  stageVideo: $('stage-video'),
  stageEmpty: $('stage-empty'),
  emptyTitle: $('empty-title'),
  emptyHint: $('empty-hint'),
  stageBar: $('stage-bar'),
  presenterLabel: $('presenter-label'),
  statsLine: $('stats-line'),
  remoteControls: $('remote-controls'),
  clickToPlay: $('click-to-play'),
  playBtn: $('play-btn'),
  muteBtn: $('mute-btn'),
  iconSoundOn: $('icon-sound-on'),
  iconSoundOff: $('icon-sound-off'),
  volumeSlider: $('volume-slider'),
  fullscreenBtn: $('fullscreen-btn'),
  members: $('members'),
  qualityPicker: $('quality-picker'),
  shareBtn: $('share-btn'),
  shareBtnText: $('share-btn-text'),
  obsBtn: $('obs-btn'),
  obsPanel: $('obs-panel'),
  obsDot: $('obs-dot'),
  obsStatus: $('obs-status'),
  obsUrl: $('obs-url'),
  obsCopyBtn: $('obs-copy-btn'),
  toasts: $('toasts'),
};

/* ================= 工具 ================= */

function toast(text, kind = 'info', ms = 3200) {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  el.toasts.appendChild(t);
  setTimeout(() => {
    t.classList.add('leaving');
    setTimeout(() => t.remove(), 320);
  }, ms);
}

function showView(view) {
  el.viewHome.classList.toggle('hidden', view !== 'home');
  el.viewRoom.classList.toggle('hidden', view !== 'room');
}

function avatarColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function memberName(id) {
  const m = state.members.get(id);
  return m ? m.name : '对方';
}

/* ================= WebSocket 信令 ================= */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  return proto + location.host;
}

let clientPingTimer = null;

function connect(onOpen) {
  const ws = new WebSocket(wsUrl());
  state.ws = ws;

  ws.onopen = () => {
    // 应用层心跳：托管平台的代理可能按"客户端方向长时间无数据"掐断长连接
    clearInterval(clientPingTimer);
    clientPingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
    if (onOpen) onOpen();
  };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handleSignal(msg);
  };

  ws.onclose = () => {
    if (state.ws !== ws) return; // 已被新连接替换
    clearInterval(clientPingTimer);
    handleDisconnect();
  };

  ws.onerror = () => ws.close();
}

function sendMsg(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function handleDisconnect() {
  const wasInRoom = !!state.roomCode && !state.intentionalLeave;

  if (!wasInRoom) {
    stopLocalShare(false);
    closeAllPeers();
    stopHls();
    hideObsPanel();
    clearRemoteStage();
    state.roomCode = null;
    showView('home');
    setBusy(false);
    return;
  }

  if (state.reconnectAttempts >= 8) {
    stopLocalShare(false);
    closeAllPeers();
    stopHls();
    hideObsPanel();
    clearRemoteStage();
    toast('连接已断开，请刷新页面重试', 'error', 6000);
    state.roomCode = null;
    showView('home');
    setBusy(false);
    return;
  }

  // 断的只是信令；画面走的是独立的媒体连接，保持不动。
  // 重连后凭 token 恢复原身份（resume），不会在房间里产生"分身"
  const delay = Math.min(1000 * 2 ** state.reconnectAttempts, 8000);
  state.reconnectAttempts++;
  toast('连接断开，正在重连…', 'warn');
  setTimeout(() => {
    connect(() => sendMsg({
      type: 'resume',
      roomCode: state.roomCode,
      memberId: state.selfId,
      token: state.token,
      name: state.name,
    }));
  }, delay);
}

function handleSignal(msg) {
  switch (msg.type) {
    case 'joined': {
      state.reconnectAttempts = 0;
      // 断线重连且身份恢复成功：媒体连接原封不动，只同步房间状态
      const sameIdentity = msg.selfId === state.selfId && msg.roomCode === state.roomCode;
      state.roomCode = msg.roomCode;
      state.selfId = msg.selfId;
      state.token = msg.token;
      state.presenterId = msg.presenterId;
      state.presenterMode = msg.presenterMode || (msg.presenterId ? 'p2p' : null);
      state.obsAvailable = !!msg.obsAvailable;
      state.hlsDirect = msg.hlsDirect || null;
      state.members = new Map(msg.members.map((m) => [m.id, m]));
      // 清理离线期间已离开成员的旧媒体连接
      for (const id of [...state.peers.keys()]) {
        if (!state.members.has(id)) closePeer(id);
      }
      history.replaceState(null, '', `?room=${msg.roomCode}`);
      showView('room');
      setBusy(false);
      renderRoom();
      if (sameIdentity) {
        toast('连接已恢复', 'success');
        // 离线期间进来的新观众：补推流
        if (state.presenterId === state.selfId && state.localStream) {
          for (const id of state.members.keys()) {
            if (id !== state.selfId && !state.peers.has(id)) offerTo(id);
          }
        }
      } else {
        toast(`已进入房间 ${msg.roomCode}`, 'success');
        // 全新身份：旧媒体连接作废
        closeAllPeers();
        if (state.localStream) {
          // 屏幕仍在采集（重连时未中断）：重新申请共享权，复用现有画面
          sendMsg({ type: 'request-share' });
        } else if (state.presenterId && state.presenterId !== state.selfId) {
          setStageConnecting();
        }
      }
      // OBS 直播状态同步（新进房 / 断线恢复通用；startHls 已在拉流时不会重复起）
      if (state.presenterMode === 'obs') {
        if (state.presenterId === state.selfId) {
          if (!hls.live) showObsPanel();
        } else if (!hls.live) {
          setStageConnecting();
        }
        startHls();
      } else {
        stopHls();
        hideObsPanel();
      }
      break;
    }

    case 'error': {
      setBusy(false);
      if (msg.code === 'room-not-found' || msg.code === 'room-full') {
        toast(msg.code === 'room-not-found' ? '房间不存在或已关闭' : '房间已满（最多 3 人）', 'error');
        stopLocalShare(false);
        closeAllPeers();
        clearRemoteStage();
        state.roomCode = null;
        showView('home');
      }
      break;
    }

    case 'peer-joined': {
      state.members.set(msg.member.id, msg.member);
      renderRoom();
      toast(`${msg.member.name} 加入了房间`, 'info');
      // 我正在共享 → 主动向新人推流
      if (state.presenterId === state.selfId && state.localStream) {
        offerTo(msg.member.id);
      }
      break;
    }

    case 'peer-left': {
      const name = memberName(msg.id);
      state.members.delete(msg.id);
      closePeer(msg.id);
      renderRoom();
      toast(`${name} 离开了房间`, 'info');
      break;
    }

    case 'presenter-changed': {
      state.presenterId = msg.presenterId;
      state.presenterMode = msg.presenterId ? (msg.mode || 'p2p') : null;
      if (msg.presenterId === null) {
        stopHls();
        hideObsPanel();
        if (state.localStream) {
          // 我还在采集屏幕但锁被释放了（重连后旧身份被清理）：自动拿回共享权
          sendMsg({ type: 'request-share' });
        } else {
          // 共享结束：观看端清理连接与画面
          closeAllPeers();
          clearRemoteStage();
        }
      } else if (msg.presenterId !== state.selfId) {
        closeAllPeers();
        if (state.presenterMode === 'obs') {
          // 别人开始 OBS 直播：从服务器拉流
          toast(`${memberName(msg.presenterId)} 开始了 OBS 直播`, 'info');
          setStageConnecting();
          startHls();
        } else {
          // 别人开始浏览器共享，等待对方的 offer
          stopHls();
          toast(`${memberName(msg.presenterId)} 开始共享屏幕`, 'info');
          setStageConnecting();
        }
      }
      renderRoom();
      break;
    }

    case 'share-granted': {
      if (msg.mode === 'obs') {
        state.presenterId = state.selfId;
        state.presenterMode = 'obs';
        state.rtmpUrl = msg.rtmpUrl;
        showObsPanel();
        startHls(); // 自己也从服务器拉一路做预览（静音）
        renderRoom();
        break;
      }
      if (state.localStream) {
        // 重连后复用仍在采集的画面，直接向所有人重新推流
        state.presenterId = state.selfId;
        el.stageVideo.srcObject = state.localStream;
        el.stageVideo.muted = true;
        el.stageVideo.play().catch(() => {});
        setStageMode('local');
        renderRoom();
        for (const id of state.members.keys()) {
          if (id !== state.selfId) offerTo(id);
        }
      } else {
        startCapture();
      }
      break;
    }

    case 'share-denied': {
      if (msg.reason === 'obs-busy') toast('另一个房间正在使用 OBS 直播，请稍后再试', 'warn');
      else if (msg.reason === 'obs-unavailable') toast('服务器未配置 OBS 推流', 'warn');
      else toast('已有人在共享屏幕', 'warn');
      break;
    }

    case 'offer': handleOffer(msg); break;
    case 'answer': handleAnswer(msg); break;
    case 'ice-candidate': handleCandidate(msg); break;
  }
}

/* ================= WebRTC ================= */

// 各对端的连续连接失败次数：中继模式连不上 2 次后回退自动选路（保底）
const relayFails = new Map();

function createPeer(peerId) {
  closePeer(peerId);
  const forceRelay = hasRelay && (relayFails.get(peerId) || 0) < 2;
  const pc = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: forceRelay ? 'relay' : 'all',
  });
  const peer = { pc, pending: [] };
  state.peers.set(peerId, peer);

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      sendMsg({ type: 'ice-candidate', to: peerId, candidate: ev.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    const iAmPresenter = state.presenterId === state.selfId;
    if (s === 'connected') {
      relayFails.delete(peerId);
      toast(iAmPresenter
        ? `${memberName(peerId)} 已连接，画面传输中`
        : '画面传输已连接', 'success');
      if (iAmPresenter) applySenderTuning(pc);
      startStats();
    } else if (s === 'failed') {
      relayFails.set(peerId, (relayFails.get(peerId) || 0) + 1);
      if (iAmPresenter && state.localStream && state.members.has(peerId)) {
        // 演示端对单个观看者连接失败 → 重新发起
        toast(`与 ${memberName(peerId)} 的连接中断，正在重试…`, 'warn');
        offerTo(peerId);
      } else if (!iAmPresenter) {
        toast('与演示者的连接失败，正在等待重连…', 'error', 5000);
        setStageConnecting();
      }
    }
  };

  return peer;
}

// 演示端：向某个观看者建连并推流
async function offerTo(peerId) {
  const peer = createPeer(peerId);
  const pc = peer.pc;
  for (const track of state.localStream.getTracks()) {
    pc.addTrack(track, state.localStream);
  }
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendMsg({ type: 'offer', to: peerId, sdp: pc.localDescription });
  } catch (err) {
    console.error('创建 offer 失败', err);
  }
}

// 观看端：收到演示者的 offer
async function handleOffer(msg) {
  const peer = createPeer(msg.from);
  const pc = peer.pc;

  pc.ontrack = (ev) => {
    if (ev.streams && ev.streams[0]) {
      attachRemoteStream(ev.streams[0]);
    }
  };

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    await flushCandidates(peer);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendMsg({ type: 'answer', to: msg.from, sdp: pc.localDescription });
  } catch (err) {
    console.error('处理 offer 失败', err);
  }
}

async function handleAnswer(msg) {
  const peer = state.peers.get(msg.from);
  if (!peer) return;
  try {
    await peer.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    await flushCandidates(peer);
  } catch (err) {
    console.error('处理 answer 失败', err);
  }
}

async function handleCandidate(msg) {
  const peer = state.peers.get(msg.from);
  if (!peer) return;
  if (peer.pc.remoteDescription) {
    try { await peer.pc.addIceCandidate(msg.candidate); } catch (err) { console.warn(err); }
  } else {
    peer.pending.push(msg.candidate);
  }
}

async function flushCandidates(peer) {
  for (const c of peer.pending.splice(0)) {
    try { await peer.pc.addIceCandidate(c); } catch (err) { console.warn(err); }
  }
}

// 画质档位：走境外中继时国际链路带宽有限，卡顿时切"流畅"压码率保帧率
const QUALITY_PRESETS = {
  smooth: { label: '流畅', maxBitrate: 1_500_000 },
  balanced: { label: '平衡', maxBitrate: 3_000_000 },
  hd: { label: '高清', maxBitrate: 6_000_000 },
};
let qualityKey = localStorage.getItem('screenroom-quality') || 'balanced';
if (!QUALITY_PRESETS[qualityKey]) qualityKey = 'balanced';

function setQuality(key, notify = true) {
  if (!QUALITY_PRESETS[key]) return;
  qualityKey = key;
  localStorage.setItem('screenroom-quality', key);
  for (const peer of state.peers.values()) applySenderTuning(peer.pc);
  updateQualityUI();
  if (notify) toast(`画质已切换为「${QUALITY_PRESETS[key].label}」`, 'info');
}

function updateQualityUI() {
  const sharing = state.presenterId === state.selfId && !!state.localStream;
  el.qualityPicker.classList.toggle('hidden', !sharing);
  for (const btn of el.qualityPicker.querySelectorAll('button')) {
    btn.classList.toggle('active', btn.dataset.q === qualityKey);
  }
}

// 发送端调优：保帧率降级 + 按当前档位限码率
function applySenderTuning(pc) {
  for (const sender of pc.getSenders()) {
    if (!sender.track || sender.track.kind !== 'video') continue;
    try {
      const p = sender.getParameters();
      p.degradationPreference = 'maintain-framerate';
      if (p.encodings && p.encodings.length) {
        p.encodings[0].maxBitrate = QUALITY_PRESETS[qualityKey].maxBitrate;
      }
      sender.setParameters(p).catch(() => {});
    } catch { /* 不支持就算了 */ }
  }
}

/* ---------- 连接诊断（悬停画面可见） ---------- */

let statsTimer = null;
const statsPrev = new Map(); // peerId -> { bytes, ts, lost, recv }

function startStats() {
  if (statsTimer) return;
  statsTimer = setInterval(updateStats, 2000);
}

function stopStats() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  statsPrev.clear();
  el.statsLine.textContent = '';
}

async function updateStats() {
  // OBS/HLS 模式没有 WebRTC 统计，诊断行由 HLS 逻辑单独维护，这里只管 P2P
  if (state.presenterMode === 'obs') return;
  const iAmPresenter = state.presenterId === state.selfId && !!state.localStream;
  const entries = [...state.peers.entries()].filter(([, p]) => p.pc.connectionState === 'connected');
  if (!entries.length) { el.statsLine.textContent = ''; return; }
  try {
    if (iAmPresenter) {
      const parts = [];
      for (const [id, peer] of entries) {
        const s = await collectStats(peer.pc, id, 'outbound');
        if (s) parts.push(`${memberName(id)}:${s.pathLabel} ${s.mbps}Mbps${s.limited ? '·受限(' + s.limited + ')' : ''}`);
      }
      el.statsLine.textContent = parts.join(' ｜ ');
    } else {
      const [id, peer] = entries[0];
      const s = await collectStats(peer.pc, id, 'inbound');
      if (s) {
        el.statsLine.textContent =
          `${s.pathLabel} · 延迟${s.rtt}ms · ${s.mbps}Mbps · ${s.fps != null ? s.fps + 'fps' : ''} · 丢包${s.loss}%`;
      }
    }
  } catch { /* 统计失败不影响使用 */ }
}

async function collectStats(pc, key, dir) {
  const stats = await pc.getStats();
  const local = {}, remote = {}, pairs = {};
  let selectedPairId = null, rtp = null;
  stats.forEach((r) => {
    if (r.type === 'local-candidate') local[r.id] = r;
    else if (r.type === 'remote-candidate') remote[r.id] = r;
    else if (r.type === 'candidate-pair') pairs[r.id] = r;
    else if (r.type === 'transport' && r.selectedCandidatePairId) selectedPairId = r.selectedCandidatePairId;
    else if (dir === 'inbound' && r.type === 'inbound-rtp' && r.kind === 'video') rtp = r;
    else if (dir === 'outbound' && r.type === 'outbound-rtp' && r.kind === 'video') rtp = r;
  });
  if (!rtp) return null;
  const pair = (selectedPairId && pairs[selectedPairId]) ||
    Object.values(pairs).find((p) => p.nominated && p.state === 'succeeded');
  const lc = pair && local[pair.localCandidateId];
  const rc = pair && remote[pair.remoteCandidateId];
  const isRelay = (lc && lc.candidateType === 'relay') || (rc && rc.candidateType === 'relay');
  const rtt = pair && pair.currentRoundTripTime != null ? Math.round(pair.currentRoundTripTime * 1000) : '?';

  const bytes = dir === 'inbound' ? (rtp.bytesReceived || 0) : (rtp.bytesSent || 0);
  const now = performance.now();
  const prev = statsPrev.get(key) || { bytes, ts: now - 2000, lost: 0, recv: 0 };
  const mbps = ((bytes - prev.bytes) * 8 / Math.max(1, now - prev.ts) / 1000).toFixed(1);
  let loss = 0;
  if (dir === 'inbound') {
    const dLost = (rtp.packetsLost || 0) - prev.lost;
    const dRecv = (rtp.packetsReceived || 0) - prev.recv;
    loss = dLost + dRecv > 0 ? Math.round((dLost / (dLost + dRecv)) * 100) : 0;
  }
  statsPrev.set(key, { bytes, ts: now, lost: rtp.packetsLost || 0, recv: rtp.packetsReceived || 0 });

  const limited = dir === 'outbound' && rtp.qualityLimitationReason && rtp.qualityLimitationReason !== 'none'
    ? (rtp.qualityLimitationReason === 'cpu' ? 'CPU' : '带宽') : '';
  return { pathLabel: isRelay ? '中继' : '直连', rtt, mbps, fps: rtp.framesPerSecond, loss, limited };
}

function closePeer(peerId) {
  const peer = state.peers.get(peerId);
  if (!peer) return;
  peer.pc.onicecandidate = null;
  peer.pc.ontrack = null;
  peer.pc.onconnectionstatechange = null;
  peer.pc.close();
  state.peers.delete(peerId);
}

function closeAllPeers() {
  for (const id of [...state.peers.keys()]) closePeer(id);
}

/* ================= OBS 直播（HLS 从服务器拉流，全 TCP） ================= */
// OBS 用 RTMP 把画面推到自建媒体服务器，房间里每个人（含演示者自己的预览）
// 都通过 HLS(HTTP/TCP) 从服务器拉流，经本站代理。全程 TCP，绕开运营商对 UDP 的限速。
// 代价是有 1~3 秒延迟。OBS 未开播时 m3u8 会 404，静默重试直到出流。

const hls = { inst: null, active: false, timer: null, live: false, srcIdx: 0, fails: 0 };

// 播放地址按优先级排列：直连媒体服务器（国内链路，几十 Mbps）优先，
// 经 Render 的 /hls 代理垫底（跨境只有 ~2Mbps，只能兜低码率的底）。
// 连续失败 2 次就换下一个地址轮询，出画后归零。
function hlsSrcs() {
  const list = [];
  if (state.hlsDirect) list.push(state.hlsDirect);
  list.push(`/hls/${encodeURIComponent(state.roomCode || '')}/index.m3u8`);
  return list;
}

function hlsFail() {
  hls.fails += 1;
  if (hls.fails >= 2) {
    hls.fails = 0;
    hls.srcIdx += 1;
  }
}

function startHls() {
  if (hls.active) return;
  hls.active = true;
  hls.live = false;
  hls.srcIdx = 0;
  hls.fails = 0;
  hlsAttempt();
}

function stopHls() {
  hls.active = false;
  hls.live = false;
  clearTimeout(hls.timer);
  hls.timer = null;
  if (hls.inst) { try { hls.inst.destroy(); } catch { /* ignore */ } hls.inst = null; }
  if (el.stageVideo.src) { el.stageVideo.removeAttribute('src'); el.stageVideo.load(); }
  stopStats();
}

function scheduleHlsRetry(ms) {
  if (!hls.active) return;
  clearTimeout(hls.timer);
  hls.timer = setTimeout(hlsAttempt, ms);
}

function hlsAttempt() {
  if (!hls.active) return;
  const iAmPresenter = state.presenterId === state.selfId;
  const video = el.stageVideo;
  const srcs = hlsSrcs();
  const src = srcs[hls.srcIdx % srcs.length];
  video.srcObject = null; // HLS 走 <video>.src / MSE，不是 srcObject
  // 演示者看自己的画面：静音（避免和本机声音叠成回声）；观看者正常出声
  video.muted = iAmPresenter;

  if (hls.inst) { try { hls.inst.destroy(); } catch { /* ignore */ } hls.inst = null; }

  const onLive = () => {
    if (!hls.active || hls.live) return;
    hls.live = true;
    hls.fails = 0;
    onHlsPlaying(iAmPresenter, src);
  };

  if (window.Hls && window.Hls.isSupported()) {
    // 用标准 HLS（非低延迟模式）：更稳，不依赖阻塞式分片预取（那条路会卡住）。
    // 关键是防延迟累积：离直播边缘超过目标就 1.5 倍速追赶，落后太多直接跳到边缘，
    // 否则一次网络抖动攒下的延迟会永远还不掉（实测能攒到 20 秒）。
    const inst = new window.Hls({
      lowLatencyMode: false,
      liveSyncDurationCount: 2,       // 距边缘 2 个切片起播（切片 1~2 秒）
      liveMaxLatencyDurationCount: 6, // 落后超 6 个切片：跳回同步点
      maxLiveSyncPlaybackRate: 1.5,   // 落后时悄悄加速播放追上去
      backBufferLength: 10,
      manifestLoadingMaxRetry: 4,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 6,
    });
    hls.inst = inst;
    inst.loadSource(src);
    inst.attachMedia(video);
    inst.on(window.Hls.Events.FRAG_BUFFERED, onLive);
    inst.on(window.Hls.Events.ERROR, (_e, data) => {
      if (!hls.active || inst !== hls.inst || !data.fatal) return;
      // 流暂时不可用（OBS 还没开播/断流）→ 整段重来；媒体错误先尝试就地恢复
      const gone = /manifestLoad|levelEmpty|levelLoad/.test(data.details || '');
      if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !gone) {
        try { inst.recoverMediaError(); return; } catch { /* 落到下面重建 */ }
      }
      hls.live = false;
      hlsFail();
      try { inst.destroy(); } catch { /* ignore */ }
      if (inst === hls.inst) hls.inst = null;
      onHlsDown();
      scheduleHlsRetry(2000);
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    // iOS/Safari 原生 HLS。必须主动 play()：原生路径没有 MSE 事件，
    // 不播就永远等不到 playing；有声自动播被拦时降级为静音 + 点击开声
    video.src = src;
    video.addEventListener('playing', onLive, { once: true });
    video.addEventListener('error', () => {
      if (!hls.active) return;
      hlsFail();
      onHlsDown();
      scheduleHlsRetry(2000);
    }, { once: true });
    video.play().catch(() => {
      if (!hls.active || iAmPresenter) return;
      video.muted = true;
      video.play().catch(() => {});
      el.clickToPlay.classList.remove('hidden');
    });
  } else {
    toast('当前浏览器不支持观看 OBS 直播，请用 Chrome / Edge', 'error', 6000);
  }
}

// 首帧到达：真正把画面显示出来
function onHlsPlaying(iAmPresenter, src) {
  const direct = !!src && src === state.hlsDirect;
  const video = el.stageVideo;
  setObsLive(true);
  state.remoteStream = null; // HLS 不用 MediaStream，占位标记有画面
  if (iAmPresenter) {
    hideObsPanel();
    setStageMode('local');
    el.presenterLabel.textContent = '你正在通过 OBS 直播 · 其他人可以看到并听到';
    video.play().catch(() => {});
    showControls();
  } else {
    setStageMode('remote');
    showControls();
    video.play().then(() => {
      el.clickToPlay.classList.add('hidden');
    }).catch(() => {
      // 浏览器拦截有声自动播放 → 先静音播出，用户点一下开声音
      video.muted = true;
      video.play().catch(() => {});
      el.clickToPlay.classList.remove('hidden');
    });
  }
  el.statsLine.textContent = direct
    ? 'OBS 直播 · 直连（约 2~4 秒延迟）'
    : 'OBS 直播 · 中转（带宽有限，卡顿请降低 OBS 码率）';
}

// 拉流断开/未开播：清画面回到等待
function onHlsDown() {
  el.stageVideo.removeAttribute('src');
  el.stageVideo.load && el.stageVideo.load();
  setObsLive(false);
  el.statsLine.textContent = '';
  if (state.presenterId === state.selfId) showObsPanel();
  else if (state.presenterMode === 'obs') setStageConnecting();
}

/* ---------- OBS 推流面板（仅演示者） ---------- */

// RTMP 用查询参数携带鉴权：整串填进 OBS「服务器」，「串流密钥」留空
function fillObsPanel(url) {
  el.obsUrl.textContent = url;
}

function showObsPanel() {
  if (!state.rtmpUrl) return;
  fillObsPanel(state.rtmpUrl);
  setObsLive(false);
  el.obsPanel.classList.remove('hidden');
}

function hideObsPanel() {
  el.obsPanel.classList.add('hidden');
}

function setObsLive(live) {
  el.obsDot.classList.toggle('live', live);
  el.obsStatus.textContent = live
    ? '直播中 · 房间里所有人都能看到（约 1~3 秒延迟）'
    : '等待 OBS 开始推流…';
}

function stopObsShare() {
  sendMsg({ type: 'stop-share' });
  stopHls();
  hideObsPanel();
  state.presenterId = null;
  state.presenterMode = null;
  state.remoteStream = null;
  clearRemoteStage();
  renderRoom();
}

/* ================= 共享流程 ================= */

async function startCapture() {
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      // 限制 1080p30：更高分辨率会压垮编码器和上传带宽
      video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: 'include',
    });
  } catch (err) {
    // 用户在选择器里点了取消 → 释放共享锁
    sendMsg({ type: 'stop-share' });
    state.presenterId = null;
    renderRoom();
    if (err && err.name !== 'NotAllowedError') {
      toast('无法获取屏幕画面：' + err.message, 'error');
    }
    return;
  }

  state.localStream = stream;

  // 看视频场景优先保帧率（宁可降分辨率也不掉帧卡顿）
  const vTrack = stream.getVideoTracks()[0];
  if (vTrack) vTrack.contentHint = 'motion';

  if (stream.getAudioTracks().length === 0) {
    toast('未包含系统声音（共享整个屏幕或标签页时可勾选「分享音频」）', 'warn', 5000);
  }

  // 用户点击浏览器原生的「停止共享」按钮
  stream.getVideoTracks()[0].addEventListener('ended', () => stopLocalShare(true));

  // 本地预览
  el.stageVideo.srcObject = stream;
  el.stageVideo.muted = true;
  el.stageVideo.play().catch(() => {});
  setStageMode('local');
  renderRoom();

  // 向房间里其他人推流
  for (const id of state.members.keys()) {
    if (id !== state.selfId) offerTo(id);
  }
}

function stopLocalShare(notifyServer) {
  if (!state.localStream) return;
  for (const track of state.localStream.getTracks()) track.stop();
  state.localStream = null;
  stopStats();
  closeAllPeers();
  if (notifyServer) sendMsg({ type: 'stop-share' });
  if (state.presenterId === state.selfId) state.presenterId = null;
  clearRemoteStage();
  renderRoom();
}

function onShareClick() {
  if (state.presenterId === state.selfId && state.presenterMode === 'obs') {
    stopObsShare();
    return;
  }
  if (!CAN_SHARE) {
    toast('这台设备的浏览器不支持共享屏幕（手机/平板一般只能观看），请用电脑共享', 'warn', 5000);
    return;
  }
  if (state.presenterId === state.selfId && state.localStream) {
    stopLocalShare(true);
    return;
  }
  if (state.presenterId && state.presenterId !== state.selfId) {
    toast(`${memberName(state.presenterId)} 正在共享中`, 'warn');
    return;
  }
  sendMsg({ type: 'request-share' });
}

/* ================= 舞台 / UI ================= */

function attachRemoteStream(stream, asObsPreview = false) {
  state.remoteStream = stream;
  el.stageVideo.srcObject = stream;
  if (asObsPreview) {
    // 演示者看自己的 OBS 画面：必须静音，否则和本机声音叠成回声
    el.stageVideo.muted = true;
    setStageMode('local');
    el.presenterLabel.textContent = '你正在通过 OBS 直播 · 其他人可以看到并听到';
    el.stageVideo.play().catch(() => {});
    hideObsPanel();
    showControls();
    return;
  }
  el.stageVideo.muted = false;
  el.stageVideo.volume = el.volumeSlider.value / 100;
  setStageMode('remote');
  showControls(); // 画面接入时亮一下控制条，3 秒后自动隐藏
  el.stageVideo.play().then(() => {
    el.clickToPlay.classList.add('hidden');
  }).catch(() => {
    // 浏览器拦截有声自动播放 → 先静音播出画面，用户点一下再开声音
    el.stageVideo.muted = true;
    el.stageVideo.play().catch(() => {});
    el.clickToPlay.classList.remove('hidden');
  });
}

function clearRemoteStage() {
  state.remoteStream = null;
  stopStats();
  el.stageVideo.srcObject = null;
  el.clickToPlay.classList.add('hidden');
  el.emptyTitle.textContent = '暂时没有人在共享屏幕';
  el.emptyHint.textContent = '点击下方「开始共享屏幕」，把你的画面带给大家';
  setStageMode('empty');
}

// 演示者已在共享但画面还没送达时的等待状态
function setStageConnecting() {
  if (state.remoteStream) return;
  if (state.presenterMode === 'obs') {
    el.emptyTitle.textContent = `等待 ${memberName(state.presenterId)} 的 OBS 画面…`;
    el.emptyHint.textContent = '对方在 OBS 里点「开始直播」后，画面会自动出现';
  } else {
    el.emptyTitle.textContent = `正在连接 ${memberName(state.presenterId)} 的画面…`;
    el.emptyHint.textContent = '通常几秒内出现；如长时间无画面，双方网络可能受限';
  }
  setStageMode('empty');
}

// mode: 'empty' | 'local' | 'remote'
function setStageMode(mode) {
  el.stageVideo.classList.toggle('hidden', mode === 'empty');
  el.stageEmpty.classList.toggle('hidden', mode !== 'empty');
  el.stageBar.classList.toggle('hidden', mode === 'empty');
  el.remoteControls.classList.toggle('hidden', mode !== 'remote');
  if (mode === 'local') {
    el.presenterLabel.textContent = '你正在共享屏幕 · 其他人可以看到并听到';
  } else if (mode === 'remote') {
    el.presenterLabel.textContent = `${memberName(state.presenterId)} 的屏幕`;
  }
}

function renderRoom() {
  el.roomCodeLabel.textContent = state.roomCode || '------';
  el.memberCount.textContent = `${state.members.size} / 3`;

  // 成员列表（含空位）
  el.members.innerHTML = '';
  for (const m of state.members.values()) {
    const div = document.createElement('div');
    div.className = 'member' + (m.id === state.presenterId ? ' presenting' : '');

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = avatarColor(m.id);
    avatar.textContent = [...m.name][0].toUpperCase();

    const info = document.createElement('div');
    info.className = 'member-info';

    const nameEl = document.createElement('span');
    nameEl.className = 'member-name';
    nameEl.textContent = m.name;
    if (m.id === state.selfId) {
      const you = document.createElement('span');
      you.className = 'you';
      you.textContent = '（你）';
      nameEl.appendChild(you);
    }

    const badge = document.createElement('span');
    if (m.id === state.presenterId) {
      badge.className = 'member-badge';
      badge.textContent = '正在共享';
    } else {
      badge.className = 'member-badge idle';
      badge.textContent = '在线';
    }

    info.appendChild(nameEl);
    info.appendChild(badge);
    div.appendChild(avatar);
    div.appendChild(info);
    el.members.appendChild(div);
  }
  for (let i = state.members.size; i < 3; i++) {
    const div = document.createElement('div');
    div.className = 'member slot-empty';
    div.innerHTML = `
      <div class="avatar"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg></div>
      <div class="member-info"><span class="member-name">等待加入…</span></div>`;
    el.members.appendChild(div);
  }

  // 共享按钮状态
  const iAmPresenter = state.presenterId === state.selfId;
  const someoneElse = state.presenterId && !iAmPresenter;
  el.shareBtn.disabled = !!someoneElse;
  el.shareBtn.classList.toggle('sharing', iAmPresenter);
  if (iAmPresenter) {
    el.shareBtnText.textContent = '停止共享';
  } else if (someoneElse) {
    el.shareBtnText.textContent = `${memberName(state.presenterId)} 正在共享`;
  } else {
    el.shareBtnText.textContent = '开始共享屏幕';
  }

  // 不支持屏幕采集的设备（手机/平板）：按钮降为提示样式
  if (!CAN_SHARE && !someoneElse) {
    el.shareBtnText.textContent = '共享屏幕请用电脑';
    el.shareBtn.classList.add('unsupported');
  } else {
    el.shareBtn.classList.remove('unsupported');
  }

  // OBS 推流按钮：电脑端 + 服务器已配置时可见；自己已在共享时收起
  el.obsBtn.classList.toggle('hidden', !CAN_SHARE || !state.obsAvailable || iAmPresenter);
  el.obsBtn.disabled = !!someoneElse;

  updateQualityUI();
}

function setBusy(busy) {
  el.createBtn.disabled = busy;
  el.joinBtn.disabled = busy;
}

/* ================= 进出房间 ================= */

function getName() {
  const name = el.nameInput.value.trim();
  if (!name) {
    toast('先填一个昵称吧', 'warn');
    el.nameInput.focus();
    return null;
  }
  localStorage.setItem('screenroom-name', name);
  return name;
}

function createRoom() {
  const name = getName();
  if (!name) return;
  state.name = name;
  state.intentionalLeave = false;
  setBusy(true);
  loadIceServers(); // 刷新中继凭据（页面可能已开了很久）
  connect(() => sendMsg({ type: 'create-room', name }));
}

function joinRoom() {
  const name = getName();
  if (!name) return;
  const code = el.codeInput.value.trim().toUpperCase();
  if (code.length !== 6) {
    toast('请输入 6 位房间码', 'warn');
    el.codeInput.focus();
    return;
  }
  state.name = name;
  state.intentionalLeave = false;
  setBusy(true);
  loadIceServers();
  connect(() => sendMsg({ type: 'join-room', roomCode: code, name }));
}

function leaveRoom() {
  state.intentionalLeave = true;
  stopLocalShare(false);
  closeAllPeers();
  stopHls();
  hideObsPanel();
  clearRemoteStage();
  if (state.ws) state.ws.close();
  state.roomCode = null;
  state.presenterId = null;
  state.presenterMode = null;
  state.rtmpUrl = null;
  state.members.clear();
  history.replaceState(null, '', location.pathname);
  showView('home');
}

async function copyText(text, okMsg) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // 非 HTTPS 环境的降级方案
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(okMsg, 'success');
}

function copyInviteLink() {
  copyText(`${location.origin}${location.pathname}?room=${state.roomCode}`, '邀请链接已复制，发给朋友吧');
}

/* ================= 事件绑定 ================= */

el.createBtn.addEventListener('click', createRoom);
el.joinBtn.addEventListener('click', joinRoom);
el.leaveBtn.addEventListener('click', leaveRoom);
el.copyLinkBtn.addEventListener('click', copyInviteLink);
el.shareBtn.addEventListener('click', onShareClick);

el.obsBtn.addEventListener('click', () => {
  if (state.presenterId && state.presenterId !== state.selfId) {
    toast(`${memberName(state.presenterId)} 正在共享中`, 'warn');
    return;
  }
  if (state.presenterId === state.selfId) return; // 已在共享
  sendMsg({ type: 'request-share', mode: 'obs' });
});

el.obsCopyBtn.addEventListener('click', () => {
  copyText(el.obsUrl.textContent, '推流地址已复制，粘贴到 OBS 的「服务器」栏');
});

el.qualityPicker.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-q]');
  if (btn) setQuality(btn.dataset.q);
});

el.playBtn.addEventListener('click', () => {
  el.stageVideo.muted = false;
  el.stageVideo.play().then(() => el.clickToPlay.classList.add('hidden')).catch(() => {});
});

el.muteBtn.addEventListener('click', () => {
  el.stageVideo.muted = !el.stageVideo.muted;
  el.iconSoundOn.classList.toggle('hidden', el.stageVideo.muted);
  el.iconSoundOff.classList.toggle('hidden', !el.stageVideo.muted);
});

el.volumeSlider.addEventListener('input', () => {
  el.stageVideo.volume = el.volumeSlider.value / 100;
  if (el.stageVideo.muted && el.volumeSlider.value > 0) {
    el.stageVideo.muted = false;
    el.iconSoundOn.classList.remove('hidden');
    el.iconSoundOff.classList.add('hidden');
  }
});

el.fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) {
    document.exitFullscreen();
    return;
  }
  if (el.stage.requestFullscreen) {
    el.stage.requestFullscreen().catch(() => {});
  } else if (el.stageVideo.webkitEnterFullscreen) {
    // iOS 不支持网页元素全屏，只能全屏视频本体
    el.stageVideo.webkitEnterFullscreen();
  }
});

// 控制条显隐（视频播放器式）：动鼠标/点屏幕唤出，3 秒无操作自动隐藏
let controlsTimer = null;

function showControls(autoHide = true) {
  el.stage.classList.add('controls-visible');
  clearTimeout(controlsTimer);
  if (autoHide) {
    controlsTimer = setTimeout(() => el.stage.classList.remove('controls-visible'), 3000);
  }
}

function hideControls() {
  clearTimeout(controlsTimer);
  el.stage.classList.remove('controls-visible');
}

// 鼠标：移动唤出并重置计时；停在控制条上时保持显示不倒计时
el.stage.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'mouse') return;
  showControls(!e.target.closest('.stage-bar'));
});
el.stage.addEventListener('mouseleave', hideControls);

// 触屏：点按画面切换显隐；点控制条上的按钮则保持显示并重置计时
el.stage.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse') return;
  if (e.target.closest('.stage-bar') || e.target.closest('.click-to-play')) {
    showControls();
    return;
  }
  if (el.stage.classList.contains('controls-visible')) hideControls();
  else showControls();
});

el.nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (el.codeInput.value.trim()) joinRoom();
    else createRoom();
  }
});
el.codeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
el.codeInput.addEventListener('input', () => {
  el.codeInput.value = el.codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

/* ================= 初始化 ================= */

(function init() {
  loadIceServers(); // 异步获取 TURN 中继凭据，失败则纯 STUN

  const savedName = localStorage.getItem('screenroom-name');
  if (savedName) el.nameInput.value = savedName;

  const params = new URLSearchParams(location.search);
  const room = params.get('room');
  if (room) {
    el.codeInput.value = room.toUpperCase().slice(0, 6);
    if (savedName) {
      el.joinBtn.focus();
    } else {
      el.nameInput.focus();
    }
    toast('输入昵称后点「加入」即可进入房间', 'info', 4500);
  } else {
    el.nameInput.focus();
  }

  // iOS 不允许网页调节媒体音量，隐藏音量滑块（静音按钮仍可用）
  if (IS_IOS) el.volumeSlider.style.display = 'none';

  // 桌面浏览器不支持屏幕采集时才警告（手机属正常情况，按钮上已有提示）
  if (!CAN_SHARE && window.matchMedia('(pointer: fine)').matches) {
    toast('当前浏览器不支持屏幕共享，请使用 Chrome / Edge，并通过 HTTPS 或 localhost 访问', 'error', 8000);
  }
})();
