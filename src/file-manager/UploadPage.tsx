import { useState } from "react";
import { ArrowLeft, Link2, Trash2, Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { FM_API, breadcrumbItems } from "./paths";
import type { UrlFetchJob } from "./types";
import { uploadSingleFile } from "./upload-xhr";

type Staged = { key: string; file: File };

function fileKey(f: File): string {
  return `${f.name}:${f.size}:${f.lastModified}`;
}

type Props = {
  path: string;
  busy: boolean;
  setBusy: (v: boolean) => void;
  onBack: () => void;
  onUnauthorized: () => void;
  onAfterUpload: () => void;
  onUrlFetchStarted: (job: UrlFetchJob) => void;
};

export function UploadPage({
  path,
  busy,
  setBusy,
  onBack,
  onUnauthorized,
  onAfterUpload,
  onUrlFetchStarted,
}: Props) {
  const [staged, setStaged] = useState<Staged[]>([]);
  const [progressByKey, setProgressByKey] = useState<Record<string, number>>({});
  const [overall, setOverall] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [fetchUrl, setFetchUrl] = useState("");
  const [fetchName, setFetchName] = useState("");
  const [urlStartBusy, setUrlStartBusy] = useState(false);

  const crumbs = breadcrumbItems(path);

  const totalBytes = staged.reduce((s, x) => s + x.file.size, 0);

  function onPickFiles(list: FileList | null) {
    if (!list?.length) return;
    setUploadError(null);
    setStaged(prev => {
      const map = new Map(prev.map(x => [x.key, x]));
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        if (!f) continue;
        const key = fileKey(f);
        map.set(key, { key, file: f });
      }
      return [...map.values()];
    });
  }

  function removeStaged(key: string) {
    setStaged(s => s.filter(x => x.key !== key));
    setProgressByKey(p => {
      const n = { ...p };
      delete n[key];
      return n;
    });
  }

  async function runUploads() {
    if (staged.length === 0 || busy) return;
    setUploadError(null);
    setBusy(true);
    setOverall(0);
    const weights = staged.map(x => x.file.size);
    const sum = weights.reduce((a, b) => a + b, 0) || 1;
    let completedWeight = 0;

    try {
      for (let i = 0; i < staged.length; i++) {
        const { key, file } = staged[i]!;
        await uploadSingleFile(file, path, ratio => {
          const part = file.size * ratio;
          const o = (completedWeight + part) / sum;
          setOverall(Math.min(1, o));
          setProgressByKey(p => ({ ...p, [key]: ratio }));
        });
        completedWeight += file.size;
        setOverall(completedWeight / sum);
        setProgressByKey(p => ({ ...p, [key]: 1 }));
      }
      setStaged([]);
      setProgressByKey({});
      setOverall(1);
      onAfterUpload();
    } catch (e) {
      setUploadError(e instanceof Error ? e.message : "Ошибка загрузки");
    } finally {
      setBusy(false);
    }
  }

  async function onFetchUrl(e: React.FormEvent) {
    e.preventDefault();
    const url = fetchUrl.trim();
    if (!url || urlStartBusy) return;
    setUrlStartBusy(true);
    setUploadError(null);
    try {
      const res = await fetch(`${FM_API}/fetch-url/start`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          dir: path,
          ...(fetchName.trim() ? { filename: fetchName.trim() } : {}),
        }),
      });
      if (res.status === 401) {
        onUnauthorized();
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setUploadError(j.error ?? `Ошибка ${res.status}`);
        return;
      }
      const data = (await res.json()) as { id: string; filename: string; total: number };
      onUrlFetchStarted({
        id: data.id,
        filename: data.filename,
        total: data.total,
        received: 0,
        status: "downloading",
      });
      setFetchUrl("");
      setFetchName("");
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : "Не удалось начать скачивание");
    } finally {
      setUrlStartBusy(false);
    }
  }

  const uploading = busy;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="border-mist flex flex-wrap items-start justify-between gap-4 border-b px-6 py-5">
        <div>
          <p className="fm-label text-[#868584]">Хранилище</p>
          <h1 className="text-[#faf9f6] mt-1 text-2xl font-normal tracking-[-0.02em]">Загрузка файлов</h1>
          <nav className="text-[#868584] mt-3 flex flex-wrap items-center gap-1 text-sm">
            {crumbs.map((c, i) => (
              <span key={c.rel} className="opacity-80">
                {i > 0 ? <span className="mx-1 opacity-50">/</span> : null}
                <span>{c.label}</span>
              </span>
            ))}
          </nav>
        </div>
        <Button
          type="button"
          variant="outline"
          className="fm-pill border-mist rounded-full border bg-transparent text-[#afaeac]"
          onClick={onBack}
          disabled={uploading}
        >
          <ArrowLeft className="size-4" />
          К файлам
        </Button>
      </header>

      <div className="mx-auto w-full max-w-2xl flex-1 space-y-8 px-6 py-8">
        <section className="border-mist fm-veil-soft rounded-xl border p-6">
          <p className="fm-label text-[#868584]">Файлы с устройства</p>
          <p className="text-[#afaeac] mt-2 text-[15px] leading-relaxed">
            Выберите файлы — загрузка начнётся только после нажатия кнопки «Загрузить».
          </p>

          <div className="mt-5 space-y-2">
            <Label htmlFor="fm-pick" className="fm-label text-[#868584]">
              Выбор файлов
            </Label>
            <Input
              id="fm-pick"
              type="file"
              multiple
              disabled={uploading}
              onChange={e => {
                onPickFiles(e.target.files);
                e.target.value = "";
              }}
              className="border-mist bg-[rgba(255,255,255,0.04)] text-[#faf9f6] file:text-[#afaeac] cursor-pointer"
            />
          </div>

          {staged.length > 0 ? (
            <ul className="border-mist mt-5 divide-y divide-[rgba(226,226,226,0.2)] rounded-lg border">
              {staged.map(({ key, file }) => {
                const pct = Math.round((progressByKey[key] ?? 0) * 100);
                return (
                  <li key={key} className="flex flex-col gap-2 px-3 py-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[#faf9f6] text-sm">{file.name}</p>
                      <p className="text-[#868584] text-xs">{formatSize(file.size)}</p>
                      {uploading ? (
                        <div className="bg-[rgba(255,255,255,0.08)] mt-2 h-2 overflow-hidden rounded-full">
                          <div
                            className="bg-[#353534] h-full rounded-full transition-[width] duration-150"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="text-[#868584] shrink-0 hover:text-[#faf9f6]"
                      disabled={uploading}
                      onClick={() => removeStaged(key)}
                      aria-label={`Удалить ${file.name} из очереди`}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : null}

          {totalBytes > 0 && uploading ? (
            <div className="mt-5">
              <p className="fm-label text-[#868584] mb-2">Общий прогресс</p>
              <div className="bg-[rgba(255,255,255,0.08)] h-2 overflow-hidden rounded-full">
                <div
                  className="bg-[#353534] h-full rounded-full transition-[width] duration-150"
                  style={{ width: `${Math.round(overall * 100)}%` }}
                />
              </div>
              <p className="text-[#868584] mt-2 text-xs">{Math.round(overall * 100)}%</p>
            </div>
          ) : null}

          {uploadError ? <p className="text-[#c4a89c] mt-4 text-sm">{uploadError}</p> : null}

          <Button
            type="button"
            className="fm-pill mt-6 w-full rounded-full bg-[#353534] text-[#afaeac] hover:opacity-95 sm:w-auto"
            disabled={uploading || staged.length === 0}
            onClick={() => void runUploads()}
          >
            <Upload className="size-4" />
            Загрузить
          </Button>
        </section>

        <section className="border-mist fm-veil-soft rounded-xl border p-6">
          <p className="fm-label text-[#868584]">По ссылке</p>
          <p className="text-[#afaeac] mt-2 text-[15px] leading-relaxed">
            Скачивание идёт на сервере в фоне. Прогресс и скорость показываются в окне внизу справа на всех страницах (его можно свернуть). Список задач восстанавливается после перезагрузки вкладки.
          </p>
          <form onSubmit={onFetchUrl} className="mt-4 flex flex-col gap-4">
            <div className="space-y-2">
              <Label htmlFor="fm-up-url" className="fm-label text-[#868584]">
                URL
              </Label>
              <Input
                id="fm-up-url"
                type="url"
                placeholder="https://…"
                value={fetchUrl}
                onChange={e => setFetchUrl(e.target.value)}
                disabled={urlStartBusy}
                className="border-mist bg-[rgba(255,255,255,0.04)] text-[#faf9f6] placeholder:text-[#868584]"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="fm-up-name" className="fm-label text-[#868584]">
                Имя файла (необязательно)
              </Label>
              <Input
                id="fm-up-name"
                value={fetchName}
                onChange={e => setFetchName(e.target.value)}
                disabled={urlStartBusy}
                className="border-mist bg-[rgba(255,255,255,0.04)] text-[#faf9f6]"
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              className="fm-pill border-mist rounded-full border bg-transparent text-[#afaeac]"
              disabled={urlStartBusy || !fetchUrl.trim()}
            >
              <Link2 className="size-4" />
              {urlStartBusy ? "Запуск…" : "Скачать в текущую папку"}
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
