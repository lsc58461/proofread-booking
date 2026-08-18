export type DateCol = { col: number; label: string };
export type TimeRow = { row: number; label: string };

/** 슬롯 식별자. 시트의 열/행 번호를 그대로 쓴다. 예: c4r12 */
export type SlotKey = string;

export type BookingState = {
  ok: true;
  ready: boolean;
  now: number;
  /** true 면 사이트가 차단된 상태 — 없는 페이지처럼 보여준다 */
  blocked?: boolean;
  title: string;
  message?: string;
  notice?: string;
  openAt?: number;
  closeAt?: number;
  dates?: DateCol[];
  times?: TimeRow[];
  open?: SlotKey[];
  taken?: Record<SlotKey, string>;
};

export type TakenState = {
  ok: true;
  now: number;
  blocked?: boolean;
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
};

export type AdminLoad = {
  ok: true;
  config: AdminConfig;
  now: number;
  sheets: string[];
  dates: DateCol[];
  openCount: number;
  preCount: number;
  /** 흰색이지만 배경색을 직접 지정한 적이 없어 제외된 칸 수 */
  unpainted: number;
  /** false 면 Sheets 고급 서비스를 못 써서 '칠한 적 없음'을 구분하지 못한 상태 */
  exact: boolean;
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
