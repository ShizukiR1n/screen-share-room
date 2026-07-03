# 聚幕 · 屏幕共享直播间

纯网页端的三人小直播间：一个人共享电脑的**屏幕画面 + 系统声音**，其他人实时观看。
基于 WebRTC 点对点传输，画面不经过服务器，延迟低。

> 部署网址不公开。部署到 Render 后，为防免费实例休眠，可在任意常开的机器上加定时任务
> 每 10 分钟访问一次站点；修改代码后需到 Render 控制台点 Manual Deploy 重新部署。

## 一、本地运行

需要先安装 [Node.js](https://nodejs.org/zh-cn)（LTS 版本即可）。

```powershell
cd "D:\code\Screen Share"
npm install
npm start
```

看到 `聚幕直播间已启动: http://localhost:3000` 后，浏览器打开 <http://localhost:3000> 即可使用。

## 二、让不同网络的朋友加入（推荐路线）

浏览器的屏幕采集功能强制要求 **HTTPS**（localhost 除外），所以给朋友用时需要一个公网
HTTPS 网址。最简单的办法是 Cloudflare 免费隧道，**无需注册、一条命令**：

1. 安装 cloudflared（只需一次）：

   ```powershell
   winget install Cloudflare.cloudflared
   ```

2. 保持 `npm start` 运行，另开一个终端执行：

   ```powershell
   cloudflared tunnel --url http://localhost:3000
   ```

3. 稍等几秒，终端里会显示一个类似
   `https://xxxx-xxxx.trycloudflare.com` 的网址 —— 把它发给朋友。
   **所有人（包括你自己）都用这个 https 网址进房间**。

4. 进房后点顶栏的「邀请」按钮，可以直接复制带房间码的链接。

> 注意：隧道网址每次重启 cloudflared 都会变化，属于临时网址。用完关掉终端即可。

## 三、永久部署（可选）

想要一个固定网址，可以把项目免费部署到 [Render](https://render.com)：

1. 把这个文件夹推送到一个 GitHub 仓库
2. Render 上 New → Web Service → 连接该仓库
3. Build Command 填 `npm install`，Start Command 填 `npm start`，选 Free 套餐
4. 部署完成后获得 `https://xxx.onrender.com` 固定网址

> Render 免费套餐闲置 15 分钟会休眠，首次打开需等待几十秒唤醒。

## 使用说明

- **创建/加入**：填昵称 → 创建房间，把 6 位房间码或邀请链接发给朋友（最多 3 人）
- **共享屏幕**：点「开始共享屏幕」，在浏览器弹窗中选择整个屏幕/窗口/标签页；
  **想让对方听到电脑声音，务必勾选弹窗左下角的「同时分享系统音频」**
  （选"整个屏幕"或"标签页"时才有此选项，Chrome/Edge on Windows 支持）
- **同一时间只有一人能共享**；点「停止共享」后其他人即可接棒
- 观看端把鼠标移到画面上，可以调音量、静音、全屏

## 常见问题

| 问题 | 解决办法 |
| --- | --- |
| 点共享没有反应 / 报不支持 | 必须用 Chrome 或 Edge，且通过 https 或 localhost 访问 |
| 对方听不到声音 | 共享时没勾选「分享音频」；重新共享并勾选 |
| 画面一直转圈连不上 | 少数严格防火墙网络会拦截；会自动降级走 TURN 中继，稍等片刻 |
| 房间进不去 | 房间码错误、房间已满 3 人，或房主已全部离开（房间自动销毁） |

## 技术架构

- `server.js` — Node.js（express + ws）：托管网页 + WebSocket 信令（房间管理、演示者锁、SDP/ICE 转发）
- `public/` — 原生 HTML/CSS/JS，无构建步骤
- 传输 — WebRTC `getDisplayMedia` 采集屏幕+系统声音，演示者与每个观看者一对一传输（星型），
  STUN/TURN 配置由服务端 `/api/ice` 按需下发（支持自建 coturn 或 Cloudflare，通过环境变量配置）
