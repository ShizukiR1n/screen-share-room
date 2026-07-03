'use strict';
// 信令服务器协议自动化测试（node test-signaling.js，需要服务器已在 3000 端口运行）

const WebSocket = require('ws');
const URL = 'ws://localhost:3000';

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { passed++; console.log('  ✓ ' + label); }
  else { failed++; console.log('  ✗ ' + label); }
}

function client() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d);
    const i = waiters.findIndex((w) => w.type === msg.type);
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else queue.push(msg);
  });
  return {
    ws,
    send: (m) => ws.send(JSON.stringify(m)),
    open: () => new Promise((r) => ws.once('open', r)),
    // 等待某类型消息（先查积压队列；超时后清理等待器，避免吞掉后续消息）
    wait: (type, ms = 3000) => {
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { type, resolve: null };
        const t = setTimeout(() => {
          const idx = waiters.indexOf(w);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`等待 ${type} 超时`));
        }, ms);
        w.resolve = (m) => { clearTimeout(t); resolve(m); };
        waiters.push(w);
      });
    },
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('— 创建与加入 —');
  const a = client(); await a.open();
  a.send({ type: 'create-room', name: '甲' });
  const joinedA = await a.wait('joined');
  assert(/^[A-Z2-9]{6}$/.test(joinedA.roomCode), `创建房间返回 6 位房间码 (${joinedA.roomCode})`);
  assert(joinedA.members.length === 1, '创建者在成员列表中');
  const code = joinedA.roomCode;

  const b = client(); await b.open();
  b.send({ type: 'join-room', roomCode: code.toLowerCase(), name: '乙' });
  const joinedB = await b.wait('joined');
  assert(joinedB.members.length === 2, '加入者收到完整成员列表（房间码忽略大小写）');
  const notifyA = await a.wait('peer-joined');
  assert(notifyA.member.name === '乙', 'A 收到 peer-joined 广播');

  console.log('— 房间不存在 / 满员 —');
  const x = client(); await x.open();
  x.send({ type: 'join-room', roomCode: 'ZZZZZZ', name: '路人' });
  assert((await x.wait('error')).code === 'room-not-found', '不存在的房间返回 room-not-found');
  x.close();

  const c = client(); await c.open();
  c.send({ type: 'join-room', roomCode: code, name: '丙' });
  const joinedC = await c.wait('joined');
  await a.wait('peer-joined'); await b.wait('peer-joined');

  const d = client(); await d.open();
  d.send({ type: 'join-room', roomCode: code, name: '丁' });
  assert((await d.wait('error')).code === 'room-full', '第 4 人被拒绝 room-full');
  d.close();

  console.log('— 演示者锁 —');
  a.send({ type: 'request-share' });
  await a.wait('share-granted');
  const pcB = await b.wait('presenter-changed');
  assert(pcB.presenterId === joinedA.selfId, 'B 收到 presenter-changed(A)');
  await c.wait('presenter-changed');

  b.send({ type: 'request-share' });
  assert((await b.wait('share-denied')).type === 'share-denied', 'A 共享期间 B 请求被拒');

  console.log('— 信令转发 —');
  a.send({ type: 'offer', to: joinedB.selfId, sdp: { type: 'offer', sdp: 'fake' } });
  const offerAtB = await b.wait('offer');
  assert(offerAtB.from === joinedA.selfId && offerAtB.sdp.sdp === 'fake', 'offer 定向转发并带 from');
  b.send({ type: 'answer', to: joinedA.selfId, sdp: { type: 'answer', sdp: 'fake2' } });
  assert((await a.wait('answer')).from === joinedB.selfId, 'answer 回传给 A');
  a.send({ type: 'ice-candidate', to: joinedB.selfId, candidate: { candidate: 'c1' } });
  assert((await b.wait('ice-candidate')).candidate.candidate === 'c1', 'ICE candidate 转发');

  console.log('— 停止共享 / 演示者断线 —');
  a.send({ type: 'stop-share' });
  assert((await b.wait('presenter-changed')).presenterId === null, 'stop-share 后锁释放');
  await c.wait('presenter-changed');

  b.send({ type: 'request-share' });
  await b.wait('share-granted');
  await a.wait('presenter-changed'); await c.wait('presenter-changed');
  b.close(); // 演示者直接断线
  const afterDrop = await a.wait('presenter-changed');
  assert(afterDrop.presenterId === null, '演示者断线自动释放锁');
  assert((await a.wait('peer-left')).id === joinedB.selfId, '广播 peer-left');
  await c.wait('presenter-changed'); await c.wait('peer-left');

  console.log('— 断线恢复身份（resume） —');
  // c 模拟信令闪断后凭 token 恢复
  const c2 = client(); await c2.open();
  c2.send({ type: 'resume', roomCode: code, memberId: joinedC.selfId, token: joinedC.token, name: '丙' });
  const resumedC = await c2.wait('joined');
  assert(resumedC.selfId === joinedC.selfId, 'resume 后身份不变（同一 selfId）');
  assert(resumedC.members.length === 2, '成员数不变（没有分身）');
  let ghostEvent = false;
  try { await a.wait('peer-joined', 800); ghostEvent = true; } catch { /* 预期超时 */ }
  assert(!ghostEvent, 'A 不会收到多余的 peer-joined（无分身广播）');

  // 错误 token：回退为普通加入（新身份 + 广播）
  const d2 = client(); await d2.open();
  d2.send({ type: 'resume', roomCode: code, memberId: joinedC.selfId, token: 'wrong-token', name: '丙分身' });
  const fallback = await d2.wait('joined');
  assert(fallback.selfId !== joinedC.selfId, '错误 token 回退为新身份');
  assert((await a.wait('peer-joined')).member.name === '丙分身', '回退路径正常广播 peer-joined');
  d2.close();
  await a.wait('peer-left');
  c2.close();
  await a.wait('peer-left');

  console.log('— 房间销毁 —');
  a.close();
  await sleep(200);
  const y = client(); await y.open();
  y.send({ type: 'join-room', roomCode: code, name: '再来' });
  assert((await y.wait('error')).code === 'room-not-found', '全员离开后房间销毁');
  y.close();

  console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error('测试异常:', err.message);
  process.exit(1);
});
