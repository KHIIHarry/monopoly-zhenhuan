# Create Room Desktop Grid Design

## Goal

Make the room creation form use the available desktop width without changing
the mobile interaction flow. Give the room-list return action a consistent
outlined treatment on both desktop and mobile.

## Layout

- At desktop widths, the creation form becomes a three-column grid.
- Each room-setting control occupies one grid cell in source order: room name,
  password, initial balance, start reward, dice mode, visibility, and the four
  switch rows.
- The return action, page heading, validation message, and submit action span
  all columns so their hierarchy remains clear.
- The dice mode control stays as a two-choice segment inside its own grid cell.
- At mobile widths, the form returns to a single column with the existing
  source order and touch target sizes.

## Return Action

- The create-room return action is labelled `🔙 房间列表`.
- It has a single, visible outline and no filled background in its default
  state.
- The same styling applies at all viewport widths.

## Verification

- Add a browser regression check for the desktop three-column layout, the
  single-column mobile layout, and the return action label/style.
- Run the focused browser test and the project type check.
