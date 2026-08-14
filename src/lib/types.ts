export type DateCol = { col: number; label: string };
export type TimeRow = { row: number; label: string };

/** 슬롯 식별자. 시트의 열/행 번호를 그대로 쓴다. 예: c4r12 */
export type SlotKey = string;

export type BookingState = {
  ok: true;
  ready: boolean;
  now: number;
  title: string;
  message?: string;
  notice?: string;
  openAt?: number;
  closeAt?: number;
  allowCancel?: boolean;
  dates?: DateCol[];
  times?: TimeRow[];
  open?: SlotKey[];
  taken?: Record<SlotKey, string>;
};

export type TakenState = {
  ok: true;
  now: number;
  taken: Record<SlotKey, string>;
};

export type ApiResult<T = Record<string, never>> =
  | ({ ok: true } & T)
  | { ok: false; message: string };

export type AdminConfig = {
  title: string;
  notice: string;
  sheetUrl: string;
  sheetName: string;
  openCols: number[];
  openAt: number;
  closeAt: number;
  allowCancel: boolean;
};

export type AdminLoad = {
  ok: true;
  config: AdminConfig;
  now: number;
  sheets: string[];
  dates: DateCol[];
  openCount: number;
  preCount: number;
  error: string;
};

export type AdminInspect = {
  ok: true;
  sheets: string[];
  sheetName: string;
  dates: DateCol[];
  timeCount: number;
};

export type ClaimRow = {
  slot: SlotKey;
  date: string;
  time: string;
  name: string;
  phone: string;
  ts: string;
};
