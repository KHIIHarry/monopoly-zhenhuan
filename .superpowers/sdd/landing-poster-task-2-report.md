# Landing Poster Task 2 Report

## Changed Files

- `scripts/extract-landing-assets.sh`: repeatable `sips` crop script.
- `apps/web/public/assets/landing/background-texture.png`
- `apps/web/public/assets/landing/palace-sky.png`
- `apps/web/public/assets/landing/gold-frame.png`
- `apps/web/public/assets/landing/characters.png`
- `apps/web/public/assets/landing/foreground-flora.png`
- `apps/web/public/assets/landing/game-title.png`
- `apps/web/public/assets/landing/game-subtitle.png`
- `apps/web/public/assets/landing/join-button.png`

No React or CSS files were changed.

## Commands And Output

1. `sips -g pixelWidth -g pixelHeight ../板式2-元素拆分.PNG`
   - Output: source image is `1536x1024`.
2. `zsh scripts/extract-landing-assets.sh` before the script existed.
   - Output: `zsh: can't open input file: scripts/extract-landing-assets.sh` (expected red check).
3. `zsh scripts/extract-landing-assets.sh && for asset in apps/web/public/assets/landing/*.png; do sips -g format -g pixelWidth -g pixelHeight "$asset"; done`
   - Exit code: `0`.
   - Output: eight assets, all `format: png`, with positive dimensions: `256x302`, `600x250`, `320x300`, `300x155`, `330x150`, `300x300`, `300x100`, and `256x305`.
4. Visual inspection with the image viewer of all eight exported files.
   - Result: each crop contains only its named visual. The subtitle and join-button horizontal offsets were adjusted from the initial brief coordinates to prevent adjacent title/subtitle bleed.
5. `git status --short` and `git rev-parse --show-toplevel`.
   - Output: `fatal: not a git repository`; no commit was attempted as required.

## Self-Review

- The script uses `set -euo pipefail`, creates its output directory, and can be rerun without manual setup.
- All required PNGs are generated from the supplied source image; none is a full-image background substitute.
- Visual review confirms no source-image numbering or explanatory labels are present. Black preview backing remains intentionally for later `mix-blend-mode: screen` handling.
- Scope is confined to the extraction script and generated static assets.

## Review-fix evidence

- Expanded the character crop from `600` to `620` pixels and shifted its origin to `x=560`, preserving the fifth character's complete right edge.
- Shifted the floral crop origin from `x=1200` to `x=1215` and narrowed it to `310` pixels, removing the adjacent purple character fragment.
- Expanded the title crop from `330` to `350` pixels, preserving the final `传` glyph with a black safe margin.
- Re-ran `zsh scripts/extract-landing-assets.sh` successfully, confirmed all eight files are PNG with positive dimensions, and visually checked the three corrected files.
