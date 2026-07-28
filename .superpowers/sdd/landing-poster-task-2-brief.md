### Task 2: 裁切并导出可独立组合的本地海报素材

**Files:**
- Create: `scripts/extract-landing-assets.sh`
- Create: `apps/web/public/assets/landing/background-texture.png`
- Create: `apps/web/public/assets/landing/palace-sky.png`
- Create: `apps/web/public/assets/landing/gold-frame.png`
- Create: `apps/web/public/assets/landing/characters.png`
- Create: `apps/web/public/assets/landing/foreground-flora.png`
- Create: `apps/web/public/assets/landing/game-title.png`
- Create: `apps/web/public/assets/landing/game-subtitle.png`
- Create: `apps/web/public/assets/landing/join-button.png`

**Interfaces:**
- Consumes: `/Users/harry/Documents/甄嬛传大富翁/板式2-元素拆分.PNG`（1536x1024）。
- Produces: `/assets/landing/<name>.png`，供首页组件使用。

- [ ] **Step 1: 写入可重复运行的裁切脚本，使用 `sips` 从示意图提取每个素材区域。**

```sh
#!/bin/zsh
set -euo pipefail
source_image="${0:A:h:h:h}/板式2-元素拆分.PNG"
output_dir="${0:A:h:h}/apps/web/public/assets/landing"
mkdir -p "$output_dir"
sips -c 302 256 --cropOffset 58 587 "$source_image" --out "$output_dir/background-texture.png"
sips -c 305 256 --cropOffset 55 869 "$source_image" --out "$output_dir/palace-sky.png"
sips -c 300 300 --cropOffset 58 1202 "$source_image" --out "$output_dir/gold-frame.png"
sips -c 250 600 --cropOffset 420 565 "$source_image" --out "$output_dir/characters.png"
sips -c 300 320 --cropOffset 408 1200 "$source_image" --out "$output_dir/foreground-flora.png"
sips -c 150 330 --cropOffset 770 570 "$source_image" --out "$output_dir/game-title.png"
sips -c 155 300 --cropOffset 770 900 "$source_image" --out "$output_dir/game-subtitle.png"
sips -c 100 300 --cropOffset 795 1200 "$source_image" --out "$output_dir/join-button.png"
```

- [ ] **Step 2: 执行脚本并用 `sips` 核对所有输出为 PNG 且具有正的宽高。**

Run: `zsh scripts/extract-landing-assets.sh && for asset in apps/web/public/assets/landing/*.png; do sips -g pixelWidth -g pixelHeight "$asset"; done`

Expected: 八个 PNG 文件均输出 `pixelWidth` 与 `pixelHeight`，数值大于 0。

- [ ] **Step 3: 逐个检查输出，必要时仅调整裁切坐标，确保运行时素材不带图三中的编号、说明文字或相邻组件。**

Expected: 每个文件只包含其命名所对应的视觉元素；纯黑预览底可以由后续 CSS `mix-blend-mode: screen` 处理，但不得把整张示意图作为背景。

Do not modify React or CSS files in this task. The current workspace has no Git metadata, so record the absence rather than attempting a commit.
