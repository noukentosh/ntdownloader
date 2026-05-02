import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, X } from "lucide-react";

import { Button } from "@/components/ui/button";

import type { UrlFetchJob } from "./types";

const COLLAPSED_KEY = "fm_fetch_panel_collapsed";

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return "—";
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} Б/с`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} КБ/с`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(2)} МБ/с`;
}

type Props = {
  jobs: UrlFetchJob[];
  onDismiss: (id: string) => void;
  onCancel: (id: string) => void;
};

export function UrlFetchProgressPanel({ jobs, onDismiss, onCancel }: Props) {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return sessionStorage.getItem(COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });

  const [speedById, setSpeedById] = useState<Record<string, number>>({});
  const prevSampleRef = useRef<Record<string, { r: number; t: number }>>({});

  useEffect(() => {
    const now = Date.now();
    setSpeedById(prevSpeed => {
      const next = { ...prevSpeed };
      const sample = { ...prevSampleRef.current };

      for (const j of jobs) {
        if (j.status !== "downloading") {
          delete next[j.id];
          delete sample[j.id];
          continue;
        }

        const p = sample[j.id];
        if (!p) {
          sample[j.id] = { r: j.received, t: now };
          continue;
        }

        const dt = (now - p.t) / 1000;
        if (j.received > p.r && dt >= 0.15) {
          const instant = (j.received - p.r) / dt;
          const prev = next[j.id];
          next[j.id] = prev != null ? prev * 0.55 + instant * 0.45 : instant;
          sample[j.id] = { r: j.received, t: now };
        }
      }

      prevSampleRef.current = sample;
      return next;
    });
  }, [jobs]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      sessionStorage.setItem(COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      /* ignore */
    }
  }

  const activeCount = jobs.filter(j => j.status === "downloading").length;

  if (jobs.length === 0) return null;

  return (
    <div
      className="border-mist fm-veil-soft fixed bottom-4 right-4 z-50 flex max-h-[min(70vh,420px)] w-[min(calc(100vw-2rem),340px)] flex-col rounded-xl border bg-[#161514] shadow-lg"
      role="region"
      aria-label="Прогресс загрузки по ссылке"
    >
      <div className="border-mist flex items-center justify-between gap-2 border-b px-3 py-2">
        <button
          type="button"
          onClick={toggleCollapsed}
          className="text-[#faf9f6] flex min-w-0 flex-1 items-center gap-2 text-left text-sm font-medium hover:opacity-90"
        >
          {collapsed ? <ChevronUp className="size-4 shrink-0 text-[#868584]" /> : <ChevronDown className="size-4 shrink-0 text-[#868584]" />}
          <span className="truncate">Загрузки по ссылке</span>
          {activeCount > 0 ? (
            <span className="bg-[rgba(255,255,255,0.1)] text-[#afaeac] shrink-0 rounded-full px-2 py-0.5 text-xs">{activeCount}</span>
          ) : null}
        </button>
      </div>

      {collapsed ? (
        <div className="text-[#868584] px-3 py-2 text-xs">
          {activeCount > 0 ? (
            <>
              Активно: {activeCount}
              {(() => {
                const sum = jobs
                  .filter(j => j.status === "downloading")
                  .reduce((s, j) => s + (speedById[j.id] ?? 0), 0);
                return sum > 0 ? (
                  <span className="text-[#afaeac] ml-1">· {formatSpeed(sum)}</span>
                ) : null;
              })()}
            </>
          ) : (
            "Нет активных · разверните для списка"
          )}
        </div>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-[rgba(226,226,226,0.15)] overflow-y-auto">
          {jobs.map(job => (
            <PanelRow
              key={job.id}
              job={job}
              speedBps={speedById[job.id]}
              onDismiss={() => onDismiss(job.id)}
              onCancel={() => void onCancel(job.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function PanelRow({
  job,
  speedBps,
  onDismiss,
  onCancel,
}: {
  job: UrlFetchJob;
  speedBps: number | undefined;
  onDismiss: () => void;
  onCancel: () => void;
}) {
  const pct =
    job.total > 0 ? Math.min(100, Math.round((job.received / job.total) * 100)) : job.status === "done" ? 100 : 0;
  const statusLabel =
    job.status === "downloading"
      ? "Скачивание…"
      : job.status === "done"
        ? "Готово"
        : job.status === "cancelled"
          ? "Отменено"
          : job.status === "error"
            ? "Ошибка"
            : job.status;

  return (
    <li className="flex gap-2 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[#faf9f6] text-xs font-medium">{job.filename}</p>
        <p className="text-[#868584] mt-0.5 text-[11px] leading-snug">
          {job.total > 0 ? (
            <>
              {formatSize(job.received)} / {formatSize(job.total)}
            </>
          ) : (
            <>Скачано: {formatSize(job.received)}</>
          )}
          {job.total > 0 ? <> · {pct}%</> : null}
          {" · "}
          <span className="text-[#afaeac]">{statusLabel}</span>
        </p>
        {job.status === "downloading" ? (
          <>
            <p className="text-[#868584] mt-1 text-[11px]">Скорость: {formatSpeed(speedBps ?? 0)}</p>
            <div className="bg-[rgba(255,255,255,0.08)] mt-1.5 h-1.5 overflow-hidden rounded-full">
              <div
                className={`bg-[#353534] h-full rounded-full transition-[width] duration-150 ${job.total === 0 && job.received === 0 ? "animate-pulse" : ""}`}
                style={{
                  width: job.total > 0 ? `${pct}%` : job.received > 0 ? "100%" : "33%",
                }}
              />
            </div>
          </>
        ) : null}
        {job.error ? <p className="text-[#c4a89c] mt-1 text-[11px]">{job.error}</p> : null}
      </div>
      <div className="flex shrink-0 flex-col items-end justify-start gap-0.5">
        {job.status === "downloading" ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-[#868584] h-7 px-2 text-[11px] hover:text-[#faf9f6]"
            onClick={onCancel}
          >
            Отмена
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="text-[#868584] size-7 hover:text-[#faf9f6]"
            onClick={onDismiss}
            aria-label="Убрать из списка"
          >
            <X className="size-3.5" />
          </Button>
        )}
      </div>
    </li>
  );
}
