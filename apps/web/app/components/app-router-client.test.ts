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

describe('property explorer integration', () => {
  test('uses the shared property explorer for player and bank property views', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component.match(/<LandingPropertyCardPicker\s+mode="browse"/g)).toHaveLength(3);
    expect(component.match(/viewerPlayerId=\{me\.id\}/g)).toHaveLength(2);
    expect(component).toContain('mode="landing"');
    expect(component).not.toContain('function PropertyList(');
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
    expect(component).toMatch(/parsed\.data\.audience !== runtime\.workbench\?\.view/);
    expect(component).toMatch(/enqueue\(\{ id: parsed\.data\.eventId, message: parsed\.data\.message \}\)/);
    expect(component).toContain('socket.on("room.toast", onRoomToast)');
  });

  test('renders the AppRouter queue item as one passive live-region Toast', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/toast=\{currentToast\}[\s\S]*?showNotice=\{showNotice\}/);
    expect(component).toMatch(/<div className="toast" role="status" aria-live="polite" aria-atomic="true">[\s\S]*?<Check aria-hidden="true" \/>[\s\S]*?<span>\{toast\.message\}<\/span>/);
    expect(component).not.toContain('window.setTimeout(() => setNotice(""), 3500)');
    expect(component).not.toMatch(/useEffect\(\(\) => \{\s*useEffect\(\(\) => \(\) => toastQueue\.current\?\.dispose\(\)/);
    expect(component).not.toContain('if (!toastQueue.current) toastQueue.current = createToastQueue(setCurrentToast)');
    expect(component).toMatch(/useEffect\(\(\) => \{\s*const queue = createToastQueue\(setCurrentToast\);\s*toastQueue\.current = queue;[\s\S]*?queue\.dispose\(\);[\s\S]*?toastQueue\.current = null;/);
  });
});
