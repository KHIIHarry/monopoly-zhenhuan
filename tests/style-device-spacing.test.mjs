import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stylesheet = await readFile(new URL('../apps/web/app/globals.css', import.meta.url), 'utf8');
const appRouter = await readFile(new URL('../apps/web/app/components/app-router-client.tsx', import.meta.url), 'utf8');
const appLayout = await readFile(new URL('../apps/web/app/layout.tsx', import.meta.url), 'utf8');
const landingPicker = await readFile(new URL('../apps/web/app/components/landing-property-card-picker.tsx', import.meta.url), 'utf8');

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
  /\.event-actions\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*gap:\s*12px;/s,
  'Physical-event actions must be an evenly spaced two-column grid.',
);

assert.match(
  stylesheet,
  /\.event-actions\s+\.quick\s*\{[^}]*width:\s*100%;[^}]*min-height:\s*112px;/s,
  'Physical-event actions must have equal button dimensions.',
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

assert.match(
  stylesheet,
  /\.workbench-scroll\s*>\s*\.workbench-segment:not\(\.toast\)\s*\{[^}]*width:\s*calc\(100%\s*\+\s*var\(--workbench-inline-padding\)\s*\+\s*var\(--workbench-inline-padding\)\);/s,
  'The desktop workbench view switcher must extend to the same edges as the surrounding information bands.',
);

assert.match(
  stylesheet,
  /@media\s*\(max-width:\s*899px\)\s*\{[\s\S]*?\.admin-tabs\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);[^}]*overflow-x:\s*clip;/s,
  'Mobile admin navigation must keep all four tabs in a fixed non-scrollable row.',
);

assert.match(
  stylesheet,
  /@media\s*\(max-width:\s*899px\)\s*\{[\s\S]*?\.admin-tabs\s*\{[^}]*width:\s*calc\(100%\s*\+\s*32px\);[^}]*margin-inline:\s*-16px;/s,
  'Mobile admin navigation must extend to both viewport edges.',
);

assert.match(
  appRouter,
  /<ActionSheet\s+title="声明实体落点"\s+onClose=\{\(\)\s*=>\s*setPanel\(null\)\}/,
  'The landing declaration must retain the standard sheet position.',
);

assert.match(
  appLayout,
  /themeColor:\s*['"]#ffffff['"]/,
  'The mobile browser toolbar must use a white theme color.',
);

assert.match(
  appRouter,
  /className="primary landing-confirm"[\s\S]*?确认落点/,
  'The landing confirmation must have a dedicated mobile layout hook.',
);

assert.match(
  stylesheet,
  /@media\s*\(max-width:\s*899px\)\s*\{[\s\S]*?\.landing-confirm\s*\{[^}]*width:\s*calc\(100%\s*\+\s*36px\);[^}]*margin:\s*0\s+-18px;/s,
  'The mobile landing confirmation must meet the property picker without gaps and extend to its edges.',
);

assert.match(
  landingPicker,
  /\{selected\s*&&\s*<span\s+className="landing-property-selected-label"\s+aria-hidden="true">✅<\/span>\}/,
  'Selected landing cards must use a compact check-mark emoji.',
);

assert.match(
  stylesheet,
  /\.landing-property-selected-label\s*\{[^}]*position:\s*absolute;[^}]*width:\s*22px;[^}]*height:\s*22px;[^}]*font-size:\s*18px;/s,
  'The selected landing marker must not consume card-title layout space.',
);

assert.match(
  stylesheet,
  /\.landing-property-card:hover:not\(:disabled\):not\(\.selected\)\s*\{[^}]*border-color:\s*var\(--gold\);/s,
  'Hover styling must not override the persistent selected landing-card border.',
);

assert.match(
  appRouter,
  /data\.accounts\.map\([\s\S]*?admin-account-detail-host-\$\{item\.id\}/,
  'Account management must mount directly below the selected account row.',
);

assert.match(
  appRouter,
  /data\.rooms\.map\([\s\S]*?admin-room-detail-host-\$\{room\.id\}/,
  'Room management must mount directly below the selected room row.',
);

assert.match(
  stylesheet,
  /\.admin-row\s*>\s*\.danger-text\s*\{[^}]*grid-column:\s*1\s*\/\s*-1;[^}]*width:\s*100%;/s,
  'Room-member removal actions must span the full member row regardless of asset text length.',
);
