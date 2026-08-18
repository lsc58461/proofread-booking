'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import SlotGrid from '@/components/SlotGrid';
import NotFound from '@/components/NotFound';
import type { BookingState, SlotKey, TakenState } from '@/lib/types';

const ID_KEY = 'pb.identity';
const POLL_MS = 5000;
/** 신청이 밀릴 때 브라우저가 순서를 붙잡고 기다리는 최대 시간 */
const CLAIM_DEADLINE_MS = 90000;

type Toast = { kind: 'ok' | 'err'; text: string };
type Phase = 'loading' | 'error' | 'notready' | 'before' | 'open' | 'closed';

const pad = (n: number) => String(n).padStart(2, '0');

function fmtRemain(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const rest = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return d > 0 ? `${d}일 ${rest}` : rest;
}

function fmtAt(ms: number) {
  return new Date(ms).toLocaleString('ko-KR', {
    month: 'long',
    day: 'numeric',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function ApplyPage() {
  const [state, setState] = useState<BookingState | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [name, setName] = useState('');
  const [last4, setLast4] = useState('');
  const [selected, setSelected] = useState<SlotKey | null>(null);
  // 방금 신청한 자리. 저장하지 않으므로 새로고침하면 사라진다.
  const [booked, setBooked] = useState<SlotKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [toast, setToast] = useState<Toast | null>(null);
  const [, forceTick] = useState(0);

  const offsetRef = useRef(0); // 서버 시각 - 브라우저 시각
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((kind: Toast['kind'], text: string) => {
    setToast({ kind, text });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  /* 저장해 둔 이름·연락처 복원 (입력 편의용) */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(ID_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as { name?: string; last4?: string };
      setName(saved.name ?? '');
      setLast4(saved.last4 ?? '');
    } catch {
      /* 저장소를 쓸 수 없어도 신청 자체는 가능하다 */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(ID_KEY, JSON.stringify({ name, last4 }));
    } catch {
      /* 무시 */
    }
  }, [name, last4]);

  const loadFull = useCallback(async () => {
    try {
      const res = await fetch('/api/state', { cache: 'no-store' });
      const data = (await res.json()) as BookingState | { ok: false; message: string };
      if (!('ready' in data)) {
        setLoadError(data.message || '불러오지 못했습니다.');
        return;
      }
      offsetRef.current = data.now - Date.now();
      if (data.blocked) { setBlocked(true); return; }
      setState(data);
      setLoadError('');
    } catch {
      setLoadError('서버에 연결하지 못했습니다.');
    }
  }, []);

  const loadTaken = useCallback(async () => {
    try {
      const res = await fetch('/api/state?light=1', { cache: 'no-store' });
      const data = (await res.json()) as TakenState | { ok: false };
      if (!('taken' in data)) return;
      offsetRef.current = data.now - Date.now();
      if (data.blocked) { setBlocked(true); return; }
      setState((prev) => (prev ? { ...prev, taken: data.taken } : prev));
    } catch {
      /* 폴링 실패는 조용히 넘어가고 다음 주기에 다시 시도한다 */
    }
  }, []);

  useEffect(() => {
    void loadFull();
  }, [loadFull]);

  /* 남은 자리 폴링 — 탭이 보일 때만 */
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void loadTaken();
    }, POLL_MS);
    const onShow = () => {
      if (document.visibilityState === 'visible') void loadTaken();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [loadTaken]);

  /* 카운트다운 갱신 */
  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const serverNow = Date.now() + offsetRef.current;

  const phase: Phase = useMemo(() => {
    if (loadError) return 'error';
    if (!state) return 'loading';
    if (!state.ready) return 'notready';
    if (state.openAt && serverNow < state.openAt) return 'before';
    if (state.closeAt && serverNow > state.closeAt) return 'closed';
    return 'open';
  }, [state, loadError, serverNow]);

  const openSet = useMemo(() => new Set(state?.open ?? []), [state?.open]);
  const taken = state?.taken ?? {};
  const total = openSet.size;
  const free = useMemo(
    () => [...openSet].filter((k) => taken[k] === undefined).length,
    [openSet, taken],
  );

  const slotLabel = useCallback(
    (slot: SlotKey | null) => {
      if (!slot || !state?.dates || !state?.times) return '';
      const m = /^c(\d+)r(\d+)$/.exec(slot);
      if (!m) return '';
      const d = state.dates.find((x) => x.col === Number(m[1]));
      const t = state.times.find((x) => x.row === Number(m[2]));
      return d && t ? `${d.label} ${t.label}` : '';
    },
    [state],
  );

  const submit = useCallback(async () => {
    if (!selected || busy) return;
    const n = name.trim();
    const p = last4.trim();
    if (n.length < 2) return showToast('err', '이름을 정확히 입력해 주세요.');
    if (!/^\d{4}$/.test(p)) return showToast('err', '연락처 뒤 4자리를 입력해 주세요.');

    setBusy(true);
    setNote('');
    const deadline = Date.now() + CLAIM_DEADLINE_MS;
    try {
      // 접속이 몰려 밀린 경우 여기서 계속 다시 시도한다.
      // 중간에 포기하면 줄에서 빠져 맨 뒤로 다시 서게 되고, 그 사이 자리가
      // 찰 수 있다. 같은 신청을 다시 보내도 결과가 같으므로 반복해도 안전하다.
      for (;;) {
        const res = await fetch('/api/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: n, last4: p, slot: selected }),
        });
        const data = (await res.json()) as { ok: boolean; retryable?: boolean; message?: string };

        if (data.ok) {
          setBooked(selected);
          setSelected(null);
          showToast('ok', '신청이 완료되었습니다.');
          return;
        }
        if (!data.retryable || Date.now() > deadline) {
          showToast('err', data.message ?? '신청하지 못했습니다.');
          return;
        }
        setNote('신청이 몰리고 있어요. 순서를 기다리는 중입니다…');
        await new Promise((r) => setTimeout(r, 600 + Math.random() * 700));
      }
    } catch {
      showToast('err', '네트워크 오류가 발생했습니다. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
      setNote('');
      void loadTaken();
    }
  }, [selected, busy, name, last4, showToast, loadTaken]);

  if (blocked) return <NotFound />;

  return (
    <>
      <main className="mx-auto max-w-5xl px-4 py-8 pb-36">
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight">{state?.title ?? '첨삭 신청'}</h1>
          {state?.notice && (
            <p className="mt-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm leading-relaxed whitespace-pre-line text-muted">
              {state.notice}
            </p>
          )}
        </header>

        {/* 상태 카드 */}
        <section className="mb-6 rounded-xl border border-line bg-surface p-5">
          {phase === 'loading' && <p className="text-sm text-muted">불러오는 중…</p>}

          {phase === 'error' && (
            <div>
              <p className="text-sm font-semibold text-danger">불러오지 못했습니다</p>
              <p className="mt-1 text-sm text-muted">{loadError}</p>
              <button
                type="button"
                onClick={() => void loadFull()}
                className="mt-3 rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-canvas"
              >
                다시 시도
              </button>
            </div>
          )}

          {phase === 'notready' && (
            <p className="text-sm text-muted">{state?.message ?? '아직 신청이 열리지 않았습니다.'}</p>
          )}

          {phase === 'before' && state?.openAt && (
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <div>
                <p className="text-xs font-semibold tracking-wide text-muted">신청 시작까지</p>
                <p className="mt-1 text-3xl font-bold tabular">
                  {fmtRemain(state.openAt - serverNow)}
                </p>
              </div>
              <p className="text-sm text-muted">{fmtAt(state.openAt)} 오픈</p>
            </div>
          )}

          {phase === 'open' && (
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
              <div>
                <p className="flex items-center gap-2 text-xs font-semibold tracking-wide text-good">
                  <span className="inline-block size-2 rounded-full bg-good" />
                  신청 진행 중
                </p>
                <p className="mt-1 text-3xl font-bold tabular">
                  {free}
                  <span className="ml-1 text-base font-normal text-muted">/ {total}자리 남음</span>
                </p>
              </div>
              {state?.closeAt ? (
                <p className="text-sm text-muted">
                  마감까지{' '}
                  <span className="tabular font-semibold text-ink">
                    {fmtRemain(state.closeAt - serverNow)}
                  </span>
                </p>
              ) : (
                <p className="text-sm text-muted">자리가 모두 차면 종료됩니다</p>
              )}
            </div>
          )}

          {phase === 'closed' && (
            <div>
              <p className="text-sm font-semibold">신청이 마감되었습니다</p>
              <p className="mt-1 text-sm text-muted">
                {state?.closeAt ? `${fmtAt(state.closeAt)} 마감` : ''}
              </p>
            </div>
          )}
        </section>

        {/* 신청 완료 안내 — 이 화면에서만 보인다 */}
        {booked && (
          <section className="mb-6 rounded-xl border border-good/30 bg-good-soft px-5 py-4">
            <p className="text-xs font-semibold text-good">신청 완료</p>
            <p className="mt-0.5 text-lg font-bold">{slotLabel(booked)}</p>
            <p className="mt-2 text-xs leading-relaxed text-good/80">
              {name} 님으로 신청되었습니다. 신청 내역은 화면을 벗어나면 다시 확인할 수 없으니
              시간을 메모해 두세요. 변경이나 취소는 담당자에게 문의해 주세요.
            </p>
          </section>
        )}

        {/* 신청자 정보 */}
        {!booked && (phase === 'open' || phase === 'before') && (
          <section className="mb-6 rounded-xl border border-line bg-surface p-5">
            <h2 className="mb-3 text-sm font-semibold">신청자 정보</h2>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted">이름</span>
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="홍길동"
                  maxLength={20}
                  autoComplete="name"
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
              </label>
              <label className="block">
                <span className="mb-1.5 block text-xs text-muted">연락처 뒤 4자리</span>
                <input
                  value={last4}
                  onChange={(e) => setLast4(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  placeholder="1234"
                  inputMode="numeric"
                  className="w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm tabular outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                />
              </label>
            </div>
            <p className="mt-2.5 text-xs text-muted">
              동명이인 구분에만 쓰입니다. 한 사람당 한 자리만 신청할 수 있습니다.
            </p>
          </section>
        )}

        {/* 시간표 */}
        {state?.ready && state.dates && state.times && (
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">시간 선택</h2>
              <p className="text-xs text-muted">
                {phase === 'before' ? '오픈 후 선택할 수 있습니다' : `${free}자리 남음`}
              </p>
            </div>

            <SlotGrid
              dates={state.dates}
              times={state.times}
              open={openSet}
              taken={taken}
              selected={selected}
              booked={booked}
              locked={phase !== 'open' || !!booked || busy}
              onSelect={(k) => setSelected((cur) => (cur === k ? null : k))}
            />

            <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted">
              <li className="flex items-center gap-1.5">
                <span className="inline-block size-3 rounded border border-line bg-surface" /> 신청 가능
              </li>
              <li className="flex items-center gap-1.5">
                <span className="inline-block size-3 rounded bg-line" /> 마감
              </li>
            </ul>
          </section>
        )}
      </main>

      {/* 하단 신청 바 — 시간표의 고정 열·헤더가 z-10/z-20 이라 그보다 위에 둔다 */}
      {selected && phase === 'open' && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-surface/95 shadow-[0_-1px_12px_rgba(16,24,40,0.08)] backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs text-muted">{note ? '순서 대기 중' : '선택한 시간'}</p>
              <p className="truncate font-semibold">{slotLabel(selected)}</p>
              {note && <p className="mt-0.5 truncate text-xs text-brand">{note}</p>}
            </div>
            <div className="flex shrink-0 gap-2">
              {!busy && (
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="rounded-lg border border-line px-3.5 py-2.5 text-sm hover:bg-canvas"
                >
                  취소
                </button>
              )}
              <button
                type="button"
                onClick={() => void submit()}
                disabled={busy}
                className="rounded-lg bg-brand px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-60"
              >
                {busy ? '신청 중…' : '신청하기'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 알림 */}
      {toast && (
        <div
          role="status"
          className={`fixed inset-x-4 bottom-24 z-50 mx-auto max-w-sm rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${
            toast.kind === 'ok'
              ? 'bg-good-soft text-good ring-1 ring-good/30'
              : 'bg-danger-soft text-danger ring-1 ring-danger/30'
          }`}
        >
          {toast.text}
        </div>
      )}
    </>
  );
}
