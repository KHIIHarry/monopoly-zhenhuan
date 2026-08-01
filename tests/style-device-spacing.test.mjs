import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const stylesheet = await readFile(new URL('../apps/web/app/globals.css', import.meta.url), 'utf8');
const appRouter = await readFile(new URL('../apps/web/app/components/app-router-client.tsx', import.meta.url), 'utf8');
const appLayout = await readFile(new URL('../apps/web/app/layout.tsx', import.meta.url), 'utf8');
const landingPicker = await readFile(new URL('../apps/web/app/components/landing-property-card-picker.tsx', import.meta.url), 'utf8');

const quickGridStart = appRouter.indexOf('<div className="quick-grid">');
const quickGridEnd = appRouter.indexOf('</div>', quickGridStart);
const quickGrid = appRouter.slice(quickGridStart, quickGridEnd);

assert.ok(
  quickGrid.indexOf('label="支付过路费"') < quickGrid.indexOf('label="购买 / 建造"')
    && quickGrid.indexOf('label="购买 / 建造"') < quickGrid.indexOf('label="起点奖励"'),
  'The player quick grid must place toll payment before purchase/build and start reward after it.',
);

assert.match(
  stylesheet,
  /\.bank-workbench-header\s*\{[^}]*display:\s*grid;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;[^}]*align-items:\s*center;/s,
  'The bank workbench header must reserve independent room information and action columns.',
);

assert.match(
  stylesheet,
  /\.app-shell\s+header\.bank-workbench-header\s*\{[^}]*display:\s*grid;/s,
  'The bank header grid must override the shared flex header layout.',
);

assert.match(
  stylesheet,
  /@media\s*\(max-width:\s*899px\)\s*\{[\s\S]*?\.app-shell\s+header\.bank-workbench-header\s*\{[^}]*min-height:\s*100px;[^}]*border-bottom-width:\s*3px;/s,
  'Mobile bank header must use the reference-scale title area and gold divider.',
);

assert.match(
  stylesheet,
  /\.bank-workbench-header\s+\.workbench-room-info\s+strong,[\s\S]*?\.bank-workbench-header\s+\.workbench-room-info\s+h1\s*\{[^}]*white-space:\s*nowrap;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s,
  'Bank room information text must never wrap or overlap the action column.',
);

assert.match(
  stylesheet,
  /\.bank-workbench-header\s+\.workbench-room-meta\s+strong\s*\{[^}]*flex:\s*0\s+1\s+auto;/s,
  'The room name must not consume the gap before the adjacent room code.',
);

assert.match(
  stylesheet,
  /@media\s*\(max-width:\s*899px\)\s*\{[\s\S]*?\.bank-workbench-header\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto;[^}]*gap:\s*8px;[\s\S]*?\.bank-workbench-header\s+\.workbench-tools\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*nowrap;[\s\S]*?\.bank-workbench-header\s+\.workbench-tools\s*>\s*button:not\(\.icon\)\s*\{[^}]*min-width:\s*86px;[^}]*min-height:\s*44px;[^}]*font-size:\s*18px;/s,
  'Mobile bank-header actions must remain a reference-sized non-wrapping right column.',
);

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
  /\.workbench-scroll\s*>\s*\.bank-summary:not\(\.toast\)\s*\{[^}]*width:\s*calc\(100%\s*\+\s*var\(--workbench-inline-padding\)\s*\+\s*var\(--workbench-inline-padding\)\);[^}]*margin-left:\s*calc\(0px\s*-\s*var\(--workbench-inline-padding\)\);[^}]*margin-right:\s*calc\(0px\s*-\s*var\(--workbench-inline-padding\)\);/s,
  'The desktop bank summary must extend evenly to both workbench edges.',
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
  /<ActionSheet\s+title=\{currentLanding\?\.status === "DECLARED" \? "更正实体落点" : "声明实体落点"\}\s+className="landing-action-sheet"\s+onClose=\{\(\)\s*=>\s*setPanel\(null\)\}/s,
  'The landing declaration must use its fixed confirmation layout.',
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
  /\.landing-action-sheet\s+\.landing-confirm\s*\{[^}]*width:\s*calc\(100%\s*\+\s*36px\);[^}]*margin:\s*10px\s+-18px;[^}]*border-radius:\s*6px;/s,
  'The landing confirmation must align to the sheet edges while preserving small vertical spacing on every device.',
);

assert.match(
  appRouter,
  /<ActionSheet\s+title=\{currentLanding\?\.status === "DECLARED" \? "更正实体落点" : "声明实体落点"\}\s+className="landing-action-sheet"/s,
  'The landing declaration must opt into the fixed confirmation layout.',
);

assert.match(
  stylesheet,
  /\.landing-action-sheet\s*\{[^}]*overflow:\s*hidden;[^}]*display:\s*grid;[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\);/s,
  'The landing sheet must prevent the outer dialog from scrolling.',
);

assert.match(
  stylesheet,
  /\.landing-action-sheet\s+\.landing-property-grid\s*\{[^}]*min-height:\s*0;[^}]*max-height:\s*none;[^}]*overflow-y:\s*auto;/s,
  'Only the landing property grid may scroll while the confirmation remains visible.',
);

assert.match(
  landingPicker,
  /\{selected\s*&&\s*\(\s*<span\s+className="property-selected-mark"\s+aria-hidden="true">✓<\/span>\s*\)\}/s,
  'Selected landing cards must use a compact check mark.',
);

assert.match(
  stylesheet,
  /\.property-selected-mark\s*\{[^}]*position:\s*absolute;[^}]*font-size:\s*20px;[^}]*pointer-events:\s*none;/s,
  'The selected landing marker must not consume card-title layout space.',
);

assert.match(
  stylesheet,
  /\.landing-property-card:hover:not\(\.selected\)\s*\{[^}]*background:\s*#fff8ec;[\s\S]*?\.landing-property-card\.selected\s*\{[^}]*outline:\s*3px\s+solid\s+var\(--red\);/s,
  'Hover styling must not override the persistent selected landing-card outline.',
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

assert.match(
  stylesheet,
  /\.toast\s*\{[^}]*top:\s*calc\(86px\s*\+\s*env\(safe-area-inset-top\)\);[^}]*width:\s*calc\(100%\s*-\s*8px\);[^}]*pointer-events:\s*none;[^}]*white-space:\s*nowrap;/s,
  'Mobile Toasts must stay below the safe area, stay single-line, and never intercept pointer input.',
);

assert.match(
  stylesheet,
  /@media\s*\(min-width:\s*900px\)\s*\{[\s\S]*?\.toast\s*\{[^}]*top:\s*24px;[^}]*right:\s*24px;[^}]*left:\s*auto;[^}]*transform:\s*none;[^}]*width:\s*min\(680px,\s*calc\(100vw\s*-\s*348px\)\);/s,
  'Desktop Toasts must use the top-right space without covering the 300px navigation sidebar.',
);

assert.match(
  stylesheet,
  /\.toast\s*\{[^}]*width:\s*calc\(100%\s*-\s*8px\);[^}]*gap:\s*6px;[^}]*padding:\s*8px\s+10px;[^}]*border-radius:\s*8px;[^}]*font-size:\s*12px;[^}]*white-space:\s*nowrap;[^}]*animation:\s*toast-enter\s+260ms\s+ease-out\s+both;/s,
  'Mobile Toasts must use the compact single-line entry treatment.',
);

assert.match(
  stylesheet,
  /\.toast-success\s*\{[^}]*color:\s*#174d34;[^}]*background:\s*#e4f2e8;[^}]*border:\s*1px\s+solid\s+var\(--jade\);[^}]*border-radius:\s*8px;/s,
  'Success Toasts must use the approved pale-green treatment.',
);

assert.match(
  stylesheet,
  /\.toast-rejected\s*\{[^}]*color:\s*#8b2730;[^}]*background:\s*#f9e8e9;[^}]*border:\s*1px\s+solid\s+#8b2730;[^}]*border-radius:\s*8px;/s,
  'Rejected Toasts must use the approved pale-red treatment.',
);

assert.match(
  stylesheet,
  /\.toast\s+svg\s*\{[^}]*width:\s*13px;[^}]*height:\s*13px;/s,
  'Toast icons must remain compact on mobile.',
);

assert.match(
  stylesheet,
  /@keyframes\s+toast-enter\s*\{[\s\S]*?from\s*\{[^}]*opacity:\s*0;[^}]*translate:\s*0\s+-12px;[^}]*\}[\s\S]*?to\s*\{[^}]*opacity:\s*1;[^}]*translate:\s*0\s+0;[^}]*\}/s,
  'Toast entry must fade and translate vertically without replacing mobile centering transforms.',
);

assert.match(
  stylesheet,
  /@media\s*\(min-width:\s*900px\)\s*\{[\s\S]*?\.toast\s*\{[^}]*width:\s*min\(680px,\s*calc\(100vw\s*-\s*348px\)\);[^}]*max-width:\s*680px;[^}]*white-space:\s*nowrap;/s,
  'Desktop Toasts must retain a 680px single-line maximum width beside the navigation.',
);

assert.match(
  stylesheet,
  /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?\.toast\s*\{[^}]*animation:\s*none;/s,
  'Toast entry animation must be disabled for reduced-motion users.',
);
