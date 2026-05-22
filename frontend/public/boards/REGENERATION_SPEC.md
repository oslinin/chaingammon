# Gemini Board Regeneration Spec

The four `gemini_board_N.png` files in this directory must be **empty boards** (no checkers depicted) and must conform to the SVG playing grid below, otherwise checkers placed by `app/Board.tsx` will not visually land on the painted point triangles.

## Output requirements

- **Aspect ratio:** exactly `716 : 440` (≈ 1.627 : 1). Avoid 16:9, 3:2 defaults.
- **Recommended resolution:** 1432 × 880 (2×) so it stays crisp on retina displays.
- **No checkers, no dice, no decals** inside the play area. Just the board itself.
- **No text** (no "ROLL DICE", no logos, no point numbers — `Board.tsx` overlays its own labels).

## Required layout (proportions of total image)

The SVG coordinate grid in `Board.tsx`:

| Element | px (of 716×440) | fraction of width / height |
|---|---|---|
| Outer frame thickness | 20 px on all sides | 2.79% w / 4.55% h |
| Left bear-off tray | x = 20, w = 48 | 2.79–9.50% w |
| Left point quadrant (6 points) | x = 68, w = 264 | 9.50–46.37% w |
| Center bar | x = 332, w = 52 | 46.37–53.63% w |
| Right point quadrant (6 points) | x = 384, w = 264 | 53.63–90.50% w |
| Right bear-off tray | x = 648, w = 48 | 90.50–97.21% w |
| Each point column | w = 44 | 6.15% w |
| Point triangle height | 180 px | 40.91% h |

The 12 top points and 12 bottom points must align vertically to those 6.15%-wide columns inside each quadrant. Triangles extend ~41% of board height from their respective base toward the center.

## Per-theme prompts

Feed each prompt below to Gemini (or any image generator) along with the layout requirements above. State **explicitly** that no checkers should appear.

### gemini_board_1.png — Walnut Classic
> Empty backgammon board, top-down view, dark walnut wood frame and bar, cream felt play area, cream and crimson alternating point triangles, traditional pub/lounge style. No checkers, no dice, no text, no logos. Aspect ratio 716:440.

### gemini_board_2.png — Overhead Wood
> Empty backgammon board, top-down photographic view, honey-colored hardwood frame with visible grain, dark green felt play surface, light wood and dark green alternating triangles, natural lighting. No checkers, no dice, no text, no logos. Aspect ratio 716:440.

### gemini_board_3.png — Cyber Arena
> Empty backgammon board, top-down view, sci-fi cyberpunk style, brushed metal frame, dark glass play surface, glowing neon orange and electric blue triangles, holographic accents. No checkers, no dice, no text, no logos. Aspect ratio 716:440.

### gemini_board_4.png — Steampunk Brass
> Empty backgammon board, top-down view, steampunk style, aged brass and copper frame with riveted plates, dark leather play surface, brass and oxidized-copper alternating triangles, subtle gear detailing only on outer frame (never in play area). No checkers, no dice, no text, no logos. Aspect ratio 716:440.

## Replacement workflow

1. Generate the four PNGs to the spec above.
2. Overwrite the files in this directory using the same filenames (`gemini_board_1.png` … `gemini_board_4.png`).
3. No code changes needed — `boardThemes.ts` already references these paths.

## Verification

After replacement, start the dev server and visit `/team-demo`. For each theme:
- The painted triangles in the image should sit directly under the SVG point click targets.
- Starting-position checkers should sit centered on the painted triangles.
- After moves, no painted "ghost" checkers should remain visible.
