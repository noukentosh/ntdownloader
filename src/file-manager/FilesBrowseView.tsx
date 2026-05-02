import { Archive, Download, File, Folder, FolderPlus, RefreshCw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { FM_API, breadcrumbItems, joinRel } from "./paths";
import type { ListItem } from "./types";

type Props = {
  path: string;
  items: ListItem[];
  listError: string | null;
  busy: boolean;
  selected: Record<string, boolean>;
  newFolder: string;
  onNewFolderChange: (v: string) => void;
  onMkdir: (e: React.FormEvent) => void;
  onRefresh: () => void;
  onNavigateFolder: (rel: string) => void;
  onToggleSelect: (rel: string) => void;
  onSelectAll: () => void;
  onDownloadArchive: () => void;
  onDeleteSelected: () => void;
  selectedCount: number;
};

export function FilesBrowseView({
  path,
  items,
  listError,
  busy,
  selected,
  newFolder,
  onNewFolderChange,
  onMkdir,
  onRefresh,
  onNavigateFolder,
  onToggleSelect,
  onSelectAll,
  onDownloadArchive,
  onDeleteSelected,
  selectedCount,
}: Props) {
  const crumbs = breadcrumbItems(path);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="border-mist flex flex-wrap items-start justify-between gap-4 border-b px-6 py-5">
        <div>
          <p className="fm-label text-[#868584]">Хранилище</p>
          <h1 className="text-[#faf9f6] mt-1 text-2xl font-normal tracking-[-0.02em]">Файлы в папке</h1>
          <nav className="text-[#868584] mt-3 flex flex-wrap items-center gap-1 text-sm">
            {crumbs.map((c, i) => (
              <span key={c.rel} className="flex items-center gap-1">
                {i > 0 ? <span className="opacity-50">/</span> : null}
                <button
                  type="button"
                  className="hover:text-[#faf9f6] underline-offset-4 hover:underline"
                  onClick={() => onNavigateFolder(c.rel)}
                >
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="fm-pill border-mist rounded-full border bg-transparent text-[#afaeac] hover:bg-[rgba(255,255,255,0.04)]"
            disabled={busy || items.length === 0}
            onClick={onSelectAll}
          >
            Выбрать всё
          </Button>
          <Button
            type="button"
            size="sm"
            className="fm-pill rounded-full bg-[#353534] text-[#afaeac] hover:opacity-95"
            disabled={busy || selectedCount === 0}
            onClick={onDownloadArchive}
          >
            <Archive className="size-4" />
            ZIP ({selectedCount})
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="fm-pill border-mist rounded-full border border-[rgba(196,168,156,0.35)] bg-transparent text-[#c4a89c] hover:bg-[rgba(196,168,156,0.08)]"
            disabled={busy || selectedCount === 0}
            onClick={onDeleteSelected}
          >
            <Trash2 className="size-4" />
            Удалить ({selectedCount})
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full text-[#868584] hover:bg-[rgba(255,255,255,0.04)] hover:text-[#faf9f6]"
            disabled={busy}
            onClick={onRefresh}
          >
            <RefreshCw className="size-4" />
            Обновить
          </Button>
        </div>
      </header>

      <div className="border-mist fm-veil-soft flex flex-wrap items-end gap-3 border-b px-6 py-4">
        <form onSubmit={onMkdir} className="flex flex-wrap items-end gap-3">
          <div className="space-y-2">
            <Label htmlFor="fm-mkdir" className="fm-label text-[#868584]">
              Новая папка
            </Label>
            <Input
              id="fm-mkdir"
              placeholder="имя"
              value={newFolder}
              onChange={e => onNewFolderChange(e.target.value)}
              disabled={busy}
              className="border-mist bg-[rgba(255,255,255,0.04)] text-[#faf9f6] placeholder:text-[#868584] md:w-56"
            />
          </div>
          <Button
            type="submit"
            disabled={busy}
            className="fm-pill rounded-full bg-[#353534] text-[#afaeac] hover:opacity-95"
          >
            <FolderPlus className="size-4" />
            Создать
          </Button>
        </form>
      </div>

      {listError ? (
        <p className="text-[#c4a89c] px-6 pt-4 text-sm">{listError}</p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="border-mist overflow-hidden rounded-xl border">
          <table className="w-full border-collapse text-left text-[15px]">
            <thead>
              <tr className="border-mist fm-veil-soft border-b">
                <th className="fm-label text-[#868584] w-10 px-3 py-3 font-normal"></th>
                <th className="fm-label text-[#868584] px-3 py-3 font-normal">Имя</th>
                <th className="fm-label text-[#868584] hidden w-28 px-3 py-3 font-normal sm:table-cell">Тип</th>
                <th className="fm-label text-[#868584] hidden w-32 px-3 py-3 text-right font-normal md:table-cell">
                  Размер
                </th>
                <th className="fm-label text-[#868584] hidden w-44 px-3 py-3 font-normal lg:table-cell">
                  Изменён
                </th>
                <th className="fm-label text-[#868584] w-28 px-3 py-3 text-right font-normal"></th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-[#868584] px-4 py-10 text-center text-sm">
                    В этой папке пока нет файлов и подпапок
                  </td>
                </tr>
              ) : (
                items.map(it => {
                  const rel = joinRel(path, it.name);
                  const q = new URLSearchParams({ path: rel });
                  const href = `${FM_API}/download?${q}`;
                  const typeLabel = it.type === "dir" ? "Папка" : "Файл";
                  return (
                    <tr key={rel} className="border-mist hover:bg-[rgba(255,255,255,0.05)] border-b last:border-b-0">
                      <td className="px-3 py-2 align-middle">
                        <input
                          type="checkbox"
                          className="accent-[#353534] size-4 rounded border-[rgba(226,226,226,0.35)]"
                          checked={!!selected[rel]}
                          onChange={() => onToggleSelect(rel)}
                          aria-label={`Выбрать ${it.name}`}
                        />
                      </td>
                      <td className="px-3 py-2 align-middle">
                        <button
                          type="button"
                          className="hover:text-[#faf9f6] flex max-w-full items-center gap-2 text-left text-[#afaeac]"
                          onClick={() => {
                            if (it.type === "dir") onNavigateFolder(rel);
                          }}
                        >
                          {it.type === "dir" ? (
                            <Folder className="text-[#868584] size-4 shrink-0" />
                          ) : (
                            <File className="text-[#868584] size-4 shrink-0" />
                          )}
                          <span className="truncate">{it.name}</span>
                        </button>
                      </td>
                      <td className="text-[#868584] hidden px-3 py-2 align-middle sm:table-cell">{typeLabel}</td>
                      <td className="text-[#868584] hidden px-3 py-2 text-right align-middle md:table-cell">
                        {it.type === "file" ? formatSize(it.size) : "—"}
                      </td>
                      <td className="text-[#868584] hidden px-3 py-2 align-middle text-sm lg:table-cell">
                        {it.mtime ? formatDate(it.mtime) : "—"}
                      </td>
                      <td className="px-3 py-2 text-right align-middle">
                        {it.type === "file" ? (
                          <a
                            className="fm-link inline-flex items-center justify-end gap-1 text-sm text-[#666469] underline underline-offset-4 hover:text-[#faf9f6]"
                            href={href}
                            download={it.name}
                          >
                            <Download className="size-4" />
                            <span className="hidden sm:inline">Скачать</span>
                          </a>
                        ) : (
                          <span className="text-[#868584] text-sm opacity-60">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}
