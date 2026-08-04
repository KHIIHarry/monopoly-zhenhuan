import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, test, vi } from 'vitest';
import {
  ApiError,
  bankTransferApprovalFeedback,
  hasRoomCapability,
  pendingRealtimeToastInput,
  playerTransferFeedback,
  routeRealtimeToast,
  runGameAction,
} from './app-router-client';

const componentUrl = new URL('./app-router-client.tsx', import.meta.url);
const seatsPageUrl = new URL('../rooms/[roomId]/seats/page.tsx', import.meta.url);

function sourceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, startMarker).toBeGreaterThanOrEqual(0);
  expect(end, endMarker).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('confirmation dialog', () => {
  test('describes room removal as archival rather than permanent deletion', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain('title: "归档房间"');
    expect(component).toContain('fieldLabel: "确认归档房间"');
    expect(component).toContain('房间将停止操作并保留不可删除的账本与审计记录');
    expect(component).not.toContain('${selectedRoom.name} 的全部房间数据将被永久清除，且无法恢复。');
  });

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

describe('admin room trash state', () => {
  test('loads trash on the rooms tab and after an admin reload', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');
    const adminView = sourceBetween(component, 'function AdminView(', 'function BankView(');
    const loadTrashRooms = sourceBetween(
      adminView,
      'async function loadTrashRooms()',
      'async function reloadAdmin()',
    );
    const reloadAdmin = sourceBetween(
      adminView,
      'async function reloadAdmin()',
      'useEffect(() => {\n    if (tab !== "ROOMS")',
    );

    expect(adminView).toContain('const [trashRooms, setTrashRooms] = useState<AdminTrashRoom[]>([])');
    expect(adminView).toContain('loadAllPages<AdminTrashRoom>("/api/admin/rooms/trash")');
    expect(loadTrashRooms).toContain('trashLoader.load()');
    expect(loadTrashRooms).not.toContain('runAction');
    expect(reloadAdmin).toMatch(
      /return reloadAdminWithTrash\(\s*onReload,\s*loadTrashRooms,\s*trashTabActive,?\s*\)/,
    );
    expect(reloadAdmin).not.toContain('tab === "ROOMS"');
  });

  test('closes trash and stops its clock immediately outside the rooms tab', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');
    const adminView = sourceBetween(component, 'function AdminView(', 'function BankView(');
    const roomsEffect = sourceBetween(
      adminView,
      'useEffect(() => {\n    if (tab !== "ROOMS")',
      '  }, [tab]);',
    );

    expect(adminView).toContain('const [trashOpen, setTrashOpen] = useState(false)');
    expect(adminView).toContain('const [trashNowMs, setTrashNowMs] = useState(() => Date.now())');
    expect(adminView).toContain('const trashTabActive = useRef(false)');
    expect(roomsEffect).toMatch(/if \(tab !== "ROOMS"\) \{[\s\S]*?trashTabActive\.current = false;[\s\S]*?setTrashOpen\(false\);[\s\S]*?trashLoader\.invalidate\(\);[\s\S]*?return;/);
    expect(roomsEffect).toMatch(/trashTabActive\.current = true;[\s\S]*?void loadTrashRooms\(\)/);
    expect(roomsEffect).toMatch(
      /window\.setInterval\(\s*\(\) => setTrashNowMs\(Date\.now\(\)\),\s*60_000,?\s*\)/,
    );
    const cleanup = sourceBetween(
      roomsEffect,
      'return () => {',
      '    };',
    );
    expect(cleanup).toContain('trashTabActive.current = false');
    expect(cleanup).toContain('trashLoader.invalidate()');
    expect(cleanup).toContain('window.clearInterval(trashTimer)');
  });

  test('restores and permanently deletes through the stable writer', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');
    const adminView = sourceBetween(component, 'function AdminView(', 'function BankView(');
    const restore = sourceBetween(
      adminView,
      'async function restoreTrashRoom(roomId: string)',
      'async function permanentlyDeleteTrashRoom(roomId: string)',
    );
    const permanent = sourceBetween(
      adminView,
      'async function permanentlyDeleteTrashRoom(roomId: string)',
      '// Task 7 consumes this state',
    );

    expect(restore).toContain('path: `/api/admin/rooms/${roomId}/restore`');
    expect(restore).toContain('method: "POST"');
    expect(restore).toContain('completeTrashWrite(');
    expect(permanent).toContain('path: `/api/admin/rooms/${roomId}/permanent`');
    expect(permanent).toContain('method: "DELETE"');
    expect(permanent).toContain('completeTrashWrite(');
  });
});

describe('workbench headers', () => {
  test('uses the same mobile header structure for bank and player workbenches', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/<header\s+className="bank-workbench-header">/);
    expect(component).toMatch(/className="workbench-room-info"[\s\S]*?className="workbench-room-meta"[\s\S]*?<strong title=\{snapshot\.name\}>\{snapshot\.name\}<\/strong>[\s\S]*?<small>\{" \\u2022 "\}\{snapshot\.code\}<\/small>/);
    expect(component).toContain('aria-label={context.view === "PLAYER" ? "玩家端" : "银行端"}');
    expect(component).toContain('{context.view === "PLAYER" ? playerName : "银行端"}');
    expect(component).not.toContain("审批、轮次与资产管理");
    expect(component).toMatch(/className="workbench-tools"[\s\S]*?className="workbench-tool-seat"[\s\S]*?aria-label="管理席位"[\s\S]*?<Users\s*\/>[\s\S]*?<RefreshButton\s+label="刷新房间快照"[\s\S]*?className="icon workbench-leave-mobile"[\s\S]*?aria-label="退出房间"[\s\S]*?<LogOut\s*\/>/);
    expect(component).toMatch(/<Nav\s+className="workbench-leave-nav"[\s\S]*?icon=\{<LogIn\s*\/>\}[\s\S]*?label="退出"/);
  });
});

describe('workbench selector routing', () => {
  test('renders the selector only for memberships with both player and bank capabilities', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(
      /screen === "WORKBENCH_SELECT" &&\s*seats\?\.membership &&\s*hasRoomCapability\(seats\.membership, "player"\) &&\s*hasRoomCapability\(seats\.membership, "bank"\)/,
    );
  });
});

describe('seat management return action', () => {
  test('returns joined members to their current workbench and keeps room-list exit for unjoined members', async () => {
    const [component, seatsPage] = await Promise.all([
      readFile(fileURLToPath(componentUrl), 'utf8'),
      readFile(fileURLToPath(seatsPageUrl), 'utf8'),
    ]);

    expect(component).not.toContain('useSearchParams');
    expect(component).toContain('seatsReturnView?: "player" | "bank";');
    expect(seatsPage).toContain("searchParams: Promise<{ returnTo?: string | string[] }>");
    expect(seatsPage).toMatch(/requestedReturn === 'player'[\s\S]*?requestedReturn === 'bank'/);
    expect(seatsPage).toContain('seatsReturnView={seatsReturnView}');
    expect(component).toContain('`${roomPath("seats", workbench.roomId)}?returnTo=${workbench.view === "PLAYER" ? "player" : "bank"}`');
    expect(component).toMatch(/const returnToWorkbench =\s*seats &&\s*seatsReturnView &&\s*hasRoomCapability\(seats\.membership, seatsReturnView\)\s*\? \(\) => go\(roomPath\(seatsReturnView, seats\.room\.id\)\)\s*:\s*undefined;/s);
    expect(component).toContain('onReturnToRoom={returnToWorkbench}');
    expect(component).toMatch(/onReturnToRoom \? \(\s*<button\s+className="icon subtle"\s+aria-label="返回当前房间"[\s\S]*?<ArrowLeft\s*\/>[\s\S]*?\) : \(\s*<button onClick=\{onBack\}>房间列表<\/button>/);
  });

  test('accepts return targets only when the current membership has that capability', async () => {
    const player = { characterId: 'zhenhuan', playerId: 'player-1', isBank: false };
    const bank = { characterId: null, playerId: null, isBank: true };
    const dual = { ...player, isBank: true };

    expect(hasRoomCapability(player, 'player')).toBe(true);
    expect(hasRoomCapability(player, 'bank')).toBe(false);
    expect(hasRoomCapability(bank, 'bank')).toBe(true);
    expect(hasRoomCapability(bank, 'player')).toBe(false);
    expect(hasRoomCapability(dual, 'player')).toBe(true);
    expect(hasRoomCapability(dual, 'bank')).toBe(true);
    expect(
      hasRoomCapability(
        { characterId: 'zhenhuan', playerId: null, isBank: false },
        'player',
      ),
    ).toBe(false);
    expect(hasRoomCapability(null, 'bank')).toBe(false);
    expect(hasRoomCapability(dual, undefined)).toBe(false);
  });
});

describe('manual refresh feedback', () => {
  test('uses a local two-turn refresh control with success notices', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain('function RefreshButton(');
    expect(component).toContain('className="refresh-two-turns"');
    expect(component).toContain('notice="房间快照已刷新"');
    expect(component).toContain('notice="席位信息已刷新"');
    expect(component).toContain('notice="后台数据已刷新"');
  });
});

describe('landing confirmation status', () => {
  test('restores the current landing from the room snapshot', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain('selectCurrentLanding(snapshot.landings');
    expect(component).toContain('? "落点待银行确认"');
    expect(component).toContain('? "本次落点"');
    expect(component).toContain(': "上次确认落点"');
    expect(component).not.toContain('trustedLandings');
    expect(component).not.toContain('setTrustedLandings');
  });
});

describe('seat swap requests', () => {
  test('lets members request the occupied bank seat through the role-swap endpoint', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/body: target,/);
    expect(component).toMatch(/const canRequestRoleSwap = seats\.room\.status === "LOBBY"/);
    expect(component).toMatch(/canRequestRoleSwap && !own[\s\S]*?className="swap-request"[\s\S]*?onClick=\{\(\) => void onSwap\(\{ targetCharacterId: character\.id \}\)\}/);
    expect(component).toMatch(/canRequestRoleSwap && !seats\.membership\?\.isBank[\s\S]*?className="swap-request"[\s\S]*?onClick=\{\(\) => void onSwap\(\{ targetRole: "BANK" \}\)\}/);
  });
});

describe('mobile landing approval layout', () => {
  test('marks landing approvals for their independent action layout', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain('className="approval-list landing-approval-list payment-approval-list"');
  });

  test('places the landing player nickname below the location icon', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/className="landing-location-meta"[\s\S]*?<MapPin\s*\/>[\s\S]*?className="landing-player-nickname"[\s\S]*?\{landingPlayer\?\.name \?\? "未知玩家"\}[\s\S]*?<\/div>\s*<div className="landing-approval-details"/);
  });

  test('stacks the landed property owner below its name after the landing character', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain('const landedProperty = properties.find(');
    expect(component).toContain('const landedPropertyOwner = players.find(');
    expect(component).toMatch(
      /className="landing-location-meta"[\s\S]*?实体落点[\s\S]*?<MapPin\s*\/>/,
    );
    expect(component).toContain('className={`landing-approval-title-line property-theme-${landedPropertyOwner?.characterId ?? "unowned"}`}');
    expect(component).toContain('landing-approval-character');
    expect(component).toContain('className="landing-approval-arrow"');
    expect(component).toMatch(/className="landing-approval-arrow"[^>]*>\s*→\s*<\/span>/);
    expect(component).toContain(
      'className="landing-approval-property-name"',
    );
    expect(component).not.toContain('className={`landing-approval-property property-theme-');
    expect(component).toMatch(
      /className="landing-approval-property-name"[\s\S]*?landing\.propertyName \?\? landing\.spaceType[\s\S]*?className="landing-approval-property-owner"[\s\S]*?\[/,
    );
    expect(component).toContain('characterName(landedPropertyOwner.characterId)');
    expect(component).toContain(': "无主"');
  });
});

describe('approval action controls', () => {
  test('uses icon-only confirmation and rejection actions throughout approval cards', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/className="approval-action approval-action-confirm"[\s\S]*?aria-label="确认已结算剧情"[\s\S]*?<Check\s*\/>/);
    expect(component).toMatch(/className="approval-action approval-action-reject"[\s\S]*?aria-label="取消地产操作"[\s\S]*?<X\s*\/>/);
    expect(component).toMatch(/className="approval-action approval-action-confirm"[\s\S]*?aria-label=\{requestActionLabel\("批准", request\)\}[\s\S]*?<Check\s*\/>/);
    expect(component).toMatch(/className="approval-action approval-action-reject"[\s\S]*?aria-label=\{requestActionLabel\("拒绝", request\)\}[\s\S]*?<X\s*\/>/);
  });

  test('uses the landing-card layout and amount annotation for bank approvals', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/className="approval-list landing-approval-list payment-approval-list"[\s\S]*?className="payment-approval-meta"[\s\S]*?<Banknote\s*\/>[\s\S]*?className="payment-approval-details"/);
    expect(component).toContain('const approvalAmount = approvalAmountDelta(request);');
    expect(component).toMatch(/className=\{`approval-action-amount \$\{approvalAmount < 0 \? "debit" : "credit"\}`\}[\s\S]*?\{approvalAmount > 0 \? "\+" : ""\}[\s\S]*?\{formatMoney\(approvalAmount\)\}/);
  });

  test('adds the themed character name after every payment approval nickname', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/player\?\.characterId && \([\s\S]*?className=\{`payment-approval-character character-\$\{player\.characterId\}`\}[\s\S]*?（\{characterName\(player\.characterId\)\}）/);
    expect(component).not.toContain('request.type === "PLAYER_TRANSFER" && player?.characterId');
  });
});

describe('unified bank pending approvals', () => {
  test('uses the same complete chronological section in summary and approval tabs', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toMatch(/type BankRequest = \{[\s\S]*?createdAt\?: string;/);
    expect(component).toMatch(/type Landing = \{[\s\S]*?createdAt\?: string;/);
    expect(component).toContain('const pendingApprovals = mergePendingApprovals(pending, pendingLandings);');
    expect(component.match(/<PendingApprovalSection/g)).toHaveLength(2);
    expect(component).not.toContain('pending.slice(0, 2)');
    expect(component).not.toContain('title="待确认落点"');
    expect(component).not.toContain('title="待审批请求"');
    expect(component).toContain('formatApprovalSubmittedAt(item.createdAt)');
    expect(component).toContain('当前没有待审批事项');
  });
});

describe('start reward submission', () => {
  test('uses the existing declaration button for one approval and keeps the bank amount under its checkmark', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');
    const startFlow = component.slice(
      component.indexOf('async function declareStartLanding'),
      component.indexOf('async function confirmTrade'),
    );
    const startSheet = component.slice(
      component.indexOf('{panel === "START"'),
      component.indexOf('{panel === "PROPERTY"'),
    );
    const approvalSection = component.slice(
      component.indexOf('function PendingApprovalSection'),
      component.indexOf('function approvalDetails'),
    );

    expect(startFlow).toContain('起点 ${formatMoney(snapshot.startReward)} 两申请已提交银行审批');
    expect(startFlow).not.toContain('async function requestStartReward');
    expect(startSheet).toContain('声明停留起点');
    expect(startSheet).not.toContain('等待银行确认起点落点');
    expect(startSheet).not.toContain('银行已确认本轮精确停留起点');
    expect(approvalSection).toMatch(/<Check \/>[\s\S]*?\{approvalAmount > 0 \? "\+" : ""\}[\s\S]*?\{formatMoney\(approvalAmount\)\}/);
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

  test('keeps a committed write successful when its snapshot refresh is superseded', async () => {
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

    expect(result).toEqual({
      ok: true,
      committed: true,
      snapshotRefreshed: false,
      value,
      body,
    });
    expect(confirm).toHaveBeenCalledOnce();
  });

  test('uses committed success semantics for non-transfer actions after a stale refresh', async () => {
    const paths = [
      '/api/rooms/room-1/bank/adjust-balance',
      '/api/rooms/room-1/requests/bank-payment',
      '/api/rooms/room-1/landings/start',
      '/api/rooms/room-1/events/cold-palace',
    ];

    for (const path of paths) {
      const body = { playerId: 'player-1', amount: 100 };
      const result = await runGameAction({
        owner: { roomId: 'room-1', view: 'PLAYER', generation: 1 },
        spec: { path, body },
        write: async () => ({
          ok: true as const,
          value: { path },
          body,
          confirm: vi.fn(),
        }),
        ownsRoom: () => true,
        refreshGame: async () => false,
      });

      expect(result, path).toMatchObject({
        ok: true,
        committed: true,
        snapshotRefreshed: false,
      });
    }
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
  test('reconciles members removed when a room starts without changing generic subscription recovery', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');
    const handler = component.slice(
      component.indexOf('const onRoomSubscriptionLost'),
      component.indexOf('const onRoomToast'),
    );

    expect(component).toMatch(/const ROOM_STARTED_WITHOUT_CAPABILITY_MESSAGE =\s*"游戏已开始，你因未选择人物或银行身份已退出房间";/);
    expect(handler).toContain('{ roomId?: unknown; reason?: unknown }');
    expect(handler).toMatch(/notification\?\.reason === "ROOM_STARTED_WITHOUT_CAPABILITY"[\s\S]*?clearRoomState\(\);[\s\S]*?go\("\/rooms\?reason=room-started-without-capability", true\);[\s\S]*?loadRooms\(\)/);
    expect(handler).toMatch(/snapshotRequestGeneration\.current \+= 1;\s*refresh\(\);/);
  });

  test('keys route errors and admin keyboard focus to the target URL', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).not.toMatch(/let pendingRouteError|let pendingAdminTabFocus|let suppressNextRouteHeadingFocus/);
    expect(component).toMatch(/page === "login" && reason === "session-invalid"[\s\S]*?SESSION_INVALID_MESSAGE/);
    expect(component).toMatch(/page === "rooms" && reason === "room-started-without-capability"[\s\S]*?ROOM_STARTED_WITHOUT_CAPABILITY_MESSAGE/);
    expect(component).toMatch(/setError\(routeError\);[\s\S]*?window\.history\.replaceState\(\s*window\.history\.state,\s*"",\s*window\.location\.pathname,?\s*\)/);
    expect(component).toContain('go("/login?reason=session-invalid", true);');
    expect(component).toMatch(/screen === "ADMIN"[\s\S]*?return;/);
    expect(component).toMatch(/focusAdminTab[\s\S]*?new URLSearchParams\(window\.location\.search\)\.get\("focus"\) === "tab"[\s\S]*?window\.requestAnimationFrame[\s\S]*?admin-tab-\$\{initialTab\.toLowerCase\(\)\}[\s\S]*?window\.history\.replaceState\(\s*window\.history\.state,\s*"",\s*window\.location\.pathname,?\s*\)/);
    expect(component).toMatch(/onTab\(next, focus\)/);
    expect(component).toMatch(/focus \? `\$\{path\}\?focus=tab` : path/);
  });

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

describe('authoritative room admission', () => {
  test('uses summary admission independently from lifecycle badges and blocked navigation', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain('canJoin: boolean;');
    expect(component).toContain('joinBlockedReason:');
    expect(component).toContain('availableCharacters: Array<{ id: string; name: string }>');
    expect(component).toContain('label: "已加入" | "可加入" | "不可加入" | "准备中" | "游戏中" | "已结束";');
    expect(component).toMatch(/const accessBadge = room\.mine[\s\S]*?room\.canJoin[\s\S]*?label: "不可加入"[\s\S]*?tone: "unavailable"/);
    expect(component).toMatch(/if \(!room\.mine && !terminalRoom\(room\.status\) && !room\.canJoin\)[\s\S]*?setError\(code \? API_ERROR_MESSAGES\[code\] : "当前无法加入该房间"\);[\s\S]*?return;/);
  });

  test('submits one join object and refreshes summaries after stale character conflicts', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain('type JoinRoomInput = { password?: string; characterId?: string };');
    expect(component).toContain('onJoin: (input: JoinRoomInput) => void;');
    expect(component).toContain('room.availableCharacters.map((character) => (');
    expect(component).toMatch(/body: input,/);
    expect(component).toMatch(/ROLE_ALREADY_TAKEN[\s\S]*?PLAYER_LIMIT[\s\S]*?loadRooms\(owner\)[\s\S]*?setSelectedRoom\(items\.find\(\(room\) => room\.id === roomId\) \?\? null\)/);
    expect(component).toContain('selectedRoom.members.map((member) => (');
  });

  test('uses the exact admission messages', async () => {
    const component = await readFile(fileURLToPath(componentUrl), 'utf8');

    expect(component).toContain('MIDGAME_JOIN_DISABLED: "房间已开局，且不允许中途加入。"');
    expect(component).toContain('PLAYER_LIMIT: "房间人物已满，暂时无法加入。"');
    expect(component).toContain('ROLE_ALREADY_TAKEN: "所选人物刚刚已被其他玩家选择，请重新选择。"');
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
