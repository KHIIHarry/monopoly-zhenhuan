import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const componentUrl = new URL('./app-router-client.tsx', import.meta.url);

describe('confirmation dialog', () => {
  test('uses a wave before the confirm-exit label', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/confirmLabel === ["']确认退出["'][\s\S]*?<span aria-hidden="true">👋<\/span>/);
  });

  test('uses the player exit icon for the lobby logout action', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/className="icon"\s*aria-label="退出"\s*title="退出"\s*disabled=\{busy\}\s*onClick=\{\(\) => setLogoutOpen\(true\)\}\s*>\s*<LogIn\s*\/>\s*<\/button>/);
  });

  test('disables super-admin account disable and delete actions in the management drawer', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/title=\{selectedAccount\.isSuperAdmin \? "超级管理员账号不能禁用" : undefined\}[\s\S]*?disabled=\{busy \|\| selectedAccount\.isSuperAdmin\}[\s\S]*?禁用账号/);
    expect(component).toMatch(/title=\{selectedAccount\.isSuperAdmin \? "超级管理员账号不能删除" : undefined\}[\s\S]*?disabled=\{busy \|\| selectedAccount\.isSuperAdmin\}[\s\S]*?删除账号/);
  });
});

describe('bank workbench header', () => {
  test('stacks the bank title under room information and keeps actions separate', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/<header\s+className=\{\s*context\.view === "BANK" \? "bank-workbench-header" : undefined\s*\}/s);
    expect(component).toMatch(/className="workbench-room-info"[\s\S]*?className="workbench-room-meta"[\s\S]*?<strong title=\{snapshot\.name\}>\{snapshot\.name\}<\/strong>[\s\S]*?<small>\{" \\u2022 "\}\{snapshot\.code\}<\/small>[\s\S]*?<h1>银行端<\/h1>/);
    expect(component).not.toContain("审批、轮次与资产管理");
    expect(component).toMatch(/className="workbench-tools"[\s\S]*?管理席位[\s\S]*?aria-label="刷新房间快照"/);
  });
});

describe('property explorer integration', () => {
  test('uses the shared property explorer for player and bank property views', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component.match(/<LandingPropertyCardPicker\s+mode="browse"/g)).toHaveLength(3);
    expect(component.match(/viewerPlayerId=\{me\.id\}/g)).toHaveLength(2);
    expect(component).toContain('mode="landing"');
    expect(component).not.toContain('function PropertyList(');
  });
});

describe('physical dice turn controls', () => {
  test('renders the player turn action only for electronic dice rooms', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/snapshot\.diceMode === "ELECTRONIC" && \(\s*<Quick[\s\S]*?label=\{mustSkipCurrentTurn \? "跳过回合" : "结束回合"\}/);
  });

  test('renders the bank turn-control section only for electronic dice rooms', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/snapshot\.diceMode === "ELECTRONIC" && \(\s*<>\s*<SectionTitle\s+title="轮次控制"[\s\S]*?强制下一位[\s\S]*?<\/section>\s*<\/>\s*\)/);
  });
});

describe('ledger transaction time', () => {
  test('keeps server-newest ledger entries first and renders a second-free timestamp', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/type LedgerEntry = \{[\s\S]*?createdAt\?: string;/);
    expect(component).toMatch(/function formatLedgerTime\(createdAt\?: string\): string \| null/);
    expect(component).toMatch(/month: "long",[\s\S]*?day: "numeric",[\s\S]*?hour: "2-digit",[\s\S]*?minute: "2-digit",[\s\S]*?hour12: false/);
    expect(component).toMatch(/const visible = entries;/);
    expect(component).toMatch(/const transactionTime = formatLedgerTime\(entry\.createdAt\);/);
    expect(component).toMatch(/<time dateTime=\{entry\.createdAt\}>\{transactionTime\}<\/time>/);
  });
});

describe('realtime Toast integration', () => {
  test('validates and role-filters room Toasts into the shared queue', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain('realtimeToastEventSchema.safeParse(payload)');
    expect(component).toMatch(/parsed\.data\.roomId !== runtime\.roomId/);
    expect(component).toMatch(/parsed\.data\.audience !== runtime\.workbench\.view/);
    expect(component).toMatch(/enqueue\(\{\s*id: parsed\.data\.eventId,\s*message: parsed\.data\.message,\s*tone: parsed\.data\.kind === "REQUEST_REJECTED" \? "REJECTED" : "SUCCESS",\s*\}\)/);
    expect(component).toContain('socket.on("room.toast", onRoomToast)');
  });

  test('renders the AppRouter queue item as one passive live-region Toast', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/toast=\{currentToast\}[\s\S]*?showNotice=\{showNotice\}/);
    expect(component).toMatch(/<div\s+key=\{toast\.id\}\s+className=\{`toast toast-\$\{toast\.tone\.toLowerCase\(\)\}`\}\s+role="status"\s+aria-live="polite"\s+aria-atomic="true"\s*>/);
    expect(component).toMatch(/toast\.tone === "REJECTED" \? <CircleX aria-hidden="true" \/> : <Check aria-hidden="true" \/>/);
    expect(component).toMatch(/<span>\{toast\.message\}<\/span>/);
    expect(component).not.toContain('window.setTimeout(() => setNotice(""), 3500)');
    expect(component).not.toMatch(/useEffect\(\(\) => \{\s*useEffect\(\(\) => \(\) => toastQueue\.current\?\.dispose\(\)/);
    expect(component).not.toContain('if (!toastQueue.current) toastQueue.current = createToastQueue(setCurrentToast)');
    expect(component).toMatch(/useEffect\(\(\) => \{\s*const queue = createToastQueue\(setCurrentToast\);\s*toastQueue\.current = queue;[\s\S]*?queue\.dispose\(\);[\s\S]*?toastQueue\.current = null;/);
  });

  test('buffers only the requested role before the workbench is ready', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/const pendingRoomToasts = useRef\(new Map/);
    expect(component).toMatch(/const targetView = runtime\.requestedView;/);
    expect(component).toMatch(/if \(targetView === null \|\| parsed\.data\.audience !== targetView\) return;/);
    expect(component).toMatch(/pendingRoomToasts\.current\.set\(parsed\.data\.eventId, \{\s*event: parsed\.data,\s*generation: roomGeneration\.current,\s*\}\)/);
    expect(component).toMatch(/pending\.generation !== roomGeneration\.current/);
    expect(component).not.toContain('targetView === null || parsed.data.audience === targetView');
  });

  test('buffers a same-role Toast while the retained workbench belongs to another room', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/!runtime\.workbench \|\|\s*runtime\.workbench\.roomId !== parsed\.data\.roomId \|\|\s*runtime\.workbench\.view !== targetView/);
  });

  test('updates the Toast audience when player and bank routes share the game screen', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/\}, \[account\?\.id, roomId, page, screen, workbench\]\);/);
  });
});

describe('room completion regressions', () => {
  test('keeps finish intent until its authoritative settlement has loaded', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');
    const finishRoom = component.slice(
      component.indexOf('async function finishRoom'),
      component.indexOf('async function manageSeats'),
    );

    expect(finishRoom).toMatch(/if \(!result\.ok \|\| !ownsRoom\(owner\)\) return;\s*if \(!\(await fetchSettlement\(owner\)\) \|\| !ownsRoom\(owner\)\) return;\s*go\(roomPath\("settlement", roomId\), true\);\s*result\.confirm\(\);/);
  });

  test('places toll immediately before asset actions in the player quick grid', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');
    const quickGrid = component.slice(
      component.indexOf('<div className="quick-grid">'),
      component.indexOf('<SectionTitle title="我的地产"'),
    );

    const labels = [...quickGrid.matchAll(/label="([^"]+)"/g)].map(
      ([, label]) => label,
    );

    expect(labels.indexOf('支付过路费')).toBe(
      labels.indexOf('资产操作') - 1,
    );
    expect(labels.indexOf('购买 / 建造')).toBe(
      labels.indexOf('资产操作') + 1,
    );
    expect(labels.indexOf('起点奖励')).toBe(
      labels.indexOf('购买 / 建造') + 1,
    );
  });

  test('uses the snapshot companion reward in the approval dialog', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');
    const companionApproval = component.slice(
      component.indexOf('approveTarget.type === "COMPANION_EVENT"'),
      component.indexOf(') : (', component.indexOf('approveTarget.type === "COMPANION_EVENT"')),
    );

    expect(companionApproval).toContain('companionCashReward');
    expect(companionApproval).toContain('formatMoney(');
    expect(companionApproval).not.toContain('自动奖励 500 两');
  });
});
