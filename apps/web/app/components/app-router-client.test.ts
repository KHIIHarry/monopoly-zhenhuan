import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import {
  ApiError,
  bankTransferApprovalFeedback,
  pendingRealtimeToastInput,
  playerTransferFeedback,
  routeRealtimeToast,
  runGameAction,
} from './app-router-client';

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
  const transferFailed = {
    eventId: 'failed-1',
    roomId: 'room-1',
    audience: 'PLAYER',
    kind: 'TRANSFER_FAILED',
    message: '转账失败：余额不足',
  } as const;

  test('routes a matching rejected event directly with the rejected tone', () => {
    expect(routeRealtimeToast(transferFailed, {
      roomId: 'room-1',
      requestedView: 'PLAYER',
      workbench: { roomId: 'room-1', view: 'PLAYER' },
    }, 7)).toEqual({
      action: 'ENQUEUE',
      toast: {
        id: 'failed-1',
        message: '转账失败：余额不足',
        tone: 'REJECTED',
      },
    });
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

  test('ignores invalid, wrong-room, and wrong-audience events', () => {
    const runtime = {
      roomId: 'room-1',
      requestedView: 'PLAYER' as const,
      workbench: { roomId: 'room-1', view: 'PLAYER' as const },
    };

    expect(routeRealtimeToast({}, runtime, 7)).toEqual({ action: 'IGNORE' });
    expect(routeRealtimeToast({ ...transferFailed, roomId: 'room-2' }, runtime, 7))
      .toEqual({ action: 'IGNORE' });
    expect(routeRealtimeToast({ ...transferFailed, audience: 'BANK' }, runtime, 7))
      .toEqual({ action: 'IGNORE' });
  });

  test('buffers then delivers a matching rejected event with the rejected tone', () => {
    const routed = routeRealtimeToast(transferFailed, {
      roomId: 'room-1',
      requestedView: 'PLAYER',
      workbench: { roomId: 'previous-room', view: 'PLAYER' },
    }, 7);

    expect(routed.action).toBe('BUFFER');
    if (routed.action !== 'BUFFER') throw new Error('expected buffered Toast');
    expect(pendingRealtimeToastInput(routed.pending, {
      generation: 7,
      requestedView: 'PLAYER',
      workbench: { roomId: 'room-1', view: 'PLAYER' },
    })).toEqual({
      id: 'failed-1',
      message: '转账失败：余额不足',
      tone: 'REJECTED',
    });

    expect(pendingRealtimeToastInput(routed.pending, {
      generation: 8,
      requestedView: 'PLAYER',
      workbench: { roomId: 'room-1', view: 'PLAYER' },
    })).toBeNull();
  });
});

describe('authoritative transfer feedback', () => {
  test('returns the write error when the server rejects a mutation', async () => {
    const error = new Error('server rejected write');
    const result = await runGameAction({
      owner: { roomId: 'room-1', view: 'PLAYER', generation: 1 },
      spec: { path: '/rooms/room-1/transfers', body: { amount: 100 } },
      write: async () => ({ ok: false, error }),
      ownsRoom: () => true,
      refreshGame: async () => true,
    });

    expect(result).toEqual({ ok: false, committed: false, error });
  });

  test('keeps the authoritative response when snapshot refresh fails after a write', async () => {
    const confirm = vi.fn();
    const value = { id: 'transfer-1', status: 'EXECUTED' };
    const body = { recipientId: 'player-2', amount: 100 };
    const result = await runGameAction({
      owner: { roomId: 'room-1', view: 'PLAYER', generation: 1 },
      spec: { path: '/rooms/room-1/transfers', body },
      write: async () => ({ ok: true, value, body, confirm }),
      ownsRoom: () => true,
      refreshGame: async () => false,
    });

    expect(result).toEqual({ ok: false, committed: true, value, body });
    expect(confirm).toHaveBeenCalledOnce();
  });

  test('uses committed server status and uncommitted API details for player feedback', () => {
    expect(playerTransferFeedback({
      committed: true,
      value: { id: 'transfer-1', status: 'EXECUTED' },
    }, 'payer')).toEqual({
      committed: true,
      toast: {
        id: 'transfer-1:transfer-result:PLAYER:payer',
        message: '转账已成功，结果已同步至账本',
        tone: 'SUCCESS',
      },
    });

    expect(playerTransferFeedback({
      committed: false,
      error: new ApiError(409, 'INSUFFICIENT_BALANCE', {
        error: 'INSUFFICIENT_BALANCE',
        transferApprovalRequired: true,
      }),
    }, 'payer')).toEqual({
      committed: false,
      toast: {
        message: '转账申请提交失败：余额不足',
        tone: 'REJECTED',
      },
    });
  });

  test('keeps committed approvals successful and exposes rejected approval feedback', () => {
    expect(bankTransferApprovalFeedback({ committed: true }, 'request-1'))
      .toEqual({ committed: true });

    expect(bankTransferApprovalFeedback({
      committed: false,
      error: new ApiError(409, 'INSUFFICIENT_BALANCE', {
        error: 'INSUFFICIENT_BALANCE',
      }),
    }, 'request-1')).toEqual({
      committed: false,
      toast: {
        id: 'request-1:approval-failed:BANK',
        message: '银行审批执行失败：余额不足',
        tone: 'REJECTED',
      },
    });
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

describe('shared player asset overview', () => {
  test('adds the player overview tab and shares one accordion across both views', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain(
      'import { PlayerAssetAccordion } from "./player-asset-overview";',
    );
    expect(component).toMatch(
      /useState<\s*"HOME" \| "OVERVIEW" \| "PROPERTY" \| "LEDGER"\s*>/,
    );
    expect(component).toContain('active={playerTab === "OVERVIEW"}');
    expect(component).toContain('label="概览"');
    expect(component).toContain('onClick={() => setPlayerTab("OVERVIEW")}');
    expect(component).toContain('tab === "OVERVIEW"');
    expect(component.match(/<PlayerAssetAccordion/g)).toHaveLength(2);
    expect(component).not.toContain('function PlayerList(');
  });
});
