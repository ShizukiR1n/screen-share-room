#!/bin/bash
# Beam OBS 推流服务（MediaMTX）一键安装脚本（Ubuntu / Debian）
# 用法: bash mediamtx-setup.sh <服务器公网IP>
#
# 架构（全 TCP，绕开运营商对高速率 UDP 的限速）：
#   OBS ──RTMP(TCP 1935)──▶ MediaMTX ──HLS(HTTPS/TCP 8888)──▶ 浏览器【直连，走国内链路】
#                                        └──（兜底）网页服务器 /hls 代理（跨境仅 ~2Mbps）
# 观看端直连是关键：经海外网页服务器中转实测只有 ~2Mbps，扛不住 6~8Mbps 高清码率；
# 直连国内服务器实测 60Mbps+。页面是 HTTPS，直连必须也是 HTTPS（混合内容限制）。
# ⚠️ 国内服务器有备案墙：任何"域名"访问（含 sslip.io 等免费域名、任意端口）都会被
# 云厂商拦截到备案提示页——所以必须用 Let's Encrypt 的【纯 IP 证书】（shortlived
# profile，约 6.5 天有效，用 lego 客户端签发 + cron 自动续期；纯 IP 访问不受备案墙管）。
# HLS 读权限对「长随机路径」匿名开放（路径即口令，Safari 原生播放器带不了鉴权头）。
#
# 需在云控制台防火墙放行：
#   TCP 1935（RTMP 推流）、TCP 8888（HLS 直连观看）、TCP 80（证书签发与自动续期）
set -e

PUBIP="$1"
if [ -z "$PUBIP" ]; then
  echo "用法: bash mediamtx-setup.sh <服务器公网IP>"
  exit 1
fi

MTX_VERSION=v1.12.3
# lego（ACME 客户端，签 IP 证书用）；升级版本时要同步更新官方 sha256
LEGO_VERSION=v5.2.2
LEGO_SHA256=018de6d3f2da09630caa2fbbe8c6aa459323ad0ac0a053d0e808268914b38a8b
ACME_EMAIL="${2:-}"
PUBPASS=$(openssl rand -hex 16)
READPASS=$(openssl rand -hex 16)
STREAMPATH="beam-$(openssl rand -hex 12)"
if [ -z "$ACME_EMAIL" ]; then
  echo "用法: bash mediamtx-setup.sh <服务器公网IP> <证书联系邮箱>"
  exit 1
fi

# ---------- 下载 MediaMTX（GitHub 直连在国内经常超时，按镜像顺序回退） ----------
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

# ---------- HTTPS 证书（Let's Encrypt 纯 IP 短效证书 + lego，自动续期） ----------
if [ ! -x /usr/local/bin/lego ]; then
  cd /tmp && rm -f lego.tgz
  ok=""
  for base in \
    "https://gh-proxy.com/https://github.com/go-acme/lego/releases/download" \
    "https://ghproxy.net/https://github.com/go-acme/lego/releases/download" \
    "https://github.com/go-acme/lego/releases/download"; do
    if curl -fsSL --connect-timeout 10 -o lego.tgz \
      "$base/${LEGO_VERSION}/lego_${LEGO_VERSION}_linux_amd64.tar.gz"; then
      ok=1; break
    fi
  done
  [ -n "$ok" ] || { echo "❌ 下载 lego 失败"; exit 1; }
  # 镜像下载必须校验官方 sha256，防篡改
  echo "${LEGO_SHA256}  lego.tgz" | sha256sum -c - || { echo "❌ lego 校验失败"; exit 1; }
  tar xzf lego.tgz lego && mv lego /usr/local/bin/lego
fi

# HTTP-01 验证临时占用 80 端口（需防火墙放行 TCP 80）；纯 IP 访问不受备案墙拦截
if [ ! -f /opt/mediamtx/tls.crt ]; then
  /usr/local/bin/lego run --accept-tos -m "$ACME_EMAIL" -d "$PUBIP" \
    --http --profile shortlived --path /opt/lego
  cp "/opt/lego/certificates/${PUBIP}.crt" /opt/mediamtx/tls.crt
  cp "/opt/lego/certificates/${PUBIP}.key" /opt/mediamtx/tls.key
fi

# 短效证书 ~6.5 天有效：每天检查，满 3 天就重签
cat > /opt/lego/renew.sh <<RENEW
#!/bin/bash
if [ -z "\$(find /opt/mediamtx/tls.crt -mtime +2 2>/dev/null)" ]; then exit 0; fi
/usr/local/bin/lego run --accept-tos -m ${ACME_EMAIL} -d ${PUBIP} --http --profile shortlived --path /opt/lego \\
  && cp /opt/lego/certificates/${PUBIP}.crt /opt/mediamtx/tls.crt \\
  && cp /opt/lego/certificates/${PUBIP}.key /opt/mediamtx/tls.key \\
  && systemctl restart mediamtx
RENEW
chmod +x /opt/lego/renew.sh
echo '30 4 * * * root /opt/lego/renew.sh >>/var/log/lego-renew.log 2>&1' > /etc/cron.d/lego-renew
chmod 644 /etc/cron.d/lego-renew

# ---------- MediaMTX 配置 ----------
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
hlsEncryption: yes
hlsServerKey: /opt/mediamtx/tls.key
hlsServerCert: /opt/mediamtx/tls.crt
hlsAllowOrigin: '*'
# mpegts（单轨 TS）：hls.js 播 lowLatency/fMP4 分轨会卡在 readyState 0，mpegts 秒播
hlsVariant: mpegts
hlsSegmentCount: 7
hlsSegmentDuration: 1s
api: no
metrics: no
playback: no

# 推流要密码；观看对长随机路径匿名开放（路径即口令，只下发给房间成员）。
# viewer 账号保留给网页服务器的 /hls 兜底代理用
authInternalUsers:
- user: publisher
  pass: ${PUBPASS}
  permissions:
  - action: publish
- user: viewer
  pass: ${READPASS}
  permissions:
  - action: read
- user: any
  permissions:
  - action: read
    path: ${STREAMPATH}

# 只允许这一条固定路径，锁死其它路径防止陌生人乱推
paths:
  ${STREAMPATH}: {}
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
  echo "请把下面几行完整复制发给 Claude（用于配置网页服务器环境变量）："
  echo
  echo "MTX_PUBLISH_PASS=${PUBPASS}"
  echo "MTX_READ_PASS=${READPASS}"
  echo "MTX_PATH=${STREAMPATH}"
  echo "MTX_HLS_PUBLIC=https://${PUBIP}:8888"
  echo "=================================================="
else
  echo "❌ MediaMTX 启动失败，请把以下日志发给 Claude："
  journalctl -u mediamtx --no-pager -n 30
  exit 1
fi
