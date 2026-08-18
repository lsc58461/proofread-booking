'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

async function api<T>(action: string, extra: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch('/api/gate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...extra }),
  });
  return (await res.json()) as T;
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">{children}</main>
  );
}

export default function GatePage() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [blocked, setBlocked] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const loadStatus = useCallback(async () => {
    const r = await api<{ ok: boolean; blocked?: boolean; message?: string }>('status');
    if (r.ok) setBlocked(!!r.blocked);
    else setMsg(r.message ?? '상태를 불러오지 못했습니다.');
  }, []);

  useEffect(() => {
    void (async () => {
      const s = await api<{ ok: true; authed: boolean }>('session');
      const on = s.ok && s.authed;
      if (on) await loadStatus();
      setAuthed(on);
    })();
  }, [loadStatus]);

  const login = useCallback(async () => {
    setBusy(true);
    setMsg('');
    try {
      const r = await api<{ ok: boolean; message?: string }>('login', { password });
      if (!r.ok) return setMsg(r.message ?? '로그인하지 못했습니다.');
      setPassword('');
      await loadStatus();
      setAuthed(true);
    } finally {
      setBusy(false);
    }
  }, [password, loadStatus]);

  const toggle = useCallback(
    async (next: boolean) => {
      const label = next ? '사이트를 차단' : '차단을 해제';
      if (!confirm(`${label}할까요?`)) return;
      setBusy(true);
      setMsg('');
      try {
        const r = await api<{ ok: boolean; blocked?: boolean; message?: string }>('set', { blocked: next });
        if (!r.ok) return setMsg(r.message ?? '변경하지 못했습니다.');
        setBlocked(!!r.blocked);
        setMsg(r.blocked ? '차단했습니다.' : '차단을 해제했습니다.');
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  if (authed === null) {
    return (
      <Shell>
        <p className="text-center text-sm text-muted">확인 중…</p>
      </Shell>
    );
  }

  if (!authed) {
    return (
      <Shell>
        <h1 className="mb-6 text-xl font-bold">잠금</h1>
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
        {msg && <p className="mt-3 text-sm text-danger">{msg}</p>}
      </Shell>
    );
  }

  return (
    <Shell>
      <div className="rounded-xl border border-line bg-surface p-6">
        <h1 className="text-lg font-bold">사이트 차단</h1>
        <p className="mt-1 text-xs leading-relaxed text-muted">
          켜면 신청 페이지와 관리자 페이지가 모두 없는 페이지처럼 표시됩니다.
          신청 기록과 설정은 그대로 남아 있고, 끄면 즉시 원래대로 돌아옵니다.
        </p>

        <div className="mt-5 flex items-center justify-between rounded-lg bg-canvas px-4 py-3.5">
          <div>
            <p className="text-xs text-muted">현재 상태</p>
            <p className={`mt-0.5 font-bold ${blocked ? 'text-danger' : 'text-good'}`}>
              {blocked === null ? '—' : blocked ? '차단 중' : '정상 운영 중'}
            </p>
          </div>
          <button
            type="button"
            disabled={busy || blocked === null}
            onClick={() => void toggle(!blocked)}
            className={`rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60 ${
              blocked ? 'bg-good' : 'bg-danger'
            }`}
          >
            {busy ? '처리 중…' : blocked ? '차단 해제' : '차단하기'}
          </button>
        </div>

        {msg && <p className="mt-4 text-sm text-muted">{msg}</p>}

        <button
          type="button"
          onClick={() => void api('logout').then(() => setAuthed(false))}
          className="mt-5 text-xs text-muted underline"
        >
          로그아웃
        </button>
      </div>
    </Shell>
  );
}
