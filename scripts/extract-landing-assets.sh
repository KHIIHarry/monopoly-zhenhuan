#!/bin/zsh
set -euo pipefail

source_image="${0:A:h:h:h}/板式2-元素拆分.PNG"
output_dir="${0:A:h:h}/apps/web/public/assets/landing"

mkdir -p "$output_dir"

sips -c 302 256 --cropOffset 58 587 "$source_image" --out "$output_dir/background-texture.png"
sips -c 305 256 --cropOffset 55 869 "$source_image" --out "$output_dir/palace-sky.png"
sips -c 300 300 --cropOffset 58 1202 "$source_image" --out "$output_dir/gold-frame.png"
sips -c 250 620 --cropOffset 420 560 "$source_image" --out "$output_dir/characters.png"
sips -c 300 310 --cropOffset 408 1215 "$source_image" --out "$output_dir/foreground-flora.png"
sips -c 150 350 --cropOffset 770 570 "$source_image" --out "$output_dir/game-title.png"
sips -c 155 300 --cropOffset 770 915 "$source_image" --out "$output_dir/game-subtitle.png"
sips -c 100 300 --cropOffset 795 1230 "$source_image" --out "$output_dir/join-button.png"
