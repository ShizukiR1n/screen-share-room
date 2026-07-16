#!/bin/bash
# Beam OBS 推流服务（MediaMTX）一键安装脚本（Ubuntu / Debian）
# 用法: bash mediamtx-setup.sh <服务器公网IP>
#
# 架构（全 TCP，绕开运营商对高速率 UDP 的限速）：
#   OBS ──RTMP(TCP 1935)──▶ MediaMTX ──HLS(HTTP/TCP 8888)──▶ 网页服务器代理 ──▶ 浏览器
# 需在云控制台防火墙放行：TCP 1935（RTMP 推流）、TCP 8888（HLS，供网页服务器拉取）
set -e

PUBIP="$1"
if [ -z "$PUBIP" ]; then
  echo "用法: bash mediamtx-setup.sh <服务器公网IP>"
  exit 1
fi

MTX_VERSION=v1.12.3
PUBPASS=$(openssl rand -hex 16)
READPASS=$(openssl rand -hex 16)

# 下载（GitHub 直连在国内经常超时，按镜像顺序回退）
cd /tmp
rm -f mediamtx.tar.gz
ok=""
for base in \
  "https://gh-proxy.com/https://github.com/bluenviron/mediamtx/releases/download" \
  "https://ghproxy.net/https://github.com/bluenviron/mediamtx/releases/download" \
  "https://github.com/bluenviron/mediamtx/releases/download"; do
  if curl -fsSL --connect-timeout 10 -o mediamtx.tar.gz \
    "$base/${MTX_VERSION}/mediamtx_${MTX_VERSION}_linux_amd64.tar.gz"; then
    ok=1; break
  fi
done
if [ -z "$ok" ]; then
  echo "❌ 下载 MediaMTX 失败（GitHub 与镜像均不可达），请把此信息发给 Claude"
  exit 1
fi

mkdir -p /opt/mediamtx
tar xzf mediamtx.tar.gz -C /opt/mediamtx mediamtx

cat > /opt/mediamtx/mediamtx.yml <<EOF
logLevel: info

# 只开 RTMP 入 + HLS 出，其余协议全关（不用 WebRTC/UDP 了）
rtsp: no
srt: no
webrtc: no
rtmp: yes
rtmpAddress: :1935
rtmpEncryption: "no"
hls: yes
hlsAddress: :8888
hlsAllowOrigin: '*'
# mpegts（单轨 TS）：hls.js 播 lowLatency/fMP4 分轨会卡在 readyState 0，mpegts 秒播
hlsVariant: mpegts
hlsSegmentCount: 7
hlsSegmentDuration: 1s
api: no
metrics: no
playback: no

# 推流、拉流分别用独立密码（凭据由网页服务器代理注入，不暴露给观众）
authInternalUsers:
- user: publisher
  pass: ${PUBPASS}
  permissions:
  - action: publish
- user: viewer
  pass: ${READPASS}
  permissions:
  - action: read

# 只允许这一条固定路径，锁死其它路径防止陌生人乱推
paths:
  beam: {}
EOF

cat > /etc/systemd/system/mediamtx.service <<'EOF'
[Unit]
Description=MediaMTX (Beam OBS ingest)
After=network.target

[Service]
ExecStart=/opt/mediamtx/mediamtx /opt/mediamtx/mediamtx.yml
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

# 清理旧 WebRTC 方案遗留的 iptables 端口转发（443/8189 不再需要）
iptables -t nat -D PREROUTING -p udp --dport 443 -j REDIRECT --to-ports 3478 2>/dev/null || true
iptables -t nat -D PREROUTING -p udp --dport 8189 -j REDIRECT --to-ports 443 2>/dev/null || true
netfilter-persistent save >/dev/null 2>&1 || true

systemctl daemon-reload
systemctl enable mediamtx >/dev/null 2>&1
systemctl restart mediamtx
sleep 2

if systemctl is-active --quiet mediamtx; then
  echo
  echo "=================================================="
  echo "✅ OBS 推流服务安装并启动成功！"
  echo "请把下面两行完整复制发给 Claude："
  echo
  echo "MTX_PUBLISH_PASS=${PUBPASS}"
  echo "MTX_READ_PASS=${READPASS}"
  echo "=================================================="
else
  echo "❌ MediaMTX 启动失败，请把以下日志发给 Claude："
  journalctl -u mediamtx --no-pager -n 30
  exit 1
fi
