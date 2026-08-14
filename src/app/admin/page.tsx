'use client';

import { useCallback, useEffect, useState } from 'react';
import type { AdminConfig, AdminInspect, AdminLoad, ClaimRow, DateCol } from '@/lib/types';

type Msg = { kind: 'ok' | 'err'; text: string } | null;

const pad = (n: number) => String(n).padStart(2, '0');

/** epoch ms → datetime-local 입력값. 관리자 브라우저의 시간대를 기준으로 한다. */
function toLocalInput(ms: number) {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(v: string) {
  if (!v) return 0;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : 0;
}

async function api<T>(action: string, extra: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  return (await res.json()) as T;
}

const EMPTY: AdminConfig = {
  title: '첨삭 신청',
  notice: '',
  sheetUrl: '',
  sheetName: '',
  openCols: [],
  openAt: 0,
  closeAt: 0,
  allowCancel: true,
};

export default function AdminPage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const [busy, setBusy] = useState(false);

  const [cfg, setCfg] = useState<AdminConfig>(EMPTY);
  const [openAtStr, setOpenAtStr] = useState('');
  const [closeAtStr, setCloseAtStr] = useState('');
  const [sheets, setSheets] = useState<string[]>([]);
  const [dates, setDates] = useState<DateCol[]>([]);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [unpainted, setUnpainted] = useState(0);
  const [exact, setExact] = useState(true);
  const [rows, setRows] = useState<ClaimRow[]>([]);
  const [loadError, setLoadError] = useState('');

  const flash = useCallback((kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    setTimeout(() => setMsg(null), 5000);
  }, []);

  const applyConfig = useCallback((c: AdminConfig) => {
    setCfg(c);
    setOpenAtStr(toLocalInput(c.openAt));
    setCloseAtStr(toLocalInput(c.closeAt));
  }, []);

  const loadAll = useCallback(async () => {
    const data = await api<AdminLoad | { ok: false; message: string }>('admin.load');
    if (!data.ok) {
      flash('err', data.message);
      return;
    }
    applyConfig(data.config);
    setSheets(data.sheets);
    setDates(data.dates);
    setOpenCount(data.openCount);
    setUnpainted(data.unpainted);
    setExact(data.exact);
    setLoadError(data.error);
    const cl = await api<{ ok: true; rows: ClaimRow[] } | { ok: false; message: string }>('admin.claims');
    if (cl.ok) setRows(cl.rows);
  }, [applyConfig, flash]);

  useEffect(() => {
    void (async () => {
      const s = await api<{ ok: true; authed: boolean }>('session');
      setAuthed(s.ok && s.authed);
      if (s.ok && s.authed) await loadAll();
    })();
  }, [loadAll]);

  const login = useCallback(async () => {
    setBusy(true);
    try {
      const r = await api<{ ok: boolean; message?: string }>('login', { password });
      if (r.ok) {
        setAuthed(true);
        setPassword('');
        await loadAll();
      } else {
        flash('err', r.message ?? '로그인하지 못했습니다.');
      }
    } finally {
      setBusy(false);
    }
  }, [password, loadAll, flash]);

  const run = useCallback(
    async (action: string, extra: Record<string, unknown> = {}, done?: (d: never) => void) => {
      setBusy(true);
      try {
        const r = await api<{ ok: boolean; message?: string }>(action, extra);
        if (!r.ok) {
          flash('err', r.message ?? '요청에 실패했습니다.');
          return null;
        }
        done?.(r as never);
        return r;
      } finally {
        setBusy(false);
      }
    },
    [flash],
  );

  /* ── 로그인 화면 ── */

  if (authed === null) {
    return <main className="p-8 text-sm text-muted">확인 중…</main>;
  }

  if (!authed) {
    return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
        <h1 className="mb-1 text-xl font-bold">관리자</h1>
        <p className="mb-6 text-sm text-muted">비밀번호를 입력해 주세요.</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void login()}
          className="mb-3 w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
        <button
          type="button"
          onClick={() => void login()}
          disabled={busy}
          className="rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
        >
          로그인
        </button>
        {msg && <p className="mt-3 text-sm text-danger">{msg.text}</p>}
      </main>
    );
  }

  /* ── 관리 화면 ── */

  const toggleCol = (col: number) =>
    setCfg((c) => ({
      ...c,
      openCols: c.openCols.includes(col)
        ? c.openCols.filter((x) => x !== col)
        : [...c.openCols, col].sort((a, b) => a - b),
    }));

  const field = 'w-full rounded-lg border border-line bg-surface px-3 py-2.5 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20';
  const btn = 'rounded-lg border border-line bg-surface px-3.5 py-2 text-sm hover:bg-canvas disabled:opacity-50';

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-xl font-bold">관리자</h1>
        <button
          type="button"
          onClick={() => void api('logout').then(() => setAuthed(false))}
          className={btn}
        >
          로그아웃
        </button>
      </header>

      {msg && (
        <p
          className={`mb-4 rounded-lg px-4 py-2.5 text-sm ${
            msg.kind === 'ok' ? 'bg-good-soft text-good' : 'bg-danger-soft text-danger'
          }`}
        >
          {msg.text}
        </p>
      )}

      {loadError && (
        <p className="mb-4 rounded-lg bg-danger-soft px-4 py-2.5 text-sm text-danger">
          시트를 읽지 못했습니다: {loadError}
        </p>
      )}

      {/* 1. 시트 연결 */}
      <section className="mb-6 rounded-xl border border-line bg-surface p-5">
        <h2 className="mb-4 text-sm font-semibold">1. 시트 연결</h2>

        <label className="mb-3 block">
          <span className="mb-1.5 block text-xs text-muted">구글시트 주소</span>
          <input
            value={cfg.sheetUrl}
            onChange={(e) => setCfg({ ...cfg, sheetUrl: e.target.value })}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            className={field}
          />
        </label>

        <button
          type="button"
          disabled={busy || !cfg.sheetUrl}
          onClick={() =>
            void run('admin.inspect', { sheetUrl: cfg.sheetUrl, sheetName: cfg.sheetName }, (d) => {
              const r = d as unknown as AdminInspect;
              setSheets(r.sheets);
              setDates(r.dates);
              setCfg((c) => ({ ...c, sheetName: c.sheetName || r.sheetName }));
              flash('ok', `탭 ${r.sheets.length}개, 날짜 ${r.dates.length}개, 시간 ${r.timeCount}개를 읽었습니다.`);
            })
          }
          className={btn}
        >
          시트 확인
        </button>

        {sheets.length > 0 && (
          <label className="mt-4 block">
            <span className="mb-1.5 block text-xs text-muted">탭</span>
            <select
              value={cfg.sheetName}
              onChange={(e) => setCfg({ ...cfg, sheetName: e.target.value })}
              className={field}
            >
              {sheets.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
        )}
      </section>

      {/* 2. 신청 받을 날짜 */}
      <section className="mb-6 rounded-xl border border-line bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold">2. 신청 받을 날짜</h2>
        <p className="mb-4 text-xs text-muted">
          체크한 날짜의 <strong>흰색 칸</strong>만 신청을 받습니다. 회색·주황색 칸과 이미 이름이 적힌 칸은 자동으로 제외됩니다.
        </p>

        {dates.length === 0 ? (
          <p className="text-sm text-muted">먼저 시트를 확인해 주세요.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {dates.map((d) => {
              const on = cfg.openCols.includes(d.col);
              return (
                <button
                  key={d.col}
                  type="button"
                  onClick={() => toggleCol(d.col)}
                  className={`rounded-full border px-3.5 py-2 text-sm transition-colors ${
                    on ? 'border-brand bg-brand text-white' : 'border-line bg-surface'
                  }`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={busy || !cfg.openCols.length}
            onClick={() =>
              void run('admin.preview', { config: cfg }, (d) => {
                const r = d as unknown as {
                  openCount: number;
                  preCount: number;
                  unpainted: number;
                  exact: boolean;
                };
                setOpenCount(r.openCount);
                setUnpainted(r.unpainted);
                setExact(r.exact);
                flash(
                  'ok',
                  `열릴 자리 ${r.openCount}개${r.preCount ? ` (그중 ${r.preCount}개는 시트에 이미 이름이 있음)` : ''}`,
                );
              })
            }
            className={btn}
          >
            열릴 자리 확인
          </button>
          {openCount !== null && (
            <span className="text-sm text-muted">
              현재 <strong className="text-ink tabular">{openCount}</strong>자리
            </span>
          )}
        </div>

        {unpainted > 0 && (
          <p className="mt-3 rounded-lg bg-canvas px-4 py-3 text-xs leading-relaxed text-muted">
            이 중 <strong className="text-ink tabular">{unpainted}개</strong>는 배경색을 한 번도 지정하지 않은
            칸입니다. 화면에서 흰색으로 보이므로 함께 열었습니다. 열지 않으려면 시트에서 회색으로 칠한 뒤
            다시 확인해 주세요.
          </p>
        )}

        {!exact && (
          <p className="mt-3 rounded-lg bg-canvas px-4 py-3 text-xs leading-relaxed text-muted">
            Sheets 고급 서비스를 사용할 수 없어 배경색을 지정하지 않은 칸이 몇 개인지 세지 못했습니다.
            열리는 칸 수 자체는 정확합니다.
          </p>
        )}
      </section>

      {/* 3. 오픈 시간 */}
      <section className="mb-6 rounded-xl border border-line bg-surface p-5">
        <h2 className="mb-4 text-sm font-semibold">3. 오픈 시간</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1.5 block text-xs text-muted">신청 시작</span>
            <input
              type="datetime-local"
              value={openAtStr}
              onChange={(e) => setOpenAtStr(e.target.value)}
              className={field}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs text-muted">신청 마감 (비워두면 무제한)</span>
            <input
              type="datetime-local"
              value={closeAtStr}
              onChange={(e) => setCloseAtStr(e.target.value)}
              className={field}
            />
          </label>
        </div>
        <label className="mt-4 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={cfg.allowCancel}
            onChange={(e) => setCfg({ ...cfg, allowCancel: e.target.checked })}
            className="size-4 accent-[var(--color-brand)]"
          />
          신청자가 직접 취소할 수 있게 하기
        </label>
      </section>

      {/* 4. 안내 문구 */}
      <section className="mb-6 rounded-xl border border-line bg-surface p-5">
        <h2 className="mb-4 text-sm font-semibold">4. 안내 문구</h2>
        <label className="mb-3 block">
          <span className="mb-1.5 block text-xs text-muted">제목</span>
          <input
            value={cfg.title}
            onChange={(e) => setCfg({ ...cfg, title: e.target.value })}
            className={field}
          />
        </label>
        <label className="block">
          <span className="mb-1.5 block text-xs text-muted">공지 (선택)</span>
          <textarea
            value={cfg.notice}
            onChange={(e) => setCfg({ ...cfg, notice: e.target.value })}
            rows={3}
            placeholder="1인 1회만 신청 가능합니다."
            className={`${field} resize-y`}
          />
        </label>
      </section>

      <button
        type="button"
        disabled={busy}
        onClick={() => {
          const next = { ...cfg, openAt: fromLocalInput(openAtStr), closeAt: fromLocalInput(closeAtStr) };
          void run('admin.save', { config: next }, (d) => {
            applyConfig((d as unknown as { config: AdminConfig }).config);
            flash('ok', '저장했습니다.');
          });
        }}
        className="mb-8 w-full rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-white disabled:opacity-60"
      >
        설정 저장
      </button>

      {/* 신청 현황 */}
      <section className="mb-6 rounded-xl border border-line bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-semibold">
            신청 현황 <span className="ml-1 text-muted tabular">{rows.length}건</span>
          </h2>
          <button type="button" onClick={() => void loadAll()} disabled={busy} className={btn}>
            새로고침
          </button>
        </div>

        {rows.length === 0 ? (
          <p className="text-sm text-muted">아직 신청이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-muted">
                  <th className="py-2 pr-3 font-medium">날짜</th>
                  <th className="py-2 pr-3 font-medium">시간</th>
                  <th className="py-2 pr-3 font-medium">이름</th>
                  <th className="py-2 pr-3 font-medium">연락처</th>
                  <th className="py-2 pr-3 font-medium">신청 시각</th>
                  <th className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.slot} className="border-b border-line/60">
                    <td className="py-2 pr-3 whitespace-nowrap">{r.date}</td>
                    <td className="py-2 pr-3 whitespace-nowrap tabular">{r.time}</td>
                    <td className="py-2 pr-3 font-medium">{r.name}</td>
                    <td className="py-2 pr-3 tabular text-muted">{r.phone}</td>
                    <td className="py-2 pr-3 text-xs whitespace-nowrap text-muted tabular">
                      {new Date(r.ts).toLocaleString('ko-KR', { hour12: false })}
                    </td>
                    <td className="py-2 text-right">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (!confirm(`${r.name} (${r.date} ${r.time}) 신청을 삭제할까요?`)) return;
                          void run('admin.delete', { slot: r.slot }, () => {
                            flash('ok', '삭제했습니다.');
                            void loadAll();
                          });
                        }}
                        className="text-xs text-danger hover:underline disabled:opacity-50"
                      >
                        삭제
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 도구 */}
      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="mb-1 text-sm font-semibold">도구</h2>
        <p className="mb-4 text-xs text-muted">
          시트를 직접 고쳤거나 화면과 시트가 어긋났을 때 사용합니다.
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run('admin.refresh', {}, (d) => {
                setOpenCount((d as unknown as { openCount: number }).openCount);
                flash('ok', '시트를 다시 읽었습니다.');
              })
            }
            className={btn}
          >
            시트 다시 읽기
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!confirm('신청 현황을 기준으로 시트를 덮어씁니다. 계속할까요?')) return;
              void run('admin.sync', {}, (d) => {
                flash('ok', `시트 ${(d as unknown as { written: number }).written}칸을 맞췄습니다.`);
              });
            }}
            className={btn}
          >
            시트에 다시 쓰기
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (!confirm('시트 내용을 기준으로 신청 현황을 새로 만듭니다. 계속할까요?')) return;
              void run('admin.import', {}, (d) => {
                flash('ok', `${(d as unknown as { imported: number }).imported}건을 가져왔습니다.`);
                void loadAll();
              });
            }}
            className={btn}
          >
            시트에서 가져오기
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (prompt('신청 내역을 모두 지웁니다. 계속하려면 "전체삭제"를 입력하세요.') !== '전체삭제') return;
              void run('admin.reset', {}, () => {
                flash('ok', '신청 내역을 모두 삭제했습니다.');
                void loadAll();
              });
            }}
            className="rounded-lg border border-danger/30 bg-danger-soft px-3.5 py-2 text-sm text-danger hover:bg-danger-soft/70 disabled:opacity-50"
          >
            신청 내역 전체 삭제
          </button>
        </div>
      </section>
    </main>
  );
}
