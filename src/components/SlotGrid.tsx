'use client';

import { useEffect, useState } from 'react';
import type { DateCol, SlotKey, TimeRow } from '@/lib/types';

type Props = {
  dates: DateCol[];
  times: TimeRow[];
  open: Set<SlotKey>;
  taken: Record<SlotKey, string>;
  selected: SlotKey | null;
  mine: SlotKey | null;
  locked: boolean;
  onSelect: (slot: SlotKey) => void;
};

const key = (col: number, row: number): SlotKey => `c${col}r${row}`;

type Cell = 'closed' | 'taken' | 'mine' | 'selected' | 'free';

function cellState(k: SlotKey, p: Props): Cell {
  if (!p.open.has(k)) return 'closed';
  if (p.mine === k) return 'mine';
  if (p.taken[k] !== undefined) return 'taken';
  if (p.selected === k) return 'selected';
  return 'free';
}

const CELL_CLASS: Record<Cell, string> = {
  closed: 'bg-canvas text-transparent cursor-default',
  taken: 'bg-line/40 text-muted cursor-not-allowed',
  mine: 'bg-good-soft text-good ring-2 ring-good font-semibold',
  selected: 'bg-brand text-white font-semibold ring-2 ring-brand',
  free: 'bg-surface text-brand hover:bg-brand-soft cursor-pointer',
};

export default function SlotGrid(props: Props) {
  const { dates, times, taken, locked, onSelect } = props;
  const [activeCol, setActiveCol] = useState<number | null>(dates[0]?.col ?? null);

  useEffect(() => {
    // 관리자가 열린 날짜를 바꾸면 선택 중이던 탭이 사라질 수 있다.
    if (activeCol === null || !dates.some((d) => d.col === activeCol)) {
      setActiveCol(dates[0]?.col ?? null);
    }
  }, [dates, activeCol]);

  const clickable = (k: SlotKey) => !locked && cellState(k, props) === 'free';

  const label = (k: SlotKey, state: Cell) => {
    if (state === 'closed') return '·';
    if (state === 'mine') return '내 신청';
    if (state === 'taken') return taken[k] || '마감';
    if (state === 'selected') return '선택됨';
    return '신청';
  };

  return (
    <>
      {/* 데스크톱: 시트와 같은 격자 */}
      <div className="hidden overflow-x-auto rounded-xl border border-line bg-surface md:block">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              <th className="sticky left-0 z-20 w-28 border-b border-r border-line bg-surface px-3 py-2.5 text-left text-xs font-semibold text-muted">
                시간
              </th>
              {dates.map((d) => (
                <th
                  key={d.col}
                  className="min-w-24 border-b border-line bg-surface px-2 py-2.5 text-center text-xs font-semibold whitespace-nowrap"
                >
                  {d.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {times.map((t) => (
              <tr key={t.row}>
                <th className="sticky left-0 z-10 border-b border-r border-line bg-surface px-3 py-1.5 text-left text-xs font-normal whitespace-nowrap text-muted tabular">
                  {t.label}
                </th>
                {dates.map((d) => {
                  const k = key(d.col, t.row);
                  const state = cellState(k, props);
                  return (
                    <td key={d.col} className="border-b border-line p-0.5">
                      <button
                        type="button"
                        disabled={!clickable(k)}
                        onClick={() => onSelect(k)}
                        className={`h-8 w-full truncate rounded-md px-1 text-xs transition-colors ${CELL_CLASS[state]}`}
                        title={state === 'taken' ? `${d.label} ${t.label} · 마감` : `${d.label} ${t.label}`}
                      >
                        {label(k, state)}
                      </button>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 모바일: 날짜 탭 + 시간 목록 */}
      <div className="md:hidden">
        <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-3">
          {dates.map((d) => {
            const free = times.filter(
              (t) => cellState(key(d.col, t.row), props) === 'free',
            ).length;
            const on = activeCol === d.col;
            return (
              <button
                key={d.col}
                type="button"
                onClick={() => setActiveCol(d.col)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-2 text-sm whitespace-nowrap transition-colors ${
                  on
                    ? 'border-brand bg-brand text-white'
                    : 'border-line bg-surface text-ink'
                }`}
              >
                {d.label}
                <span className={`text-xs tabular ${on ? 'text-white/80' : 'text-muted'}`}>
                  {free}
                </span>
              </button>
            );
          })}
        </div>

        <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
          {times
            .filter((t) => activeCol !== null && props.open.has(key(activeCol, t.row)))
            .map((t) => {
              const k = key(activeCol as number, t.row);
              const state = cellState(k, props);
              return (
                <li key={t.row} className="flex items-center justify-between gap-3 px-4 py-3">
                  <span className="text-sm tabular">{t.label}</span>
                  <button
                    type="button"
                    disabled={!clickable(k)}
                    onClick={() => onSelect(k)}
                    className={`min-w-20 rounded-lg px-3 py-1.5 text-xs transition-colors ${CELL_CLASS[state]} ${
                      state === 'free' ? 'border border-brand/30' : ''
                    }`}
                  >
                    {label(k, state)}
                  </button>
                </li>
              );
            })}
          {activeCol !== null &&
            times.every((t) => !props.open.has(key(activeCol, t.row))) && (
              <li className="px-4 py-8 text-center text-sm text-muted">
                이 날짜에는 열린 시간이 없습니다.
              </li>
            )}
        </ul>
      </div>
    </>
  );
}
