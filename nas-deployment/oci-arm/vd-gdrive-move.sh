#!/bin/bash
# 把本地下载目录中已落盘 >=5 分钟的文件搬到 Google Drive 月度文件夹，成功后删除本地
set -uo pipefail
SRC="/home/ubuntu/data/dy"
DEST="gdrive:抖音 Download/$(date +%Y-%m)"
LOG="/var/log/vd-gdrive-move.log"

[ -d "$SRC" ] || exit 0
if [ -z "$(ls -A "$SRC" 2>/dev/null)" ]; then exit 0; fi

rclone move "$SRC" "$DEST" --config /home/ubuntu/.config/rclone/rclone.conf \
  --min-age 5m --exclude "*.part" \
  --transfers 4 --checkers 8 \
  --drive-chunk-size 16M --multi-thread-cutoff 8M --multi-thread-streams 4 \
  --delete-empty-src-dirs \
  --log-file "$LOG" --log-level INFO --stats 0
rc=$?
echo "[$(date "+%F %T")] move done rc=$rc remaining=$(ls -A "$SRC" 2>/dev/null | wc -l)" >> "$LOG"

