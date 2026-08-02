"use client";

import {
  FormEvent,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  realtimeToastEventSchema,
  type RealtimeToastEvent,
} from "@zhenhuan/shared";
import { LandingPoster } from "./landing/landing-poster";
import { LandingPropertyCardPicker } from "./landing-property-card-picker";
import { PlayerAssetAccordion } from "./player-asset-overview";
import { createToastQueue, type ToastInput, type ToastItem } from "./toast-queue";
import {
  bankApprovalFailureToast,
  toastToneForRealtimeKind,
  transferFailureToast,
  transferSuccessToast,
  type TransferResult,
} from "./transfer-toast-feedback";
import { useRouter } from "next/navigation";
import { io } from "socket.io-client";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowLeftRight,
  Banknote,
  BookOpen,
  Building2,
  Check,
  ChevronRight,
  CircleX,
  CircleMinus,
  CircleDollarSign,
  Crown,
  Dices,
  FileCheck2,
  History,
  Home as HomeIcon,
  Landmark,
  LoaderCircle,
  LogIn,
  MapPin,
  PackageMinus,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";

const API = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

const characters = [
  { id: "zhenhuan", name: "钮祜禄·甄嬛" },
  { id: "yixiu", name: "乌拉那拉·宜修" },
  { id: "huashifei", name: "年世兰" },
  { id: "meizhuang", name: "沈眉庄" },
  { id: "anlingrong", name: "安陵容" },
] as const;

type Player = {
  id: string;
  name: string;
  characterId: string | null;
  balance: number;
  remainingSkipTurns: number;
  companionCashReward?: number;
  buildDiscount?: number;
  tollBonus?: number;
  coldPalaceSkipReduction?: number;
  coldPalaceCashReward?: number;
  plotFineReduction?: number;
  tollCollectionBlocked?: boolean;
};

type Property = {
  name: string;
  ownerId: string | null;
  level: number;
  mortgaged: boolean;
  mortgage: number;
  purchasePrice: number;
  build: number;
  buildingSell: number;
  tolls: number[];
};

type LedgerEntry = {
  id: string;
  playerId: string;
  type: string;
  description: string;
  amount: number;
  createdAt?: string;
};

type BankRequest = {
  id: string;
  type: string;
  playerId: string;
  targetPlayerId?: string | null;
  propertyName?: string;
  quantity?: number;
  note?: string | null;
  amount: number;
  status: string;
  buyerConfirmed?: boolean;
  recipientType?: "PLAYER" | "BANK";
  originalAmount?: number;
  reduction?: number;
  actualAmount?: number;
  isPlotFine?: boolean;
};

type AuditEntry = {
  id: string;
  action: string;
  reason?: string | null;
  actorRole?: string;
  createdAt?: string;
};

type Landing = {
  id: string;
  playerId: string;
  propertyName?: string;
  spaceType: string;
  status: "DECLARED" | "CONFIRMED";
  plotResolved: boolean;
  propertyActionsCancelled: boolean;
  tollSettled?: boolean;
  turnId?: string;
};

type ReversalCandidate = {
  id: string;
  type: string;
  createdAt: string;
  effects: Array<{ playerId: string; amount: number }>;
};

type Snapshot = {
  id: string;
  stateVersion: number;
  code: string;
  name: string;
  status: "LOBBY" | "PLAYING" | "ENDED" | "FINISHED";
  diceMode: "ELECTRONIC" | "PHYSICAL";
  redemptionFee: number;
  startReward: number;
  currentPlayerId?: string;
  turn?: {
    id?: string;
    number?: number;
    playerId?: string;
    dice?: [number, number];
    total?: number;
  } | null;
  players: Player[];
  properties: Property[];
  ledger: LedgerEntry[];
  requests: BankRequest[];
  landings?: Landing[];
  audit?: AuditEntry[];
  reversalCandidate: ReversalCandidate | null;
};

type PropertyAdjustment = {
  propertyName: string;
  ownerPlayerId: string | null;
  buildingLevel: number;
  mortgaged: boolean;
  reason: string;
};

type BalanceAdjustment = {
  playerId: string;
  amount: number;
  reason: string;
};

type SkipAdjustment = {
  playerId: string;
  count: number;
  source: string;
  reason: string;
};

type SkipConsumption = {
  playerId: string;
  count: number;
  reason: string;
};

type IdempotentBody = Record<string, unknown>;
type WriteBody = IdempotentBody | undefined;
type RoomOwner = { roomId: string; generation: number };
type RoomActionOwner = RoomOwner & { view: "PLAYER" | "BANK" };
type RunResult<T> = { ok: true; value: T } | { ok: false; error?: unknown };
type TaskRunner = <T>(
  task: () => Promise<T>,
  owner?: RoomOwner,
) => Promise<RunResult<T>>;
type StableWriteSpec<B extends WriteBody = WriteBody> = {
  path: string;
  method?: string;
  body?: B;
  intentKey?: string;
  createBody?: () => B;
};
type StableWriteResult<T, B extends WriteBody = WriteBody> =
  | { ok: true; value: T; body: B; confirm: () => void }
  | { ok: false; error?: unknown };
type StableWriteOptions = { owner?: RoomOwner };
type StableWriter = <T = unknown, B extends WriteBody = WriteBody>(
  spec: StableWriteSpec<B>,
  options?: StableWriteOptions,
) => Promise<StableWriteResult<T, B>>;
type RoomActionResult<T, B extends WriteBody> =
  | { ok: true; value: T; body: B; committed: true }
  | { ok: false; value: T; body: B; committed: true }
  | { ok: false; committed: false; error?: unknown };
type ActionRunner = <T = unknown, B extends WriteBody = WriteBody>(
  spec: StableWriteSpec<B>,
) => Promise<RoomActionResult<T, B>>;
type PendingWriteIntent = { key: string; body: WriteBody; payload?: string };
type PendingRoomToast = { event: RealtimeToastEvent; generation: number };

export async function runGameAction<T = unknown, B extends WriteBody = WriteBody>({
  owner,
  spec,
  write,
  ownsRoom,
  refreshGame,
}: {
  owner: RoomActionOwner;
  spec: StableWriteSpec<B>;
  write: (
    spec: StableWriteSpec<B>,
    options?: StableWriteOptions,
  ) => Promise<StableWriteResult<T, B>>;
  ownsRoom: (owner: RoomActionOwner) => boolean;
  refreshGame: (owner: RoomActionOwner) => Promise<boolean>;
}): Promise<RoomActionResult<T, B>> {
  const result = await write(spec, { owner });
  if (!result.ok) return { ...result, committed: false };
  if (!ownsRoom(owner)) {
    result.confirm();
    return { ok: false, committed: true, value: result.value, body: result.body };
  }
  if (!(await refreshGame(owner))) {
    result.confirm();
    return { ok: false, committed: true, value: result.value, body: result.body };
  }
  result.confirm();
  return { ok: true, committed: true, value: result.value, body: result.body };
}

const pendingWriteIntents = new Map<string, PendingWriteIntent>();

const API_ERROR_MESSAGES: Record<string, string> = {
  AUTH_REQUIRED: "请先登录账号",
  INVALID_CREDENTIALS: "用户名或密码不正确",
  SESSION_INVALID: "登录已失效，请重新登录",
  SESSION_LIMIT_REACHED: "当前账号已在2台设备登录",
  ROOM_PASSWORD_INVALID: "房间密码不正确",
  ROOM_CREATE_FORBIDDEN: "当前账号没有创建房间权限",
  ROOM_MEMBERSHIP_REQUIRED: "请先加入该房间",
  ROOM_CONTROL_LOST: "该房间已在另一台设备打开",
  ROLE_ALREADY_TAKEN:
    "该角色刚刚已被其他玩家选择，当前页面信息可能已过期，请刷新页面后重新加入房间。",
  BANK_ALREADY_TAKEN: "银行席位刚刚已被其他成员选择，请刷新页面后重试。",
  ACCOUNT_CHARACTER_LIMIT_REACHED:
    "每个账号在同一房间最多选择一名人物；如需更换，请申请角色交换。",
  ROOM_FINISHED: "该房间已经结束",
  SETTLEMENT_BLOCKED: "仍有未完成事项，暂时不能结束游戏",
  FINISH_CONFIRMATION_REQUIRED: "请输入“确认结束游戏”",
  ACCOUNT_DELETE_BLOCKED: "该账号仍关联保留房间或结算记录，无法删除",
  CANNOT_DELETE_CURRENT_ACCOUNT: "不能删除当前登录的超级管理员账号",
  CANNOT_DELETE_SUPER_ADMIN: "不能删除超级管理员账号",
  SUPER_ADMIN_CANNOT_BE_DISABLED: "不能禁用超级管理员账号",
  ADMIN_REQUIRED: "此操作需要超级管理员权限",
  BANK_REQUIRED: "此操作需要银行能力，请切换到银行端",
  UNAUTHORIZED: "当前账号无权执行此操作",
  ROOM_NOT_FOUND: "没有找到该房间，请返回房间列表刷新",
  ROOM_NOT_IN_LOBBY: "房间已经开局，不能再执行此操作",
  ROOM_NOT_PLAYING: "房间当前不在游戏中",
  ROOM_ENDED: "房间已经结束，不能继续操作",
  MINIMUM_PLAYERS: "至少需要两位玩家才能开局",
  PLAYER_LIMIT: "房间人数已满，请联系银行确认",
  PLAYER_COUNT_OUT_OF_RANGE: "玩家人数不符合开局要求",
  MIDGAME_JOIN_DISABLED: "房间已开局，不能中途加入",
  CHARACTER_REQUIRED: "请选择人物后再加入",
  CHARACTER_TAKEN: "该人物已被选择，请换一位人物",
  UNKNOWN_CHARACTER: "人物信息无效，请重新选择",
  JOIN_INTENT_CONFLICT: "加入信息已变化，请返回后重新提交",
  RATE_LIMITED: "操作过于频繁，请稍后重试",
  SNAPSHOT_UNAVAILABLE: "服务暂时不可用，请稍后重试",
  IDEMPOTENCY_KEY_REQUIRED: "请求缺少防重复标识，请刷新页面后重试",
  IDEMPOTENCY_KEY_REUSED: "提交内容已变化，请重新确认后提交",
  INVALID_REQUEST: "提交内容不完整，请检查后重试",
  INVALID_AMOUNT: "金额必须是有效整数，请检查输入",
  INSUFFICIENT_BALANCE: "余额不足，请先处理资产或调整金额",
  INVALID_TRANSFER: "转帐信息无效，请检查收款对象和金额",
  SAME_PLAYER_TRANSFER: "不能向自己转帐，请选择其他玩家",
  NOT_CURRENT_PLAYER: "现在不是你的回合，请等待轮到你",
  PLAYER_MUST_SKIP_TURN: "该玩家本轮需要停轮，不能执行此操作",
  SKIP_TURN_NOT_ALLOWED: "当前回合不能跳过，请刷新后重试",
  ALREADY_ROLLED: "本轮已经掷过骰子，不能重复掷骰",
  ROLL_REQUIRED: "请先完成本轮掷骰",
  ROLL_NOT_FOUND: "没有找到本轮骰子结果，请刷新后重试",
  ROLL_HAS_SETTLED_ACTIONS: "本轮已有结算，不能再将骰子作废",
  PHYSICAL_DICE_MODE: "实体骰子模式请由现场确认轮次",
  PHYSICAL_DICE_MODE_REQUIRED: "此操作仅适用于实体骰子模式",
  ELECTRONIC_TURN_REQUIRED: "此操作需要有效的电子轮次",
  TURN_NOT_FOUND: "当前轮次已变化，请刷新后重试",
  LANDING_REQUIRED: "请先声明本轮落点",
  CONFIRMED_LANDING_REQUIRED: "请等待银行确认落点和剧情结算",
  LANDING_ALREADY_DECLARED: "本轮已经声明过落点",
  LANDING_NOT_FOUND: "没有找到该落点，请重新声明",
  LANDING_NOT_PENDING: "该落点已经处理，请刷新后查看",
  LANDING_TURN_EXPIRED: "落点所属轮次已结束，请重新声明",
  LANDING_ACTION_ALREADY_USED: "该落点已经完成过地产操作",
  LANDING_PROPERTY_ACTIONS_CANCELLED: "该落点的地产操作已被银行取消",
  START_LANDING_REQUIRED: "请先声明并确认精确停留起点",
  START_LANDING_TURN_EXPIRED: "起点落点所属轮次已结束",
  PROPERTY_REQUIRED: "请选择地产后再提交",
  PROPERTY_NOT_FOUND: "没有找到该地产，请刷新后重试",
  PROPERTY_NOT_ALLOWED: "当前落点不能操作这块地产",
  PROPERTY_OWNED: "该地产已有主人，不能购买",
  NOT_PROPERTY_OWNER: "你不是该地产的主人，不能操作",
  PROPERTY_LOCKED: "该地产有待审批操作，请等待处理完成",
  PROPERTY_STATE_CHANGED: "地产状态已变化，请刷新后重新确认",
  BUILDINGS_MUST_BE_SOLD: "请先出售该地产上的全部建筑",
  NO_BUILDINGS: "该地产没有可出售的建筑",
  INVALID_BUILDING_COUNT: "出售建筑数量无效，请重新输入",
  TOO_MANY_BUILDINGS: "出售数量超过现有建筑，请重新输入",
  PALACE_SELLS_AS_FIVE: "大宫殿必须按五栋建筑整体出售",
  MAX_BUILDING_LEVEL: "该地产已经达到最高建筑等级",
  MORTGAGED_PROPERTY: "抵押中的地产不能执行此操作",
  ALREADY_MORTGAGED: "该地产已经抵押",
  NOT_MORTGAGED: "该地产尚未抵押，无需赎回",
  NO_TOLL_DUE: "当前无需支付过路费",
  OWNER_CANNOT_COLLECT_TOLL: "地主正在冷宫中，本次免过路费",
  TOLL_ALREADY_SETTLED: "本次过路费已经结算",
  REQUEST_NOT_FOUND: "没有找到该请求，请刷新后重试",
  REQUEST_NOT_PENDING: "该请求已经处理，请刷新后查看",
  REQUEST_ALREADY_RESOLVED: "该请求已经完成，不能重复处理",
  REQUEST_TURN_EXPIRED: "请求所属轮次已结束，请重新发起",
  TRADE_BUYER_CONFIRMATION_REQUIRED: "请等待买家确认交易",
  TRADE_BUYER_MISMATCH: "当前身份不是该交易的买家",
  INVALID_TRADE: "交易信息无效，请检查地产和成交价",
  REASON_REQUIRED: "请填写现场原因后再提交",
  TRANSACTION_RETRY_EXHAUSTED: "多人同时操作，请刷新后重试",
  INTERNAL_ERROR: "服务暂时不可用，请稍后重试",
};

function apiErrorMessage(status: number, code: string) {
  if (API_ERROR_MESSAGES[code]) return API_ERROR_MESSAGES[code];
  if (status === 401 || status === 403)
    return "身份验证失败，请检查身份或重新加入";
  if (status === 404) return "没有找到相关内容，请刷新后重试";
  if (status === 409) return "状态已经变化，请刷新后重新操作";
  if (status === 429) return "操作过于频繁，请稍后重试";
  if (status >= 500) return "服务暂时不可用，请稍后重试";
  return "操作未完成，请检查输入后重试";
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly data: unknown,
  ) {
    super(apiErrorMessage(status, code));
    this.name = "ApiError";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !headers.has("Content-Type"))
    headers.set("Content-Type", "application/json");
  const response = await fetch(`${API}${path}`, {
    ...init,
    credentials: "include",
    headers,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new ApiError(
      response.status,
      (body as { error?: string }).error ?? "请求失败",
      body,
    );
  return body as T;
}

async function loadAllPages<T>(path: string) {
  const items: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;

  do {
    const separator = path.includes("?") ? "&" : "?";
    const page: { items: T[]; nextCursor: string | null } = await call(
      `${path}${cursor ? `${separator}cursor=${encodeURIComponent(cursor)}` : ""}`,
    );
    items.push(...page.items);
    if (!page.nextCursor || seenCursors.has(page.nextCursor)) break;
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (cursor);

  return items;
}

function requestKey() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function useStableWrite(runAction: TaskRunner) {
  const write: StableWriter = async <T, B extends WriteBody>(
    spec: StableWriteSpec<B>,
    options: StableWriteOptions = {},
  ): Promise<StableWriteResult<T, B>> => {
    const method = (spec.method ?? "POST").toUpperCase();
    const initialPayload =
      spec.body === undefined ? undefined : JSON.stringify(spec.body);
    const intent =
      spec.intentKey === undefined
        ? `${method}\n${spec.path}\n${initialPayload ?? ""}`
        : `${method}\n${spec.path}\nintent:${spec.intentKey}`;
    let pending = pendingWriteIntents.get(intent);
    if (!pending) {
      const body = spec.createBody ? spec.createBody() : spec.body;
      pending = {
        key: requestKey(),
        body,
        payload: body === undefined ? undefined : JSON.stringify(body),
      };
      pendingWriteIntents.set(intent, pending);
    }
    const ownedPending = pending;
    const result = await runAction(
      () =>
        call<T>(spec.path, {
          method,
          headers: { "Idempotency-Key": ownedPending.key },
          body: ownedPending.payload,
        }),
      options.owner,
    );
    if (!result.ok) return result;
    const confirm = () => {
      if (pendingWriteIntents.get(intent) === ownedPending)
        pendingWriteIntents.delete(intent);
    };
    return { ...result, body: ownedPending.body as B, confirm };
  };

  return { write, clear: () => pendingWriteIntents.clear() };
}

function booleanRoomAction(action: ActionRunner) {
  return async function submit(path: string, body?: IdempotentBody) {
    return (await action({ path, body })).ok;
  };
}

const formatMoney = (amount: number) => amount.toLocaleString("zh-CN");
function formatLedgerTime(createdAt?: string): string | null {
  if (!createdAt) return null;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
const characterName = (id: string) =>
  characters.find((item) => item.id === id)?.name ?? id;
const numericSkill = (skill: Record<string, unknown>, ...keys: string[]) => {
  const value = keys
    .map((key) => skill[key])
    .find(
      (candidate) =>
        typeof candidate === "number" && Number.isFinite(candidate),
    );
  return typeof value === "number" ? value : null;
};
const formatCharacterSkill = (
  characterId: string,
  skill: Record<string, unknown>,
  skillEnabled: boolean,
) => {
  if (skillEnabled === false) return "人物技能已停用";
  if (characterId === "zhenhuan") {
    const reward = numericSkill(skill, "companionCashReward", "cashReward");
    if (reward !== null) return `伙伴卡 +${formatMoney(reward)} 两`;
  }
  if (characterId === "yixiu") {
    const reduction = numericSkill(
      skill,
      "coldPalaceSkipReduction",
      "skipTurnsReduction",
    );
    const reward = numericSkill(skill, "coldPalaceCashReward", "cashReward");
    if (reduction !== null || reward !== null)
      return `冷宫减 ${formatMoney(reduction ?? 0)} 轮，获 ${formatMoney(reward ?? 0)} 两`;
  }
  if (characterId === "huashifei") {
    const bonus = numericSkill(skill, "tollBonus", "bonus");
    if (bonus !== null) return `过路费 +${formatMoney(bonus)} 两`;
  }
  if (characterId === "meizhuang") {
    const reduction = numericSkill(skill, "plotFineReduction", "reduction");
    if (reduction !== null) return `剧情罚款 -${formatMoney(reduction)} 两`;
  }
  if (characterId === "anlingrong") {
    const discount = numericSkill(skill, "buildDiscount", "discount");
    if (discount !== null) return `升级费用 -${formatMoney(discount)} 两`;
  }
  return "人物技能由房间配置决定";
};
const currentPropertyToll = (property: Property, players: Player[]) => {
  if (property.mortgaged || !property.ownerId) return 0;
  const owner = players.find((player) => player.id === property.ownerId);
  if (owner?.tollCollectionBlocked) return 0;
  return (property.tolls[property.level] ?? 0) + (owner?.tollBonus ?? 0);
};
const transactionName = (type: string) =>
  (
    ({
      MANUAL_BALANCE_CHANGE: "余额人工修正",
      PLAYER_TRANSFER: "转帐",
      PLAYER_BANK_PAYMENT: "支付银行",
      BUY_PROPERTY: "购买地产",
      BUILD_PROPERTY: "建造升级",
      SELL_BUILDING: "出售建筑",
      MORTGAGE_PROPERTY: "抵押地产",
      REDEEM_PROPERTY: "赎回地产",
      SELL_PROPERTY_TO_BANK: "卖给银行",
      TRADE_PROPERTY: "玩家地产交易",
      TOLL: "过路费结算",
      PLOT_FINE: "剧情罚款",
    }) as Record<string, string>
  )[type] ?? type;

type AccountView = {
  id: string;
  username: string;
  displayName: string;
  isSuperAdmin: boolean;
  canCreateRoom: boolean;
  lastLoginAt: string | null;
};
type DeviceView = {
  id: string;
  deviceName: string;
  browser: string;
  operatingSystem: string;
  loginIp: string;
  lastIp: string;
  createdAt: string;
  lastActiveAt: string;
  current: boolean;
};
type RoomStatus = "LOBBY" | "PLAYING" | "ENDED" | "FINISHED" | "CLOSED";
type RoomSummary = {
  id: string;
  name: string;
  status: RoomStatus;
  creator: string;
  memberCount: number;
  playerCount: number;
  playerLimit: number;
  hasPassword: boolean;
  mine: boolean;
  characterId: string | null;
  myCharacter: string | null;
  isBank: boolean;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};
type RoomMembershipView = {
  id: string;
  characterId: string | null;
  playerId: string | null;
  isBank: boolean;
  activeHere: boolean;
};
type WorkbenchContext = {
  roomId: string;
  membership: RoomMembershipView;
  view: "PLAYER" | "BANK";
  skillEnabled: boolean;
};
type RoleSwapStatus =
  | "PENDING_TARGET"
  | "PENDING_BANK"
  | "APPROVED"
  | "REJECTED"
  | "CANCELLED"
  | "EXPIRED"
  | "CONFLICTED";
type RoleSwapView = {
  id: string;
  roomId: string;
  requesterMembershipId: string;
  targetMembershipId: string;
  requesterCharacterId: string | null;
  targetCharacterId: string;
  requesterDisplayName: string;
  targetDisplayName: string;
  status: RoleSwapStatus;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  actions: {
    canAccept: boolean;
    canReject: boolean;
    canCancel: boolean;
    canApproveBank: boolean;
  };
};
type SeatSnapshot = {
  stateVersion: number;
  room: { id: string; name: string; status: RoomStatus; skillEnabled: boolean };
  membership: RoomMembershipView | null;
  characters: Array<{
    id: string;
    name: string;
    skill: Record<string, unknown>;
    initialProperty: string;
    occupiedBy: string | null;
    canSelect: boolean;
  }>;
  bank: { occupiedBy: string | null };
  roleSwapRequests: RoleSwapView[];
};
type PropertySettlementDetail = {
  roomPropertyId: string;
  nameSnapshot: string;
  mortgaged: boolean;
  mortgagePriceSnapshot: number;
  landSaleValue: number;
  landSettlementValue: number;
  buildingLevel: number;
  buildingSellPriceSnapshot: number;
  buildingSellValue: number;
};
type SettlementPlayerView = {
  accountId: string;
  displayNameSnapshot: string;
  characterNameSnapshot: string | null;
  cash: number;
  unmortgagedPropertyValue: number;
  mortgagedPropertyNetValue: number;
  buildingSellValue: number;
  totalWealth: number;
  rank: number;
  isWinner: boolean;
  propertyDetails: PropertySettlementDetail[];
};
type SettlementBlocker = {
  code: string;
  [key: string]: string | number | boolean | null;
};
type SettlementPreviewView = {
  blockers: SettlementBlocker[];
  players: SettlementPlayerView[];
};
type SettlementView = {
  id: string;
  roomId: string;
  stateVersion: number;
  endedByAccountId: string;
  endedAt: string;
  totalTurns: number;
  durationSeconds: number;
  forced: boolean;
  forceReason: string | null;
  winners: string[];
  ranking: Array<{ accountId: string; rank: number }>;
  overriddenBlockers: SettlementBlocker[];
  players: SettlementPlayerView[];
};
type AdminAccount = {
  id: string;
  username: string;
  displayName: string;
  note: string | null;
  status: "ACTIVE" | "DISABLED";
  isSuperAdmin: boolean;
  canCreateRoom: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type AdminRoom = {
  id: string;
  name: string;
  status: RoomStatus;
  visibility: "PUBLIC" | "PRIVATE";
  creator: { id: string; displayName: string };
  memberCount: number;
  playerCount: number;
  hasBank: boolean;
  hasPassword: boolean;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  settlement: { id: string; endedAt: string; forced: boolean } | null;
};
type AdminLog = {
  id: string;
  action: string;
  accountId: string | null;
  actorAccountId: string | null;
  ip: string | null;
  createdAt: string;
  details?: Record<string, unknown>;
};
type AdminDevice = {
  id: string;
  deviceName: string;
  browser: string;
  operatingSystem: string;
  loginIp: string;
  lastIp: string;
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;
  active: boolean;
  revokedAt: string | null;
  revokeReason: string | null;
};
type AdminRoomDetail = {
  id: string;
  code: string;
  name: string;
  status: RoomStatus;
  creator: { id: string; displayName: string; username: string };
  configuration: {
    initialBalance: number;
    diceMode: "ELECTRONIC" | "PHYSICAL";
    skillEnabled: boolean;
    startReward: number;
    allowMidgameJoin: boolean;
    visibility: "PUBLIC" | "PRIVATE";
    transferApprovalRequired: boolean;
    playerLimit: number;
    hasPassword: boolean;
  };
  lifecycle: {
    createdAt: string;
    startedAt: string | null;
    updatedAt: string;
    expiresAt: string;
  };
  members: Array<{
    id: string;
    accountId: string;
    displayNameSnapshot: string;
    status: string;
    characterId: string | null;
    characterName: string | null;
    isBank: boolean;
    controllerActive: boolean;
    joinedAt: string;
    player: {
      id: string;
      balance: number;
      status: string;
      ownedPropertyCount: number;
    } | null;
  }>;
  blockers: {
    pendingRequests: number;
    pendingSwaps: number;
    openDebts: number;
    activeTurns: number;
  };
  settlement: {
    id: string;
    endedAt: string;
    durationSeconds: number;
    forced: boolean;
    forceReason: string | null;
  } | null;
};
type DashboardView = {
  accounts: { total: number; active: number };
  sessions: { valid: number };
  rooms: { lobby: number; playing: number; finished: number };
  games: { settledTotal: number; averageDurationSeconds: number };
  characterSelections: Array<{
    characterId: string;
    characterNameSnapshot: string;
    count: number;
  }>;
  characterWins: Array<{ characterNameSnapshot: string; count: number }>;
  recentGames: Array<{
    roomId: string;
    roomNameSnapshot: string;
    endedAt: string;
    durationSeconds: number;
    forced: boolean;
    winners: Array<{
      displayNameSnapshot: string;
      characterNameSnapshot: string | null;
    }>;
  }>;
};
type AdminData = {
  accounts: AdminAccount[];
  rooms: AdminRoom[];
  logs: AdminLog[];
  dashboard: DashboardView | null;
};
type Screen =
  | "LANDING"
  | "LOGIN"
  | "LIMIT"
  | "LOBBY"
  | "JOIN"
  | "CREATE"
  | "SEATS"
  | "CONTROL"
  | "WORKBENCH_SELECT"
  | "PROFILE"
  | "ADMIN"
  | "GAME"
  | "FINISH"
  | "SETTLEMENT"
  | "FORBIDDEN";
type SeatsRouteIntent = "AUTO" | "MANAGE";
type RoomRuntime = {
  roomId: string | null;
  screen: Screen;
  requestedView: "PLAYER" | "BANK" | null;
  workbench: WorkbenchContext | null;
};
export type AppPage =
  | "home"
  | "login"
  | "rooms"
  | "create-room"
  | "join-room"
  | "seats"
  | "workbench"
  | "player"
  | "bank"
  | "finish"
  | "settlement"
  | "profile"
  | "admin-dashboard"
  | "admin-accounts"
  | "admin-rooms"
  | "admin-logs"
  | "forbidden";

const screens: Record<AppPage, Screen> = {
  home: "LANDING",
  login: "LOGIN",
  rooms: "LOBBY",
  "create-room": "CREATE",
  "join-room": "JOIN",
  seats: "SEATS",
  workbench: "WORKBENCH_SELECT",
  player: "GAME",
  bank: "GAME",
  finish: "FINISH",
  settlement: "SETTLEMENT",
  profile: "PROFILE",
  "admin-dashboard": "ADMIN",
  "admin-accounts": "ADMIN",
  "admin-rooms": "ADMIN",
  "admin-logs": "ADMIN",
  forbidden: "FORBIDDEN",
};
const screenForPage = (page: AppPage): Screen => screens[page];

const terminalRoom = (status: RoomStatus) =>
  status === "FINISHED" || status === "ENDED" || status === "CLOSED";
type RoomStatusBadge = {
  label: "已加入" | "可加入" | "准备中" | "游戏中" | "已结束";
  tone: "joined" | "joinable" | "lobby" | "playing" | "ended";
};
const roomStatusBadges = (room: RoomSummary): RoomStatusBadge[] => {
  if (terminalRoom(room.status)) return [{ label: "已结束", tone: "ended" }];
  return [
    {
      label: room.mine ? "已加入" : "可加入",
      tone: room.mine ? "joined" : "joinable",
    },
    {
      label: room.status === "PLAYING" ? "游戏中" : "准备中",
      tone: room.status === "PLAYING" ? "playing" : "lobby",
    },
  ];
};
const localizedRoomStatus = (status: RoomStatus) =>
  ({
    LOBBY: "等待入席",
    PLAYING: "进行中",
    ENDED: "旧版结束",
    FINISHED: "已结算",
    CLOSED: "已关闭",
  })[status];
const capabilityLabel = (room: RoomSummary) =>
  room.characterId && room.isBank
    ? room.myCharacter
      ? `${room.myCharacter}兼银行`
      : "人物兼银行"
    : room.characterId
      ? (room.myCharacter ?? "人物玩家")
      : room.isBank
        ? "银行"
        : "";
const formatRoomLifecycleTime = (value: string | null, emptyLabel: string) => {
  if (!value) return emptyLabel;
  const date = new Date(value);
  const weekday = [
    "星期日",
    "星期一",
    "星期二",
    "星期三",
    "星期四",
    "星期五",
    "星期六",
  ][date.getDay()];
  return `${date.getFullYear()}年${String(date.getMonth() + 1).padStart(2, "0")}月${String(date.getDate()).padStart(2, "0")}日 ${weekday} ${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
};
let lastFocusOutsideDialog: HTMLElement | null = null;

export default function AppRouterClient({
  page,
  roomId,
}: {
  page: AppPage;
  roomId?: string;
}) {
  const router = useRouter();
  const screen = screenForPage(page);
  const [account, setAccount] = useState<AccountView | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginLimited, setLoginLimited] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<RoomSummary | null>(null);
  const [seats, setSeats] = useState<SeatSnapshot | null>(null);
  const [workbench, setWorkbench] = useState<WorkbenchContext | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [settlement, setSettlement] = useState<SettlementView | null>(null);
  const [settlementPreview, setSettlementPreview] =
    useState<SettlementPreviewView | null>(null);
  const [devices, setDevices] = useState<DeviceView[]>([]);
  const [adminData, setAdminData] = useState<AdminData>({
    accounts: [],
    rooms: [],
    logs: [],
    dashboard: null,
  });
  const [loginIntent, setLoginIntent] = useState({
    username: "",
    password: "",
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [currentToast, setCurrentToast] = useState<ToastItem | null>(null);
  const toastQueue = useRef<ReturnType<typeof createToastQueue> | null>(null);
  const enqueue = useCallback((toast: ToastInput) => {
    toastQueue.current?.enqueue(toast);
  }, []);
  const showNotice = useCallback((message: string) => {
    enqueue({ message });
  }, [enqueue]);
  const showToast = useCallback((toast: ToastInput) => {
    enqueue(toast);
  }, [enqueue]);
  useEffect(() => {
    const queue = createToastQueue(setCurrentToast);
    toastQueue.current = queue;
    return () => {
      queue.dispose();
      if (toastQueue.current === queue) toastQueue.current = null;
    };
  }, []);
  const busyRef = useRef(false);
  const roomGeneration = useRef(0);
  const roomTarget = useRef<string | null>(null);
  const activeRoomTransition = useRef<number | null>(null);
  const snapshotRequestGeneration = useRef(0);
  const roomStateVersion = useRef(-1);
  const accountSocket = useRef<ReturnType<typeof io> | null>(null);
  const socketRoomSubscription = useRef<string | null>(null);
  const roomInvalidator = useRef<(() => void) | null>(null);
  const roomRuntime = useRef<RoomRuntime>({
    roomId: null,
    screen,
    requestedView: null,
    workbench: null,
  });
  const pendingRoomToasts = useRef(new Map<string, PendingRoomToast>());
  const { write, clear: clearPendingIntents } = useStableWrite(run);

  const roomPath = (
    target:
      | "seats"
      | "workbench"
      | "player"
      | "bank"
      | "finish"
      | "settlement"
      | "join",
    targetRoomId = roomId,
  ) => `/rooms/${targetRoomId}/${target}`;
  const go = (path: string, replace = false) =>
    replace ? router.replace(path) : router.push(path);
  const loginDestination = () =>
    typeof window === "undefined"
      ? "/rooms"
      : new URLSearchParams(window.location.search).get("next") || "/rooms";

  useEffect(() => {
    void call<{ account: AccountView; sessions: DeviceView[] }>("/api/auth/me")
      .then(({ account: restored, sessions }) => {
        setAccount(restored);
        setDevices(sessions);
        if (page === "home") go("/rooms", true);
      })
      .catch(() => setAccount(null))
      .finally(() => setAuthChecked(true));
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    const publicPage =
      page === "home" || page === "login" || page === "forbidden";
    if (!account && !publicPage) {
      go(
        `/login?next=${encodeURIComponent(roomId ? roomPath(page === "player" ? "player" : page === "bank" ? "bank" : page === "settlement" ? "settlement" : page === "finish" ? "finish" : "seats", roomId) : page === "profile" ? "/profile" : page.startsWith("admin") ? "/admin" : "/rooms")}`,
        true,
      );
      return;
    }
    if (!account) return;
    if (page === "rooms") {
      void loadRooms().catch((caught) => void handleFailure(caught));
      return;
    }
    if (page === "join-room" && roomId) {
      void loadRooms()
        .then((items) =>
          setSelectedRoom(items.find((item) => item.id === roomId) ?? null),
        )
        .catch((caught) => void handleFailure(caught));
      return;
    }
    if (
      (page === "seats" ||
        page === "workbench" ||
        page === "player" ||
        page === "bank" ||
        page === "finish") &&
      roomId
    ) {
      void loadSeats(
        roomId,
        page === "player"
          ? "PLAYER"
          : page === "bank" || page === "finish"
            ? "BANK"
            : undefined,
        page === "seats" ? "MANAGE" : "AUTO",
      );
      return;
    }
    if (page === "settlement" && roomId) {
      const owner = beginRoomTransition(roomId);
      void runRoomTransition(owner, () => fetchSettlement(owner));
      return;
    }
    if (page === "profile") {
      void loadProfile();
      return;
    }
    if (page.startsWith("admin")) {
      if (!account.isSuperAdmin) {
        go("/403", true);
        return;
      }
      void loadAdmin();
    }
  }, [account, authChecked, page, roomId]);

  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      if (
        event.target instanceof HTMLElement &&
        !event.target.closest(".modal-backdrop")
      )
        lastFocusOutsideDialog = event.target;
    };
    document.addEventListener("focusin", rememberFocus);
    return () => {
      document.removeEventListener("focusin", rememberFocus);
      lastFocusOutsideDialog = null;
    };
  }, []);

  useEffect(() => {
    const heading = document.querySelector("h1");
    if (heading instanceof HTMLElement) {
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
    }
  }, [page]);

  function clearPassword() {
    setLoginIntent((current) => ({ ...current, password: "" }));
  }

  function beginRoomTransition(
    roomId: string,
    requestedView: "PLAYER" | "BANK" | null = null,
  ): RoomOwner {
    toastQueue.current?.clear();
    pendingRoomToasts.current.clear();
    roomGeneration.current += 1;
    roomTarget.current = roomId;
    snapshotRequestGeneration.current += 1;
    roomStateVersion.current = -1;
    roomRuntime.current = {
      ...roomRuntime.current,
      roomId,
      requestedView,
    };
    return { roomId, generation: roomGeneration.current };
  }

  function invalidateRoomTransition() {
    pendingRoomToasts.current.clear();
    roomGeneration.current += 1;
    roomTarget.current = null;
    snapshotRequestGeneration.current += 1;
    roomStateVersion.current = -1;
  }

  function ownsRoom(owner: RoomOwner) {
    return (
      owner.generation === roomGeneration.current &&
      owner.roomId === roomTarget.current
    );
  }

  function clearRoomState() {
    toastQueue.current?.clear();
    invalidateRoomTransition();
    setSelectedRoom(null);
    setSeats(null);
    setWorkbench(null);
    setSnapshot(null);
    setSettlement(null);
    setSettlementPreview(null);
  }

  function isAuthFailure(caught: unknown): caught is ApiError {
    return (
      caught instanceof ApiError &&
      (caught.code === "SESSION_INVALID" || caught.code === "AUTH_REQUIRED")
    );
  }

  async function handleFailure(caught: unknown, owner?: RoomOwner) {
    if (isAuthFailure(caught)) {
      invalidateLogin((caught as Error).message);
      return;
    }
    if (owner && !ownsRoom(owner)) return;
    if (
      owner &&
      caught instanceof ApiError &&
      caught.code === "ROOM_CONTROL_LOST"
    ) {
      await handleRoomControlLost(owner);
      return;
    }
    setError((caught as Error).message);
  }

  async function runRoomTransition(
    owner: RoomOwner,
    task: () => Promise<unknown>,
  ) {
    activeRoomTransition.current = owner.generation;
    setBusy(true);
    setError("");
    try {
      await task();
    } catch (caught) {
      await handleFailure(caught, owner);
    } finally {
      if (activeRoomTransition.current === owner.generation) {
        activeRoomTransition.current = null;
        setBusy(false);
      }
    }
  }

  function invalidateLogin(message = "当前登录已失效，请重新登录") {
    clearPassword();
    clearPendingIntents();
    clearRoomState();
    setAccount(null);
    setRooms([]);
    setError(message);
    go("/login", true);
  }

  async function handleRoomControlLost(failedOwner: RoomOwner) {
    if (!ownsRoom(failedOwner)) return;
    toastQueue.current?.clear();
    const owner = beginRoomTransition(failedOwner.roomId);
    setSnapshot(null);
    setWorkbench(null);
    setSettlementPreview(null);
    let next: SeatSnapshot;
    try {
      next = await call<SeatSnapshot>(`/api/rooms/${owner.roomId}/seats`);
    } catch (caught) {
      if (isAuthFailure(caught)) invalidateLogin((caught as Error).message);
      else if (ownsRoom(owner)) go(roomPath("seats", owner.roomId), true);
      return;
    }
    await routeFromSeats(owner, next, undefined, "AUTO");
  }

  async function run<T>(
    task: () => Promise<T>,
    owner?: RoomOwner,
  ): Promise<RunResult<T>> {
    if (busyRef.current) return { ok: false };
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      return { ok: true, value: await task() };
    } catch (caught) {
      await handleFailure(caught, owner);
      return { ok: false, error: caught };
    } finally {
      busyRef.current = false;
      if (activeRoomTransition.current === null) setBusy(false);
    }
  }

  async function loadRooms(owner?: RoomOwner) {
    const [all, mine, history] = await Promise.all([
      call<RoomSummary[]>("/api/rooms"),
      call<RoomSummary[]>("/api/rooms/mine"),
      call<RoomSummary[]>("/api/rooms/history"),
    ]);
    const merged = new Map(
      [...all, ...mine, ...history].map((room) => [room.id, room]),
    );
    const next = [...merged.values()];
    if (owner && !ownsRoom(owner)) return next;
    setRooms(next);
    return next;
  }

  async function login(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      try {
        const result = await call<{ account: AccountView }>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({
            username: loginIntent.username,
            password: loginIntent.password,
          }),
        });
        clearPendingIntents();
        clearPassword();
        setAccount(result.account);
        go(loginDestination(), true);
        await loadRooms();
      } catch (caught) {
        if (
          caught instanceof ApiError &&
          caught.code === "SESSION_LIMIT_REACHED"
        ) {
          setDevices((caught.data as { devices?: DeviceView[] }).devices ?? []);
          setLoginLimited(true);
          return;
        }
        throw caught;
      }
    });
  }

  async function replaceOldest() {
    await run(async () => {
      const result = await call<{ account: AccountView }>(
        "/api/auth/login/replace-oldest-session",
        {
          method: "POST",
          body: JSON.stringify({
            username: loginIntent.username,
            password: loginIntent.password,
          }),
        },
      );
      clearPendingIntents();
      clearPassword();
      setLoginLimited(false);
      setAccount(result.account);
      go(loginDestination(), true);
      await loadRooms();
    });
  }

  async function logout() {
    await run(() => call("/api/auth/logout", { method: "POST" }));
    clearPendingIntents();
    clearPassword();
    clearRoomState();
    setAccount(null);
    setRooms([]);
    go("/", true);
  }

  function leaveRoom() {
    clearRoomState();
    go("/rooms");
    void loadRooms().catch((caught) => {
      void handleFailure(caught);
    });
  }

  async function openRoom(room: RoomSummary) {
    if (!room.mine && !terminalRoom(room.status)) {
      go(roomPath("join", room.id));
      return;
    }
    go(
      roomPath(terminalRoom(room.status) ? "settlement" : "workbench", room.id),
    );
  }

  async function joinRoom(password?: string) {
    if (!selectedRoom) return;
    const roomId = selectedRoom.id;
    const owner = beginRoomTransition(roomId);
    await runRoomTransition(owner, async () => {
      const result = await write(
        {
          path: `/api/rooms/${roomId}/join`,
          body: password ? { password } : {},
        },
        { owner },
      );
      if (!result.ok || !ownsRoom(owner)) return;
      await loadRooms(owner);
      if (!ownsRoom(owner)) return;
      if (await fetchSeats(owner, undefined, "AUTO")) result.confirm();
    });
  }

  async function routeFromSeats(
    owner: RoomOwner,
    next: SeatSnapshot,
    preferredView?: "PLAYER" | "BANK",
    intent: SeatsRouteIntent = "AUTO",
  ): Promise<boolean> {
    if (!ownsRoom(owner) || next.room.id !== owner.roomId) return false;
    if (next.stateVersion < roomStateVersion.current) return false;
    roomStateVersion.current = next.stateVersion;
    setSeats(next);
    const membership = next.membership;
    if (
      next.room.status === "FINISHED" ||
      next.room.status === "ENDED" ||
      next.room.status === "CLOSED"
    ) {
      go(roomPath("settlement", owner.roomId), true);
      return true;
    }
    if (membership && !membership.activeHere) {
      setSettlementPreview(null);
      setSnapshot(null);
      setWorkbench(null);
      go(roomPath("seats", owner.roomId), true);
      return ownsRoom(owner);
    }
    if (intent === "MANAGE") return ownsRoom(owner);
    if (!membership) {
      go(roomPath("seats", owner.roomId), true);
      return ownsRoom(owner);
    }
    const hasPlayer = membership.characterId !== null;
    const hasBank = membership.isBank;
    if (hasPlayer && hasBank) {
      const validPreferred =
        preferredView === "PLAYER" || preferredView === "BANK";
      if (validPreferred) return openGame(owner, next, preferredView);
      setSnapshot(null);
      setWorkbench(null);
      if (page !== "workbench") go(roomPath("workbench", owner.roomId), true);
      return ownsRoom(owner);
    }
    if (hasPlayer) {
      if (page === "bank" || page === "finish") {
        go("/403", true);
        return true;
      }
      if (page !== "player") {
        go(roomPath("player", owner.roomId), true);
        return true;
      }
      return openGame(owner, next, "PLAYER");
    }
    if (hasBank) {
      if (page !== "bank" && page !== "finish") {
        go(roomPath("bank", owner.roomId), true);
        return true;
      }
      return openGame(owner, next, "BANK");
    }
    go(roomPath("seats", owner.roomId), true);
    return ownsRoom(owner);
  }

  async function loadSeats(
    roomId: string,
    preferredView?: "PLAYER" | "BANK",
    intent: SeatsRouteIntent = "AUTO",
  ) {
    const owner = beginRoomTransition(roomId, preferredView ?? null);
    await runRoomTransition(owner, () =>
      fetchSeats(owner, preferredView, intent),
    );
  }

  async function fetchSeats(
    owner: RoomOwner,
    preferredView?: "PLAYER" | "BANK",
    intent: SeatsRouteIntent = "AUTO",
  ) {
    const next = await call<SeatSnapshot>(`/api/rooms/${owner.roomId}/seats`);
    if (!ownsRoom(owner)) return false;
    return routeFromSeats(owner, next, preferredView, intent);
  }

  async function readSnapshot(owner: RoomOwner, view: "PLAYER" | "BANK") {
    const generation = ++snapshotRequestGeneration.current;
    const nextSnapshot = await call<Snapshot>(
      `/api/rooms/${owner.roomId}/snapshot?view=${view}`,
    );
    if (
      generation !== snapshotRequestGeneration.current ||
      !ownsRoom(owner) ||
      nextSnapshot.stateVersion < roomStateVersion.current
    )
      return null;
    roomStateVersion.current = nextSnapshot.stateVersion;
    setSnapshot(nextSnapshot);
    return nextSnapshot;
  }

  async function openGame(
    owner: RoomOwner,
    nextSeats: SeatSnapshot,
    view: "PLAYER" | "BANK",
  ) {
    if (!nextSeats.membership || nextSeats.room.id !== owner.roomId)
      return false;
    const nextSnapshot = await readSnapshot(owner, view);
    if (!nextSnapshot || !ownsRoom(owner)) return false;
    setWorkbench({
      roomId: nextSeats.room.id,
      membership: nextSeats.membership,
      view,
      skillEnabled: nextSeats.room.skillEnabled,
    });
    if (page === "finish") {
      const preview = await call<SettlementPreviewView>(
        `/api/rooms/${owner.roomId}/settlement/preview`,
        { method: "POST", body: JSON.stringify({}) },
      );
      if (ownsRoom(owner)) setSettlementPreview(preview);
    }
    return ownsRoom(owner);
  }

  async function chooseWorkbench(view: "PLAYER" | "BANK") {
    if (!seats) return;
    go(roomPath(view === "PLAYER" ? "player" : "bank", seats.room.id));
  }

  async function chooseSeat(kind: "BANK" | "PLAYER", characterId?: string) {
    if (!seats) return;
    const roomId = seats.room.id;
    const path = `/api/rooms/${roomId}/${kind === "BANK" ? "select-bank" : "select-character"}`;
    const owner = beginRoomTransition(roomId, kind);
    await runRoomTransition(owner, async () => {
      const result = await write(
        { path, body: kind === "PLAYER" ? { characterId } : {} },
        { owner },
      );
      if (!result.ok || !ownsRoom(owner)) return;
      await loadRooms(owner);
      if (!ownsRoom(owner)) return;
      if (await fetchSeats(owner, undefined, "AUTO")) result.confirm();
    });
  }

  async function requestSwap(characterId: string) {
    if (!seats) return;
    const roomId = seats.room.id;
    const owner = beginRoomTransition(roomId);
    await runRoomTransition(owner, async () => {
      const result = await write(
        {
          path: `/api/rooms/${roomId}/role-swap-requests`,
          body: { targetCharacterId: characterId },
        },
        { owner },
      );
      if (!result.ok || !ownsRoom(owner)) return;
      if (await fetchSeats(owner, undefined, "MANAGE")) result.confirm();
    });
  }

  async function roleSwapAction(
    request: RoleSwapView,
    actionName: "accept" | "reject" | "approve-bank" | "cancel",
    reason?: string,
  ) {
    const roomId = request.roomId;
    const owner = beginRoomTransition(roomId);
    await runRoomTransition(owner, async () => {
      const result = await write(
        {
          path: `/api/role-swap-requests/${request.id}/${actionName}`,
          body: actionName === "reject" ? { reason } : {},
        },
        { owner },
      );
      if (!result.ok || !ownsRoom(owner)) return;
      if (await fetchSeats(owner, undefined, "MANAGE")) result.confirm();
    });
  }

  async function takeControl() {
    if (!seats) return;
    const roomId = seats.room.id;
    const owner = beginRoomTransition(roomId);
    await runRoomTransition(owner, async () => {
      const result = await write(
        { path: `/api/rooms/${roomId}/take-control` },
        { owner },
      );
      if (!result.ok || !ownsRoom(owner)) return;
      if (await fetchSeats(owner, undefined, "AUTO")) {
        const socket = accountSocket.current;
        socketRoomSubscription.current = null;
        if (socket?.connected) {
          socket.emit("room.subscribe", { roomId });
          socketRoomSubscription.current = roomId;
        }
        result.confirm();
      }
    });
  }

  function seatsIntent(runtime: RoomRuntime): SeatsRouteIntent {
    return runtime.screen === "SEATS" ? "MANAGE" : "AUTO";
  }

  function needsSeatsReconciliation(caught: unknown) {
    return (
      caught instanceof ApiError &&
      [
        "ROOM_CONTROL_LOST",
        "BANK_REQUIRED",
        "PLAYER_IDENTITY_MISMATCH",
        "ROOM_MEMBERSHIP_REQUIRED",
        "ROOM_FINISHED",
      ].includes(caught.code)
    );
  }

  async function refreshSeatsAfterAuthorityChange(
    owner: RoomActionOwner,
  ): Promise<boolean> {
    const runtime = roomRuntime.current;
    if (runtime.roomId !== owner.roomId || !ownsRoom(owner)) return false;
    try {
      return await fetchSeats(
        owner,
        runtime.requestedView ?? undefined,
        seatsIntent(runtime),
      );
    } catch (caught) {
      await handleFailure(caught, owner);
      return false;
    }
  }

  async function refreshGame(owner?: RoomActionOwner): Promise<boolean> {
    const requested =
      owner ??
      (workbench
        ? {
            roomId: workbench.roomId,
            view: workbench.view,
            generation: roomGeneration.current,
          }
        : null);
    if (!requested || !ownsRoom(requested)) return false;
    try {
      return (await readSnapshot(requested, requested.view)) !== null;
    } catch (caught) {
      if (needsSeatsReconciliation(caught))
        return refreshSeatsAfterAuthorityChange(requested);
      await handleFailure(caught, requested);
      return false;
    }
  }

  async function refreshCurrentRoom() {
    const runtime = roomRuntime.current;
    if (!runtime.roomId) return false;
    const owner = {
      roomId: runtime.roomId,
      generation: roomGeneration.current,
      view: runtime.requestedView ?? undefined,
    };
    if (!ownsRoom(owner)) return false;
    if (
      runtime.workbench &&
      (runtime.screen === "GAME" || runtime.screen === "FINISH")
    )
      return refreshGame({ ...owner, view: runtime.workbench.view });
    try {
      return await fetchSeats(
        owner,
        runtime.requestedView ?? undefined,
        seatsIntent(runtime),
      );
    } catch (caught) {
      await handleFailure(caught, owner);
      return false;
    }
  }

  async function gameAction<T = unknown, B extends WriteBody = WriteBody>(
    spec: StableWriteSpec<B>,
  ): Promise<RoomActionResult<T, B>> {
    if (!workbench) return { ok: false, committed: false };
    const owner = {
      roomId: workbench.roomId,
      view: workbench.view,
      generation: roomGeneration.current,
    };
    return runGameAction<T, B>({ owner, spec, write, ownsRoom, refreshGame });
  }

  async function loadProfile() {
    await run(async () => {
      setDevices(await call<DeviceView[]>("/api/auth/sessions"));
    });
  }

  async function revokeDevice(id: string) {
    await run(async () => {
      await call(`/api/auth/sessions/${id}`, { method: "DELETE" });
      setDevices(await call<DeviceView[]>("/api/auth/sessions"));
    });
  }

  async function loadAdmin(): Promise<RunResult<AdminData>> {
    return run(async () => {
      const [accounts, adminRooms, logs, dashboard] = await Promise.all([
        loadAllPages<AdminAccount>("/api/admin/accounts?limit=100"),
        loadAllPages<AdminRoom>("/api/admin/rooms?limit=100"),
        loadAllPages<AdminLog>("/api/admin/security-logs?limit=100"),
        call<DashboardView>("/api/admin/dashboard"),
      ]);
      const next = { accounts, rooms: adminRooms, logs, dashboard };
      setAdminData(next);
      return next;
    });
  }

  async function fetchSettlement(owner: RoomOwner) {
    const next = await call<SettlementView>(
      `/api/rooms/${owner.roomId}/settlement`,
    );
    if (
      !ownsRoom(owner) ||
      next.roomId !== owner.roomId ||
      next.stateVersion < roomStateVersion.current
    )
      return false;
    roomStateVersion.current = next.stateVersion;
    setSettlement(next);
    return ownsRoom(owner);
  }

  async function openFinish() {
    if (!workbench) return;
    go(roomPath("finish", workbench.roomId));
  }

  async function finishRoom(confirmation: string) {
    if (!workbench) return;
    const roomId = workbench.roomId;
    const owner = beginRoomTransition(roomId);
    await runRoomTransition(owner, async () => {
      const result = await write<
        { created: boolean },
        { confirmation: string }
      >(
        {
          path: `/api/rooms/${roomId}/finish`,
          body: { confirmation },
          intentKey: `finish:${roomId}`,
        },
        { owner },
      );
      if (!result.ok || !ownsRoom(owner)) return;
      if (!(await fetchSettlement(owner)) || !ownsRoom(owner)) return;
      go(roomPath("settlement", roomId), true);
      result.confirm();
      await loadRooms(owner);
    });
  }

  async function manageSeats() {
    if (!workbench) return;
    go(roomPath("seats", workbench.roomId));
  }

  useEffect(() => {
    if (!account) return;
    const socket = io(API, { withCredentials: true });
    accountSocket.current = socket;
    const refresh = () => {
      void refreshCurrentRoom();
    };
    const onRoomEvent = (payload: unknown) => {
      const notification =
        payload && typeof payload === "object"
          ? (payload as { roomId?: unknown; stateVersion?: unknown })
          : null;
      const roomId =
        typeof notification?.roomId === "string" ? notification.roomId : null;
      if (!roomId || roomId !== roomRuntime.current.roomId) return;
      const stateVersion =
        typeof notification?.stateVersion === "number" &&
        Number.isInteger(notification.stateVersion)
          ? notification.stateVersion
          : null;
      if (stateVersion !== null) {
        if (stateVersion <= roomStateVersion.current) return;
        roomStateVersion.current = stateVersion;
      }
      snapshotRequestGeneration.current += 1;
      refresh();
    };
    const onRoomSubscriptionLost = (payload: unknown) => {
      const notification =
        payload && typeof payload === "object"
          ? (payload as { roomId?: unknown })
          : null;
      const roomId =
        typeof notification?.roomId === "string" ? notification.roomId : null;
      if (!roomId || roomId !== roomRuntime.current.roomId) return;
      if (socketRoomSubscription.current === roomId)
        socketRoomSubscription.current = null;
      snapshotRequestGeneration.current += 1;
      refresh();
    };
    const onRoomToast = (payload: unknown) => {
      const parsed = realtimeToastEventSchema.safeParse(payload);
      if (!parsed.success) return;
      const runtime = roomRuntime.current;
      if (parsed.data.roomId !== runtime.roomId) return;
      const targetView = runtime.requestedView;
      if (targetView === null || parsed.data.audience !== targetView) return;
      if (
        !runtime.workbench ||
        runtime.workbench.roomId !== parsed.data.roomId ||
        runtime.workbench.view !== targetView
      ) {
        pendingRoomToasts.current.set(parsed.data.eventId, {
          event: parsed.data,
          generation: roomGeneration.current,
        });
        return;
      }
      if (parsed.data.audience !== runtime.workbench.view) return;
      enqueue({
        id: parsed.data.eventId,
        message: parsed.data.message,
        tone: toastToneForRealtimeKind(parsed.data.kind),
      });
    };
    roomInvalidator.current = refresh;
    socket.on("connect", () => {
      socketRoomSubscription.current = null;
      const { roomId } = roomRuntime.current;
      if (roomId) {
        socket.emit("room.subscribe", { roomId });
        socketRoomSubscription.current = roomId;
        refresh();
      }
    });
    socket.on("disconnect", () => {
      socketRoomSubscription.current = null;
    });
    socket.on("room.snapshot-required", onRoomEvent);
    socket.on("room.subscription-rejected", onRoomSubscriptionLost);
    socket.on("room.control.changed", onRoomSubscriptionLost);
    socket.on("room.toast", onRoomToast);
    socket.on("account.session.revoked", () => invalidateLogin());
    return () => {
      const subscribedRoom = socketRoomSubscription.current;
      if (subscribedRoom && socket.connected)
        socket.emit("room.unsubscribe", { roomId: subscribedRoom });
      socketRoomSubscription.current = null;
      if (accountSocket.current === socket) accountSocket.current = null;
      if (roomInvalidator.current === refresh) roomInvalidator.current = null;
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [account?.id]);

  useEffect(() => {
    if (!account) return;
    const refresh = () => {
      roomInvalidator.current?.();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [account?.id]);

  useEffect(() => {
    const activeRoomScreen = [
      "SEATS",
      "CONTROL",
      "WORKBENCH_SELECT",
      "GAME",
      "FINISH",
    ].includes(screen);
    const activeRoomId = account && roomId && activeRoomScreen ? roomId : null;
    const requestedView =
      page === "player"
        ? "PLAYER"
        : page === "bank" || page === "finish"
          ? "BANK"
          : null;
    roomRuntime.current = {
      roomId: activeRoomId,
      screen,
      requestedView,
      workbench,
    };
    const socket = accountSocket.current;
    if (!socket?.connected) return;
    const subscribedRoom = socketRoomSubscription.current;
    if (subscribedRoom && subscribedRoom !== activeRoomId) {
      socket.emit("room.unsubscribe", { roomId: subscribedRoom });
      socketRoomSubscription.current = null;
    }
    if (activeRoomId && socketRoomSubscription.current !== activeRoomId) {
      socket.emit("room.subscribe", { roomId: activeRoomId });
      socketRoomSubscription.current = activeRoomId;
      roomInvalidator.current?.();
    }
  }, [account?.id, roomId, page, screen, workbench]);

  useEffect(() => {
    if (!workbench) return;
    for (const pending of pendingRoomToasts.current.values()) {
      const toast = pending.event;
      pendingRoomToasts.current.delete(toast.eventId);
      if (
        pending.generation !== roomGeneration.current ||
        toast.roomId !== workbench.roomId ||
        roomRuntime.current.requestedView !== workbench.view ||
        toast.audience !== workbench.view
      )
        continue;
      enqueue({
        id: toast.eventId,
        message: toast.message,
        tone: toastToneForRealtimeKind(toast.kind),
      });
    }
  }, [enqueue, workbench]);

  if (screen === "LANDING")
    return <LandingPoster onJoin={() => go(account ? "/rooms" : "/login")} />;

  if (screen === "LOGIN" && !loginLimited)
    return (
      <main className="v2-page auth-page">
        <button className="text-back" onClick={() => go("/")}>
          返回
        </button>
        <form className="v2-form" onSubmit={login}>
          <ShieldCheck />
          <h1>账号登录</h1>
          <label>
            用户名
            <input
              required
              autoComplete="username"
              value={loginIntent.username}
              onChange={(event) =>
                setLoginIntent({ ...loginIntent, username: event.target.value })
              }
            />
          </label>
          <label>
            密码
            <input
              required
              type="password"
              autoComplete="current-password"
              value={loginIntent.password}
              onChange={(event) =>
                setLoginIntent({ ...loginIntent, password: event.target.value })
              }
            />
          </label>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? <LoaderCircle className="spin" /> : <LogIn />}登录
          </button>
        </form>
      </main>
    );

  if (screen === "LOGIN" && loginLimited)
    return (
      <main className="v2-page">
        <section className="v2-panel">
          <AlertTriangle />
          <h1>设备数量已达上限</h1>
          <p>当前账号已在2台设备登录。继续登录将退出最早登录的设备。</p>
          <div className="device-list">
            {devices.map((device) => (
              <article key={device.id}>
                <strong>{device.deviceName}</strong>
                <span>
                  {device.operatingSystem} · {device.browser}
                </span>
                <small>{device.lastIp}</small>
              </article>
            ))}
          </div>
          <button
            className="danger-button"
            disabled={busy}
            onClick={() => void replaceOldest()}
          >
            退出最早登录设备并继续
          </button>
          <button
            onClick={() => {
              clearPassword();
              setLoginLimited(false);
            }}
          >
            取消登录
          </button>
        </section>
      </main>
    );

  if (screen === "FORBIDDEN")
    return (
      <main className="v2-page">
        <section className="v2-panel">
          <ShieldCheck />
          <h1>403 无权访问</h1>
          <p>当前账号没有访问该页面的权限。</p>
          <button
            className="primary"
            onClick={() => go(account ? "/rooms" : "/login")}
          >
            返回合法页面
          </button>
        </section>
      </main>
    );

  if (!authChecked || !account)
    return (
      <main className="center">
        <LoaderCircle className="spin" />
      </main>
    );

  if (screen === "LOBBY")
    return (
      <Lobby
        account={account}
        rooms={rooms}
        busy={busy}
        error={error}
        onOpen={openRoom}
        onCreate={() => go("/rooms/create")}
        onProfile={() => go("/profile")}
        onAdmin={() => go("/admin")}
        onLogout={logout}
      />
    );
  if (screen === "JOIN" && selectedRoom)
    return (
      <JoinRoom
        room={selectedRoom}
        busy={busy}
        error={error}
        onJoin={joinRoom}
        onBack={leaveRoom}
      />
    );
  if (screen === "CREATE")
    return (
      <CreateRoom
        busy={busy}
        error={error}
        onBack={() => go("/rooms")}
        onCreate={async (input) => {
          const result = await write({ path: "/api/rooms", body: input });
          if (!result.ok) return;
          const refreshed = await run(async () => {
            await loadRooms();
            go("/rooms", true);
          });
          if (refreshed.ok) result.confirm();
        }}
      />
    );
  if (screen === "SEATS" && seats?.membership && !seats.membership.activeHere)
    return (
      <main className="v2-page">
        <section className="v2-panel">
          <ShieldCheck />
          <h1>该房间已在另一台设备打开</h1>
          <button
            className="primary"
            disabled={busy}
            onClick={() => void takeControl()}
          >
            接管本房间
          </button>
          <button onClick={leaveRoom}>返回房间列表</button>
        </section>
      </main>
    );
  if (screen === "WORKBENCH_SELECT" && seats?.membership)
    return (
      <WorkbenchSelector
        membership={seats.membership}
        busy={busy}
        onChoose={chooseWorkbench}
        onManage={() => go(roomPath("seats", seats.room.id))}
        onBack={leaveRoom}
      />
    );
  if (screen === "SEATS" && seats)
    return (
      <SeatsView
        seats={seats}
        busy={busy}
        error={error}
        onChoose={chooseSeat}
        onSwap={requestSwap}
        onSwapAction={roleSwapAction}
        onRefresh={() => loadSeats(seats.room.id, undefined, "MANAGE")}
        onBack={leaveRoom}
      />
    );
  if (screen === "PROFILE")
    return (
      <Profile
        account={account}
        devices={devices}
        busy={busy}
        onRevoke={revokeDevice}
        onLogoutOthers={async () => {
          await run(() =>
            call("/api/auth/sessions/logout-others", { method: "POST" }),
          );
          await loadProfile();
        }}
        onBack={() => go("/rooms")}
      />
    );
  if (screen === "ADMIN")
    return (
      <AdminView
        account={account}
        data={adminData}
        busy={busy}
        error={error}
        onBack={() => go("/rooms")}
        onReload={loadAdmin}
        runAction={run}
        writeAction={write}
        initialTab={
          page === "admin-accounts"
            ? "ACCOUNTS"
            : page === "admin-rooms"
              ? "ROOMS"
              : page === "admin-logs"
                ? "LOGS"
                : "DASHBOARD"
        }
        onTab={(tab) =>
          go(
            tab === "DASHBOARD"
              ? "/admin"
              : tab === "ACCOUNTS"
                ? "/admin/accounts"
                : tab === "ROOMS"
                  ? "/admin/rooms"
                  : "/admin/logs",
          )
        }
      />
    );
  if (screen === "FINISH" && settlementPreview)
    return (
      <FinishPreview
        preview={settlementPreview}
        busy={busy}
        error={error}
        onConfirm={finishRoom}
        onBack={() => go(roomPath("bank", workbench?.roomId))}
      />
    );
  if (screen === "SETTLEMENT" && settlement)
    return <Settlement settlement={settlement} onBack={leaveRoom} />;
  if (screen === "SETTLEMENT" && error)
    return (
      <main className="v2-page">
        <section className="v2-panel">
          <AlertTriangle />
          <h1>结算不可用</h1>
          <p>{error}</p>
          <button className="primary" onClick={() => go("/rooms")}>
            返回房间列表
          </button>
        </section>
      </main>
    );
  if (screen === "GAME" && workbench && snapshot)
    return (
      <Workbench
        context={workbench}
        snapshot={snapshot}
        busy={busy}
        error={error}
        action={gameAction}
        toast={currentToast}
        showNotice={showNotice}
        showToast={showToast}
        refresh={refreshGame}
        switchView={(view) => void chooseWorkbench(view)}
        manageSeats={() => void manageSeats()}
        finish={() => void openFinish()}
        leave={leaveRoom}
      />
    );
  return (
    <main className="center">
      <LoaderCircle className="spin" />
    </main>
  );
}

function Lobby({
  account,
  rooms,
  busy,
  error,
  onOpen,
  onCreate,
  onProfile,
  onAdmin,
  onLogout,
}: {
  account: AccountView;
  rooms: RoomSummary[];
  busy: boolean;
  error: string;
  onOpen: (room: RoomSummary) => void;
  onCreate: () => void;
  onProfile: () => void;
  onAdmin: () => void;
  onLogout: () => void;
}) {
  const [logoutOpen, setLogoutOpen] = useState(false);
  const active = rooms.filter(
    (room) => room.mine && !terminalRoom(room.status),
  );
  const available = rooms.filter(
    (room) => !room.mine && !terminalRoom(room.status),
  );
  const history = rooms.filter(
    (room) => room.mine && terminalRoom(room.status),
  );
  const band = (title: string, list: RoomSummary[]) => (
    <section className="room-band" aria-label={title}>
      <h2>{title}</h2>
      <div className="room-list">
        {list.length ? (
          list.map((room) => (
            <button
              key={room.id}
              className="room-row"
              onClick={() => void onOpen(room)}
            >
              <div>
                <div className="room-title">
                  <strong>{room.name}</strong>
                  <span className="room-status-badges">
                    {roomStatusBadges(room).map((badge) => (
                      <span
                        className={`room-status-badge room-status-${badge.tone}`}
                        key={badge.tone}
                      >
                        {badge.label}
                      </span>
                    ))}
                  </span>
                </div>
                <span>
                  {room.creator} · {room.memberCount} 位成员 ·{" "}
                  {room.playerCount}/{room.playerLimit} 人物
                </span>
                <div className="room-lifecycle">
                  <span>{`创建时间：${formatRoomLifecycleTime(room.createdAt, "")}`}</span>
                  <span>{`开始时间：${formatRoomLifecycleTime(room.startedAt, "未开始")}`}</span>
                  <span>{`结束时间：${formatRoomLifecycleTime(room.endedAt, "未结束")}`}</span>
                </div>
              </div>
              <div>
                <small>
                  {room.hasPassword ? "需密码" : "免密码"} ·{" "}
                  {localizedRoomStatus(room.status)}
                </small>
                {capabilityLabel(room) && <b>{capabilityLabel(room)}</b>}
                <ChevronRight />
              </div>
            </button>
          ))
        ) : (
          <p className="empty">暂无房间</p>
        )}
      </div>
    </section>
  );
  return (
    <main className="v2-page lobby-page">
      <header className="v2-header lobby-hero">
        <div>
          <small>当前账号</small>
          <h1>{account.displayName}</h1>
          <p>@{account.username}</p>
        </div>
        <div>
          <button
            className="icon"
            aria-label="个人信息"
            title="个人信息"
            onClick={() => void onProfile()}
          >
            <Users />
          </button>
          {account.isSuperAdmin && (
            <button
              className="icon"
              aria-label="超管后台"
              title="超管后台"
              onClick={() => void onAdmin()}
            >
              <Crown />
            </button>
          )}
          <button
            className="icon"
            aria-label="退出"
            title="退出"
            disabled={busy}
            onClick={() => setLogoutOpen(true)}
          >
            <LogIn />
          </button>
        </div>
      </header>
      {error && (
        <p className="error banner" role="alert">
          {error}
        </p>
      )}
      {band("我参与的游戏", active)}
      {band("可加入房间", available)}
      {band("历史对局", history)}
      {account.canCreateRoom && (
        <button className="floating-create" disabled={busy} onClick={onCreate}>
          <Building2 />
          创建房间
        </button>
      )}
      {logoutOpen && (
        <ConfirmDialog
          title="确认退出账号"
          confirmLabel="确认退出"
          busy={busy}
          onCancel={() => setLogoutOpen(false)}
          onConfirm={() => void onLogout()}
        >
          <p>退出后需要重新登录才能继续游戏。</p>
        </ConfirmDialog>
      )}
    </main>
  );
}

function JoinRoom({
  room,
  busy,
  error,
  onJoin,
  onBack,
}: {
  room: RoomSummary;
  busy: boolean;
  error: string;
  onJoin: (password?: string) => void;
  onBack: () => void;
}) {
  const [password, setPassword] = useState("");
  return (
    <main className="v2-page">
      <section className="v2-panel">
        <button className="text-back" onClick={onBack}>
          返回房间列表
        </button>
        <Landmark />
        <h1>{room.name}</h1>
        {room.hasPassword && (
          <label>
            房间密码
            <input
              type="password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="primary"
          disabled={busy || (room.hasPassword && !password)}
          onClick={() => void onJoin(password || undefined)}
        >
          加入房间
        </button>
      </section>
    </main>
  );
}

function CreateRoom({
  busy,
  error,
  onBack,
  onCreate,
}: {
  busy: boolean;
  error: string;
  onBack: () => void;
  onCreate: (input: Record<string, unknown>) => void;
}) {
  const [review, setReview] = useState(false);
  const [value, setValue] = useState({
    name: "",
    password: "",
    initialBalance: "5000",
    diceMode: "ELECTRONIC",
    skillEnabled: true,
    startReward: "1000",
    allowMidgameJoin: false,
    visibility: "PUBLIC",
    transferApprovalRequired: false,
  });
  const update = <K extends keyof typeof value>(
    key: K,
    next: (typeof value)[K],
  ) => setValue((current) => ({ ...current, [key]: next }));
  const payload = {
    ...value,
    password: value.password || undefined,
    initialBalance: Number(value.initialBalance),
    startReward: Number(value.startReward),
  };
  const toggle = (
    key: "skillEnabled" | "allowMidgameJoin" | "transferApprovalRequired",
    label: string,
  ) => (
    <label className="toggle-row">
      <span>{label}</span>
      <input
        type="checkbox"
        role="switch"
        checked={value[key]}
        onChange={(event) => update(key, event.target.checked)}
      />
    </label>
  );
  if (review)
    return (
      <main className="v2-page">
        <section className="review-band">
          <button className="text-back" onClick={() => setReview(false)}>
            返回修改
          </button>
          <h1>确认房间设置</h1>
          <dl>
            <div>
              <dt>房间</dt>
              <dd>{value.name}</dd>
            </div>
            <div>
              <dt>密码</dt>
              <dd>{value.password ? "已设置" : "无"}</dd>
            </div>
            <div>
              <dt>资金 / 起点</dt>
              <dd>
                {formatMoney(Number(value.initialBalance))} /{" "}
                {formatMoney(Number(value.startReward))} 两
              </dd>
            </div>
            <div>
              <dt>骰子</dt>
              <dd>
                {value.diceMode === "ELECTRONIC" ? "电子骰子" : "实体骰子"}
              </dd>
            </div>
            <div>
              <dt>人物技能</dt>
              <dd>{value.skillEnabled ? "启用" : "停用"}</dd>
            </div>
            <div>
              <dt>中途加入</dt>
              <dd>{value.allowMidgameJoin ? "允许" : "不允许"}</dd>
            </div>
            <div>
              <dt>可见性</dt>
              <dd>{value.visibility === "PUBLIC" ? "公开" : "私密"}</dd>
            </div>
            <div>
              <dt>转帐审批</dt>
              <dd>{value.transferApprovalRequired ? "需要" : "不需要"}</dd>
            </div>
          </dl>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button
            className="primary"
            disabled={busy}
            onClick={() => void onCreate(payload)}
          >
            <Check />
            确认创建
          </button>
        </section>
      </main>
    );
  return (
    <main className="v2-page">
      <form
        className="v2-form create-form"
        onSubmit={(event) => {
          event.preventDefault();
          setReview(true);
        }}
      >
        <button
          type="button"
          className="text-back room-list-back"
          onClick={onBack}
        >
          🔙 房间列表
        </button>
        <h1>创建房间</h1>
        <label>
          房间名称
          <input
            required
            pattern={".*\\S.*"}
            maxLength={40}
            placeholder="例：翊坤宫夜局"
            value={value.name}
            onChange={(event) => update("name", event.target.value)}
          />
        </label>
        <label>
          房间密码（可选）
          <input
            type="password"
            maxLength={100}
            value={value.password}
            onChange={(event) => update("password", event.target.value)}
          />
        </label>
        <div className="form-grid">
          <label>
            初始资金
            <input
              required
              type="number"
              min="0"
              step="1"
              value={value.initialBalance}
              onChange={(event) => update("initialBalance", event.target.value)}
            />
            <small className="field-lock-note">开局后锁定</small>
          </label>
          <label>
            起点奖励
            <input
              required
              type="number"
              min="0"
              step="1"
              value={value.startReward}
              onChange={(event) => update("startReward", event.target.value)}
            />
            <small className="field-lock-note">开局后锁定</small>
          </label>
        </div>
        <fieldset>
          <legend>骰子模式</legend>
          <div className="segment">
            <button
              type="button"
              aria-pressed={value.diceMode === "ELECTRONIC"}
              onClick={() => update("diceMode", "ELECTRONIC")}
            >
              电子骰子
            </button>
            <button
              type="button"
              aria-pressed={value.diceMode === "PHYSICAL"}
              onClick={() => update("diceMode", "PHYSICAL")}
            >
              实体骰子
            </button>
          </div>
        </fieldset>
        <label>
          房间可见性
          <select
            value={value.visibility}
            onChange={(event) => update("visibility", event.target.value)}
          >
            <option value="PUBLIC">公开房间</option>
            <option value="PRIVATE">私密房间</option>
          </select>
        </label>
        <div className="create-form-toggles">
          {toggle("skillEnabled", "启用人物技能")}
          {toggle("allowMidgameJoin", "允许中途加入")}
          {toggle("transferApprovalRequired", "玩家转帐需要审批")}
        </div>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          检查设置
        </button>
      </form>
    </main>
  );
}

function SeatsView({
  seats,
  busy,
  error,
  onChoose,
  onSwap,
  onSwapAction,
  onRefresh,
  onBack,
}: {
  seats: SeatSnapshot;
  busy: boolean;
  error: string;
  onChoose: (kind: "BANK" | "PLAYER", characterId?: string) => void;
  onSwap: (characterId: string) => void;
  onSwapAction: (
    request: RoleSwapView,
    action: "accept" | "reject" | "approve-bank" | "cancel",
    reason?: string,
  ) => void;
  onRefresh: () => void;
  onBack: () => void;
}) {
  const [rejecting, setRejecting] = useState<RoleSwapView | null>(null);
  const [reason, setReason] = useState("");
  const statusLabel: Record<RoleSwapStatus, string> = {
    PENDING_TARGET: "等待目标决定",
    PENDING_BANK: "等待银行确认",
    APPROVED: "已同意",
    REJECTED: "已拒绝",
    CANCELLED: "已取消",
    EXPIRED: "已过期",
    CONFLICTED: "状态冲突",
  };
  const nameOf = (id: string | null) =>
    id ? (seats.characters.find((item) => item.id === id)?.name ?? id) : "空席";
  const groups = seats.roleSwapRequests.reduce<
    Record<"MINE" | "INBOX" | "BANK", RoleSwapView[]>
  >(
    (result, request) => {
      if (
        request.requesterMembershipId === seats.membership?.id ||
        request.actions.canCancel
      )
        result.MINE.push(request);
      else if (
        request.status === "PENDING_BANK" ||
        request.actions.canApproveBank
      )
        result.BANK.push(request);
      else if (request.targetMembershipId === seats.membership?.id)
        result.INBOX.push(request);
      else result.BANK.push(request);
      return result;
    },
    { MINE: [], INBOX: [], BANK: [] },
  );
  const swapCard = (request: RoleSwapView) => (
    <article key={request.id}>
      <div>
        <strong>
          {request.requesterDisplayName} → {request.targetDisplayName}
        </strong>
        <span>
          {nameOf(request.requesterCharacterId)} /{" "}
          {nameOf(request.targetCharacterId)}
        </span>
        <small>
          {new Date(request.createdAt).toLocaleString("zh-CN")} ·{" "}
          {statusLabel[request.status]}
        </small>
        {request.rejectionReason && <p>原因：{request.rejectionReason}</p>}
      </div>
      <div className="request-actions">
        {request.actions.canAccept && (
          <button
            disabled={busy}
            onClick={() => void onSwapAction(request, "accept")}
          >
            接受交换
          </button>
        )}
        {request.actions.canReject && (
          <button
            disabled={busy}
            onClick={() => {
              setReason("");
              setRejecting(request);
            }}
          >
            拒绝交换
          </button>
        )}
        {request.actions.canApproveBank && (
          <button
            disabled={busy}
            onClick={() => void onSwapAction(request, "approve-bank")}
          >
            银行确认
          </button>
        )}
        {request.actions.canCancel && (
          <button
            disabled={busy}
            onClick={() => void onSwapAction(request, "cancel")}
          >
            取消申请
          </button>
        )}
      </div>
    </article>
  );
  const swapGroup = (title: string, requests: RoleSwapView[]) => (
    <section className="swap-group">
      <h3>{title}</h3>
      {requests.length ? (
        <div className="swap-list">{requests.map(swapCard)}</div>
      ) : (
        <p className="empty">暂无项目</p>
      )}
    </section>
  );
  return (
    <main className="v2-page seats-page">
      <header className="v2-header">
        <button onClick={onBack}>房间列表</button>
        <div>
          <small>席位与能力</small>
          <h1>选择席位</h1>
          <p>{seats.room.name}</p>
        </div>
        <button
          className="icon"
          aria-label="刷新页面"
          title="刷新页面"
          onClick={() => void onRefresh()}
        >
          <RefreshCw />
        </button>
      </header>
      {error && (
        <div className="error banner" role="alert">
          <p>{error}</p>
          <div>
            <button onClick={() => void onRefresh()}>刷新页面</button>
            <button onClick={onBack}>返回房间列表</button>
          </div>
        </div>
      )}
      <div className="capability-summary" role="status">
        <strong>当前能力</strong>
        <span>
          {seats.membership?.characterId
            ? nameOf(seats.membership.characterId)
            : "未选择人物"}
        </span>
        <span>{seats.membership?.isBank ? "兼任银行" : "未担任银行"}</span>
      </div>
      <section className="seat-grid" aria-label="人物席位">
        {seats.characters.map((character) => {
          const own = seats.membership?.characterId === character.id;
          return (
            <article
              className={`seat-card character-${character.id} ${character.occupiedBy ? "occupied" : ""}`}
              key={character.id}
            >
              {character.occupiedBy && <b className="occupied-mark">已占用</b>}
              <h2>{character.name}</h2>
              <div className="character-divider" aria-hidden="true" />
              <p>
                {formatCharacterSkill(
                  character.id,
                  character.skill,
                  seats.room.skillEnabled,
                )}
              </p>
              <small>初始宫殿：{character.initialProperty}</small>
              {character.occupiedBy ? (
                <>
                  <span>当前玩家：{character.occupiedBy}</span>
                  {!own && (
                    <button
                      disabled={busy}
                      onClick={() => void onSwap(character.id)}
                    >
                      申请交换
                    </button>
                  )}
                </>
              ) : !seats.membership?.characterId && character.canSelect ? (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => void onChoose("PLAYER", character.id)}
                >
                  选择角色
                </button>
              ) : (
                <span>
                  {seats.membership?.characterId
                    ? "已有人物，仅可申请交换"
                    : "当前不可选择"}
                </span>
              )}
            </article>
          );
        })}
        <article
          className={`seat-card bank-seat ${seats.bank.occupiedBy ? "occupied" : ""}`}
        >
          {seats.bank.occupiedBy && <b className="occupied-mark">已占用</b>}
          <Landmark />
          <h2>银行</h2>
          <p>管理审批、轮次与结算</p>
          {seats.bank.occupiedBy ? (
            <span>当前银行：{seats.bank.occupiedBy}</span>
          ) : (
            <button
              className="primary"
              disabled={busy || Boolean(seats.membership?.isBank)}
              onClick={() => void onChoose("BANK")}
            >
              {seats.membership?.characterId ? "兼任银行" : "选择银行"}
            </button>
          )}
        </article>
      </section>
      <section className="swap-band" aria-label="角色交换">
        <div className="section-title">
          <h2>角色交换</h2>
          <span>{seats.roleSwapRequests.length} 项</span>
        </div>
        {swapGroup("我的申请", groups.MINE)}
        {swapGroup("待我处理", groups.INBOX)}
        {swapGroup("银行确认", groups.BANK)}
      </section>
      {rejecting && (
        <ConfirmDialog
          title="拒绝角色交换"
          confirmLabel="确认拒绝"
          busy={busy}
          disabled={!reason.trim()}
          onCancel={() => setRejecting(null)}
          onConfirm={() => {
            void onSwapAction(rejecting, "reject", reason.trim());
            setRejecting(null);
          }}
        >
          <p>
            {rejecting.requesterDisplayName} 的交换申请将被拒绝，原因会保留。
          </p>
          <label>
            拒绝原因
            <textarea
              autoFocus
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
        </ConfirmDialog>
      )}
    </main>
  );
}

function Profile({
  account,
  devices,
  busy,
  onRevoke,
  onLogoutOthers,
  onBack,
}: {
  account: AccountView;
  devices: DeviceView[];
  busy: boolean;
  onRevoke: (id: string) => void;
  onLogoutOthers: () => void;
  onBack: () => void;
}) {
  const [confirm, setConfirm] = useState<{
    kind: "ONE" | "OTHERS";
    device?: DeviceView;
  } | null>(null);
  return (
    <main className="v2-page">
      <header className="v2-header">
        <button className="room-list-back" onClick={onBack}>
          🔙 房间列表
        </button>
        <h1>个人信息</h1>
      </header>
      <section className="profile-summary">
        <strong>{account.displayName}</strong>
        <span>@{account.username}</span>
        <p>
          {account.canCreateRoom ? "可创建房间" : "不可创建房间"} · 最近登录{" "}
          {account.lastLoginAt
            ? new Date(account.lastLoginAt).toLocaleString("zh-CN")
            : "暂无记录"}
        </p>
      </section>
      <section className="room-band" aria-label="已登录设备">
        <h2>已登录设备</h2>
        <div className="device-list">
          {devices.map((device) => (
            <article key={device.id}>
              <div>
                <strong>
                  {device.deviceName}
                  {device.current && <b>当前设备</b>}
                </strong>
                <span>
                  {device.operatingSystem} · {device.browser}
                </span>
                <small>
                  登录 IP {device.loginIp} · 最近 IP {device.lastIp}
                </small>
                <small>
                  登录 {new Date(device.createdAt).toLocaleString("zh-CN")}
                </small>
                <small>
                  活跃 {new Date(device.lastActiveAt).toLocaleString("zh-CN")}
                </small>
              </div>
              {!device.current && (
                <button
                  disabled={busy}
                  onClick={() => setConfirm({ kind: "ONE", device })}
                >
                  退出设备
                </button>
              )}
            </article>
          ))}
        </div>
        <button
          disabled={busy || devices.length < 2}
          onClick={() => setConfirm({ kind: "OTHERS" })}
        >
          退出其他所有设备
        </button>
      </section>
      {confirm && (
        <ConfirmDialog
          title={confirm.kind === "ONE" ? "退出指定设备" : "退出其他所有设备"}
          confirmLabel="确认退出"
          busy={busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            if (confirm.kind === "ONE" && confirm.device)
              void onRevoke(confirm.device.id);
            else void onLogoutOthers();
            setConfirm(null);
          }}
        >
          <p>
            {confirm.kind === "ONE"
              ? `${confirm.device?.deviceName} 将立即失去登录状态。`
              : "除当前设备外，其他设备将立即失去登录状态。"}
          </p>
        </ConfirmDialog>
      )}
    </main>
  );
}

function AdminView({
  account,
  data,
  busy,
  error,
  onBack,
  onReload,
  runAction,
  writeAction,
  initialTab,
  onTab,
}: {
  account: AccountView;
  data: AdminData;
  busy: boolean;
  error: string;
  onBack: () => void;
  onReload: () => Promise<RunResult<AdminData>>;
  runAction: TaskRunner;
  writeAction: StableWriter;
  initialTab: "DASHBOARD" | "ACCOUNTS" | "ROOMS" | "LOGS";
  onTab: (tab: "DASHBOARD" | "ACCOUNTS" | "ROOMS" | "LOGS") => void;
}) {
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--admin-display-name",
      JSON.stringify(account.displayName),
    );
    return () => {
      document.documentElement.style.removeProperty("--admin-display-name");
    };
  }, [account.displayName]);
  const tab = initialTab;
  const [selectedAccount, setSelectedAccount] = useState<AdminAccount | null>(
    null,
  );
  const [accountDevices, setAccountDevices] = useState<AdminDevice[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<AdminRoomDetail | null>(
    null,
  );
  const [roomLogs, setRoomLogs] = useState<
    Array<{
      id: string;
      action: string;
      actorRole: string | null;
      reason: string | null;
      createdAt: string;
    }>
  >([]);
  const [confirm, setConfirm] = useState<{
    title: string;
    copy: string;
    expectedValues?: string[];
    confirmationHint?: string;
    fieldLabel?: string;
    run: () => Promise<boolean | void>;
  } | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const [newAccount, setNewAccount] = useState({
    username: "",
    password: "",
    displayName: "",
    note: "",
    canCreateRoom: false,
  });
  const [accountDraft, setAccountDraft] = useState({
    displayName: "",
    note: "",
    canCreateRoom: false,
    password: "",
  });
  const [roomDraft, setRoomDraft] = useState({
    name: "",
    visibility: "PUBLIC",
    diceMode: "ELECTRONIC",
    initialBalance: "0",
    startReward: "0",
    skillEnabled: true,
    allowMidgameJoin: false,
    transferApprovalRequired: false,
    password: "",
    bankMembershipId: "",
    forceReason: "",
  });
  const [accountSaveState, setAccountSaveState] = useState<
    "IDLE" | "SAVING" | "SUCCESS" | "ERROR"
  >("IDLE");
  const [roomSaveState, setRoomSaveState] = useState<
    "IDLE" | "SAVING" | "SUCCESS" | "ERROR"
  >("IDLE");
  const [roomLifecycleNotice, setRoomLifecycleNotice] = useState("");
  const accountSaveTimer = useRef<number | null>(null);
  const roomSaveTimer = useRef<number | null>(null);
  async function refreshAccount(account: AdminAccount) {
    const devices = await loadAllPages<AdminDevice>(
      `/api/admin/accounts/${account.id}/sessions?state=recent&limit=100`,
    );
    setSelectedAccount(account);
    setAccountDevices(devices);
    setAccountDraft({
      displayName: account.displayName,
      note: account.note ?? "",
      canCreateRoom: account.canCreateRoom,
      password: "",
    });
  }

  async function saveAccountConfiguration() {
    if (!selectedAccount || accountSaveState === "SAVING") return;
    const draft = {
      displayName: accountDraft.displayName,
      note: accountDraft.note || null,
      canCreateRoom: accountDraft.canCreateRoom,
    };
    const input = Object.fromEntries(
      Object.entries(draft).filter(
        ([key, value]) => selectedAccount[key as keyof typeof draft] !== value,
      ),
    );
    if (accountSaveTimer.current !== null)
      window.clearTimeout(accountSaveTimer.current);
    if (Object.keys(input).length === 0) {
      setAccountSaveState("SUCCESS");
      return;
    }
    setAccountSaveState("SAVING");
    const result = await writeAction({
      path: `/api/admin/accounts/${selectedAccount.id}`,
      body: input,
      method: "PATCH",
    });
    if (!result.ok) {
      setAccountSaveState("ERROR");
      return;
    }
    const reloaded = await onReload();
    if (!reloaded.ok) {
      setAccountSaveState("ERROR");
      return;
    }
    const refreshed = reloaded.value.accounts.find(
      (account) => account.id === selectedAccount.id,
    );
    if (!refreshed) {
      setAccountSaveState("ERROR");
      return;
    }
    await refreshAccount(refreshed);
    if (
      !Object.entries(input).every(
        ([key, value]) => refreshed[key as keyof typeof draft] === value,
      )
    ) {
      setAccountSaveState("ERROR");
      return;
    }
    result.confirm();
    setAccountSaveState("SUCCESS");
    accountSaveTimer.current = window.setTimeout(
      () => setAccountSaveState("IDLE"),
      3_000,
    );
  }

  async function refreshRoom(roomId: string) {
    const [detail, logs] = await Promise.all([
      call<AdminRoomDetail>(`/api/admin/rooms/${roomId}`),
      loadAllPages<(typeof roomLogs)[number]>(
        `/api/admin/rooms/${roomId}/audit-logs?limit=100`,
      ),
    ]);
    if (
      selectedRoom?.id === roomId &&
      selectedRoom.status === "LOBBY" &&
      detail.status !== "LOBBY"
    )
      setRoomLifecycleNotice("房间已开始，部分规则已锁定");
    setSelectedRoom(detail);
    setRoomLogs(logs);
    setRoomDraft({
      name: detail.name,
      visibility: detail.configuration.visibility,
      diceMode: detail.configuration.diceMode,
      initialBalance: String(detail.configuration.initialBalance),
      startReward: String(detail.configuration.startReward),
      skillEnabled: detail.configuration.skillEnabled,
      allowMidgameJoin: detail.configuration.allowMidgameJoin,
      transferApprovalRequired: detail.configuration.transferApprovalRequired,
      password: "",
      bankMembershipId:
        detail.members.find((member) => member.isBank)?.id ?? "",
      forceReason: "",
    });
    return detail;
  }

  async function saveRoomConfiguration() {
    if (!selectedRoom || roomSaveState === "SAVING") return;
    const roomRulesLocked = selectedRoom.status !== "LOBBY";
    const lockedKeys = new Set([
      "diceMode",
      "initialBalance",
      "startReward",
      "skillEnabled",
    ]);
    const draft = {
      name: roomDraft.name,
      visibility: roomDraft.visibility,
      diceMode: roomDraft.diceMode,
      initialBalance: Number(roomDraft.initialBalance),
      startReward: Number(roomDraft.startReward),
      skillEnabled: roomDraft.skillEnabled,
      allowMidgameJoin: roomDraft.allowMidgameJoin,
      transferApprovalRequired: roomDraft.transferApprovalRequired,
    };
    const input = Object.fromEntries(
      Object.entries(draft).filter(
        ([key, value]) =>
          (key === "name"
            ? selectedRoom.name !== value
            : selectedRoom.configuration[
                key as keyof AdminRoomDetail["configuration"]
              ] !== value) &&
          (!roomRulesLocked || !lockedKeys.has(key)),
      ),
    );
    if (roomSaveTimer.current !== null)
      window.clearTimeout(roomSaveTimer.current);
    if (Object.keys(input).length === 0) return;
    setRoomSaveState("SAVING");
    const result = await writeAction({
      path: `/api/admin/rooms/${selectedRoom.id}`,
      body: input,
      method: "PATCH",
    });
    if (!result.ok) {
      setRoomSaveState("ERROR");
      return;
    }
    const reloaded = await onReload();
    if (!reloaded.ok) {
      setRoomSaveState("ERROR");
      return;
    }
    const refreshed = await runAction(() => refreshRoom(selectedRoom.id));
    if (!refreshed.ok) {
      setRoomSaveState("ERROR");
      return;
    }
    const matched = Object.entries(input).every(([key, value]) =>
      key === "name"
        ? refreshed.value.name === value
        : refreshed.value.configuration[
            key as keyof AdminRoomDetail["configuration"]
          ] === value,
    );
    if (!matched) {
      setRoomSaveState("ERROR");
      return;
    }
    result.confirm();
    setRoomSaveState("SUCCESS");
    roomSaveTimer.current = window.setTimeout(
      () => setRoomSaveState("IDLE"),
      3_000,
    );
  }

  const roomConfigurationHasChanges = selectedRoom
    ? (() => {
        const locked = selectedRoom.status !== "LOBBY";
        const draft = {
          name: roomDraft.name,
          visibility: roomDraft.visibility,
          diceMode: roomDraft.diceMode,
          initialBalance: Number(roomDraft.initialBalance),
          startReward: Number(roomDraft.startReward),
          skillEnabled: roomDraft.skillEnabled,
          allowMidgameJoin: roomDraft.allowMidgameJoin,
          transferApprovalRequired: roomDraft.transferApprovalRequired,
        };
        return Object.entries(draft).some(
          ([key, value]) =>
            (key === "name"
              ? selectedRoom.name !== value
              : selectedRoom.configuration[
                  key as keyof AdminRoomDetail["configuration"]
                ] !== value) &&
            (!locked ||
              ![
                "diceMode",
                "initialBalance",
                "startReward",
                "skillEnabled",
              ].includes(key)),
        );
      })()
    : false;

  async function mutateAndReload(
    path: string,
    body: Record<string, unknown> = {},
    method = "POST",
    roomId?: string,
    accountId?: string,
  ) {
    const targetAccountId =
      accountId ??
      (selectedAccount &&
      path.startsWith(`/api/admin/accounts/${selectedAccount.id}`)
        ? selectedAccount.id
        : undefined);
    const result = await writeAction({ path, body, method });
    if (!result.ok) return false;
    const reloaded = await onReload();
    if (!reloaded.ok) return false;
    if (roomId) {
      const detail = await runAction(() => refreshRoom(roomId));
      if (!detail.ok) return false;
    }
    if (targetAccountId) {
      const refreshedAccount = reloaded.value.accounts.find(
        (account) => account.id === targetAccountId,
      );
      if (refreshedAccount) {
        const detail = await runAction(() => refreshAccount(refreshedAccount));
        if (!detail.ok) return false;
      } else {
        setSelectedAccount(null);
        setAccountDevices([]);
      }
    }
    result.confirm();
    return true;
  }

  const tabs = [
    { id: "DASHBOARD", label: "数据看板" },
    { id: "ACCOUNTS", label: "账号" },
    { id: "ROOMS", label: "房间" },
    { id: "LOGS", label: "安全日志" },
  ] as const;
  function activateTab(next: typeof tab, focus = false) {
    onTab(next);
    if (focus)
      window.requestAnimationFrame(() =>
        document.getElementById(`admin-tab-${next.toLowerCase()}`)?.focus(),
      );
  }
  function navigateTabs(event: ReactKeyboardEvent<HTMLButtonElement>) {
    const currentIndex = tabs.findIndex((item) => item.id === tab);
    let nextIndex: number;
    if (event.key === "ArrowRight")
      nextIndex = (currentIndex + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = tabs.length - 1;
    else return;
    event.preventDefault();
    activateTab(tabs[nextIndex].id, true);
  }

  const dashboard = data.dashboard;
  return (
    <main className="v2-page admin-page">
      <header className="v2-header">
        <button className="room-list-back" onClick={onBack}>
          🔙 房间列表
        </button>
        <div>
          <small>账号、设备、房间与审计</small>
          <h1>超级管理员</h1>
        </div>
        <button
          className="icon"
          aria-label="刷新后台"
          title="刷新后台"
          onClick={() => void onReload()}
        >
          <RefreshCw />
        </button>
      </header>
      <div className="admin-tabs" role="tablist" aria-label="后台视图">
        {tabs.map((item) => (
          <button
            key={item.id}
            id={`admin-tab-${item.id.toLowerCase()}`}
            role="tab"
            aria-selected={tab === item.id}
            aria-controls={`admin-panel-${item.id.toLowerCase()}`}
            tabIndex={tab === item.id ? 0 : -1}
            onKeyDown={navigateTabs}
            onClick={() => activateTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="error banner" role="alert">
          {error}
        </p>
      )}
      {tab === "DASHBOARD" && dashboard && (
        <div
          className="admin-workspace"
          role="tabpanel"
          id="admin-panel-dashboard"
          aria-labelledby="admin-tab-dashboard"
        >
          <section className="dashboard-strip" aria-label="核心指标">
            <div>
              <span>账号</span>
              <strong>
                {dashboard.accounts.active}/{dashboard.accounts.total}
              </strong>
            </div>
            <div>
              <span>有效会话</span>
              <strong>{dashboard.sessions.valid}</strong>
            </div>
            <div>
              <span>进行中</span>
              <strong>{dashboard.rooms.playing}</strong>
            </div>
            <div>
              <span>已结算</span>
              <strong>{dashboard.rooms.finished}</strong>
            </div>
            <div>
              <span>总对局</span>
              <strong>{dashboard.games.settledTotal}</strong>
            </div>
            <div>
              <span>平均时长</span>
              <strong>
                {Math.round(dashboard.games.averageDurationSeconds / 60)} 分
              </strong>
            </div>
          </section>
          <section className="admin-band">
            <h2>人物选择 / 获胜</h2>
            <div className="aggregate-grid">
              <div>
                {dashboard.characterSelections.map((item) => (
                  <p key={item.characterId}>
                    <span>{item.characterNameSnapshot}</span>
                    <b>{item.count} 次选择</b>
                  </p>
                ))}
              </div>
              <div>
                {dashboard.characterWins.map((item) => (
                  <p key={item.characterNameSnapshot}>
                    <span>{item.characterNameSnapshot}</span>
                    <b>{item.count} 次获胜</b>
                  </p>
                ))}
              </div>
            </div>
          </section>
          <section className="admin-band">
            <h2>最近结束对局</h2>
            {dashboard.recentGames.map((game) => (
              <article
                className="admin-row"
                key={`${game.roomId}-${game.endedAt}`}
              >
                <div>
                  <strong>{game.roomNameSnapshot}</strong>
                  <span>
                    {new Date(game.endedAt).toLocaleString("zh-CN")} ·{" "}
                    {Math.round(game.durationSeconds / 60)} 分钟
                  </span>
                </div>
                <small>
                  {game.forced ? "强制结束" : "正常结束"} ·{" "}
                  {game.winners
                    .map((winner) => winner.displayNameSnapshot)
                    .join("、")}
                </small>
              </article>
            ))}
          </section>
        </div>
      )}
      {tab !== "DASHBOARD" && (
        <div
          role="tabpanel"
          id={`admin-panel-${tab.toLowerCase()}`}
          aria-labelledby={`admin-tab-${tab.toLowerCase()}`}
        >
          {tab === "ACCOUNTS" && (
            <div className="admin-workspace">
              <form
                className="admin-create"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutateAndReload("/api/admin/accounts", newAccount);
                }}
              >
                <h2>新增账号</h2>
                <input
                  aria-label="新用户名"
                  required
                  minLength={3}
                  placeholder="用户名"
                  value={newAccount.username}
                  onChange={(event) =>
                    setNewAccount({
                      ...newAccount,
                      username: event.target.value,
                    })
                  }
                />
                <input
                  aria-label="新用户昵称"
                  required
                  placeholder="用户昵称"
                  value={newAccount.displayName}
                  onChange={(event) =>
                    setNewAccount({
                      ...newAccount,
                      displayName: event.target.value,
                    })
                  }
                />
                <input
                  aria-label="初始密码"
                  required
                  minLength={8}
                  type="password"
                  placeholder="初始密码"
                  value={newAccount.password}
                  onChange={(event) =>
                    setNewAccount({
                      ...newAccount,
                      password: event.target.value,
                    })
                  }
                />
                <input
                  aria-label="账号备注"
                  placeholder="备注"
                  value={newAccount.note}
                  onChange={(event) =>
                    setNewAccount({ ...newAccount, note: event.target.value })
                  }
                />
                <label className="toggle-row">
                  <span>允许创建房间</span>
                  <input
                    type="checkbox"
                    checked={newAccount.canCreateRoom}
                    onChange={(event) =>
                      setNewAccount({
                        ...newAccount,
                        canCreateRoom: event.target.checked,
                      })
                    }
                  />
                </label>
                <button className="primary" disabled={busy}>
                  创建账号
                </button>
              </form>
              <section className="admin-band">
                <h2>账号管理</h2>
                {data.accounts.map((item) => (
                  <div className="admin-item" key={item.id}>
                    <article className="admin-row">
                      <div>
                        <strong>{item.displayName}</strong>
                        <span>
                          @{item.username} ·{" "}
                          {item.status === "ACTIVE" ? "启用" : "禁用"}
                        </span>
                      </div>
                      <small>
                        {item.isSuperAdmin ? "超管" : "普通"} ·{" "}
                        {item.canCreateRoom ? "可建房" : "不可建房"}
                      </small>
                      <button onClick={() => void refreshAccount(item)}>
                        管理
                      </button>
                    </article>
                    <div id={`admin-account-detail-host-${item.id}`} />
                  </div>
                ))}
              </section>
              {selectedAccount &&
                createPortal(
                  <section className="admin-detail">
                    <header>
                      <div>
                        <small>@{selectedAccount.username}</small>
                        <h2>管理 {selectedAccount.displayName}</h2>
                      </div>
                      <button
                        className="close-icon"
                        aria-label="关闭"
                        title="关闭"
                        onClick={() => setSelectedAccount(null)}
                      >
                        <X />
                      </button>
                    </header>
                    <label>
                      昵称
                      <input
                        value={accountDraft.displayName}
                        onChange={(event) =>
                          setAccountDraft({
                            ...accountDraft,
                            displayName: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label>
                      备注
                      <textarea
                        value={accountDraft.note}
                        onChange={(event) =>
                          setAccountDraft({
                            ...accountDraft,
                            note: event.target.value,
                          })
                        }
                      />
                    </label>
                    <label className="toggle-row">
                      <span>创建房间权限</span>
                      <input
                        type="checkbox"
                        checked={accountDraft.canCreateRoom}
                        onChange={(event) =>
                          setAccountDraft({
                            ...accountDraft,
                            canCreateRoom: event.target.checked,
                          })
                        }
                      />
                    </label>
                    <div className="room-save-controls">
                      <button
                        className={`primary ${accountSaveState === "SUCCESS" ? "saved" : ""}`}
                        disabled={busy || accountSaveState === "SAVING"}
                        onClick={() => void saveAccountConfiguration()}
                      >
                        {accountSaveState === "SAVING" ? (
                          <>
                            <LoaderCircle className="spin" />
                            正在保存
                          </>
                        ) : accountSaveState === "SUCCESS" ? (
                          <>
                            <Check />
                            已保存并生效
                          </>
                        ) : (
                          "保存账号"
                        )}
                      </button>
                      {accountSaveState === "SAVING" && (
                        <p className="room-save-status" role="status">
                          正在保存账号信息
                        </p>
                      )}
                      {accountSaveState === "SUCCESS" && (
                        <p className="room-save-status success" role="status">
                          <Check />
                          已保存并生效
                        </p>
                      )}
                      {accountSaveState === "ERROR" && (
                        <p className="room-save-status error" role="alert">
                          保存后未能确认账号信息，请刷新后重试。
                        </p>
                      )}
                    </div>
                    <div className="inline-form">
                      <input
                        aria-label="重置后的密码"
                        type="password"
                        minLength={8}
                        placeholder="新密码"
                        value={accountDraft.password}
                        onChange={(event) =>
                          setAccountDraft({
                            ...accountDraft,
                            password: event.target.value,
                          })
                        }
                      />
                      <button
                        disabled={accountDraft.password.length < 8}
                        onClick={() =>
                          setConfirm({
                            title: "重置账号密码",
                            copy: `${selectedAccount.displayName} 的全部现有登录会立即失效。`,
                            run: async () => {
                              await mutateAndReload(
                                `/api/admin/accounts/${selectedAccount.id}/reset-password`,
                                { password: accountDraft.password },
                              );
                            },
                          })
                        }
                      >
                        重置密码
                      </button>
                    </div>
                    <button
                      className="danger-button"
                      title={selectedAccount.isSuperAdmin ? "超级管理员账号不能禁用" : undefined}
                      disabled={busy || selectedAccount.isSuperAdmin}
                      onClick={() =>
                        setConfirm({
                          title:
                            selectedAccount.status === "ACTIVE"
                              ? "禁用账号"
                              : "启用账号",
                          copy:
                            selectedAccount.status === "ACTIVE"
                              ? `${selectedAccount.displayName} 将无法登录，全部会话立即失效。`
                              : `${selectedAccount.displayName} 可重新登录，旧会话不会恢复。`,
                          run: async () => {
                            await mutateAndReload(
                              `/api/admin/accounts/${selectedAccount.id}/${selectedAccount.status === "ACTIVE" ? "disable" : "enable"}`,
                            );
                          },
                        })
                      }
                    >
                      {selectedAccount.status === "ACTIVE"
                        ? "禁用账号"
                        : "启用账号"}
                    </button>
                    <button
                      className="danger-button"
                      title={selectedAccount.isSuperAdmin ? "超级管理员账号不能删除" : undefined}
                      disabled={busy || selectedAccount.isSuperAdmin}
                      onClick={() => {
                        setConfirmName("");
                        setConfirm({
                          title: "删除账号",
                          fieldLabel: "确认删除账号",
                          expectedValues: [
                            selectedAccount.username,
                            selectedAccount.displayName,
                          ],
                          confirmationHint: `请输入用户名或昵称：${selectedAccount.username} / ${selectedAccount.displayName}`,
                          copy: `${selectedAccount.displayName} 的全部房间数据将被永久清除，且无法恢复。`,
                          run: async () => {
                            const deleted = await mutateAndReload(
                              `/api/admin/accounts/${selectedAccount.id}`,
                              {},
                              "DELETE",
                            );
                            if (deleted) {
                              setSelectedAccount(null);
                              setAccountDevices([]);
                            }
                            return deleted;
                          },
                        });
                      }}
                    >
                      删除账号
                    </button>
                    <h3>目标账号设备</h3>
                    {accountDevices.map((device) => (
                      <article className="device-admin-row" key={device.id}>
                        <div>
                          <strong>{device.deviceName}</strong>
                          <span>
                            {device.operatingSystem} · {device.browser} ·{" "}
                            {device.loginIp}
                          </span>
                          <small>
                            {device.active
                              ? "有效"
                              : `已注销：${device.revokeReason ?? "未知原因"}`}{" "}
                            · 活跃{" "}
                            {new Date(device.lastActiveAt).toLocaleString(
                              "zh-CN",
                            )}
                          </small>
                        </div>
                        {device.active && (
                          <button
                            onClick={() => {
                              const reason = "管理员注销设备";
                              setConfirm({
                                title: "注销目标设备",
                                copy: `${device.deviceName} 将立即失去登录状态，原因：${reason}`,
                                run: async () => {
                                  await mutateAndReload(
                                    `/api/admin/accounts/${selectedAccount.id}/sessions/${device.id}/revoke`,
                                    { reason },
                                  );
                                },
                              });
                            }}
                          >
                            注销
                          </button>
                        )}
                      </article>
                    ))}
                  </section>,
                  document.getElementById(
                    `admin-account-detail-host-${selectedAccount.id}`,
                  ) ?? document.body,
                )}
            </div>
          )}
          {tab === "ROOMS" && (
            <div className="admin-workspace">
              <section className="admin-band">
                <h2>全部房间</h2>
                {data.rooms.map((room) => (
                  <div className="admin-item" key={room.id}>
                    <article className="admin-row">
                      <div>
                        <strong>{room.name}</strong>
                        <span>
                          {localizedRoomStatus(room.status)} ·{" "}
                          {room.memberCount} 成员 · {room.playerCount} 人物
                        </span>
                        <div className="room-lifecycle">
                          <span>{`创建时间：${formatRoomLifecycleTime(room.createdAt, "")}`}</span>
                          <span>{`开始时间：${formatRoomLifecycleTime(room.startedAt, "未开始")}`}</span>
                          <span>{`结束时间：${formatRoomLifecycleTime(room.settlement?.endedAt ?? null, "未结束")}`}</span>
                        </div>
                      </div>
                      <small>
                        {room.visibility === "PUBLIC" ? "公开" : "私密"} ·{" "}
                        {room.hasPassword ? "有密码" : "无密码"} ·{" "}
                        {room.hasBank ? "有银行" : "无银行"}
                      </small>
                      <button onClick={() => void refreshRoom(room.id)}>
                        管理
                      </button>
                    </article>
                    <div id={`admin-room-detail-host-${room.id}`} />
                  </div>
                ))}
              </section>
              {selectedRoom &&
                createPortal(
                  <section className="admin-detail">
                    <header>
                      <div>
                        <small>
                          {selectedRoom.code} ·{" "}
                          {localizedRoomStatus(selectedRoom.status)}
                        </small>
                        <h2>{selectedRoom.name}</h2>
                      </div>
                      <button
                        className="close-icon"
                        aria-label="关闭"
                        title="关闭"
                        onClick={() => setSelectedRoom(null)}
                      >
                        <X />
                      </button>
                    </header>
                    {roomLifecycleNotice && (
                      <p className="room-save-status" role="status">
                        {roomLifecycleNotice}
                      </p>
                    )}
                    <div className="dashboard-strip">
                      <div>
                        <span>待审批</span>
                        <strong>{selectedRoom.blockers.pendingRequests}</strong>
                      </div>
                      <div>
                        <span>待交换</span>
                        <strong>{selectedRoom.blockers.pendingSwaps}</strong>
                      </div>
                      <div>
                        <span>债务</span>
                        <strong>{selectedRoom.blockers.openDebts}</strong>
                      </div>
                      <div>
                        <span>进行回合</span>
                        <strong>{selectedRoom.blockers.activeTurns}</strong>
                      </div>
                    </div>
                    <div className="form-grid">
                      <label>
                        房间名称
                        <input
                          value={roomDraft.name}
                          onChange={(event) =>
                            setRoomDraft({
                              ...roomDraft,
                              name: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        可见性
                        <select
                          value={roomDraft.visibility}
                          onChange={(event) =>
                            setRoomDraft({
                              ...roomDraft,
                              visibility: event.target.value,
                            })
                          }
                        >
                          <option value="PUBLIC">公开</option>
                          <option value="PRIVATE">私密</option>
                        </select>
                      </label>
                      <label>
                        骰子
                        <select
                          disabled={selectedRoom.status !== "LOBBY"}
                          value={roomDraft.diceMode}
                          onChange={(event) =>
                            setRoomDraft({
                              ...roomDraft,
                              diceMode: event.target.value,
                            })
                          }
                        >
                          <option value="ELECTRONIC">电子骰子</option>
                          <option value="PHYSICAL">实体骰子</option>
                        </select>
                        <small className="field-lock-note">开局后锁定</small>
                      </label>
                      <label>
                        初始资金
                        <input
                          disabled={selectedRoom.status !== "LOBBY"}
                          type="number"
                          min="0"
                          value={roomDraft.initialBalance}
                          onChange={(event) =>
                            setRoomDraft({
                              ...roomDraft,
                              initialBalance: event.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        起点奖励
                        <input
                          disabled={selectedRoom.status !== "LOBBY"}
                          type="number"
                          min="0"
                          value={roomDraft.startReward}
                          onChange={(event) =>
                            setRoomDraft({
                              ...roomDraft,
                              startReward: event.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                    {(
                      [
                        "skillEnabled",
                        "allowMidgameJoin",
                        "transferApprovalRequired",
                      ] as const
                    ).map((key) => (
                      <label className="toggle-row" key={key}>
                        <span>
                          {
                            {
                              skillEnabled: "人物技能",
                              allowMidgameJoin: "中途加入",
                              transferApprovalRequired: "转帐审批",
                            }[key]
                          }
                        </span>
                        <input
                          type="checkbox"
                          disabled={
                            selectedRoom.status !== "LOBBY" &&
                            key === "skillEnabled"
                          }
                          checked={roomDraft[key]}
                          onChange={(event) =>
                            setRoomDraft({
                              ...roomDraft,
                              [key]: event.target.checked,
                            })
                          }
                        />
                        {selectedRoom.status !== "LOBBY" &&
                          key === "skillEnabled" && (
                            <small className="field-lock-note">
                              开局后锁定
                            </small>
                          )}
                      </label>
                    ))}
                    <div className="room-save-controls">
                      <button
                        className={`primary ${roomSaveState === "SUCCESS" ? "saved" : ""}`}
                        disabled={
                          busy ||
                          roomSaveState === "SAVING" ||
                          !roomConfigurationHasChanges
                        }
                        onClick={() => void saveRoomConfiguration()}
                      >
                        {roomSaveState === "SAVING" ? (
                          <>
                            <LoaderCircle className="spin" />
                            正在保存
                          </>
                        ) : roomSaveState === "SUCCESS" ? (
                          <>
                            <Check />
                            已保存并生效
                          </>
                        ) : (
                          "保存房间配置"
                        )}
                      </button>
                      {roomSaveState === "SAVING" && (
                        <p className="room-save-status" role="status">
                          正在保存房间配置
                        </p>
                      )}
                      {roomSaveState === "SUCCESS" && (
                        <p className="room-save-status success" role="status">
                          <Check />
                          已保存并生效
                        </p>
                      )}
                      {roomSaveState === "ERROR" && (
                        <p className="room-save-status error" role="alert">
                          保存后未能确认配置，请刷新后重试。
                        </p>
                      )}
                    </div>
                    <div className="inline-form">
                      <input
                        aria-label="新房间密码"
                        placeholder="留空表示清除密码"
                        value={roomDraft.password}
                        onChange={(event) =>
                          setRoomDraft({
                            ...roomDraft,
                            password: event.target.value,
                          })
                        }
                      />
                      <button
                        onClick={() =>
                          setConfirm({
                            title: "修改房间密码",
                            copy: `${selectedRoom.name} 的新加入成员将使用${roomDraft.password ? "新密码" : "无密码"}，已加入成员不受影响。`,
                            run: async () => {
                              await mutateAndReload(
                                `/api/admin/rooms/${selectedRoom.id}/password`,
                                { password: roomDraft.password || null },
                                "POST",
                                selectedRoom.id,
                              );
                            },
                          })
                        }
                      >
                        更新密码
                      </button>
                    </div>
                    <h3>成员与银行</h3>
                    {selectedRoom.members.map((member) => (
                      <article className="admin-row" key={member.id}>
                        <div>
                          <strong>{member.displayNameSnapshot}</strong>
                          <span>
                            {member.characterName ?? "未选人物"} ·{" "}
                            {member.isBank ? "银行" : "非银行"} ·{" "}
                            {member.controllerActive ? "控制中" : "无有效控制"}
                          </span>
                        </div>
                        <small>
                          {member.player
                            ? `余额 ${formatMoney(member.player.balance)} · ${member.player.ownedPropertyCount} 地产`
                            : "无 Player 资产"}
                        </small>
                        <button
                          className="danger-text"
                          onClick={() =>
                            setConfirm({
                              title: "移除房间成员",
                              copy: `${member.displayNameSnapshot} 将失去当前席位与操作权，历史和资产记录保留。`,
                              run: async () => {
                                await mutateAndReload(
                                  `/api/admin/rooms/${selectedRoom.id}/members/${member.id}/remove`,
                                  {},
                                  "POST",
                                  selectedRoom.id,
                                );
                              },
                            })
                          }
                        >
                          移除成员
                        </button>
                      </article>
                    ))}
                    <label>
                      更换银行
                      <select
                        value={roomDraft.bankMembershipId}
                        onChange={(event) =>
                          setRoomDraft({
                            ...roomDraft,
                            bankMembershipId: event.target.value,
                          })
                        }
                      >
                        <option value="">选择成员</option>
                        {selectedRoom.members.map((member) => (
                          <option key={member.id} value={member.id}>
                            {member.displayNameSnapshot}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      disabled={!roomDraft.bankMembershipId}
                      onClick={() =>
                        setConfirm({
                          title: "更换银行",
                          copy: `银行能力将转移给所选成员，人物与资产保持不变。`,
                          run: async () => {
                            await mutateAndReload(
                              `/api/admin/rooms/${selectedRoom.id}/bank/reassign`,
                              {
                                targetMembershipId: roomDraft.bankMembershipId,
                              },
                              "POST",
                              selectedRoom.id,
                            );
                          },
                        })
                      }
                    >
                      确认更换银行
                    </button>
                    <label>
                      强制结束原因
                      <textarea
                        value={roomDraft.forceReason}
                        onChange={(event) =>
                          setRoomDraft({
                            ...roomDraft,
                            forceReason: event.target.value,
                          })
                        }
                      />
                    </label>
                    <button
                      className="danger-button"
                      disabled={
                        !roomDraft.forceReason.trim() ||
                        terminalRoom(selectedRoom.status)
                      }
                      onClick={() =>
                        setConfirm({
                          title: "强制结束房间",
                          copy: `${selectedRoom.name} 将生成不可变结算并停止全部游戏操作。原因：${roomDraft.forceReason.trim()}`,
                          run: async () => {
                            await mutateAndReload(
                              `/api/admin/rooms/${selectedRoom.id}/finish`,
                              { reason: roomDraft.forceReason.trim() },
                              "POST",
                              selectedRoom.id,
                            );
                          },
                        })
                      }
                    >
                      强制结束
                    </button>
                    <button
                      className="danger-button"
                      onClick={() => {
                        setConfirmName("");
                        setConfirm({
                          title: "删除房间",
                          fieldLabel: "确认删除房间",
                          expectedValues: [selectedRoom.name],
                          confirmationHint: `请输入房间名称：${selectedRoom.name}`,
                          copy: `${selectedRoom.name} 的全部房间数据将被永久清除，且无法恢复。`,
                          run: async () => {
                            const deleted = await mutateAndReload(
                              `/api/admin/rooms/${selectedRoom.id}`,
                              {},
                              "DELETE",
                            );
                            if (deleted) {
                              setSelectedRoom(null);
                              setRoomLogs([]);
                            }
                            return deleted;
                          },
                        });
                      }}
                    >
                      删除房间
                    </button>
                    <h3>房间审计日志</h3>
                    {roomLogs.map((log) => (
                      <article className="log-row" key={log.id}>
                        <strong>{log.action}</strong>
                        <span>
                          {log.actorRole ?? "SYSTEM"} ·{" "}
                          {new Date(log.createdAt).toLocaleString("zh-CN")}
                        </span>
                        <small>{log.reason ?? "无附加原因"}</small>
                      </article>
                    ))}
                  </section>,
                  document.getElementById(
                    `admin-room-detail-host-${selectedRoom.id}`,
                  ) ?? document.body,
                )}
            </div>
          )}
          {tab === "LOGS" && (
            <section className="admin-band log-list">
              <h2>安全日志</h2>
              {data.logs.map((log) => (
                <article className="log-row" key={log.id}>
                  <strong>{log.action}</strong>
                  <span>
                    {new Date(log.createdAt).toLocaleString("zh-CN")} ·{" "}
                    {log.ip ?? "无 IP"}
                  </span>
                  <small>
                    账号 {log.accountId ?? "-"} · 操作者{" "}
                    {log.actorAccountId ?? "SYSTEM"}
                  </small>
                  {log.details && <code>{JSON.stringify(log.details)}</code>}
                </article>
              ))}
            </section>
          )}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          confirmLabel={confirm.expectedValues ? "确认删除" : "确认执行"}
          busy={busy}
          disabled={Boolean(
            confirm.expectedValues &&
            !confirm.expectedValues.includes(confirmName.trim()),
          )}
          onCancel={() => {
            setConfirm(null);
            setConfirmName("");
          }}
          onConfirm={() => {
            void confirm.run().then((succeeded) => {
              if (succeeded !== false) {
                setConfirm(null);
                setConfirmName("");
              }
            });
          }}
        >
          <p>{confirm.copy}</p>
          {confirm.expectedValues && confirm.fieldLabel && (
            <label>
              {confirm.fieldLabel}
              <input
                aria-label={confirm.fieldLabel}
                value={confirmName}
                onChange={(event) => setConfirmName(event.target.value)}
              />
              {confirm.confirmationHint && (
                <small>{confirm.confirmationHint}</small>
              )}
            </label>
          )}
        </ConfirmDialog>
      )}
    </main>
  );
}

function WorkbenchSelector({
  membership,
  busy,
  onChoose,
  onManage,
  onBack,
}: {
  membership: RoomMembershipView;
  busy: boolean;
  onChoose: (view: "PLAYER" | "BANK") => void;
  onManage: () => void;
  onBack: () => void;
}) {
  return (
    <main className="v2-page">
      <section className="workbench-selector">
        <Crown />
        <h1>选择工作台</h1>
        <p>同一成员关系拥有两项能力。选择只改变当前界面。</p>
        <div className="selector-actions">
          <button
            className="primary"
            disabled={busy}
            onClick={() => void onChoose("PLAYER")}
          >
            <Users />
            玩家端
          </button>
          <button
            className="primary jade"
            disabled={busy}
            onClick={() => void onChoose("BANK")}
          >
            <Landmark />
            银行端
          </button>
        </div>
        <button onClick={onManage}>管理席位</button>
        <button onClick={onBack}>返回房间列表</button>
        <small>成员 {membership.id.slice(0, 8)} · 共用一个操作控制权</small>
      </section>
    </main>
  );
}

function blockerLabel(blocker: SettlementBlocker) {
  const labels: Record<string, string> = {
    PENDING_GAME_REQUEST: "待处理游戏请求",
    INCOMPLETE_PROPERTY_TRADE: "未完成地产交易",
    PROPERTY_ACTION_LOCKED: "地产操作锁定",
    PENDING_ROLE_SWAP: "待处理角色交换",
    INVALID_PLAYER_BALANCE: "异常玩家余额",
    OPEN_DEBT: "未结债务",
    UNRESOLVED_LANDING: "未结算落点",
    ACTIVE_TURN: "当前回合未结束",
    SETTLEMENT_DATA_INVALID: "结算参与者数据异常",
  };
  return labels[blocker.code] ?? blocker.code;
}

function FinishPreview({
  preview,
  busy,
  error,
  onConfirm,
  onBack,
}: {
  preview: SettlementPreviewView;
  busy: boolean;
  error: string;
  onConfirm: (confirmation: string) => void;
  onBack: () => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  const blocked = preview.blockers.length > 0;
  return (
    <main className="v2-page finish-page">
      <header className="v2-header">
        <button onClick={onBack}>返回银行端</button>
        <div>
          <small>银行结算预览</small>
          <h1>结束游戏</h1>
        </div>
      </header>
      <section className="finish-ranking">
        <h2>当前排名</h2>
        {preview.players.map((player) => (
          <div key={player.accountId}>
            <b>第 {player.rank} 名</b>
            <span>
              {player.displayNameSnapshot} · {player.characterNameSnapshot}
            </span>
            <strong>{formatMoney(player.totalWealth)} 两</strong>
          </div>
        ))}
      </section>
      <section className="finish-blockers">
        <h2>结束前检查</h2>
        {blocked ? (
          preview.blockers.map((blocker, index) => (
            <article key={`${blocker.code}-${index}`}>
              <AlertTriangle />
              <div>
                <strong>{blockerLabel(blocker)}</strong>
                <small>
                  {Object.entries(blocker)
                    .filter(([key]) => key !== "code")
                    .map(([key, value]) => `${key}: ${String(value)}`)
                    .join(" · ")}
                </small>
              </div>
            </article>
          ))
        ) : (
          <p className="success-line">
            <Check />
            没有阻塞项，可以生成不可变结算。
          </p>
        )}
      </section>
      <section className="finish-confirm">
        <label>
          输入“确认结束游戏”
          <input
            disabled={blocked}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button
          className="danger-button"
          disabled={busy || blocked || confirmation !== "确认结束游戏"}
          onClick={() => void onConfirm(confirmation)}
        >
          确认结束游戏
        </button>
      </section>
    </main>
  );
}

function Settlement({
  settlement,
  onBack,
}: {
  settlement: SettlementView;
  onBack: () => void;
}) {
  return (
    <main className="v2-page settlement-page">
      <header className="v2-header">
        <button onClick={onBack}>房间列表</button>
        <div>
          <small>不可变结算快照</small>
          <h1>对局结算</h1>
          <p>
            {new Date(settlement.endedAt).toLocaleString("zh-CN")} ·{" "}
            {settlement.totalTurns} 回合
          </p>
        </div>
      </header>
      {settlement.forced && (
        <p className="error banner">强制结束：{settlement.forceReason}</p>
      )}
      <div className="settlement-list">
        {settlement.players.map((player) => (
          <article
            key={player.accountId}
            className={player.isWinner ? "winner" : ""}
          >
            <b>
              第 {player.rank} 名{player.isWinner ? " · 获胜" : ""}
            </b>
            <h2>{player.displayNameSnapshot}</h2>
            {player.characterNameSnapshot && (
              <p>{player.characterNameSnapshot}</p>
            )}
            <dl>
              <div>
                <dt>流动资金</dt>
                <dd>{formatMoney(player.cash)} 两</dd>
              </div>
              <div>
                <dt>未抵押地产</dt>
                <dd>{formatMoney(player.unmortgagedPropertyValue)} 两</dd>
              </div>
              <div>
                <dt>抵押地产净值</dt>
                <dd>{formatMoney(player.mortgagedPropertyNetValue)} 两</dd>
              </div>
              <div>
                <dt>建筑出售价值</dt>
                <dd>{formatMoney(player.buildingSellValue)} 两</dd>
              </div>
              <div className="total">
                <dt>总财富</dt>
                <dd>{formatMoney(player.totalWealth)} 两</dd>
              </div>
            </dl>
            <details>
              <summary>地产结算明细（{player.propertyDetails.length}）</summary>
              <div className="settlement-properties">
                {player.propertyDetails.map((property) => (
                  <div key={property.roomPropertyId}>
                    <strong>{property.nameSnapshot}</strong>
                    <span>
                      {property.mortgaged ? "已抵押" : "未抵押"} · 土地{" "}
                      {formatMoney(property.landSettlementValue)} 两
                    </span>
                    <span>
                      抵押价 {formatMoney(property.mortgagePriceSnapshot)} ·
                      售价 {formatMoney(property.landSaleValue)}
                    </span>
                    <span>
                      建筑 {property.buildingLevel} · 单价{" "}
                      {formatMoney(property.buildingSellPriceSnapshot)} · 价值{" "}
                      {formatMoney(property.buildingSellValue)}
                    </span>
                  </div>
                ))}
              </div>
            </details>
          </article>
        ))}
      </div>
    </main>
  );
}

function Workbench({
  context,
  snapshot,
  busy,
  error,
  action,
  toast,
  showNotice,
  showToast,
  refresh,
  switchView,
  manageSeats,
  finish,
  leave,
}: {
  context: WorkbenchContext;
  snapshot: Snapshot;
  busy: boolean;
  error: string;
  action: ActionRunner;
  toast: ToastItem | null;
  showNotice: (message: string) => void;
  showToast: (toast: ToastInput) => void;
  refresh: () => Promise<boolean>;
  switchView: (view: "PLAYER" | "BANK") => void;
  manageSeats: () => void;
  finish: () => void;
  leave: () => void;
}) {
  const [playerTab, setPlayerTab] = useState<
    "HOME" | "OVERVIEW" | "PROPERTY" | "LEDGER"
  >("HOME");
  const [bankTab, setBankTab] = useState<
    "SUMMARY" | "APPROVAL" | "PROPERTY" | "LEDGER" | "TRANSACTION"
  >("SUMMARY");
  const [leaveOpen, setLeaveOpen] = useState(false);
  const playerName =
    snapshot.players.find((player) => player.id === context.membership.playerId)
      ?.name ?? "玩家";

  return (
    <main className="app-shell" aria-busy={busy}>
      <div className="workbench-scroll">
        <header
          className={
            context.view === "BANK" ? "bank-workbench-header" : undefined
          }
        >
          {context.view === "PLAYER" ? (
            <div className="workbench-header-title">
              <h1 aria-label="玩家端">{playerName}</h1>
            </div>
          ) : (
            <>
              <div className="workbench-room-info">
                <div className="workbench-room-meta">
                  <strong title={snapshot.name}>{snapshot.name}</strong>
                  <small>{" \u2022 "}{snapshot.code}</small>
                </div>
                <h1>银行端</h1>
              </div>
            </>
          )}
          <div className="workbench-tools">
            <button onClick={manageSeats}>管理席位</button>
            <button
              className="icon"
              aria-label="刷新房间快照"
              title="刷新房间快照"
              disabled={busy}
              onClick={() => void refresh()}
            >
              {busy ? <LoaderCircle className="spin" /> : <RefreshCw />}
            </button>
          </div>
        </header>
        {context.membership.characterId && context.membership.isBank && (
          <div
            className="workbench-segment"
            role="group"
            aria-label="工作台视图"
          >
            <button
              aria-pressed={context.view === "PLAYER"}
              disabled={busy}
              onClick={() => switchView("PLAYER")}
            >
              玩家端
            </button>
            <button
              aria-pressed={context.view === "BANK"}
              disabled={busy}
              onClick={() => switchView("BANK")}
            >
              银行端
            </button>
          </div>
        )}
        {error && (
          <p className="error banner" role="alert">
            {error}
          </p>
        )}
        {toast && (
          <div
            key={toast.id}
            className={`toast toast-${toast.tone.toLowerCase()}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {toast.tone === "REJECTED" ? <CircleX aria-hidden="true" /> : <Check aria-hidden="true" />}
            <span>{toast.message}</span>
          </div>
        )}

        {context.view === "PLAYER" ? (
          <PlayerView
            membership={context.membership}
            snapshot={snapshot}
            skillEnabled={context.skillEnabled}
            busy={busy}
            tab={playerTab}
            action={action}
            showNotice={showNotice}
            showToast={showToast}
          />
        ) : (
          <BankView
            snapshot={snapshot}
            busy={busy}
            tab={bankTab}
            action={action}
            showNotice={showNotice}
            showToast={showToast}
            onFinish={finish}
          />
        )}
      </div>

      <nav
        aria-label="工作台导航"
        className={context.view === "BANK" ? "bank-nav" : ""}
      >
        <div className="desktop-nav-identity" aria-hidden="true">
          <small>{snapshot.code}</small>
          <strong>{context.view === "BANK" ? "银行端" : "玩家端"}</strong>
          <span>{snapshot.name}</span>
        </div>
        {context.view === "PLAYER" ? (
          <>
            <Nav
              active={playerTab === "HOME"}
              icon={<HomeIcon />}
              label="首页"
              onClick={() => setPlayerTab("HOME")}
            />
            <Nav
              active={playerTab === "OVERVIEW"}
              icon={<Users />}
              label="概览"
              onClick={() => setPlayerTab("OVERVIEW")}
            />
            <Nav
              active={playerTab === "PROPERTY"}
              icon={<Landmark />}
              label="地产"
              onClick={() => setPlayerTab("PROPERTY")}
            />
            <Nav
              active={playerTab === "LEDGER"}
              icon={<History />}
              label="账本"
              onClick={() => setPlayerTab("LEDGER")}
            />
          </>
        ) : (
          <>
            <Nav
              active={bankTab === "SUMMARY"}
              icon={<Users />}
              label="概览"
              onClick={() => setBankTab("SUMMARY")}
            />
            <Nav
              active={bankTab === "APPROVAL"}
              icon={<FileCheck2 />}
              label="审批"
              badge={
                snapshot.requests.filter(
                  (request) => request.status === "PENDING",
                ).length
              }
              onClick={() => setBankTab("APPROVAL")}
            />
            <Nav
              active={bankTab === "PROPERTY"}
              icon={<Landmark />}
              label="地产"
              onClick={() => setBankTab("PROPERTY")}
            />
            <Nav
              active={bankTab === "LEDGER"}
              icon={<BookOpen />}
              label="账本"
              onClick={() => setBankTab("LEDGER")}
            />
            <Nav
              active={bankTab === "TRANSACTION"}
              icon={<ArrowLeftRight />}
              label="事务"
              onClick={() => setBankTab("TRANSACTION")}
            />
          </>
        )}
        <Nav icon={<LogIn />} label="退出" onClick={() => setLeaveOpen(true)} />
      </nav>
      {leaveOpen && (
        <ConfirmDialog
          title="返回房间列表"
          confirmLabel="确认返回"
          busy={false}
          onCancel={() => setLeaveOpen(false)}
          onConfirm={leave}
        >
          <p>当前席位会保留。再次打开房间时将从服务器重新读取状态。</p>
        </ConfirmDialog>
      )}
    </main>
  );
}

function PlayerView({
  membership,
  snapshot,
  skillEnabled,
  busy,
  tab,
  action,
  showNotice,
  showToast,
}: {
  membership: RoomMembershipView;
  snapshot: Snapshot;
  skillEnabled: boolean;
  busy: boolean;
  tab: "HOME" | "OVERVIEW" | "PROPERTY" | "LEDGER";
  action: ActionRunner;
  showNotice: (message: string) => void;
  showToast: (toast: ToastInput) => void;
}) {
  const me = snapshot.players.find(
    (player) => player.id === membership.playerId,
  );
  const playerId = membership.playerId ?? "";
  const current = snapshot.players.find(
    (player) => player.id === snapshot.currentPlayerId,
  );
  const currentCharacterSkill = me?.characterId
    ? formatCharacterSkill(
        me.characterId,
        me as unknown as Record<string, unknown>,
        skillEnabled,
      )
    : null;
  const canAct =
    snapshot.diceMode === "PHYSICAL" || me?.id === snapshot.currentPlayerId;
  const mine = useMemo(
    () => snapshot.properties.filter((property) => property.ownerId === me?.id),
    [snapshot.properties, me?.id],
  );
  const [panel, setPanel] = useState<
    | "LANDING"
    | "START"
    | "PROPERTY"
    | "TOLL"
    | "ASSET"
    | "TRANSFER"
    | "BANK_PAYMENT"
    | "EVENT"
    | "END"
    | "SKIP_CONSUME"
    | null
  >(null);
  const [tradeConfirmTarget, setTradeConfirmTarget] =
    useState<BankRequest | null>(null);
  const [landing, setLanding] = useState(snapshot.properties[0]?.name ?? "");
  const [trustedLandings, setTrustedLandings] = useState<{
    turnKey: string;
    propertyId?: string;
    propertyName?: string;
    startId?: string;
  }>({ turnKey: "" });
  const [propertyMode, setPropertyMode] = useState<"BUY" | "BUILD">("BUY");
  const [assetMode, setAssetMode] = useState<
    | "SELL_BUILDING"
    | "MORTGAGE_PROPERTY"
    | "REDEEM_PROPERTY"
    | "SELL_PROPERTY_TO_BANK"
    | "TRADE_PROPERTY"
  >("SELL_BUILDING");
  const [assetProperty, setAssetProperty] = useState("");
  const [targetPlayerId, setTargetPlayerId] = useState(
    snapshot.players.find((player) => player.id !== playerId)?.id ?? "",
  );
  const [operationAmount, setOperationAmount] = useState("");
  const [buildingCount, setBuildingCount] = useState("1");
  const [transferRecipient, setTransferRecipient] = useState<
    { type: "PLAYER"; playerId: string } | { type: "BANK" }
  >(() => {
    const firstPlayerId = snapshot.players.find(
      (player) => player.id !== playerId,
    )?.id;
    return firstPlayerId
      ? { type: "PLAYER", playerId: firstPlayerId }
      : { type: "BANK" };
  });
  const [transferAmount, setTransferAmount] = useState("");
  const [transferIsPlotFine, setTransferIsPlotFine] = useState(false);
  const [bankPaymentAmount, setBankPaymentAmount] = useState("");
  const [eventSkipCount, setEventSkipCount] = useState("1");
  const [plotRestReason, setPlotRestReason] = useState("");
  const [returnCompanionOpen, setReturnCompanionOpen] = useState(false);
  const [playerSkipConsumeCount, setPlayerSkipConsumeCount] = useState("1");
  const idempotentAction = booleanRoomAction(action);
  const assetProperties = snapshot.properties.filter((property) => {
    if (property.ownerId !== playerId) return false;
    if (assetMode === "SELL_BUILDING") return property.level > 0;
    if (
      assetMode === "MORTGAGE_PROPERTY" ||
      assetMode === "SELL_PROPERTY_TO_BANK" ||
      assetMode === "TRADE_PROPERTY"
    )
      return property.level === 0 && !property.mortgaged;
    if (assetMode === "REDEEM_PROPERTY") return property.mortgaged;
    return false;
  });
  const selectedAssetProperty = assetProperties.find(
    (property) => property.name === assetProperty,
  );
  const sellBuildingCount =
    selectedAssetProperty?.level === 5 ? 5 : Number(buildingCount);
  const validSellBuildingCount =
    assetMode !== "SELL_BUILDING" ||
    Boolean(
      selectedAssetProperty &&
      Number.isInteger(sellBuildingCount) &&
      sellBuildingCount >= 1 &&
      sellBuildingCount <= selectedAssetProperty.level,
    );
  const assetSettlement = selectedAssetProperty
    ? (() => {
        if (assetMode === "SELL_BUILDING")
          return {
            label: "出售建筑收入",
            amount:
              (selectedAssetProperty.buildingSell ?? 0) * sellBuildingCount,
          };
        if (assetMode === "MORTGAGE_PROPERTY")
          return {
            label: "抵押收入",
            amount: selectedAssetProperty.mortgage ?? 0,
          };
        if (assetMode === "REDEEM_PROPERTY")
          return {
            label: `赎回支出（含 ${formatMoney(snapshot.redemptionFee)} 两手续费）`,
            amount:
              (selectedAssetProperty.mortgage ?? 0) + snapshot.redemptionFee,
          };
        if (assetMode === "SELL_PROPERTY_TO_BANK")
          return {
            label: "卖回收入",
            amount: selectedAssetProperty.purchasePrice,
          };
        if (assetMode === "TRADE_PROPERTY")
          return { label: "交易金额", amount: Number(operationAmount) || 0 };
        return null;
      })()
    : null;
  const validTradeAmount =
    assetMode !== "TRADE_PROPERTY" ||
    Boolean(
      operationAmount !== "" &&
      Number.isInteger(Number(operationAmount)) &&
      Number(operationAmount) >= 0,
    );
  const turnKey =
    snapshot.turn?.id ??
    (snapshot.diceMode === "PHYSICAL" ? "PHYSICAL" : "NO_ACTIVE_TURN");
  const currentLanding = snapshot.landings?.find(
    (item) =>
      item.playerId === playerId &&
      item.spaceType === "PROPERTY" &&
      !item.propertyActionsCancelled &&
      (item.turnId
        ? item.turnId === snapshot.turn?.id
        : item.id === trustedLandings.propertyId &&
          trustedLandings.turnKey === turnKey),
  );
  const landingConfirmed =
    currentLanding?.status === "CONFIRMED" && currentLanding.plotResolved;
  const mustSkipCurrentTurn =
    snapshot.diceMode === "ELECTRONIC" &&
    canAct &&
    (me?.remainingSkipTurns ?? 0) > 0 &&
    snapshot.turn?.total === undefined;
  const landingProperty = snapshot.properties.find(
    (property) => property.name === currentLanding?.propertyName,
  );
  const canSubmitPropertyAction = Boolean(
    landingConfirmed &&
    landingProperty &&
    (propertyMode === "BUY"
      ? !landingProperty.ownerId
      : landingProperty.ownerId === me?.id &&
        !landingProperty.mortgaged &&
        landingProperty.level < 5),
  );
  const tollOwner = landingProperty?.ownerId
    ? snapshot.players.find((player) => player.id === landingProperty.ownerId)
    : undefined;
  const tollOwnerLabel = !landingProperty?.ownerId
    ? "国库"
    : tollOwner?.characterId
      ? characterName(tollOwner.characterId)
      : "角色信息缺失";
  const tollAmount = landingProperty && tollOwner
    ? currentPropertyToll(landingProperty, snapshot.players)
    : 0;
  const tollDisabledReason = !landingConfirmed
    ? "请先声明该地产落点，并由银行确认剧情已结算。"
    : !landingProperty
      ? "当前落点地产不存在，请刷新后重试。"
      : !landingProperty.ownerId
        ? "当前落点为无主地产，无需支付过路费。"
        : landingProperty.ownerId === me?.id
          ? "当前落点归你所有，无需支付过路费。"
          : landingProperty.mortgaged
            ? "当前落点地产已抵押，无需支付过路费。"
            : tollOwner?.tollCollectionBlocked
              ? "地主正在冷宫中，本次免过路费。"
              : currentLanding?.tollSettled
                ? "本次过路费已经结算。"
                : tollAmount <= 0
                  ? "当前无需支付过路费。"
                  : null;
  const canPayToll = tollDisabledReason === null;
  const startLanding = snapshot.landings?.find(
    (item) =>
      item.playerId === playerId &&
      item.spaceType === "START" &&
      (item.turnId
        ? item.turnId === snapshot.turn?.id
        : item.id === trustedLandings.startId &&
          trustedLandings.turnKey === turnKey),
  );
  const startLandingConfirmed = startLanding?.status === "CONFIRMED";
  const pendingTradeConfirmations = snapshot.requests.filter(
    (request) =>
      request.type === "TRADE_PROPERTY" &&
      request.targetPlayerId === playerId &&
      request.status === "PENDING" &&
      !request.buyerConfirmed,
  );
  const isMeizhuang = me?.characterId === "meizhuang";
  const rawTransferAmount = Number(transferAmount);
  const plotFineReduction = isMeizhuang ? (me.plotFineReduction ?? 0) : 0;
  const estimatedTransferAmount = Math.max(
    0,
    rawTransferAmount - (transferIsPlotFine ? plotFineReduction : 0),
  );
  const validTransferAmount =
    Number.isInteger(rawTransferAmount) && rawTransferAmount > 0;
  const playerSkipConsumeTotal =
    playerSkipConsumeCount === "ALL"
      ? (me?.remainingSkipTurns ?? 0)
      : Number(playerSkipConsumeCount);

  useEffect(() => {
    setTrustedLandings((current) =>
      current.turnKey === turnKey ? current : { turnKey },
    );
  }, [turnKey]);

  function trustLanding(change: {
    propertyId?: string;
    propertyName?: string;
    startId?: string;
  }) {
    const next = {
      ...(trustedLandings.turnKey === turnKey ? trustedLandings : { turnKey }),
      ...change,
      turnKey,
    };
    setTrustedLandings(next);
  }

  function clearTrustedStart() {
    const next = { ...trustedLandings, turnKey, startId: undefined };
    setTrustedLandings(next);
  }

  function clearTrustedProperty() {
    const next = {
      ...trustedLandings,
      turnKey,
      propertyId: undefined,
      propertyName: undefined,
    };
    setTrustedLandings(next);
  }

  useEffect(() => {
    if (!assetProperties.some((property) => property.name === assetProperty))
      setAssetProperty(assetProperties[0]?.name ?? "");
  }, [assetMode, assetProperties, assetProperty]);

  useEffect(() => {
    if (assetMode !== "SELL_BUILDING") {
      setBuildingCount("1");
      return;
    }
    if (!selectedAssetProperty) return;
    const max = selectedAssetProperty.level;
    setBuildingCount((currentCount) => {
      const parsed = Number(currentCount);
      const normalized =
        Number.isInteger(parsed) && parsed >= 1 ? Math.min(parsed, max) : 1;
      return String(normalized);
    });
  }, [assetMode, assetProperty, selectedAssetProperty?.level]);

  useEffect(() => {
    const others = snapshot.players.filter((player) => player.id !== playerId);
    const firstPlayerId = others[0]?.id ?? "";
    if (
      !others.some((player) => player.id === targetPlayerId) &&
      targetPlayerId !== firstPlayerId
    )
      setTargetPlayerId(firstPlayerId);
    if (
      transferRecipient.type === "PLAYER" &&
      !others.some((player) => player.id === transferRecipient.playerId)
    ) {
      setTransferRecipient(
        firstPlayerId
          ? { type: "PLAYER", playerId: firstPlayerId }
          : { type: "BANK" },
      );
    }
  }, [playerId, snapshot.players, targetPlayerId, transferRecipient]);

  if (!me) return <div className="empty page-empty">未找到当前玩家身份</div>;

  async function roll() {
    const ok = await idempotentAction(`/api/rooms/${snapshot.id}/turn/roll`, {
      playerId,
    });
    if (ok) showNotice("骰子结果已记录");
  }

  async function confirmLanding() {
    const result = await action<
      Landing,
      { playerId: string; propertyName: string }
    >({
      path: `/api/rooms/${snapshot.id}/landings`,
      body: { playerId, propertyName: landing },
    });
    if (result.ok) {
      trustLanding({ propertyId: result.value.id, propertyName: landing });
      setPanel(null);
      showNotice(`已声明落点：${landing}，等待银行确认`);
    }
  }

  async function declareStartLanding() {
    const result = await action<
      unknown,
      { playerId: string; landingId: string }
    >({
      path: `/api/rooms/${snapshot.id}/landings/start`,
      intentKey: `start-landing:${snapshot.id}:${playerId}`,
      createBody: () => ({ playerId, landingId: requestKey() }),
    });
    if (result.ok) {
      trustLanding({ startId: result.body.landingId });
      setPanel(null);
      showNotice("已声明精确停留起点，等待银行确认");
    }
  }

  async function requestStartReward() {
    if (!startLanding?.id) return;
    const ok = await idempotentAction(`/api/rooms/${snapshot.id}/requests`, {
      playerId,
      type: "START_REWARD",
      landingId: startLanding.id,
    });
    if (ok) {
      clearTrustedStart();
      setPanel(null);
      showNotice(
        `起点 ${formatMoney(snapshot.startReward)} 两申请已提交银行审批`,
      );
    }
  }

  async function confirmTrade() {
    if (!tradeConfirmTarget) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/requests/${tradeConfirmTarget.id}/confirm-trade`,
      { playerId },
    );
    if (ok) {
      setTradeConfirmTarget(null);
      showNotice("交易已确认，等待银行审批");
    }
  }

  async function propertyAction() {
    if (!landingProperty || !canSubmitPropertyAction) return;
    const route = propertyMode === "BUY" ? "buy" : "build";
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/properties/${encodeURIComponent(landingProperty.name)}/${route}`,
      { playerId },
    );
    if (ok) {
      clearTrustedProperty();
      setPanel(null);
      showNotice("操作已提交");
    }
  }

  async function endTurn() {
    const actionName = mustSkipCurrentTurn ? "skip" : "end";
    const ok = await idempotentAction(`/api/rooms/${snapshot.id}/turn/${actionName}`, {
      playerId,
    });
    if (ok) {
      setPanel(null);
      showNotice(mustSkipCurrentTurn ? "已跳过回合" : "回合已结束");
    }
  }

  async function submitAssetAction() {
    const selected = assetProperties.find(
      (property) => property.name === assetProperty,
    );
    if (!selected || (assetMode === "SELL_BUILDING" && !validSellBuildingCount))
      return;
    const ok = await idempotentAction(`/api/rooms/${snapshot.id}/requests`, {
      playerId,
      type: assetMode,
      propertyName: assetProperty,
      targetPlayerId:
        assetMode === "TRADE_PROPERTY" ? targetPlayerId : undefined,
      amount:
        assetMode === "TRADE_PROPERTY" ? Number(operationAmount) : undefined,
      count: assetMode === "SELL_BUILDING" ? sellBuildingCount : undefined,
    });
    if (ok) {
      setPanel(null);
      showNotice("资产操作已提交银行审批");
    }
  }

  async function payLandingToll() {
    if (!landingProperty || !canPayToll) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/properties/${encodeURIComponent(landingProperty.name)}/toll`,
      { playerId },
    );
    if (ok) {
      setPanel(null);
      showNotice("过路费已结算");
    }
  }

  async function submitTransfer(event: FormEvent) {
    event.preventDefault();
    if (!validTransferAmount) return;
    const body =
      transferRecipient.type === "PLAYER"
        ? {
            fromPlayerId: playerId,
            recipientType: "PLAYER",
            toPlayerId: transferRecipient.playerId,
            amount: rawTransferAmount,
            isPlotFine: isMeizhuang && transferIsPlotFine,
          }
        : {
            fromPlayerId: playerId,
            recipientType: "BANK",
            amount: rawTransferAmount,
            isPlotFine: isMeizhuang && transferIsPlotFine,
          };
    const result = await action<TransferResult, typeof body>({
      path: `/api/rooms/${snapshot.id}/transfers`,
      body,
    });
    if (result.committed) {
      setTransferAmount("");
      setTransferIsPlotFine(false);
      setPanel(null);
      showToast(transferSuccessToast(result.value, playerId));
      return;
    }
    const details = result.error instanceof ApiError
      ? result.error.data as { error?: string; transferApprovalRequired?: boolean }
      : {};
    showToast(transferFailureToast(
      details.error ?? (result.error instanceof ApiError ? result.error.code : 'INTERNAL_ERROR'),
      details.transferApprovalRequired,
    ));
  }

  async function requestBankPayment(event: FormEvent) {
    event.preventDefault();
    const amount = Number(bankPaymentAmount);
    if (!Number.isInteger(amount) || amount <= 0) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/requests/bank-payment`,
      { playerId, amount },
    );
    if (ok) {
      setBankPaymentAmount("");
      setPanel(null);
      showNotice("银行付款申请已提交审批");
    }
  }

  function finishPhysicalEvent(message: string) {
    setEventSkipCount("1");
    setPlotRestReason("");
    setReturnCompanionOpen(false);
    setPanel(null);
    showNotice(message);
  }

  async function triggerEvent(type: "cold" | "companion") {
    const count = Number(eventSkipCount);
    if (type === "cold" && (!Number.isInteger(count) || count <= 0)) return;
    const path = type === "cold" ? "cold-palace" : "companion-acquired";
    const body = type === "cold" ? { playerId, count } : { playerId };
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/events/${path}`,
      body,
    );
    if (ok) {
      finishPhysicalEvent(
        type === "cold" ? "冷宫事件已提交银行确认" : "伙伴卡事件已提交银行确认",
      );
    }
  }

  async function requestPlotRest() {
    const count = Number(eventSkipCount);
    if (!Number.isInteger(count) || count <= 0 || !plotRestReason.trim())
      return;
    const ok = await idempotentAction(`/api/rooms/${snapshot.id}/requests`, {
      playerId,
      type: "PLOT_REST_EVENT",
      count,
      reason: plotRestReason.trim(),
    });
    if (ok) {
      finishPhysicalEvent("剧情停留已提交银行确认");
    }
  }

  function openReturnCompanion() {
    setPanel(null);
    setReturnCompanionOpen(true);
  }

  function cancelReturnCompanion() {
    setReturnCompanionOpen(false);
    setPanel("EVENT");
  }

  async function requestReturnCompanion() {
    const ok = await idempotentAction(`/api/rooms/${snapshot.id}/requests`, {
      playerId,
      type: "RETURN_COMPANION_EVENT",
    });
    if (ok) finishPhysicalEvent("伙伴卡放回已提交银行审批");
  }

  async function requestSkipConsumption() {
    const remainingSkipTurns = me?.remainingSkipTurns ?? 0;
    if (
      !Number.isInteger(playerSkipConsumeTotal) ||
      playerSkipConsumeTotal <= 0 ||
      playerSkipConsumeTotal > remainingSkipTurns
    )
      return;
    const ok = await idempotentAction(`/api/rooms/${snapshot.id}/requests`, {
      playerId,
      type: "CONSUME_SKIP_TURNS",
      count: playerSkipConsumeTotal,
    });
    if (ok) {
      setPlayerSkipConsumeCount("1");
      setPanel(null);
      showNotice("减除停轮申请已提交银行确认");
    }
  }

  return (
    <>
      <section className="identity-band">
        {me.characterId && (
          <div>
            <span>当前人物</span>
            <strong>{characterName(me.characterId)}</strong>
            {currentCharacterSkill && (
              <small className="current-character-skill">
                技能：{currentCharacterSkill}
              </small>
            )}
          </div>
        )}
        <div className="balance">
          <Banknote />
          <span>余额</span>
          <strong>{formatMoney(me.balance)} 两</strong>
        </div>
      </section>
      <section className="turn-strip">
        <div>
          <span>当前玩家</span>
          <strong>
            {current?.name ??
              (snapshot.status === "LOBBY" ? "等待开局" : "实体轮次")}
          </strong>
        </div>
        <span className={canAct ? "permission yes" : "permission"}>
          {canAct ? "可操作" : "等待中"}
        </span>
        <div>
          <span>停轮</span>
          <strong>{me.remainingSkipTurns} 次</strong>
        </div>
      </section>

      {tab === "HOME" && (
        <>
          {pendingTradeConfirmations.length > 0 && (
            <>
              <SectionTitle
                title="待确认交易"
                action={`${pendingTradeConfirmations.length} 项`}
              />
              <div className="approval-list">
                {pendingTradeConfirmations.map((request) => (
                  <article key={request.id}>
                    <div className="request-icon">
                      <ArrowLeftRight />
                    </div>
                    <div>
                      <span>待确认交易</span>
                      <strong>{request.propertyName ?? "未命名地产"}</strong>
                      <small>
                        卖家：
                        {snapshot.players.find(
                          (player) => player.id === request.playerId,
                        )?.name ?? "未知玩家"}{" "}
                        · 成交价 {formatMoney(request.amount)} 两
                      </small>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() => setTradeConfirmTarget(request)}
                    >
                      确认交易
                    </button>
                  </article>
                ))}
              </div>
            </>
          )}
          <section className="dice-panel">
            <div className="dice-title">
              <Dices />
              <div>
                <span>
                  {snapshot.diceMode === "ELECTRONIC"
                    ? "电子骰子 · 2d6"
                    : "实体骰子"}
                </span>
                <strong>
                  {snapshot.turn?.total
                    ? `${snapshot.turn.dice?.join(" + ")} = ${snapshot.turn.total}`
                    : snapshot.diceMode === "ELECTRONIC"
                      ? "尚未掷骰"
                      : "请在棋盘现场掷骰"}
                </strong>
              </div>
            </div>
            {snapshot.diceMode === "ELECTRONIC" && !mustSkipCurrentTurn && (
              <button
                className="primary compact"
                disabled={busy || !canAct || snapshot.turn?.total !== undefined}
                onClick={() => void roll()}
              >
                {busy ? <LoaderCircle className="spin" /> : <Dices />}
                <span>掷骰</span>
              </button>
            )}
          </section>
          {(currentLanding?.propertyName ??
            (trustedLandings.turnKey === turnKey
              ? trustedLandings.propertyName
              : undefined)) && (
            <p className="landing-status">
              <MapPin />
              {landingConfirmed ? "落点已确认" : "落点待银行确认"}：
              {currentLanding?.propertyName ?? trustedLandings.propertyName}
            </p>
          )}
          <div className="quick-grid">
            <Quick
              icon={<MapPin />}
              label={currentLanding?.status === "DECLARED" ? "更正落点" : "声明落点"}
              disabled={busy || !canAct || mustSkipCurrentTurn}
              onClick={() => setPanel("LANDING")}
            />
            <Quick
              icon={<CircleDollarSign />}
              label="支付过路费"
              disabled={busy || !canAct || mustSkipCurrentTurn || !landingConfirmed}
              onClick={() => setPanel("TOLL")}
            />
            <Quick
              icon={<Landmark />}
              label="资产操作"
              disabled={busy || !canAct}
              onClick={() => setPanel("ASSET")}
            />
            <Quick
              icon={<Building2 />}
              label="购买 / 建造"
              disabled={busy || !canAct || mustSkipCurrentTurn || !landingConfirmed}
              onClick={() => setPanel("PROPERTY")}
            />
            <Quick
              icon={<Banknote />}
              label="起点奖励"
              disabled={busy || !canAct || mustSkipCurrentTurn}
              onClick={() => setPanel("START")}
            />
            <Quick
              icon={<ArrowLeftRight />}
              label="转帐"
              disabled={busy}
              onClick={() => setPanel("TRANSFER")}
            />
            <Quick
              icon={<Banknote />}
              label="银行付款申请"
              disabled={busy}
              onClick={() => setPanel("BANK_PAYMENT")}
            />
            <Quick
              icon={<Crown />}
              label="实体事件"
              disabled={busy}
              onClick={() => setPanel("EVENT")}
            />
            <Quick
              icon={<CircleMinus />}
              label="停轮次数减除"
              disabled={
                busy ||
                snapshot.diceMode !== "PHYSICAL" ||
                me.remainingSkipTurns <= 0
              }
              onClick={() => setPanel("SKIP_CONSUME")}
            />
            {snapshot.diceMode === "ELECTRONIC" && (
              <Quick
                icon={<Play />}
                label={mustSkipCurrentTurn ? "跳过回合" : "结束回合"}
                danger
                disabled={busy || !canAct}
                onClick={() => setPanel("END")}
              />
            )}
          </div>
          <SectionTitle title="我的地产" action={`${mine.length} 块`} />
          <LandingPropertyCardPicker
            mode="browse"
            properties={mine}
            players={snapshot.players}
            viewerPlayerId={me.id}
          />
          <SectionTitle title="最近交易" action="近 3 笔" />
          <Ledger
            entries={snapshot.ledger
              .filter((entry) => entry.playerId === me.id)
              .slice(0, 3)}
            compact
          />
        </>
      )}
      {tab === "OVERVIEW" && (
        <>
          <SectionTitle
            title="玩家资产概览"
            action={snapshot.players.length + " 人"}
          />
          <PlayerAssetAccordion
            players={snapshot.players}
            properties={snapshot.properties}
          />
        </>
      )}
      {tab === "PROPERTY" && (
        <>
          <SectionTitle
            title="全局地产"
            action={`${snapshot.properties.length} 块`}
          />
          <LandingPropertyCardPicker
            mode="browse"
            properties={snapshot.properties}
            players={snapshot.players}
            viewerPlayerId={me.id}
          />
        </>
      )}
      {tab === "LEDGER" && (
        <>
          <SectionTitle
            title="交易账本"
            action={`${snapshot.ledger.filter((entry) => entry.playerId === me.id).length} 笔`}
          />
          <Ledger
            entries={snapshot.ledger.filter(
              (entry) => entry.playerId === me.id,
            )}
          />
        </>
      )}

      {panel === "LANDING" && (
        <ActionSheet
          title={currentLanding?.status === "DECLARED" ? "更正实体落点" : "声明实体落点"}
          className="landing-action-sheet"
          onClose={() => setPanel(null)}
        >
          <p className="sheet-copy">
            请选择棋子精确停留的地产。系统不会追踪棋盘位置。
          </p>
          <LandingPropertyCardPicker
            mode="landing"
            properties={snapshot.properties}
            players={snapshot.players}
            value={landing}
            onChange={setLanding}
          />
          <button
            className="primary landing-confirm"
            disabled={busy || !landing}
            onClick={() => void confirmLanding()}
          >
            {busy ? <LoaderCircle className="spin" /> : <MapPin />}
            {currentLanding?.status === "DECLARED" ? "确认更正" : "确认落点"}
          </button>
        </ActionSheet>
      )}

      {panel === "START" && (
        <ActionSheet title="精确停留起点" onClose={() => setPanel(null)}>
          {!startLanding ? (
            <>
              <p className="sheet-copy">
                仅棋子精确停留起点可领取 {formatMoney(snapshot.startReward)}{" "}
                两；经过起点或初始摆放不能申请。
              </p>
              <button
                className="primary"
                disabled={
                  busy ||
                  (snapshot.diceMode === "ELECTRONIC" &&
                    snapshot.turn?.total === undefined)
                }
                onClick={() => void declareStartLanding()}
              >
                {busy ? <LoaderCircle className="spin" /> : <MapPin />}
                声明停留起点
              </button>
            </>
          ) : startLandingConfirmed ? (
            <>
              <p className="landing-status no-margin">
                <Check />
                银行已确认本轮精确停留起点
              </p>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void requestStartReward()}
              >
                {busy ? <LoaderCircle className="spin" /> : <Banknote />}申请{" "}
                {formatMoney(snapshot.startReward)} 两
              </button>
            </>
          ) : (
            <div className="empty no-margin">等待银行确认起点落点</div>
          )}
        </ActionSheet>
      )}

      {panel === "PROPERTY" && (
        <ActionSheet title="购买或建造" onClose={() => setPanel(null)}>
          <div className="segments two" aria-label="地产操作">
            <button
              className={propertyMode === "BUY" ? "active" : ""}
              onClick={() => setPropertyMode("BUY")}
            >
              购买地产
            </button>
            <button
              className={propertyMode === "BUILD" ? "active" : ""}
              onClick={() => setPropertyMode("BUILD")}
            >
              建造升级
            </button>
          </div>
          {landingProperty ? (
            <>
              <p className="cost-line">
                <span>目标地产</span>
                <strong>{landingProperty.name}</strong>
              </p>
              <PropertyCost
                property={landingProperty}
                mode={propertyMode}
                buildDiscount={me.buildDiscount ?? 0}
              />
              {!canSubmitPropertyAction && (
                <p className="error">
                  {propertyMode === "BUY"
                    ? "仅可购买当前确认落点的无主地产。"
                    : "仅可建造当前确认且归自己的未抵押地产。"}
                </p>
              )}
              <button
                className="primary"
                disabled={busy || !canSubmitPropertyAction}
                onClick={() => void propertyAction()}
              >
                {busy ? <LoaderCircle className="spin" /> : <Building2 />}
                {propertyMode === "BUY" ? "提交购买申请" : "提交建造申请"}
              </button>
            </>
          ) : (
            <div className="empty no-margin">
              请先声明该地产落点，并由银行确认剧情已结算。
            </div>
          )}
        </ActionSheet>
      )}

      {panel === "END" && (
        <ConfirmDialog
          title={mustSkipCurrentTurn ? "跳过当前回合" : "结束当前回合"}
          confirmLabel={mustSkipCurrentTurn ? "确认跳过" : "确认结束"}
          busy={busy}
          onCancel={() => setPanel(null)}
          onConfirm={() => void endTurn()}
        >
          {mustSkipCurrentTurn
            ? "本次将消耗 1 次停轮，操作权将交给下一位玩家。"
            : "结束后操作权将交给下一位玩家，骰子结果不能继续使用。"}
        </ConfirmDialog>
      )}

      {tradeConfirmTarget && (
        <ConfirmDialog
          title="确认交易"
          confirmLabel="确认交易"
          busy={busy}
          onCancel={() => setTradeConfirmTarget(null)}
          onConfirm={() => void confirmTrade()}
        >
          <p>确认后，该地产交易将进入银行最终审批。</p>
          <p>
            卖家：
            {snapshot.players.find(
              (player) => player.id === tradeConfirmTarget.playerId,
            )?.name ?? "未知玩家"}
          </p>
          <p>地产：{tradeConfirmTarget.propertyName ?? "未命名地产"}</p>
          <p>成交价：{formatMoney(tradeConfirmTarget.amount)} 两</p>
        </ConfirmDialog>
      )}

      {panel === "TOLL" && (
        <ActionSheet title="支付过路费" onClose={() => setPanel(null)}>
          {landingProperty && (
            <>
              <p className="cost-line">
                <span>落点地产</span>
                <strong>{landingProperty.name}</strong>
              </p>
              <p className="cost-line">
                <span>地产主人</span>
                <strong>{tollOwnerLabel}</strong>
              </p>
              <p className="cost-line">
                <span>建筑等级</span>
                <strong>{landingProperty.level} 级</strong>
              </p>
              <p className="cost-line">
                <span>本次应付过路费</span>
                <strong>{formatMoney(tollAmount)} 两</strong>
              </p>
            </>
          )}
          {tollDisabledReason && (
            <p className="error">{tollDisabledReason}</p>
          )}
          <button
            className="primary"
            disabled={busy || !canPayToll}
            onClick={() => void payLandingToll()}
          >
            {busy ? <LoaderCircle className="spin" /> : <CircleDollarSign />}
            确认支付过路费
          </button>
        </ActionSheet>
      )}

      {panel === "ASSET" && (
        <ActionSheet title="资产操作" onClose={() => setPanel(null)}>
          <label>
            操作类型
            <select
              value={assetMode}
              onChange={(event) =>
                setAssetMode(event.target.value as typeof assetMode)
              }
            >
              <option value="SELL_BUILDING">出售建筑</option>
              <option value="MORTGAGE_PROPERTY">抵押地产</option>
              <option value="REDEEM_PROPERTY">赎回地产</option>
              <option value="SELL_PROPERTY_TO_BANK">卖给银行</option>
              <option value="TRADE_PROPERTY">玩家间交易</option>
            </select>
          </label>
          {assetProperties.length ? (
            <>
              <label>
                目标地产
                <select
                  value={assetProperty}
                  onChange={(event) => setAssetProperty(event.target.value)}
                >
                  {assetProperties.map((property) => (
                    <option key={property.name}>{property.name}</option>
                  ))}
                </select>
              </label>
              {assetMode === "SELL_BUILDING" &&
                selectedAssetProperty?.level !== 5 && (
                  <label>
                    出售数量
                    <input
                      type="number"
                      min="1"
                      max={selectedAssetProperty?.level ?? 1}
                      step="1"
                      inputMode="numeric"
                      value={buildingCount}
                      onChange={(event) => setBuildingCount(event.target.value)}
                    />
                  </label>
                )}
              {assetMode === "TRADE_PROPERTY" && (
                <>
                  <label>
                    购买玩家
                    <select
                      value={targetPlayerId}
                      onChange={(event) =>
                        setTargetPlayerId(event.target.value)
                      }
                    >
                      {snapshot.players
                        .filter((player) => player.id !== playerId)
                        .map((player) => (
                          <option value={player.id} key={player.id}>
                            {player.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    成交价格
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={operationAmount}
                      onChange={(event) =>
                        setOperationAmount(event.target.value)
                      }
                    />
                  </label>
                </>
              )}
              {assetSettlement && (
                <p className="cost-line">
                  <span>
                    结算预览<small>{assetSettlement.label}</small>
                  </span>
                  <strong>{formatMoney(assetSettlement.amount)} 两</strong>
                </p>
              )}
              <button
                className="primary"
                disabled={
                  busy ||
                  !validSellBuildingCount ||
                  !validTradeAmount ||
                  (assetMode === "TRADE_PROPERTY" && !targetPlayerId)
                }
                onClick={() => void submitAssetAction()}
              >
                {busy ? <LoaderCircle className="spin" /> : <Landmark />}
                确认提交
              </button>
            </>
          ) : (
            <>
              <div className="empty no-margin">当前没有符合条件的地产</div>
              <button className="primary" disabled>
                <Landmark />
                确认提交
              </button>
            </>
          )}
        </ActionSheet>
      )}

      {panel === "TRANSFER" && (
        <ActionSheet title="转帐" onClose={() => setPanel(null)}>
          <form
            className="transfer-form"
            onSubmit={(event) => void submitTransfer(event)}
          >
            <fieldset>
              <legend>选择收款对象</legend>
              <div className="transfer-recipient-grid">
                {snapshot.players
                  .filter((player) => player.id !== playerId)
                  .map((player) => {
                    const selected =
                      transferRecipient.type === "PLAYER" &&
                      transferRecipient.playerId === player.id;
                    const skill = player.characterId
                      ? formatCharacterSkill(
                          player.characterId,
                          player as unknown as Record<string, unknown>,
                          true,
                        )
                      : "人物技能由房间配置决定";
                    return (
                      <button
                        type="button"
                        className={`transfer-recipient-card ${player.characterId ? `character-${player.characterId}` : ""} ${selected ? "selected" : ""}`}
                        aria-label={`${player.characterId ? characterName(player.characterId) : "未选人物"}，${player.name}，${skill}`}
                        aria-pressed={selected}
                        key={player.id}
                        onClick={() =>
                          setTransferRecipient({
                            type: "PLAYER",
                            playerId: player.id,
                          })
                        }
                      >
                        <strong>
                          {player.characterId
                            ? characterName(player.characterId)
                            : "未选人物"}
                        </strong>
                        <span
                          className="character-divider"
                          aria-hidden="true"
                        />
                        <span>{player.name}</span>
                        <small>{skill}</small>
                      </button>
                    );
                  })}
                <button
                  type="button"
                  className={`transfer-recipient-card transfer-bank-card ${transferRecipient.type === "BANK" ? "selected" : ""}`}
                  aria-label="银行，管理审批、轮次与结算"
                  aria-pressed={transferRecipient.type === "BANK"}
                  onClick={() => setTransferRecipient({ type: "BANK" })}
                >
                  <Landmark />
                  <strong>银行</strong>
                  <span className="character-divider" aria-hidden="true" />
                  <small>管理审批、轮次与结算</small>
                </button>
              </div>
            </fieldset>
            <label>
              转帐金额
              <input
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={transferAmount}
                onChange={(event) => setTransferAmount(event.target.value)}
              />
            </label>
            {isMeizhuang && (
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={transferIsPlotFine}
                  onChange={(event) =>
                    setTransferIsPlotFine(event.target.checked)
                  }
                />
                <span>剧情罚俸或损失时勾选（沈眉庄专属技能）</span>
              </label>
            )}
            {isMeizhuang && transferIsPlotFine && validTransferAmount && (
              <div className="transfer-fine-preview" role="status">
                <span>原始金额 {formatMoney(rawTransferAmount)} 两</span>
                <span>沈眉庄减免 {formatMoney(plotFineReduction)} 两</span>
                <strong>
                  预计支付 {formatMoney(estimatedTransferAmount)} 两
                </strong>
              </div>
            )}
            <button
              className="primary"
              disabled={busy || !validTransferAmount}
              type="submit"
            >
              {busy ? <LoaderCircle className="spin" /> : <ArrowLeftRight />}
              确认转帐
            </button>
          </form>
        </ActionSheet>
      )}

      {panel === "BANK_PAYMENT" && (
        <ActionSheet title="申请银行付款" onClose={() => setPanel(null)}>
          <form onSubmit={(event) => void requestBankPayment(event)}>
            <label>
              付款金额
              <input
                required
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={bankPaymentAmount}
                onChange={(event) => setBankPaymentAmount(event.target.value)}
              />
            </label>
            <button
              className="primary"
              disabled={
                busy ||
                !Number.isInteger(Number(bankPaymentAmount)) ||
                Number(bankPaymentAmount) <= 0
              }
              type="submit"
            >
              {busy ? <LoaderCircle className="spin" /> : <Banknote />}
              提交付款申请
            </button>
          </form>
        </ActionSheet>
      )}

      {panel === "EVENT" && (
        <ActionSheet title="实体事件" onClose={() => setPanel(null)}>
          <p className="sheet-copy">
            只记录现场已真实发生的实体卡牌或冷宫事件。
          </p>
          <label>
            停轮次数
            <input
              type="number"
              min="1"
              step="1"
              inputMode="numeric"
              value={eventSkipCount}
              onChange={(event) => setEventSkipCount(event.target.value)}
            />
          </label>
          <label>
            剧情说明
            <textarea
              rows={2}
              value={plotRestReason}
              onChange={(event) => setPlotRestReason(event.target.value)}
              placeholder="填写剧情停轮原因"
            />
          </label>
          <div className="event-actions">
            <button
              className="quick"
              disabled={
                busy ||
                !Number.isInteger(Number(eventSkipCount)) ||
                Number(eventSkipCount) <= 0
              }
              onClick={() => void triggerEvent("cold")}
            >
              <Crown />
              <span>冷宫事件</span>
            </button>
            <button
              className="quick"
              disabled={
                busy ||
                !Number.isInteger(Number(eventSkipCount)) ||
                Number(eventSkipCount) <= 0 ||
                !plotRestReason.trim()
              }
              onClick={() => void requestPlotRest()}
            >
              <CircleMinus />
              <span>剧情停轮</span>
            </button>
            <button
              className="quick"
              disabled={busy}
              onClick={() => void triggerEvent("companion")}
            >
              <Users />
              <span>获得伙伴卡</span>
            </button>
            <button
              className="quick"
              disabled={busy}
              onClick={openReturnCompanion}
            >
              <PackageMinus />
              <span>放回伙伴卡</span>
            </button>
          </div>
        </ActionSheet>
      )}

      {returnCompanionOpen && (
        <ConfirmDialog
          title="确认放回一张实体伙伴卡"
          confirmLabel="确认放回"
          busy={busy}
          onCancel={cancelReturnCompanion}
          onConfirm={() => void requestReturnCompanion()}
        >
          <p>银行批准后获得 500 两</p>
          <p>该操作不关联落点，批准后不可撤销</p>
        </ConfirmDialog>
      )}

      {panel === "SKIP_CONSUME" && (
        <ActionSheet title="停轮次数减除" onClose={() => setPanel(null)}>
          <label>
            减除次数
            <select
              value={playerSkipConsumeCount}
              onChange={(event) =>
                setPlayerSkipConsumeCount(event.target.value)
              }
            >
              {Array.from(
                { length: me.remainingSkipTurns },
                (_, index) => index + 1,
              ).map((count) => (
                <option value={count} key={count}>
                  {count} 次
                </option>
              ))}
              <option value="ALL">全部（{me.remainingSkipTurns} 次）</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={
              busy ||
              !Number.isInteger(playerSkipConsumeTotal) ||
              playerSkipConsumeTotal <= 0 ||
              playerSkipConsumeTotal > me.remainingSkipTurns
            }
            onClick={() => void requestSkipConsumption()}
          >
            {busy ? <LoaderCircle className="spin" /> : <CircleMinus />}
            提交减除申请
          </button>
        </ActionSheet>
      )}
    </>
  );
}

function BankView({
  snapshot,
  busy,
  tab,
  action,
  showNotice,
  showToast,
  onFinish,
}: {
  snapshot: Snapshot;
  busy: boolean;
  tab: "SUMMARY" | "APPROVAL" | "PROPERTY" | "LEDGER" | "TRANSACTION";
  action: ActionRunner;
  showNotice: (message: string) => void;
  showToast: (toast: ToastInput) => void;
  onFinish: () => void;
}) {
  const pending = snapshot.requests.filter(
    (request) => request.status === "PENDING",
  );
  const pendingLandings = (snapshot.landings ?? []).filter(
    (landing) =>
      landing.status === "DECLARED" && !landing.propertyActionsCancelled,
  );
  const current = snapshot.players.find(
    (player) => player.id === snapshot.currentPlayerId,
  );
  const [adjustPlayerId, setAdjustPlayerId] = useState(
    snapshot.players[0]?.id ?? "",
  );
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");
  const [balanceAdjustment, setBalanceAdjustment] =
    useState<BalanceAdjustment | null>(null);
  const [reverseOpen, setReverseOpen] = useState(false);
  const [reverseReason, setReverseReason] = useState("");
  const [reverseTarget, setReverseTarget] = useState<ReversalCandidate | null>(
    null,
  );
  const [approveTarget, setApproveTarget] = useState<BankRequest | null>(null);
  const [rejectTarget, setRejectTarget] = useState<BankRequest | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [cancelLandingTarget, setCancelLandingTarget] =
    useState<Landing | null>(null);
  const [cancelLandingReason, setCancelLandingReason] = useState("");
  const [controlDialog, setControlDialog] = useState<
    "INVALIDATE" | "FORCE_NEXT" | null
  >(null);
  const [controlReason, setControlReason] = useState("");
  const [skipPlayerId, setSkipPlayerId] = useState(
    snapshot.players[0]?.id ?? "",
  );
  const [skipAdjustmentMode, setSkipAdjustmentMode] = useState<
    "ADD" | "REMOVE"
  >("ADD");
  const [skipCount, setSkipCount] = useState("1");
  const [skipSource, setSkipSource] = useState("PLOT_REST");
  const [skipReason, setSkipReason] = useState("");
  const [skipConsumeReason, setSkipConsumeReason] = useState("");
  const [skipConsumeCount, setSkipConsumeCount] = useState("1");
  const [skipAdjustment, setSkipAdjustment] = useState<SkipAdjustment | null>(
    null,
  );
  const [skipConsumption, setSkipConsumption] =
    useState<SkipConsumption | null>(null);
  const [plotFinePlayerId, setPlotFinePlayerId] = useState(
    snapshot.players[0]?.id ?? "",
  );
  const [plotFineAmount, setPlotFineAmount] = useState("");
  const [plotFineOpen, setPlotFineOpen] = useState(false);
  const idempotentAction = booleanRoomAction(action);
  const initialProperty = snapshot.properties[0];
  const initialPropertyOwnerId = initialProperty?.ownerId ?? "";
  const initialPropertyMortgaged = Boolean(
    initialPropertyOwnerId && initialProperty?.mortgaged,
  );
  const [adjustPropertyName, setAdjustPropertyName] = useState(
    initialProperty?.name ?? "",
  );
  const [propertyOwnerId, setPropertyOwnerId] = useState(
    initialPropertyOwnerId,
  );
  const [propertyLevel, setPropertyLevel] = useState(
    initialPropertyOwnerId && !initialPropertyMortgaged
      ? String(initialProperty?.level ?? 0)
      : "0",
  );
  const [propertyMortgaged, setPropertyMortgaged] = useState(
    initialPropertyMortgaged,
  );
  const [propertyReason, setPropertyReason] = useState("");
  const [propertyAdjustment, setPropertyAdjustment] =
    useState<PropertyAdjustment | null>(null);

  useEffect(() => {
    const firstPlayerId = snapshot.players[0]?.id ?? "";
    if (
      !snapshot.players.some((player) => player.id === adjustPlayerId) &&
      adjustPlayerId !== firstPlayerId
    )
      setAdjustPlayerId(firstPlayerId);
    if (
      !snapshot.players.some((player) => player.id === skipPlayerId) &&
      skipPlayerId !== firstPlayerId
    )
      setSkipPlayerId(firstPlayerId);
    if (
      !snapshot.players.some((player) => player.id === plotFinePlayerId) &&
      plotFinePlayerId !== firstPlayerId
    )
      setPlotFinePlayerId(firstPlayerId);
  }, [adjustPlayerId, plotFinePlayerId, skipPlayerId, snapshot.players]);

  function selectPropertyForAdjustment(propertyName: string) {
    const property = snapshot.properties.find(
      (item) => item.name === propertyName,
    );
    if (!property) return;
    const ownerId = property.ownerId ?? "";
    setAdjustPropertyName(propertyName);
    setPropertyOwnerId(ownerId);
    setPropertyLevel(
      ownerId && !property.mortgaged ? String(property.level) : "0",
    );
    setPropertyMortgaged(Boolean(ownerId && property.mortgaged));
  }

  async function start() {
    const ok = await idempotentAction(`/api/rooms/${snapshot.id}/start`);
    if (ok) showNotice("房间已开局");
  }

  async function approve() {
    if (!approveTarget) return;
    if (approveTarget.type === "PLAYER_TRANSFER") {
      const target = approveTarget;
      const result = await action({
        path: `/api/rooms/${snapshot.id}/requests/${target.id}/approve`,
      });
      if (result.committed) {
        setApproveTarget(null);
        showNotice("审批已执行");
        return;
      }
      const details = result.error instanceof ApiError
        ? result.error.data as { error?: string }
        : {};
      showToast(bankApprovalFailureToast(
        details.error ?? (result.error instanceof ApiError ? result.error.code : 'INTERNAL_ERROR'),
        target.id,
      ));
      return;
    }
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/requests/${approveTarget.id}/approve`,
    );
    if (ok) {
      setApproveTarget(null);
      showNotice("审批已执行");
    }
  }

  async function rejectRequest() {
    if (!rejectTarget) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/requests/${rejectTarget.id}/reject`,
      { reason: rejectReason.trim() },
    );
    if (ok) {
      setRejectTarget(null);
      setRejectReason("");
      showNotice("请求已拒绝");
    }
  }

  async function confirmLanding(landing: Landing) {
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/landings/${landing.id}/confirm`,
      { plotResolved: true },
    );
    if (ok)
      showNotice(
        `已确认${snapshot.players.find((player) => player.id === landing.playerId)?.name ?? "玩家"}落点`,
      );
  }

  async function cancelLandingPropertyActions() {
    if (!cancelLandingTarget || !cancelLandingReason.trim()) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/landings/${cancelLandingTarget.id}/cancel-property-actions`,
      { reason: cancelLandingReason.trim() },
    );
    if (ok) {
      setCancelLandingTarget(null);
      setCancelLandingReason("");
      showNotice("已取消该落点的地产操作");
    }
  }

  function prepareBalanceAdjustment(event: FormEvent) {
    event.preventDefault();
    setBalanceAdjustment({
      playerId: adjustPlayerId,
      amount: Number(adjustAmount),
      reason: adjustReason.trim(),
    });
  }

  async function executeBalanceAdjustment() {
    if (!balanceAdjustment) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/bank/adjust-balance`,
      balanceAdjustment,
    );
    if (ok) {
      const player = snapshot.players.find(
        (item) => item.id === balanceAdjustment.playerId,
      );
      showNotice(
        `已为${player?.name ?? "玩家"}修正 ${formatMoney(balanceAdjustment.amount)} 两`,
      );
      setAdjustAmount("");
      setAdjustReason("");
      setBalanceAdjustment(null);
    }
  }

  async function reverseLatest() {
    if (!reverseTarget || !reverseReason.trim()) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/transactions/reverse-latest`,
      { transactionId: reverseTarget.id, reason: reverseReason.trim() },
    );
    if (ok) {
      setReverseOpen(false);
      setReverseReason("");
      setReverseTarget(null);
      showNotice("最近事务已撤销并写入反向账本");
    }
  }

  function openReversal() {
    if (!snapshot.reversalCandidate) return;
    setReverseTarget(snapshot.reversalCandidate);
    setReverseReason("");
    setReverseOpen(true);
  }

  function closeReversal() {
    setReverseOpen(false);
    setReverseReason("");
    setReverseTarget(null);
  }

  async function executeControl() {
    if (!controlDialog) return;
    const path =
      controlDialog === "INVALIDATE"
        ? "turn/invalidate-roll"
        : "turn/force-next";
    const ok = await idempotentAction(`/api/rooms/${snapshot.id}/${path}`, {
      reason: controlReason.trim(),
    });
    if (ok) {
      const message =
        controlDialog === "INVALIDATE"
          ? "本轮骰子已判定无效"
          : "已强制切换至下一位玩家";
      setControlDialog(null);
      setControlReason("");
      showNotice(message);
    }
  }

  function prepareSkipAdjustment() {
    setSkipAdjustment({
      playerId: skipPlayerId,
      count: Number(skipCount),
      source: skipSource,
      reason: skipReason.trim(),
    });
  }

  function submitSkipAdjustment(event: FormEvent) {
    event.preventDefault();
    if (skipAdjustmentMode === "ADD") prepareSkipAdjustment();
    else prepareSkipConsumption();
  }

  function selectSkipAdjustmentMode(mode: "ADD" | "REMOVE") {
    setSkipAdjustmentMode(mode);
    if (mode === "ADD") setSkipConsumeReason("");
    else setSkipReason("");
  }

  async function executeSkipAdjustment() {
    if (!skipAdjustment) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/bank/add-skip-turns`,
      skipAdjustment,
    );
    if (ok) {
      setSkipReason("");
      setSkipAdjustment(null);
      showNotice(`已增加 ${skipAdjustment.count} 次停轮`);
    }
  }

  function prepareSkipConsumption() {
    const player = snapshot.players.find((item) => item.id === skipPlayerId);
    const count =
      skipConsumeCount === "ALL"
        ? (player?.remainingSkipTurns ?? 0)
        : Number(skipConsumeCount);
    if (
      !skipConsumeReason.trim() ||
      !Number.isInteger(count) ||
      count <= 0 ||
      count > (player?.remainingSkipTurns ?? 0)
    )
      return;
    setSkipConsumption({
      playerId: skipPlayerId,
      count,
      reason: skipConsumeReason.trim(),
    });
  }

  async function executeSkipConsumption() {
    if (!skipConsumption) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/bank/consume-skip-turn`,
      skipConsumption,
    );
    if (ok) {
      setSkipConsumeReason("");
      setSkipConsumeCount("1");
      setSkipConsumption(null);
      showNotice(`已扣减 ${skipConsumption.count} 次停轮`);
    }
  }

  async function executePlotFine() {
    const amount = Number(plotFineAmount);
    if (!plotFinePlayerId || !Number.isInteger(amount) || amount <= 0) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/events/plot-fine`,
      { playerId: plotFinePlayerId, amount },
    );
    if (ok) {
      setPlotFineOpen(false);
      setPlotFineAmount("");
      showNotice("剧情罚款已执行");
    }
  }

  function preparePropertyAdjustment(event: FormEvent) {
    event.preventDefault();
    const ownerPlayerId = propertyOwnerId || null;
    const mortgaged = Boolean(ownerPlayerId && propertyMortgaged);
    const buildingLevel =
      ownerPlayerId && !mortgaged ? Number(propertyLevel) : 0;
    setPropertyAdjustment({
      propertyName: adjustPropertyName,
      ownerPlayerId,
      buildingLevel,
      mortgaged,
      reason: propertyReason.trim(),
    });
  }

  async function executePropertyAdjustment() {
    if (!propertyAdjustment) return;
    const ok = await idempotentAction(
      `/api/rooms/${snapshot.id}/bank/adjust-property`,
      propertyAdjustment,
    );
    if (ok) {
      setPropertyReason("");
      setPropertyAdjustment(null);
      showNotice(`${propertyAdjustment.propertyName}状态已修正`);
    }
  }

  function openControl(type: typeof controlDialog) {
    setControlReason("");
    setControlDialog(type);
  }

  const balanceAdjustmentPlayer = balanceAdjustment
    ? snapshot.players.find(
        (player) => player.id === balanceAdjustment.playerId,
      )
    : undefined;
  const skipAdjustmentPlayer = skipAdjustment
    ? snapshot.players.find((player) => player.id === skipAdjustment.playerId)
    : undefined;
  const coldPalaceReduction =
    skipAdjustment?.source === "COLD_PALACE"
      ? Math.max(0, skipAdjustmentPlayer?.coldPalaceSkipReduction ?? 0)
      : 0;
  const actualSkipCount = skipAdjustment
    ? Math.max(0, skipAdjustment.count - coldPalaceReduction)
    : 0;
  const coldPalaceCashReward =
    skipAdjustment?.source === "COLD_PALACE"
      ? Math.max(0, skipAdjustmentPlayer?.coldPalaceCashReward ?? 0)
      : 0;
  const skipConsumptionPlayer = skipConsumption
    ? snapshot.players.find((player) => player.id === skipConsumption.playerId)
    : undefined;
  const selectedSkipConsumptionPlayer = snapshot.players.find(
    (player) => player.id === skipPlayerId,
  );
  const selectedSkipConsumptionCount =
    skipConsumeCount === "ALL"
      ? (selectedSkipConsumptionPlayer?.remainingSkipTurns ?? 0)
      : Number(skipConsumeCount);
  const plotFinePlayer = snapshot.players.find(
    (player) => player.id === plotFinePlayerId,
  );
  const plotFineOriginalAmount = Number(plotFineAmount);
  const plotFineReduction = Math.max(0, plotFinePlayer?.plotFineReduction ?? 0);
  const plotFineActualAmount = Math.max(
    0,
    plotFineOriginalAmount - plotFineReduction,
  );
  const companionCashReward = Math.max(
    0,
    (approveTarget
      ? snapshot.players.find(
          (player) => player.id === approveTarget.playerId,
        )?.companionCashReward
      : 0) ?? 0,
  );

  return (
    <>
      {tab === "SUMMARY" && (
        <>
          <section className="bank-summary">
            <div>
              <Users />
              <strong>{snapshot.players.length}</strong>
              <span>玩家</span>
            </div>
            <div>
              <Landmark />
              <strong>
                {
                  snapshot.properties.filter((property) => property.ownerId)
                    .length
                }
              </strong>
              <span>已售地产</span>
            </div>
            <div>
              <ShieldCheck />
              <strong>
                {snapshot.status === "PLAYING"
                  ? "进行中"
                  : snapshot.status === "ENDED"
                    ? "已结束"
                    : "待开局"}
              </strong>
              <span>房间状态</span>
            </div>
          </section>
          {snapshot.status === "LOBBY" && (
            <button
              className="primary page-action"
              disabled={busy || snapshot.players.length < 2}
              onClick={() => void start()}
            >
              <Play />
              <span>确认玩家并开局</span>
            </button>
          )}
          {snapshot.status === "PLAYING" && (
            <section className="current-turn">
              <span>当前行动</span>
              <strong>{current?.name ?? "实体轮次"}</strong>
              <small>
                {snapshot.diceMode === "PHYSICAL"
                  ? "现场轮次由银行确认"
                  : snapshot.turn?.total
                    ? `本轮骰子 ${snapshot.turn.total} 点`
                    : "等待玩家掷骰"}
              </small>
            </section>
          )}
          <SectionTitle
            title="玩家总览"
            action={`${snapshot.players.length} 人`}
          />
          <PlayerAssetAccordion
            players={snapshot.players}
            properties={snapshot.properties}
          />
          <SectionTitle title="待审批" action={`${pending.length} 项`} />
          {pending.length ? (
            <ApprovalList
              requests={pending.slice(0, 2)}
              players={snapshot.players}
              busy={busy}
              approve={setApproveTarget}
              reject={(request) => {
                setRejectReason("");
                setRejectTarget(request);
              }}
            />
          ) : (
            <div className="empty">当前没有待审批请求</div>
          )}
        </>
      )}

      {tab === "APPROVAL" && (
        <>
          <SectionTitle
            title="待确认落点"
            action={`${pendingLandings.length} 项`}
          />
          {pendingLandings.length ? (
            <div className="approval-list">
              {pendingLandings.map((landing) => (
                <article key={landing.id}>
                  <div className="request-icon">
                    <MapPin />
                  </div>
                  <div>
                    <span>实体落点</span>
                    <strong>
                      {
                        snapshot.players.find(
                          (player) => player.id === landing.playerId,
                        )?.name
                      }
                    </strong>
                    <small>{landing.propertyName ?? landing.spaceType}</small>
                  </div>
                  {landing.spaceType === "PROPERTY" ? (
                    <div className="request-actions">
                      <button
                        disabled={busy}
                        onClick={() => void confirmLanding(landing)}
                      >
                        确认已结算剧情
                      </button>
                      <button
                        disabled={busy}
                        onClick={() => {
                          setCancelLandingReason("");
                          setCancelLandingTarget(landing);
                        }}
                      >
                        取消地产操作
                      </button>
                    </div>
                  ) : (
                    <button
                      disabled={busy}
                      onClick={() => void confirmLanding(landing)}
                    >
                      确认已结算剧情
                    </button>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="empty">没有待确认落点</div>
          )}
          <SectionTitle title="待审批请求" action={`${pending.length} 项`} />
          {pending.length ? (
            <ApprovalList
              requests={pending}
              players={snapshot.players}
              busy={busy}
              approve={setApproveTarget}
              reject={(request) => {
                setRejectReason("");
                setRejectTarget(request);
              }}
            />
          ) : (
            <div className="empty page-empty">所有请求均已处理</div>
          )}
        </>
      )}

      {tab === "PROPERTY" && (
        <>
          <SectionTitle
            title="全地图地产"
            action={`${snapshot.properties.length} 块`}
          />
          <LandingPropertyCardPicker
            mode="browse"
            properties={snapshot.properties}
            players={snapshot.players}
          />
        </>
      )}

      {tab === "LEDGER" && (
        <>
          <SectionTitle
            title="房间账本"
            action={`${snapshot.ledger.length} 笔`}
          />
          <Ledger entries={snapshot.ledger} players={snapshot.players} />
        </>
      )}

      {tab === "TRANSACTION" && (
        <div className="transaction-page">
          <SectionTitle title="剧情罚款" action="需要二次确认" />
          <form
            className="tool-section"
            onSubmit={(event) => {
              event.preventDefault();
              setPlotFineOpen(true);
            }}
          >
            <div className="tool-heading">
              <AlertTriangle />
              <div>
                <h2>执行剧情罚款</h2>
                <p>按剧情卡原始金额录入</p>
              </div>
            </div>
            <label>
              罚款玩家
              <select
                required
                value={plotFinePlayerId}
                onChange={(event) => setPlotFinePlayerId(event.target.value)}
              >
                {snapshot.players.map((player) => (
                  <option value={player.id} key={player.id}>
                    {player.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              剧情罚款金额
              <input
                required
                type="number"
                min="1"
                step="1"
                inputMode="numeric"
                value={plotFineAmount}
                onChange={(event) => setPlotFineAmount(event.target.value)}
              />
            </label>
            <button
              className="danger-button"
              type="submit"
              disabled={
                busy ||
                !plotFinePlayerId ||
                !Number.isInteger(Number(plotFineAmount)) ||
                Number(plotFineAmount) <= 0
              }
            >
              执行剧情罚款
            </button>
          </form>

          {snapshot.diceMode === "ELECTRONIC" && (
            <>
              <SectionTitle
                title="轮次控制"
                action={`第 ${snapshot.turn?.number ?? "-"} 轮`}
              />
              <section className="tool-section">
                <div className="tool-heading">
                  <Dices />
                  <div>
                    <h2>现场裁定</h2>
                    <p>所有强制操作都会记录原因</p>
                  </div>
                </div>
                <div className="control-actions">
                  <button
                    disabled={
                      busy ||
                      snapshot.status !== "PLAYING" ||
                      snapshot.turn?.total === undefined
                    }
                    onClick={() => openControl("INVALIDATE")}
                  >
                    <Dices />
                    判定骰子无效
                  </button>
                  <button
                    disabled={busy || snapshot.status !== "PLAYING"}
                    onClick={() => openControl("FORCE_NEXT")}
                  >
                    <Play />
                    强制下一位
                  </button>
                </div>
              </section>
            </>
          )}

          <SectionTitle title="停轮管理" action="按玩家调整" />
          <form className="tool-section" onSubmit={submitSkipAdjustment}>
            <div className="tool-heading">
              <Crown />
              <div>
                <h2>增加或扣减停轮</h2>
                <p>冷宫停轮将同时阻止收取过路费</p>
              </div>
            </div>
            <label>
              停轮玩家
              <select
                required
                value={skipPlayerId}
                onChange={(event) => setSkipPlayerId(event.target.value)}
              >
                {snapshot.players.map((player) => (
                  <option value={player.id} key={player.id}>
                    {player.name} · 当前 {player.remainingSkipTurns} 次
                  </option>
                ))}
              </select>
            </label>
            <div className="segments two skip-adjustment-mode" aria-label="停轮操作">
              <button
                type="button"
                className={skipAdjustmentMode === "ADD" ? "active add" : "add"}
                aria-pressed={skipAdjustmentMode === "ADD"}
                onClick={() => selectSkipAdjustmentMode("ADD")}
              >
                增加
              </button>
              <button
                type="button"
                className={skipAdjustmentMode === "REMOVE" ? "active remove" : "remove"}
                aria-pressed={skipAdjustmentMode === "REMOVE"}
                onClick={() => selectSkipAdjustmentMode("REMOVE")}
              >
                扣减
              </button>
            </div>
            {skipAdjustmentMode === "ADD" ? (
              <>
                <div className="form-grid">
                  <label>
                    次数
                    <input
                      required
                      type="number"
                      min="1"
                      step="1"
                      inputMode="numeric"
                      value={skipCount}
                      onChange={(event) => setSkipCount(event.target.value)}
                    />
                  </label>
                  <label>
                    停轮来源
                    <select
                      value={skipSource}
                      onChange={(event) => setSkipSource(event.target.value)}
                    >
                      <option value="PLOT_REST">剧情原地停留</option>
                      <option value="COLD_PALACE">冷宫</option>
                      <option value="MANUAL">现场裁定</option>
                    </select>
                  </label>
                </div>
                <label>
                  停轮说明
                  <input
                    required
                    value={skipReason}
                    onChange={(event) => setSkipReason(event.target.value)}
                    placeholder="例：剧情卡原地停留"
                  />
                </label>
              </>
            ) : (
              <>
                <label>
                  扣减次数
                  <select
                    value={skipConsumeCount}
                    onChange={(event) => setSkipConsumeCount(event.target.value)}
                  >
                    {Array.from(
                      { length: selectedSkipConsumptionPlayer?.remainingSkipTurns ?? 0 },
                      (_, index) => index + 1,
                    ).map((count) => (
                      <option value={count} key={count}>
                        {count} 次
                      </option>
                    ))}
                    <option value="ALL">
                      全部（{selectedSkipConsumptionPlayer?.remainingSkipTurns ?? 0} 次）
                    </option>
                  </select>
                </label>
                <label>
                  扣减原因
                  <input
                    required
                    value={skipConsumeReason}
                    onChange={(event) => setSkipConsumeReason(event.target.value)}
                    placeholder="填写停轮调整依据"
                  />
                </label>
              </>
            )}
            <button
              className={`primary ${skipAdjustmentMode === "REMOVE" ? "jade" : ""}`}
              type="submit"
              disabled={
                busy ||
                !skipPlayerId ||
                (skipAdjustmentMode === "ADD"
                  ? Number(skipCount) <= 0 || !skipReason.trim()
                  : !skipConsumeReason.trim() ||
                    !Number.isInteger(selectedSkipConsumptionCount) ||
                    selectedSkipConsumptionCount <= 0 ||
                    selectedSkipConsumptionCount >
                      (selectedSkipConsumptionPlayer?.remainingSkipTurns ?? 0))
              }
            >
              提交
            </button>
          </form>

          <SectionTitle title="账务修正" action="产生审计账本" />
          <form className="tool-section" onSubmit={prepareBalanceAdjustment}>
            <div className="tool-heading">
              <CircleDollarSign />
              <div>
                <h2>余额修正</h2>
                <p>正数付款，负数扣款；强制写入审计</p>
              </div>
            </div>
            <label>
              修正玩家
              <select
                required
                value={adjustPlayerId}
                onChange={(event) => setAdjustPlayerId(event.target.value)}
              >
                {snapshot.players.map((player) => (
                  <option value={player.id} key={player.id}>
                    {player.name} · {formatMoney(player.balance)} 两
                  </option>
                ))}
              </select>
            </label>
            <label>
              修正金额
              <input
                required
                type="number"
                inputMode="numeric"
                step="1"
                value={adjustAmount}
                onChange={(event) => setAdjustAmount(event.target.value)}
              />
            </label>
            <label>
              修正原因
              <textarea
                required
                rows={2}
                value={adjustReason}
                onChange={(event) => setAdjustReason(event.target.value)}
                placeholder="例：补录实体剧情卡奖励"
              />
            </label>
            <button
              className="primary"
              type="submit"
              disabled={
                busy ||
                !adjustPlayerId ||
                Number(adjustAmount) === 0 ||
                !adjustReason.trim()
              }
            >
              {busy ? <LoaderCircle className="spin" /> : <Banknote />}确认修正
            </button>
          </form>

          <SectionTitle title="地产人工修正" action="所有者 · 建筑 · 抵押" />
          <form className="tool-section" onSubmit={preparePropertyAdjustment}>
            <div className="tool-heading">
              <Landmark />
              <div>
                <h2>地产状态</h2>
                <p>仅用于补录实体地产证或纠正误操作</p>
              </div>
            </div>
            <label>
              修正地产
              <select
                required
                value={adjustPropertyName}
                onChange={(event) =>
                  selectPropertyForAdjustment(event.target.value)
                }
              >
                {snapshot.properties.map((property) => (
                  <option key={property.name}>{property.name}</option>
                ))}
              </select>
            </label>
            <label>
              地产所有者
              <select
                value={propertyOwnerId}
                onChange={(event) => {
                  const ownerId = event.target.value;
                  setPropertyOwnerId(ownerId);
                  if (!ownerId) {
                    setPropertyLevel("0");
                    setPropertyMortgaged(false);
                  }
                }}
              >
                <option value="">国库（无主）</option>
                {snapshot.players.map((player) => (
                  <option value={player.id} key={player.id}>
                    {player.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              建筑等级
              <select
                disabled={!propertyOwnerId || propertyMortgaged}
                value={propertyLevel}
                onChange={(event) => setPropertyLevel(event.target.value)}
              >
                {[0, 1, 2, 3, 4, 5].map((level) => (
                  <option value={level} key={level}>
                    {level === 5 ? "5 · 大宫殿" : `${level} 级`}
                  </option>
                ))}
              </select>
            </label>
            <label className="check-field">
              <input
                type="checkbox"
                disabled={!propertyOwnerId}
                checked={propertyMortgaged}
                onChange={(event) => {
                  const mortgaged = event.target.checked;
                  setPropertyMortgaged(mortgaged);
                  if (mortgaged) setPropertyLevel("0");
                }}
              />
              <span>抵押状态</span>
            </label>
            <label>
              地产修正原因
              <textarea
                required
                rows={2}
                value={propertyReason}
                onChange={(event) => setPropertyReason(event.target.value)}
                placeholder="填写现场状态与修正依据"
              />
            </label>
            <button
              className="primary"
              type="submit"
              disabled={busy || !adjustPropertyName || !propertyReason.trim()}
            >
              {busy ? <LoaderCircle className="spin" /> : <Landmark />}
              确认地产修正
            </button>
          </form>

          <SectionTitle title="危险操作" action="需要二次确认" />
          <section className="danger-zone">
            <div>
              <RotateCcw />
              <div>
                <strong>撤销最近事务</strong>
                <span>
                  {snapshot.reversalCandidate
                    ? `当前候选：${transactionName(snapshot.reversalCandidate.type)}`
                    : "当前没有可撤销事务"}
                </span>
              </div>
            </div>
            <button
              className="danger-button"
              disabled={busy || !snapshot.reversalCandidate}
              onClick={openReversal}
            >
              撤销最近事务
            </button>
            <div className="danger-divider">
              <AlertTriangle />
              <div>
                <strong>结束游戏并结算</strong>
                <span>先检查阻塞项和当前排名，再生成不可变结算</span>
              </div>
            </div>
            <button
              className="danger-button"
              disabled={busy || snapshot.status !== "PLAYING"}
              onClick={onFinish}
            >
              结束游戏
            </button>
          </section>

          <SectionTitle
            title="最近操作日志"
            action={`${snapshot.audit?.length ?? 0} 条`}
          />
          <AuditList entries={snapshot.audit ?? []} />
        </div>
      )}

      {balanceAdjustment && (
        <ConfirmDialog
          title="确认余额修正"
          confirmLabel="执行余额修正"
          busy={busy}
          onCancel={() => setBalanceAdjustment(null)}
          onConfirm={() => void executeBalanceAdjustment()}
        >
          <p>目标玩家：{balanceAdjustmentPlayer?.name ?? "未知玩家"}</p>
          <p>
            余额：{formatMoney(balanceAdjustmentPlayer?.balance ?? 0)} 两 →{" "}
            {formatMoney(
              (balanceAdjustmentPlayer?.balance ?? 0) +
                balanceAdjustment.amount,
            )}{" "}
            两
          </p>
          <p>
            变更：{balanceAdjustment.amount > 0 ? "+" : ""}
            {formatMoney(balanceAdjustment.amount)} 两
          </p>
          <p>原因：{balanceAdjustment.reason}</p>
        </ConfirmDialog>
      )}

      {skipAdjustment && (
        <ConfirmDialog
          title="确认增加停轮"
          confirmLabel="确认增加停轮"
          busy={busy}
          onCancel={() => setSkipAdjustment(null)}
          onConfirm={() => void executeSkipAdjustment()}
        >
          <p>目标玩家：{skipAdjustmentPlayer?.name ?? "未知玩家"}</p>
          <p>
            停轮：{skipAdjustmentPlayer?.remainingSkipTurns ?? 0} 次 →{" "}
            {(skipAdjustmentPlayer?.remainingSkipTurns ?? 0) + actualSkipCount}{" "}
            次
          </p>
          <p>
            {skipAdjustment.source === "COLD_PALACE"
              ? `变更：冷宫 ${skipAdjustment.count} 次，实际增加 ${actualSkipCount} 次停轮`
              : `变更：增加 ${actualSkipCount} 次停轮`}
          </p>
          {coldPalaceCashReward > 0 && (
            <p>
              余额：{formatMoney(skipAdjustmentPlayer?.balance ?? 0)} 两 →{" "}
              {formatMoney(
                (skipAdjustmentPlayer?.balance ?? 0) + coldPalaceCashReward,
              )}{" "}
              两
            </p>
          )}
          <p>原因：{skipAdjustment.reason}</p>
        </ConfirmDialog>
      )}

      {skipConsumption && (
        <ConfirmDialog
          title="确认扣减停轮"
          confirmLabel="确认扣减停轮"
          busy={busy}
          onCancel={() => setSkipConsumption(null)}
          onConfirm={() => void executeSkipConsumption()}
        >
          <p>目标玩家：{skipConsumptionPlayer?.name ?? "未知玩家"}</p>
          <p>
            停轮：{skipConsumptionPlayer?.remainingSkipTurns ?? 0} 次 →{" "}
            {Math.max(
              0,
              (skipConsumptionPlayer?.remainingSkipTurns ?? 0) -
                skipConsumption.count,
            )}{" "}
            次
          </p>
          <p>变更：扣减 {skipConsumption.count} 次停轮</p>
          <p>原因：{skipConsumption.reason}</p>
        </ConfirmDialog>
      )}

      {propertyAdjustment && (
        <ConfirmDialog
          title="确认地产人工修正"
          confirmLabel="执行地产修正"
          busy={busy}
          onCancel={() => setPropertyAdjustment(null)}
          onConfirm={() => void executePropertyAdjustment()}
        >
          <p>{propertyAdjustment.propertyName}</p>
          <p>
            {snapshot.players.find(
              (player) => player.id === propertyAdjustment.ownerPlayerId,
            )?.name ?? "国库"}{" "}
            ·{" "}
            {propertyAdjustment.buildingLevel === 5
              ? "大宫殿"
              : `${propertyAdjustment.buildingLevel} 级`}{" "}
            · {propertyAdjustment.mortgaged ? "已抵押" : "未抵押"}
          </p>
          <p>原因：{propertyAdjustment.reason}</p>
        </ConfirmDialog>
      )}

      {reverseOpen && reverseTarget && (
        <ConfirmDialog
          title="撤销最近事务"
          confirmLabel="确认撤销"
          busy={busy}
          disabled={!reverseReason.trim()}
          onCancel={closeReversal}
          onConfirm={() => void reverseLatest()}
        >
          <p>撤销会追加反向账本，原交易记录仍会保留。</p>
          <div className="reversal-summary">
            <strong>{transactionName(reverseTarget.type)}</strong>
            <small>
              {new Date(reverseTarget.createdAt).toLocaleString("zh-CN", {
                hour12: false,
              })}
            </small>
            {reverseTarget.effects.map((effect, index) => (
              <span key={`${effect.playerId}-${index}`}>
                {snapshot.players.find(
                  (player) => player.id === effect.playerId,
                )?.name ?? "玩家"}{" "}
                {effect.amount > 0 ? "+" : ""}
                {formatMoney(effect.amount)} 两
              </span>
            ))}
          </div>
          <label>
            撤销原因
            <textarea
              required
              rows={3}
              value={reverseReason}
              onChange={(event) => setReverseReason(event.target.value)}
              placeholder="填写现场裁定或误操作说明"
            />
          </label>
        </ConfirmDialog>
      )}

      {plotFineOpen && (
        <ConfirmDialog
          title="确认剧情罚款"
          confirmLabel="确认罚款"
          busy={busy}
          onCancel={() => setPlotFineOpen(false)}
          onConfirm={() => void executePlotFine()}
        >
          <p>罚款玩家：{plotFinePlayer?.name ?? "未知玩家"}</p>
          <p>原始金额 {formatMoney(plotFineOriginalAmount)} 两</p>
          <p>沈眉庄减免 {formatMoney(plotFineReduction)} 两</p>
          <p>实际扣款 {formatMoney(plotFineActualAmount)} 两</p>
          <small>最终金额由服务器按当前房间人物技能配置重新计算。</small>
        </ConfirmDialog>
      )}

      {approveTarget && (
        <ConfirmDialog
          title="确认批准请求"
          confirmLabel="确认批准"
          busy={busy}
          onCancel={() => setApproveTarget(null)}
          onConfirm={() => void approve()}
        >
          <p>
            玩家：
            {snapshot.players.find(
              (player) => player.id === approveTarget.playerId,
            )?.name ?? "未知玩家"}
          </p>
          {approveTarget.type === "RETURN_COMPANION_EVENT" ? (
            <>
              <p>放回 {approveTarget.quantity ?? 1} 张</p>
              <p>奖励 {formatMoney(approveTarget.amount)} 两</p>
              <p className="error">批准后不可撤销</p>
            </>
          ) : approveTarget.type === "COMPANION_EVENT" ? (
            <>
              {companionCashReward > 0 && (
                <p>自动奖励 {formatMoney(companionCashReward)} 两</p>
              )}
              <p className="error">伙伴卡事件批准后立即生效，不可撤销</p>
            </>
          ) : (
            <>
              <p>地产：{approveTarget.propertyName ?? "无"}</p>
              <p>金额：{formatMoney(approveTarget.amount)} 两</p>
              <p>数量：{approveTarget.quantity ?? "无"}</p>
            </>
          )}
          {approveTarget.type === "COLD_PALACE_EVENT" && (
            <p className="error">冷宫事件批准后立即生效，且不可撤销。</p>
          )}
        </ConfirmDialog>
      )}

      {rejectTarget && (
        <ConfirmDialog
          title="拒绝请求"
          confirmLabel="确认拒绝"
          busy={busy}
          disabled={!rejectReason.trim()}
          onCancel={() => setRejectTarget(null)}
          onConfirm={() => void rejectRequest()}
        >
          <p>拒绝后不会执行资金或地产变更，原因会保留在请求记录中。</p>
          <label>
            拒绝原因
            <textarea
              required
              rows={3}
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
              placeholder="填写现场裁定原因"
            />
          </label>
        </ConfirmDialog>
      )}

      {cancelLandingTarget && (
        <ConfirmDialog
          title="取消落点地产操作"
          confirmLabel="确认取消"
          busy={busy}
          disabled={!cancelLandingReason.trim()}
          onCancel={() => setCancelLandingTarget(null)}
          onConfirm={() => void cancelLandingPropertyActions()}
        >
          <p>取消后，该落点不能再用于购买或建造；原因会写入操作日志。</p>
          <label>
            取消原因
            <textarea
              required
              rows={3}
              value={cancelLandingReason}
              onChange={(event) => setCancelLandingReason(event.target.value)}
              placeholder="填写剧情或现场裁定原因"
            />
          </label>
        </ConfirmDialog>
      )}

      {controlDialog && (
        <ConfirmDialog
          title={controlDialog === "INVALIDATE" ? "判定骰子无效" : "强制下一位"}
          confirmLabel={
            controlDialog === "INVALIDATE" ? "确认无效" : "确认切换"
          }
          busy={busy}
          disabled={!controlReason.trim()}
          onCancel={() => setControlDialog(null)}
          onConfirm={() => void executeControl()}
        >
          <p>
            {controlDialog === "INVALIDATE"
              ? "清除本轮骰子结果后，当前玩家可重新掷骰。"
              : "当前回合会立即结束，操作权交给下一位玩家。"}
          </p>
          <label>
            {controlDialog === "INVALIDATE" ? "无效原因" : "切换原因"}
            <textarea
              required
              rows={3}
              value={controlReason}
              onChange={(event) => setControlReason(event.target.value)}
              placeholder="填写现场裁定原因"
            />
          </label>
        </ConfirmDialog>
      )}
    </>
  );
}

function ApprovalList({
  requests,
  players,
  busy,
  approve,
  reject,
}: {
  requests: BankRequest[];
  players: Player[];
  busy: boolean;
  approve: (request: BankRequest) => void;
  reject: (request: BankRequest) => void;
}) {
  return (
    <div className="approval-list">
      {requests.map((request) => {
        const player = players.find((item) => item.id === request.playerId);
        const details = approvalDetails(request, players);
        return (
          <article key={request.id}>
            <div className="request-icon">
              <Banknote />
            </div>
            <div>
              <span>{requestLabel(request.type)}</span>
              <strong>{player?.name ?? "未知玩家"}</strong>
              {details.map((detail) => (
                <small key={detail}>{detail}</small>
              ))}
              <small>请求编号 {request.id.slice(0, 8)}</small>
            </div>
            <div className="request-actions">
              {request.type === "TRADE_PROPERTY" && !request.buyerConfirmed ? (
                <button disabled>等待买家确认</button>
              ) : (
                <button disabled={busy} onClick={() => approve(request)}>
                  {requestActionLabel("批准", request)}
                </button>
              )}
              <button disabled={busy} onClick={() => reject(request)}>
                {requestActionLabel("拒绝", request)}
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function approvalDetails(request: BankRequest, players: Player[]) {
  const details = request.propertyName ? [request.propertyName] : [];
  if (request.type === "PLAYER_TRANSFER") {
    const recipient = players.find(
      (player) => player.id === request.targetPlayerId,
    );
    details.push(
      request.recipientType === "BANK"
        ? "收款：银行"
        : `收款：${recipient?.name ?? "未知玩家"}（${recipient?.characterId ? characterName(recipient.characterId) : "未选人物"}）`,
    );
    details.push(
      `原始金额 ${formatMoney(request.originalAmount ?? request.amount)} 两`,
    );
    if ((request.reduction ?? 0) > 0)
      details.push(`沈眉庄减免 ${formatMoney(request.reduction ?? 0)} 两`);
    details.push(
      `实际金额 ${formatMoney(request.actualAmount ?? request.amount)} 两`,
    );
  } else if (request.type === "TRADE_PROPERTY") {
    const buyer = players.find(
      (player) => player.id === request.targetPlayerId,
    );
    details.push(
      `买家：${buyer?.name ?? "未知玩家"} · 成交价 ${formatMoney(request.amount)} 两`,
    );
  } else if (request.type === "SELL_BUILDING") {
    details.push(
      `出售 ${request.quantity ?? 0} 栋 · 结算 ${formatMoney(request.amount)} 两`,
    );
  } else if (request.type === "COLD_PALACE_EVENT") {
    details.push(`停轮 ${request.quantity ?? 0} 次`);
  } else if (request.type === "PLOT_REST_EVENT") {
    details.push(`停轮 ${request.quantity ?? 0} 次`);
    if (request.note) details.push(request.note);
  } else if (request.type === "CONSUME_SKIP_TURNS") {
    details.push(`减除停轮 ${request.quantity ?? 0} 次`);
  } else if (request.type === "RETURN_COMPANION_EVENT") {
    details.push(
      `放回 ${request.quantity ?? 1} 张`,
      `奖励 ${formatMoney(request.amount)} 两`,
      "批准后不可撤销",
    );
  } else if (request.type !== "COMPANION_EVENT") {
    details.push(`结算 ${formatMoney(request.amount)} 两`);
  }
  return details;
}

function requestLabel(type: string) {
  return (
    (
      {
        BANK_PAYMENT: "银行付款",
        START_REWARD: "起点奖励",
        BUY_PROPERTY: "购买地产",
        BUILD_PROPERTY: "建造升级",
        SELL_BUILDING: "出售建筑",
        MORTGAGE_PROPERTY: "抵押地产",
        REDEEM_PROPERTY: "赎回地产",
        SELL_PROPERTY_TO_BANK: "卖给银行",
        TRADE_PROPERTY: "玩家间交易",
        PLAYER_TRANSFER: "转帐",
        COLD_PALACE_EVENT: "冷宫事件",
        COMPANION_EVENT: "获得伙伴卡",
        RETURN_COMPANION_EVENT: "放回伙伴卡",
        PLOT_REST_EVENT: "剧情停留",
        CONSUME_SKIP_TURNS: "减除停轮",
      } as Record<string, string>
    )[type] ?? type
  );
}

function requestActionLabel(action: "批准" | "拒绝", request: BankRequest) {
  if (
    request.type === "COLD_PALACE_EVENT" ||
    request.type === "COMPANION_EVENT" ||
    request.type === "RETURN_COMPANION_EVENT" ||
    request.type === "PLOT_REST_EVENT" ||
    request.type === "CONSUME_SKIP_TURNS"
  )
    return `${action}事件`;
  return `${action} ${formatMoney(request.amount)} 两`;
}

function AuditList({ entries }: { entries: AuditEntry[] }) {
  if (!entries.length) return <div className="empty">暂无操作日志</div>;
  return (
    <div className="audit-list">
      {entries.slice(0, 20).map((entry) => (
        <article key={entry.id}>
          <div>
            <strong>{entry.action}</strong>
            <span>
              {entry.actorRole ?? "SYSTEM"}
              {entry.createdAt
                ? ` · ${new Date(entry.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                : ""}
            </span>
          </div>
          <p>{entry.reason?.trim() || "系统操作"}</p>
        </article>
      ))}
    </div>
  );
}

function Ledger({
  entries,
  players,
  compact = false,
}: {
  entries: LedgerEntry[];
  players?: Player[];
  compact?: boolean;
}) {
  const visible = entries;
  return (
    <div className={`ledger ${compact ? "compact-ledger" : ""}`}>
      {visible.length ? (
        visible.map((entry) => {
          const transactionTime = formatLedgerTime(entry.createdAt);
          const playerName = players?.find(
            (player) => player.id === entry.playerId,
          )?.name;
          return (
            <div key={entry.id}>
              <span className={entry.amount >= 0 ? "money plus" : "money"}>
                {entry.amount >= 0 ? "+" : ""}
                {formatMoney(entry.amount)}
              </span>
              <div>
                <strong>{entry.description}</strong>
                <small>
                  {playerName ? `${playerName} · ` : ""}
                  {entry.type}
                  {transactionTime ? (
                    <>
                      {" · "}
                      <time dateTime={entry.createdAt}>{transactionTime}</time>
                    </>
                  ) : null}
                </small>
              </div>
            </div>
          );
        })
      ) : (
        <div className="empty no-margin">暂无交易记录</div>
      )}
    </div>
  );
}

function PropertyCost({
  property,
  mode,
  buildDiscount = 0,
}: {
  property?: Property;
  mode: "BUY" | "BUILD";
  buildDiscount?: number;
}) {
  if (!property) return null;
  const amount =
    mode === "BUY"
      ? property.purchasePrice
      : Math.max(0, property.build - buildDiscount);
  return (
    <div className="cost-line">
      <span>
        {mode === "BUY"
          ? "购买价格"
          : `升至 ${property.level + 1} 级${buildDiscount ? "（技能已减免）" : ""}`}
      </span>
      <strong>{formatMoney(amount)} 两</strong>
    </div>
  );
}

function useDialogFocus(onClose: () => void) {
  const ref = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const active =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previous =
      active && !dialog.contains(active) ? active : lastFocusOutsideDialog;
    const backdrop = dialog.closest(".modal-backdrop");
    const siblings = backdrop?.parentElement
      ? ([...backdrop.parentElement.children].filter(
          (item) => item !== backdrop,
        ) as HTMLElement[])
      : [];
    siblings.forEach((item) => {
      item.inert = true;
      item.setAttribute("aria-hidden", "true");
    });
    const focusable = () => [
      ...dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ),
    ];
    const focusFrame = window.requestAnimationFrame(() =>
      (
        dialog.querySelector<HTMLElement>("[autofocus]") ??
        focusable()[0] ??
        dialog
      ).focus(),
    );
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusable();
      if (!items.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.shiftKey
        ? currentIndex <= 0
          ? items.length - 1
          : currentIndex - 1
        : currentIndex < 0 || currentIndex === items.length - 1
          ? 0
          : currentIndex + 1;
      items[nextIndex].focus();
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      dialog.removeEventListener("keydown", onKeyDown);
      siblings.forEach((item) => {
        item.inert = false;
        item.removeAttribute("aria-hidden");
      });
      previous?.focus();
    };
  }, []);
  return ref;
}

function ActionSheet({
  title,
  children,
  className,
  onClose,
}: {
  title: string;
  children: ReactNode;
  className?: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useDialogFocus(onClose);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
    >
      <section
        ref={dialogRef}
        tabIndex={-1}
        className={`action-sheet${className ? ` ${className}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="modal-heading">
          <h2 id={titleId}>{title}</h2>
          <button
            className="icon subtle close-icon"
            aria-label="关闭"
            title="关闭"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        <div className="action-sheet-content" id={descriptionId}>
          {children}
        </div>
      </section>
    </div>
  );
}

function ConfirmDialog({
  title,
  children,
  confirmLabel,
  busy,
  disabled,
  onCancel,
  onConfirm,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  busy: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useDialogFocus(onCancel);
  return (
    <div className="modal-backdrop centered">
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className="warning-mark">
          <AlertTriangle />
        </div>
        <h2 id={titleId}>{title}</h2>
        <div className="confirm-copy" id={descriptionId}>
          {children}
        </div>
        <div className="dialog-actions">
          <button disabled={busy} onClick={onCancel}>
            取消
          </button>
          <button
            className="danger-button"
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {busy ? (
              <LoaderCircle className="spin" />
            ) : confirmLabel === "确认退出" ? (
              <span aria-hidden="true">👋</span>
            ) : (
              <RotateCcw />
            )}
            {confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

function SectionTitle({ title, action }: { title: string; action: string }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      <span>{action}</span>
    </div>
  );
}

function Quick({
  icon,
  label,
  disabled,
  danger,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`quick ${danger ? "danger" : ""}`}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Nav({
  icon,
  label,
  active,
  badge,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  badge?: number;
  onClick: () => void;
}) {
  return (
    <button
      className={active ? "active" : ""}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      {badge ? <b className="nav-badge">{badge}</b> : null}
      <span>{label}</span>
    </button>
  );
}
