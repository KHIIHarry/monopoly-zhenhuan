# Task 2 crop-review fixes

Read the original task brief first: `.superpowers/sdd/landing-poster-task-2-brief.md`.

An independent review identified these blocking defects in the generated assets:

1. `characters.png` ends before the fifth character's right edge. Expand or shift the source crop so all five characters have intact visual bounds.
2. `foreground-flora.png` contains a purple fragment from the adjacent character composition at its left edge. Shift and/or reduce this crop so it contains only floral, petal and cloud-pattern decoration.
3. `game-title.png` cuts off the final `传` glyph. Expand or shift the crop to preserve all title glyphs with a small safe margin.

Modify only `scripts/extract-landing-assets.sh` and the regenerated relevant PNGs. Re-run the script, inspect every changed output visually, and run `sips -g format -g pixelWidth -g pixelHeight` on all eight assets. Do not edit React, CSS or tests. Append the fix, visual evidence and commands/results to `.superpowers/sdd/landing-poster-task-2-report.md`. The workspace has no Git metadata; do not attempt a commit.
