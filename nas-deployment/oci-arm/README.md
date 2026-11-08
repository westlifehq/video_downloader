# OCI ARM（东京）部署

海外机房部署方案：页面/API 走国内家宽代理规避抖音风控，视频 CDN 直连东京带宽；文件先落本地，再由 systemd timer 搬到 Google Drive 月度文件夹。

## 目录

| 文件 | 说明 |
|---|---|
| `docker-compose.yml` | 容器编排（需 `.env` 提供 `VD_PROXY` / `VD_PROXY_HOST`） |
| `vd-gdrive-move.sh` | 本地 → Google Drive 搬运脚本（`rclone move`，成功后删本地） |

## 部署步骤

```bash
# 1. 代码与数据
git clone https://github.com/westlifehq/video_downloader.git ~/apps/video-downloader
mkdir -p ~/data/vd ~/data/dy   # 数据卷 / 下载目录

# 2. 代理环境变量
cd ~/apps/video-downloader/nas-deployment/oci-arm
cat > .env <<'ENV'
VD_PROXY=http://<家宽代理TailscaleIP>:8899
VD_PROXY_HOST=<家宽代理TailscaleIP>
ENV

# 3. 启动
docker compose up -d --build

# 4. 权限：容器以 UID 1000 运行，数据卷须归属 1000
sudo chown -R 1000:1000 ~/data/vd ~/data/dy

# 5. GDrive 搬运（systemd）
sudo install -m 755 vd-gdrive-move.sh /usr/local/bin/vd-gdrive-move.sh
# 见文末 unit 内容
sudo systemctl daemon-reload && sudo systemctl enable --now vd-gdrive-move.timer
```

## 关键点

- **NO_PROXY 必须包含视频 CDN 域名**（douyinvod / snssdk / douyinpic / bytecdn / xhscdn 等），否则下载会绕回家宽，占用上行且更慢（实测直连 366KB/s vs 代理 269KB/s）。
- 下载目录权限：容器内 `pwuser` 为 UID 1000；宿主用户若是 UID 1001，直接 `chown` 到 1000，否则 600 权限文件会读不到（表现为配置被忽略、调度显示"已禁用"）。
- 搬运脚本以 root 运行，需显式 `--config /home/ubuntu/.config/rclone/rclone.conf`，否则找不到 rclone 配置。
- 上传吞吐：rclone 单连接约 1.3MB/s（共享 client_id 限速），多文件并发可聚合到 7MB/s；自建 Google OAuth client_id 可提升。

## systemd unit

`/etc/systemd/system/vd-gdrive-move.service`
```ini
[Unit]
Description=Move finished downloads to Google Drive (monthly folder)
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/vd-gdrive-move.sh
Nice=10
```

`/etc/systemd/system/vd-gdrive-move.timer`
```ini
[Unit]
Description=Run vd-gdrive-move every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
AccuracySec=30s

[Install]
WantedBy=timers.target
```
