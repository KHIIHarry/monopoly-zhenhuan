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
