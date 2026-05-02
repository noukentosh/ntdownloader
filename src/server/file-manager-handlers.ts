import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { zip } from "fflate";

const SESSION_COOKIE = "fm_session";
const SESSION_MAX_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_MAX_UPLOAD = 50 * 1024 * 1024;
const DEFAULT_MAX_FETCH = 50 * 1024 * 1024;

export function getUploadsRoot(): string {
  return path.resolve(process.cwd(), process.env.UPLOADS_ROOT ?? "uploads");
}

function maxUploadBytes(): number {
  const n = Number(process.env.FILE_MANAGER_MAX_UPLOAD_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UPLOAD;
}

function maxFetchBytes(): number {
  const n = Number(process.env.FILE_MANAGER_MAX_FETCH_BYTES);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_FETCH;
}

/** In-memory URL fetch jobs (lost on server restart). */
type FetchJobStatus = "downloading" | "done" | "error" | "cancelled";

type FetchJob = {
  id: string;
  url: string;
  dirRel: string;
  destRel: string;
  destAbs: string;
  filename: string;
  total: number;
  received: number;
  status: FetchJobStatus;
  error?: string;
  startedAt: number;
  finishedAt?: number;
  abort: AbortController;
};

const fetchJobs = new Map<string, FetchJob>();

const FETCH_JOB_RETENTION_MS = 15 * 60 * 1000;
const FETCH_JOB_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const FETCH_STATUS_RECENT_MS = 60 * 60 * 1000;

setInterval(() => {
  const cutoff = Date.now() - FETCH_JOB_RETENTION_MS;
  for (const [id, job] of fetchJobs) {
    if (job.status === "downloading") continue;
    const end = job.finishedAt ?? job.startedAt;
    if (end < cutoff) {
      fetchJobs.delete(id);
    }
  }
}, FETCH_JOB_CLEANUP_INTERVAL_MS);

function jobToPublic(job: FetchJob) {
  return {
    id: job.id,
    filename: job.filename,
    total: job.total,
    received: job.received,
    status: job.status,
    error: job.error,
    destRel: job.destRel,
  };
}

function writeChunkToStream(stream: ReturnType<typeof createWriteStream>, chunk: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once("error", reject);
    const ok = stream.write(chunk);
    if (ok) {
      stream.removeListener("error", reject);
      resolve();
    } else {
      stream.once("drain", () => {
        stream.removeListener("error", reject);
        resolve();
      });
    }
  });
}

async function pumpFetchJob(job: FetchJob, body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<void> {
  if (!body) {
    job.status = "error";
    job.error = "No response body";
    job.finishedAt = Date.now();
    await rm(job.destAbs, { force: true }).catch(() => {});
    return;
  }
  const reader = body.getReader();
  const stream = createWriteStream(job.destAbs);
  try {
    while (true) {
      let readResult: ReadableStreamReadResult<Uint8Array>;
      try {
        readResult = await reader.read();
      } catch (e) {
        if (job.status === "cancelled") {
          stream.destroy();
          await rm(job.destAbs, { force: true }).catch(() => {});
          job.finishedAt = Date.now();
          return;
        }
        job.status = "error";
        job.error = e instanceof Error ? e.message : "Read failed";
        job.finishedAt = Date.now();
        stream.destroy();
        await rm(job.destAbs, { force: true }).catch(() => {});
        return;
      }
      const { done, value } = readResult;
      if (done) break;
      if (!value?.length) continue;
      if (job.status === "cancelled") {
        await reader.cancel().catch(() => {});
        break;
      }
      if (job.received + value.length > maxBytes) {
        await reader.cancel().catch(() => {});
        try {
          job.abort.abort();
        } catch {
          /* ignore */
        }
        job.status = "error";
        job.error = "Downloaded file too large";
        job.finishedAt = Date.now();
        stream.destroy();
        await rm(job.destAbs, { force: true }).catch(() => {});
        return;
      }
      job.received += value.length;
      try {
        await writeChunkToStream(stream, value);
      } catch (e) {
        if (job.status === "cancelled") {
          stream.destroy();
          await rm(job.destAbs, { force: true }).catch(() => {});
          job.finishedAt = Date.now();
          return;
        }
        job.status = "error";
        job.error = e instanceof Error ? e.message : "Write failed";
        job.finishedAt = Date.now();
        stream.destroy();
        await rm(job.destAbs, { force: true }).catch(() => {});
        return;
      }
    }

    if (job.status === "cancelled") {
      stream.destroy();
      await rm(job.destAbs, { force: true }).catch(() => {});
      job.finishedAt = Date.now();
      return;
    }

    await new Promise<void>((resolve, reject) => {
      stream.end(err => (err ? reject(err) : resolve()));
    });
    job.status = "done";
    job.finishedAt = Date.now();
  } catch (e) {
    if (job.status !== "cancelled") {
      job.status = "error";
      job.error = e instanceof Error ? e.message : "Download failed";
      job.finishedAt = Date.now();
    }
    stream.destroy();
    await rm(job.destAbs, { force: true }).catch(() => {});
  }
}

/** Bun enforces a server-wide body limit; above ~128MB uploads often fail with net::ERR_CONNECTION_ABORTED unless raised. */
export function getMaxRequestBodySizeBytes(): number {
  const explicit = Number(process.env.BUN_MAX_REQUEST_BODY_BYTES);
  if (Number.isFinite(explicit) && explicit > 0) {
    return Math.min(Math.floor(explicit), Number.MAX_SAFE_INTEGER);
  }
  const uploadCap = maxUploadBytes();
  const overhead = 48 * 1024 * 1024;
  const padded = uploadCap + overhead;
  const floor = 132 * 1024 * 1024;
  return Math.max(padded, floor);
}

function getSecret(): string | undefined {
  const s = process.env.FILE_MANAGER_SECRET;
  return s && s.length > 0 ? s : undefined;
}

function getCredentials(): { user: string; pass: string } | undefined {
  const user = process.env.FILE_MANAGER_USER;
  const pass = process.env.FILE_MANAGER_PASSWORD;
  if (!user || !pass) return undefined;
  return { user, pass };
}

export function safeResolveUnderRoot(root: string, userPath: string): string {
  const normalized = userPath.replace(/^[/\\]+/, "");
  const rootResolved = path.resolve(root);
  const resolved = path.resolve(rootResolved, normalized);
  const rel = path.relative(rootResolved, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new HttpError("Path outside uploads root", 403);
  }
  return resolved;
}

function getCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k === name) return decodeURIComponent(v);
  }
  return undefined;
}

function signPayload(payloadJson: string, secret: string): string {
  const sig = createHmac("sha256", secret).update(payloadJson).digest("base64url");
  const payloadB64 = Buffer.from(payloadJson, "utf8").toString("base64url");
  return `${payloadB64}.${sig}`;
}

function verifySessionToken(token: string, secret: string): boolean {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let payloadJson: string;
  try {
    payloadJson = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", secret).update(payloadJson).digest("base64url");
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    if (!timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }
  let exp: number;
  try {
    const o = JSON.parse(payloadJson) as { exp?: number };
    exp = typeof o.exp === "number" ? o.exp : 0;
  } catch {
    return false;
  }
  return exp > Date.now();
}

export function requireSession(req: Request): Response | null {
  const secret = getSecret();
  if (!secret) {
    return Response.json({ error: "FILE_MANAGER_SECRET is not set" }, { status: 503 });
  }
  const token = getCookie(req, SESSION_COOKIE);
  if (!token || !verifySessionToken(token, secret)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

function sessionCookieHeader(token: string, maxAgeSec: number): string {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAgeSec}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  return parts.join("; ");
}

function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new HttpError("Invalid JSON body", 400);
  }
}

function contentDispositionAttachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(filename);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function parseFilenameFromCd(header: string | null): string | undefined {
  if (!header) return undefined;
  const m = /filename\*?=(?:UTF-8''|")?([^";\n]+)/i.exec(header);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1].replace(/^"|"$/g, ""));
  } catch {
    return m[1].replace(/^"|"$/g, "");
  }
}

function sanitizeFilename(name: string): string {
  const base = path.basename(name.trim()) || "download";
  return base.replace(/[/\\<>:"|?*\x00-\x1f]/g, "_").slice(0, 255);
}

function isBlockedUrl(u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return true;
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "0.0.0.0") return true;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    const c = Number(ipv4[3]);
    const d = Number(ipv4[4]);
    if ([a, b, c, d].some(n => n > 255)) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (host === "[::1]") return true;
  if (host.includes(":") && !host.includes(".")) {
    const inner = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
    const lc = inner.toLowerCase();
    if (lc === "::1") return true;
    if (lc.startsWith("fe80:")) return true;
    if (lc.startsWith("fc00:") || lc.startsWith("fd")) return true;
  }

  return false;
}

function zipAsync(files: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(files, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

export type DirTreeNode = { path: string; name: string; children: DirTreeNode[] };

async function buildDirTree(absDir: string, relPath: string): Promise<DirTreeNode> {
  const entries = await readdir(absDir, { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));
  const children: DirTreeNode[] = [];
  for (const d of dirs) {
    const childRel = relPath ? `${relPath}/${d.name}` : d.name;
    const childAbs = path.join(absDir, d.name);
    children.push(await buildDirTree(childAbs, childRel));
  }
  return {
    path: relPath,
    name: relPath === "" ? "" : path.basename(relPath),
    children,
  };
}

async function collectZipEntries(
  root: string,
  absPaths: string[],
): Promise<Record<string, Uint8Array>> {
  const out: Record<string, Uint8Array> = {};
  const rootResolved = path.resolve(root);

  async function addFile(abs: string, arcName: string): Promise<void> {
    const file = Bun.file(abs);
    const buf = new Uint8Array(await file.arrayBuffer());
    out[arcName.replace(/\\/g, "/")] = buf;
  }

  async function walkDir(absDir: string, arcPrefix: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const ent of entries) {
      const abs = path.join(absDir, ent.name);
      const arc = arcPrefix ? `${arcPrefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walkDir(abs, arc);
      } else if (ent.isFile()) {
        await addFile(abs, arc);
      }
    }
  }

  for (const absInput of absPaths) {
    const rel = path.relative(rootResolved, absInput);
    if (rel.startsWith("..") || path.isAbsolute(rel)) continue;
    const st = await stat(absInput);
    if (st.isDirectory()) {
      await walkDir(absInput, rel);
    } else if (st.isFile()) {
      await addFile(absInput, rel);
    }
  }

  return out;
}

export const fileManagerRoutes = {
  "/api/file-manager/login": {
    async POST(req: Request) {
      const creds = getCredentials();
      const secret = getSecret();
      if (!creds || !secret) {
        return Response.json({ error: "File manager is not configured (ENV)" }, { status: 503 });
      }
      const body = (await readJsonBody(req)) as { username?: string; password?: string };
      const user = body.username ?? "";
      const pass = body.password ?? "";
      const ok =
        user.length === creds.user.length &&
        pass.length === creds.pass.length &&
        timingSafeEqual(Buffer.from(user, "utf8"), Buffer.from(creds.user, "utf8")) &&
        timingSafeEqual(Buffer.from(pass, "utf8"), Buffer.from(creds.pass, "utf8"));
      if (!ok) {
        return Response.json({ error: "Invalid credentials" }, { status: 401 });
      }
      const exp = Date.now() + SESSION_MAX_MS;
      const payloadJson = JSON.stringify({ exp });
      const token = signPayload(payloadJson, secret);
      return Response.json({ ok: true }, {
        headers: { "Set-Cookie": sessionCookieHeader(token, Math.floor(SESSION_MAX_MS / 1000)) },
      });
    },
  },

  "/api/file-manager/logout": {
    async POST() {
      return Response.json({ ok: true }, {
        headers: { "Set-Cookie": clearSessionCookieHeader() },
      });
    },
  },

  "/api/file-manager/me": {
    async GET(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      return Response.json({ ok: true });
    },
  },

  "/api/file-manager/list": {
    async GET(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      const root = getUploadsRoot();
      const url = new URL(req.url);
      const rel = url.searchParams.get("path") ?? "";
      let dirAbs: string;
      try {
        dirAbs = safeResolveUnderRoot(root, rel);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400;
        return Response.json({ error: e instanceof Error ? e.message : "Bad path" }, { status });
      }
      let st;
      try {
        st = await stat(dirAbs);
      } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (!st.isDirectory()) {
        return Response.json({ error: "Not a directory" }, { status: 400 });
      }
      const entries = await readdir(dirAbs, { withFileTypes: true });
      const items = await Promise.all(
        entries.map(async ent => {
          const p = path.join(dirAbs, ent.name);
          let size = 0;
          let mtime = 0;
          try {
            const s = await stat(p);
            size = s.isFile() ? s.size : 0;
            mtime = Math.floor(s.mtimeMs);
          } catch {
            /* ignore */
          }
          return {
            name: ent.name,
            type: ent.isDirectory() ? "dir" : "file",
            size,
            mtime,
          };
        }),
      );
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      return Response.json({ path: rel, items });
    },
  },

  "/api/file-manager/tree": {
    async GET(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      const root = getUploadsRoot();
      try {
        await stat(root);
      } catch {
        await mkdir(root, { recursive: true });
      }
      const tree = await buildDirTree(root, "");
      return Response.json({ tree });
    },
  },

  "/api/file-manager/mkdir": {
    async POST(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      const root = getUploadsRoot();
      const body = (await readJsonBody(req)) as { path?: string };
      const rel = typeof body.path === "string" ? body.path : "";
      let target: string;
      try {
        target = safeResolveUnderRoot(root, rel);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400;
        return Response.json({ error: e instanceof Error ? e.message : "Bad path" }, { status });
      }
      try {
        await mkdir(target, { recursive: true });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "mkdir failed" }, { status: 500 });
      }
      return Response.json({ ok: true, path: rel });
    },
  },

  "/api/file-manager/upload": {
    async POST(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      const root = getUploadsRoot();
      try {
        let form: FormData;
        try {
          form = await req.formData();
        } catch (err) {
          console.error("[file-manager] formData:", err);
          return Response.json({ error: "Invalid multipart body" }, { status: 400 });
        }
        const dirRel = typeof form.get("path") === "string" ? (form.get("path") as string) : "";
        let dirAbs: string;
        try {
          dirAbs = safeResolveUnderRoot(root, dirRel);
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 400;
          return Response.json({ error: e instanceof Error ? e.message : "Bad path" }, { status });
        }
        try {
          const st = await stat(dirAbs);
          if (!st.isDirectory()) {
            return Response.json({ error: "Target is not a directory" }, { status: 400 });
          }
        } catch {
          return Response.json({ error: "Directory does not exist" }, { status: 400 });
        }

        const maxB = maxUploadBytes();
        let saved = 0;
        const names: string[] = [];

        const candidates = [...form.getAll("files"), ...form.getAll("file")];
        for (const entry of candidates) {
          if (!(entry instanceof File) || !entry.name) continue;
          if (entry.size > maxB) {
            return Response.json({ error: `File too large: ${entry.name}` }, { status: 413 });
          }
          const name = sanitizeFilename(entry.name);
          const dest = safeResolveUnderRoot(root, path.join(dirRel.replace(/\\/g, "/"), name));
          await Bun.write(dest, entry);
          names.push(path.join(dirRel, name).replace(/\\/g, "/"));
          saved++;
        }

        if (saved === 0) {
          return Response.json({ error: "No files in request (use field \"files\")" }, { status: 400 });
        }
        return Response.json({ ok: true, saved, paths: names });
      } catch (err) {
        console.error("[file-manager] upload:", err);
        return Response.json({ error: err instanceof Error ? err.message : "Upload failed" }, { status: 500 });
      }
    },
  },

  "/api/file-manager/fetch-url/start": {
    async POST(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      const root = getUploadsRoot();
      const body = (await readJsonBody(req)) as { url?: string; dir?: string; filename?: string };
      const urlStr = typeof body.url === "string" ? body.url.trim() : "";
      const dirRel = typeof body.dir === "string" ? body.dir : "";
      if (!urlStr) {
        return Response.json({ error: "url is required" }, { status: 400 });
      }
      let u: URL;
      try {
        u = new URL(urlStr);
      } catch {
        return Response.json({ error: "Invalid URL" }, { status: 400 });
      }
      if (isBlockedUrl(u)) {
        return Response.json({ error: "URL host is not allowed" }, { status: 403 });
      }

      let dirAbs: string;
      try {
        dirAbs = safeResolveUnderRoot(root, dirRel);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400;
        return Response.json({ error: e instanceof Error ? e.message : "Bad path" }, { status });
      }
      try {
        const st = await stat(dirAbs);
        if (!st.isDirectory()) {
          return Response.json({ error: "Target is not a directory" }, { status: 400 });
        }
      } catch {
        return Response.json({ error: "Directory does not exist" }, { status: 400 });
      }

      const maxBytes = maxFetchBytes();
      const abort = new AbortController();
      let res: Response;
      try {
        res = await fetch(u.toString(), {
          redirect: "follow",
          signal: abort.signal,
        });
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Fetch failed" }, { status: 502 });
      }
      if (!res.ok) {
        return Response.json({ error: `Remote status ${res.status}` }, { status: 502 });
      }

      const lenHeader = res.headers.get("content-length");
      let total = 0;
      if (lenHeader) {
        const n = Number(lenHeader);
        if (Number.isFinite(n) && n >= 0) {
          total = Math.floor(n);
          if (total > maxBytes) {
            return Response.json({ error: "Remote file too large" }, { status: 413 });
          }
        }
      }

      let filename =
        typeof body.filename === "string" && body.filename.trim()
          ? sanitizeFilename(body.filename)
          : undefined;
      if (!filename) {
        filename = parseFilenameFromCd(res.headers.get("content-disposition"));
      }
      if (!filename) {
        filename = sanitizeFilename(path.basename(u.pathname) || "download");
      }

      const relDest = path.join(dirRel.replace(/\\/g, "/"), filename).replace(/\\/g, "/");
      let destAbs: string;
      try {
        destAbs = safeResolveUnderRoot(root, relDest);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400;
        return Response.json({ error: e instanceof Error ? e.message : "Bad path" }, { status });
      }

      try {
        await writeFile(destAbs, new Uint8Array(0));
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Could not create file" }, { status: 500 });
      }

      const id = randomUUID();
      const job: FetchJob = {
        id,
        url: u.toString(),
        dirRel,
        destRel: relDest,
        destAbs,
        filename,
        total,
        received: 0,
        status: "downloading",
        startedAt: Date.now(),
        abort,
      };
      fetchJobs.set(id, job);

      queueMicrotask(() => {
        void pumpFetchJob(job, res.body, maxBytes);
      });

      return Response.json({ id, filename, total });
    },
  },

  "/api/file-manager/fetch-url/status": {
    async GET(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      const url = new URL(req.url);
      const idsRaw = url.searchParams.get("ids") ?? "";
      const ids = idsRaw
        .split(",")
        .map(s => s.trim())
        .filter(Boolean);
      const now = Date.now();

      const recent = (job: FetchJob): boolean => {
        if (job.status === "downloading") return true;
        const t = job.finishedAt ?? job.startedAt;
        return t > now - FETCH_STATUS_RECENT_MS;
      };

      if (ids.length === 0) {
        const jobs = [...fetchJobs.values()].filter(recent).map(jobToPublic);
        return Response.json({ jobs });
      }

      const out: ReturnType<typeof jobToPublic>[] = [];
      for (const id of ids) {
        const job = fetchJobs.get(id);
        if (job) out.push(jobToPublic(job));
      }
      return Response.json({ jobs: out });
    },
  },

  "/api/file-manager/fetch-url/cancel": {
    async POST(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      const body = (await readJsonBody(req)) as { id?: string };
      const id = typeof body.id === "string" ? body.id.trim() : "";
      if (!id) {
        return Response.json({ error: "id is required" }, { status: 400 });
      }
      const job = fetchJobs.get(id);
      if (!job) {
        return Response.json({ error: "Job not found" }, { status: 404 });
      }
      if (job.status !== "downloading") {
        return Response.json({ ok: true, status: job.status });
      }
      job.status = "cancelled";
      try {
        job.abort.abort();
      } catch {
        /* ignore */
      }
      return Response.json({ ok: true, status: "cancelled" });
    },
  },

  "/api/file-manager/download": {
    async GET(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      const root = getUploadsRoot();
      const url = new URL(req.url);
      const rel = url.searchParams.get("path") ?? "";
      let fileAbs: string;
      try {
        fileAbs = safeResolveUnderRoot(root, rel);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400;
        return Response.json({ error: e instanceof Error ? e.message : "Bad path" }, { status });
      }
      let st;
      try {
        st = await stat(fileAbs);
      } catch {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      if (!st.isFile()) {
        return Response.json({ error: "Not a file" }, { status: 400 });
      }
      const file = Bun.file(fileAbs);
      const base = path.basename(fileAbs);
      return new Response(file, {
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "Content-Disposition": contentDispositionAttachment(base),
        },
      });
    },
  },

  "/api/file-manager/delete": {
    async POST(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      const root = getUploadsRoot();
      const rootResolved = path.resolve(root);
      const body = (await readJsonBody(req)) as { paths?: unknown };
      const pathsIn = Array.isArray(body.paths) ? body.paths : [];
      const relList = pathsIn.filter((p): p is string => typeof p === "string" && p.length > 0);
      if (relList.length === 0) {
        return Response.json({ error: "paths must be a non-empty array" }, { status: 400 });
      }

      for (const rel of relList) {
        const normalized = rel.replace(/^[/\\]+/, "");
        if (normalized === "") {
          return Response.json({ error: "Cannot delete storage root" }, { status: 400 });
        }
        let abs: string;
        try {
          abs = safeResolveUnderRoot(root, rel);
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 400;
          return Response.json({ error: e instanceof Error ? e.message : "Bad path" }, { status });
        }
        if (path.resolve(abs) === rootResolved) {
          return Response.json({ error: "Cannot delete storage root" }, { status: 400 });
        }
        try {
          await rm(abs, { recursive: true, force: true });
        } catch (e) {
          return Response.json({ error: e instanceof Error ? e.message : "Delete failed" }, { status: 500 });
        }
      }

      return Response.json({ ok: true, deleted: relList.length });
    },
  },

  "/api/file-manager/archive": {
    async POST(req: Request) {
      const deny = requireSession(req);
      if (deny) return deny;
      const root = getUploadsRoot();
      const body = (await readJsonBody(req)) as { paths?: unknown };
      const pathsIn = Array.isArray(body.paths) ? body.paths : [];
      const relList = pathsIn.filter((p): p is string => typeof p === "string" && p.length > 0);
      if (relList.length === 0) {
        return Response.json({ error: "paths must be a non-empty array" }, { status: 400 });
      }

      const absList: string[] = [];
      for (const rel of relList) {
        try {
          absList.push(safeResolveUnderRoot(root, rel));
        } catch (e) {
          const status = e instanceof HttpError ? e.status : 400;
          return Response.json({ error: e instanceof Error ? e.message : "Bad path" }, { status });
        }
      }

      let entries: Record<string, Uint8Array>;
      try {
        entries = await collectZipEntries(root, absList);
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Archive failed" }, { status: 500 });
      }
      const keys = Object.keys(entries);
      if (keys.length === 0) {
        return Response.json({ error: "Nothing to archive" }, { status: 400 });
      }

      let zipped: Uint8Array;
      try {
        zipped = await zipAsync(entries);
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : "Zip failed" }, { status: 500 });
      }

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      return new Response(zipped, {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": contentDispositionAttachment(`archive-${stamp}.zip`),
        },
      });
    },
  },
} as const;
