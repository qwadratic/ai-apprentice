#!/usr/bin/env bash
# Replaces the last scene of a render with a newly rendered outro (cross-fade 0.5 s, like the storyboard) and makes the
# result web-ready (H.264, faststart, silent AAC):
#   bash capture/splice-outro.sh out/clipa-tech.mp4 out/tech-outro.mp4 ../apps/web/public/videos/clipa-tech.mp4 [crf]
set -euo pipefail
main="$1"
outro="$2"
out="$3"
crf="${4:-23}"
total=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$main")
outro_len=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$outro")
offset=$(python3 -c "print(round($total - $outro_len, 3))")
ffmpeg -hide_banner -loglevel error -y -i "$main" -i "$outro" -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=48000 \
  -filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=${offset},format=yuv420p[v]" \
  -map "[v]" -map 2:a:0 -c:v libx264 -preset medium -crf "$crf" -profile:v high \
  -c:a aac -b:a 96k -shortest -movflags +faststart "$out"
ffprobe -v error -show_entries format=duration,size -show_entries stream=codec_name,width,height -of compact "$out"
