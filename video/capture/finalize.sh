#!/usr/bin/env bash
# Makes a render ready for the web: H.264 (yuv420p, faststart) plus a silent AAC track, so every player treats it alike.
#   bash capture/finalize.sh out/clipa-demo.mp4 ../apps/web/public/videos/clipa-demo.mp4 [crf]
# A voice-over replaces the silent track later: ffmpeg -i video.mp4 -i voice.m4a -map 0:v -map 1:a -c:v copy -c:a aac -shortest out.mp4
set -euo pipefail
in="$1"
out="$2"
crf="${3:-23}"
ffmpeg -hide_banner -loglevel error -y -i "$in" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -map 0:v:0 -map 1:a:0 -c:v libx264 -preset medium -crf "$crf" -pix_fmt yuv420p -profile:v high \
  -c:a aac -b:a 96k -shortest -movflags +faststart "$out"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height -of compact "$out"
