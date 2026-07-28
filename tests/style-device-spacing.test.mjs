import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stylesheet = await readFile(new URL('../apps/web/app/globals.css', import.meta.url), 'utf8');
const appRouter = await readFile(new URL('../apps/web/app/components/app-router-client.tsx', import.meta.url), 'utf8');

assert.match(
  stylesheet,
  /\.device-list\s*\+\s*button\s*\{[^}]*margin-top:\s*24px;/s,
  'The logout-others action must have 24px of space above it.',
);

assert.match(
  stylesheet,
  /\.device-list\s*\+\s*button\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*6px;[^}]*background:\s*var\(--red\);[^}]*color:\s*#fff;/s,
  'The logout-others action must use the red rounded-button treatment.',
);

assert.match(
  stylesheet,
  /\.warning-mark\s*\{[^}]*border-radius:\s*8px;/s,
  'Confirmation warning icons must use 8px rounded corners.',
);

assert.match(
  stylesheet,
  /\.admin-create\s*>\s*\.primary\s*\{[^}]*border-radius:\s*8px;[^}]*background:\s*var\(--jade\);[^}]*color:\s*#fff;[^}]*transition:\s*transform\s+150ms\s+ease;/s,
  'The create-account action must use the jade resting treatment.',
);

assert.match(
  stylesheet,
  /\.admin-create\s*>\s*\.primary:hover:not\(:disabled\)\s*\{[^}]*transform:\s*scale\(1\.02\);[^}]*background:\s*var\(--jade\);[^}]*color:\s*#fff;/s,
  'The create-account action must enlarge slightly while retaining its jade color on hover.',
);

assert.match(
  stylesheet,
  /\.lobby-hero\s*\{[^}]*width:\s*calc\(100%\s*\+\s*32px\);[^}]*margin-inline:\s*-16px;[^}]*background:\s*var\(--red\);/s,
  'The lobby account header must be a full-bleed palace-red banner.',
);

assert.match(
  stylesheet,
  /\.admin-page\s*>\s*\.admin-tabs\s*\{[^}]*position:\s*fixed;[^}]*width:\s*300px;[^}]*height:\s*100dvh;[^}]*flex-direction:\s*column;/s,
  'The desktop admin navigation must become a full-height 300px left sidebar.',
);

assert.match(
  appRouter,
  /<AdminView\s+account=\{account\}/,
  'The admin view must receive the current account for its desktop navigation identity.',
);

assert.match(
  stylesheet,
  /\.admin-page\s*>\s*\.v2-header\s+\.room-list-back\s*\{[^}]*position:\s*fixed;[^}]*bottom:\s*28px;[^}]*margin-top:\s*auto;/s,
  'The desktop room-list action must sit at the bottom of the left navigation.',
);

assert.match(
  stylesheet,
  /\.desktop-nav-identity\s+strong\s*\{[^}]*font-weight:\s*700;/s,
  'The desktop workbench identity title must use a bold weight.',
);

assert.match(
  stylesheet,
  /\.turn-strip\s*\{[^}]*padding:\s*11px\s+32px\s+11px\s+24px;/s,
  'Workbench turn information must leave additional space from both viewport edges.',
);
