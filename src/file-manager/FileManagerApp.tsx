import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { FilesBrowseView } from "./FilesBrowseView";
import { FolderTreeSidebar } from "./FolderTreeSidebar";
import { UploadPage } from "./UploadPage";
import { UrlFetchProgressPanel } from "./UrlFetchProgressPanel";
import { FM_API, joinRel, prefixesOfPath } from "./paths";
import type { DirTreeNode, ListItem, UrlFetchJob } from "./types";

const URL_FETCH_IDS_KEY = "fm_fetch_job_ids";

function mapServerUrlJob(j: {
  id: string;
  filename: string;
  total: number;
  received: number;
  status: UrlFetchJob["status"];
  error?: string;
  destRel: string;
}): UrlFetchJob {
  return {
    id: j.id,
    filename: j.filename,
    total: j.total,
    received: j.received,
    status: j.status,
    error: j.error,
    destRel: j.destRel,
  };
}

type View = "browse" | "upload";

export function FileManagerApp() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loginError, setLoginError] = useState<string | null>(null);
  const [view, setView] = useState<View>("browse");
  const [path, setPath] = useState("");
  const [tree, setTree] = useState<DirTreeNode | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [items, setItems] = useState<ListItem[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [urlJobs, setUrlJobs] = useState<UrlFetchJob[]>([]);
  const [urlRestoreReady, setUrlRestoreReady] = useState(false);
  const urlJobsRef = useRef(urlJobs);
  urlJobsRef.current = urlJobs;
  const fetchDoneNotified = useRef(new Set<string>());
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [newFolder, setNewFolder] = useState("");

  const checkSession = useCallback(async () => {
    try {
      const res = await fetch(`${FM_API}/me`, { credentials: "include" });
      setAuthed(res.ok);
    } catch {
      setAuthed(false);
    }
  }, []);

  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  const refreshTree = useCallback(async () => {
    try {
      const res = await fetch(`${FM_API}/tree`, { credentials: "include" });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      if (!res.ok) return;
      const data = (await res.json()) as { tree: DirTreeNode };
      setTree(data.tree);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (authed) void refreshTree();
  }, [authed, refreshTree]);

  useEffect(() => {
    setExpanded(prev => {
      const next = { ...prev };
      for (const p of prefixesOfPath(path)) {
        next[p] = true;
      }
      return next;
    });
  }, [path, tree]);

  useEffect(() => {
    const loginTitle = "Вход — NT Downloader";
    const browseTitle = "Файлы — NT Downloader";
    const uploadTitle = "Загрузка — NT Downloader";
    if (authed === false || authed === null) {
      document.title = loginTitle;
      return;
    }
    document.title = view === "upload" ? uploadTitle : browseTitle;
  }, [authed, view]);

  const loadList = useCallback(async () => {
    setListError(null);
    try {
      const q = new URLSearchParams();
      if (path) q.set("path", path);
      const res = await fetch(`${FM_API}/list?${q}`, { credentials: "include" });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setListError(j.error ?? `HTTP ${res.status}`);
        return;
      }
      const data = (await res.json()) as { items: ListItem[] };
      setItems(data.items);
      setSelected({});
    } catch (e) {
      setListError(e instanceof Error ? e.message : "List failed");
    }
  }, [path]);

  useEffect(() => {
    if (authed) void loadList();
  }, [authed, loadList]);

  const afterMutation = useCallback(async () => {
    await Promise.all([loadList(), refreshTree()]);
  }, [loadList, refreshTree]);

  const afterMutationRef = useRef(afterMutation);
  afterMutationRef.current = afterMutation;

  const downloadingUrlCount = useMemo(
    () => urlJobs.filter(j => j.status === "downloading").length,
    [urlJobs],
  );

  useEffect(() => {
    if (!authed || downloadingUrlCount === 0) return;
    const poll = async () => {
      const ids = urlJobsRef.current.filter(j => j.status === "downloading").map(j => j.id);
      if (ids.length === 0) return;
      try {
        const res = await fetch(
          `${FM_API}/fetch-url/status?ids=${encodeURIComponent(ids.join(","))}`,
          { credentials: "include" },
        );
        if (res.status === 401) {
          setAuthed(false);
          return;
        }
        if (!res.ok) return;
        const data = (await res.json()) as {
          jobs: Array<{
            id: string;
            filename: string;
            total: number;
            received: number;
            status: UrlFetchJob["status"];
            error?: string;
            destRel: string;
          }>;
        };
        const incoming = new Map(data.jobs.map(j => [j.id, j]));
        for (const j of data.jobs) {
          if (j.status === "done" && !fetchDoneNotified.current.has(j.id)) {
            fetchDoneNotified.current.add(j.id);
            void afterMutationRef.current();
          }
        }
        setUrlJobs(prev =>
          prev
            .map(p => {
              if (p.status !== "downloading") return p;
              const u = incoming.get(p.id);
              if (!u) return null;
              return mapServerUrlJob(u);
            })
            .filter((p): p is UrlFetchJob => p != null),
        );
      } catch {
        /* ignore */
      }
    };
    const t = setInterval(poll, 800);
    void poll();
    return () => clearInterval(t);
  }, [authed, downloadingUrlCount]);

  useEffect(() => {
    if (!authed) {
      setUrlRestoreReady(false);
      return;
    }
    let cancelled = false;
    const finish = () => {
      if (!cancelled) setUrlRestoreReady(true);
    };

    void (async () => {
      let raw: string | null;
      try {
        raw = sessionStorage.getItem(URL_FETCH_IDS_KEY);
      } catch {
        finish();
        return;
      }
      if (!raw) {
        finish();
        return;
      }
      let ids: unknown;
      try {
        ids = JSON.parse(raw);
      } catch {
        finish();
        return;
      }
      if (!Array.isArray(ids) || ids.length === 0) {
        finish();
        return;
      }
      const idList = ids.filter((x): x is string => typeof x === "string" && x.length > 0);
      if (idList.length === 0) {
        finish();
        return;
      }

      try {
        const res = await fetch(
          `${FM_API}/fetch-url/status?ids=${encodeURIComponent(idList.join(","))}`,
          { credentials: "include" },
        );
        if (cancelled) return;
        if (res.status === 401) {
          finish();
          return;
        }
        if (!res.ok) {
          finish();
          return;
        }
        const data = (await res.json()) as {
          jobs: Array<{
            id: string;
            filename: string;
            total: number;
            received: number;
            status: UrlFetchJob["status"];
            error?: string;
            destRel: string;
          }>;
        };
        const byId = new Map(data.jobs.map(j => [j.id, mapServerUrlJob(j)]));
        const restored = idList.map(id => byId.get(id)).filter((j): j is UrlFetchJob => j != null);
        if (restored.length > 0) {
          setUrlJobs(prev => {
            const have = new Set(prev.map(j => j.id));
            const extra = restored.filter(j => !have.has(j.id));
            return extra.length ? [...prev, ...extra] : prev;
          });
        }
      } catch {
        /* ignore */
      } finally {
        finish();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [authed]);

  useEffect(() => {
    if (!authed || !urlRestoreReady) return;
    try {
      sessionStorage.setItem(URL_FETCH_IDS_KEY, JSON.stringify(urlJobs.map(j => j.id)));
    } catch {
      /* ignore */
    }
  }, [authed, urlRestoreReady, urlJobs]);

  const onUrlFetchStarted = useCallback((job: UrlFetchJob) => {
    setUrlJobs(prev => [...prev, job]);
  }, []);

  const onDismissUrlJob = useCallback((id: string) => {
    fetchDoneNotified.current.delete(id);
    setUrlJobs(prev => prev.filter(j => j.id !== id));
  }, []);

  const onCancelUrlJob = useCallback(async (id: string) => {
    try {
      const res = await fetch(`${FM_API}/fetch-url/cancel`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      setUrlJobs(prev => prev.map(j => (j.id === id ? { ...j, status: "cancelled" as const } : j)));
    } catch {
      /* ignore */
    }
  }, []);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError(null);
    setBusy(true);
    try {
      const res = await fetch(`${FM_API}/login`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setLoginError(j.error ?? "Не удалось войти");
        return;
      }
      setPassword("");
      setAuthed(true);
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  async function onLogout() {
    await fetch(`${FM_API}/logout`, { method: "POST", credentials: "include" });
    try {
      sessionStorage.removeItem(URL_FETCH_IDS_KEY);
    } catch {
      /* ignore */
    }
    setUrlJobs([]);
    setAuthed(false);
    setItems([]);
    setPath("");
    setTree(null);
    setView("browse");
  }

  async function onMkdir(e: React.FormEvent) {
    e.preventDefault();
    const name = newFolder.trim();
    if (!name) return;
    setBusy(true);
    try {
      const rel = joinRel(path, name);
      const res = await fetch(`${FM_API}/mkdir`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: rel }),
      });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setListError(j.error ?? "Не удалось создать папку");
        return;
      }
      setNewFolder("");
      await afterMutation();
    } finally {
      setBusy(false);
    }
  }

  function toggleSelect(rel: string) {
    setSelected(s => ({ ...s, [rel]: !s[rel] }));
  }

  function selectAll() {
    const next: Record<string, boolean> = {};
    for (const it of items) {
      next[joinRel(path, it.name)] = true;
    }
    setSelected(next);
  }

  const selectedPaths = useMemo(
    () => Object.keys(selected).filter(k => selected[k]),
    [selected],
  );

  async function deleteSelected() {
    if (selectedPaths.length === 0) return;
    const preview =
      selectedPaths.length <= 3
        ? selectedPaths.map(p => p.split("/").pop() ?? p).join(", ")
        : `${selectedPaths.length} элементов`;
    const msg =
      selectedPaths.length === 1
        ? `Удалить «${preview}»? Это действие необратимо.`
        : `Удалить выбранное (${preview})? Файлы и папки будут удалены безвозвратно.`;
    if (!window.confirm(msg)) return;
    setBusy(true);
    try {
      const res = await fetch(`${FM_API}/delete`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: selectedPaths }),
      });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setListError(j.error ?? "Не удалось удалить");
        return;
      }
      await afterMutation();
    } finally {
      setBusy(false);
    }
  }

  async function downloadArchive() {
    if (selectedPaths.length === 0) return;
    setBusy(true);
    try {
      const res = await fetch(`${FM_API}/archive`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paths: selectedPaths }),
      });
      if (res.status === 401) {
        setAuthed(false);
        return;
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setListError(j.error ?? "Архив не создан");
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "archive.zip";
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setBusy(false);
    }
  }

  function onToggleExpand(p: string) {
    setExpanded(e => {
      const defaultOpen = p === "";
      const cur = p in e ? e[p]! : defaultOpen;
      return { ...e, [p]: !cur };
    });
  }

  if (authed === null) {
    return (
      <div className="dark flex min-h-screen items-center justify-center bg-[#141312] p-8">
        <p className="text-[#868584] text-sm tracking-wide">Проверка сессии…</p>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="dark flex min-h-screen items-center justify-center bg-[#141312] p-6">
        <Card className="border-mist fm-veil-soft w-full max-w-md border bg-[#161514] shadow-none">
          <CardHeader>
            <p className="fm-label text-[#868584]">Хранилище</p>
            <CardTitle className="text-[#faf9f6] text-2xl font-normal tracking-[-0.02em]">Вход</CardTitle>
            <CardDescription className="text-[#afaeac] text-[15px] leading-relaxed">
              Учётные данные задаются на сервере (переменные окружения).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onLogin} className="flex flex-col gap-4">
              <div className="space-y-2">
                <Label htmlFor="fm-user" className="fm-label text-[#868584]">
                  Логин
                </Label>
                <Input
                  id="fm-user"
                  autoComplete="username"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  disabled={busy}
                  className="border-mist bg-[rgba(255,255,255,0.04)] text-[#faf9f6]"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fm-pass" className="fm-label text-[#868584]">
                  Пароль
                </Label>
                <Input
                  id="fm-pass"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={busy}
                  className="border-mist bg-[rgba(255,255,255,0.04)] text-[#faf9f6]"
                />
              </div>
              {loginError ? <p className="text-[#c4a89c] text-sm">{loginError}</p> : null}
              <Button
                type="submit"
                disabled={busy}
                className="fm-pill h-11 rounded-full bg-[#353534] text-[#afaeac] text-base font-medium hover:opacity-95"
              >
                Войти
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="dark flex min-h-screen flex-col bg-[#141312] text-[#faf9f6]">
      <header className="border-mist fm-veil-soft sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 md:px-6">
        <div className="flex items-baseline gap-3">
          <span className="text-[#faf9f6] text-lg tracking-tight md:text-xl">NT Downloader</span>
          <span className="text-[#868584] hidden text-sm sm:inline">Файловое хранилище</span>
        </div>
        <nav className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`rounded-full px-4 ${view === "browse" ? "bg-[rgba(255,255,255,0.08)] text-[#faf9f6]" : "text-[#868584] hover:text-[#faf9f6]"}`}
            onClick={() => setView("browse")}
          >
            Файлы
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={`rounded-full px-4 ${view === "upload" ? "bg-[rgba(255,255,255,0.08)] text-[#faf9f6]" : "text-[#868584] hover:text-[#faf9f6]"}`}
            onClick={() => setView("upload")}
          >
            Загрузка
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-mist rounded-full border bg-transparent text-[#afaeac] hover:bg-[rgba(255,255,255,0.04)]"
            onClick={() => void onLogout()}
          >
            <LogOut className="size-4" />
            Выйти
          </Button>
        </nav>
      </header>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        <FolderTreeSidebar
          tree={tree}
          selectedPath={path}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          onSelectFolder={setPath}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {view === "browse" ? (
            <FilesBrowseView
              path={path}
              items={items}
              listError={listError}
              busy={busy}
              selected={selected}
              newFolder={newFolder}
              onNewFolderChange={setNewFolder}
              onMkdir={onMkdir}
              onRefresh={() => void loadList()}
              onNavigateFolder={setPath}
              onToggleSelect={toggleSelect}
              onSelectAll={selectAll}
              onDownloadArchive={() => void downloadArchive()}
              onDeleteSelected={() => void deleteSelected()}
              onUnauthorized={() => setAuthed(false)}
              selectedCount={selectedPaths.length}
            />
          ) : (
            <UploadPage
              path={path}
              busy={busy}
              setBusy={setBusy}
              onBack={() => setView("browse")}
              onUnauthorized={() => setAuthed(false)}
              onAfterUpload={() => void afterMutation()}
              onUrlFetchStarted={onUrlFetchStarted}
            />
          )}
        </div>
      </div>

      <UrlFetchProgressPanel jobs={urlJobs} onDismiss={onDismissUrlJob} onCancel={onCancelUrlJob} />
    </div>
  );
}
