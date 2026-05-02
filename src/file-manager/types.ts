export type ListItem = { name: string; type: "dir" | "file"; size: number; mtime: number };

export type DirTreeNode = { path: string; name: string; children: DirTreeNode[] };

export type UrlFetchJobStatus = "downloading" | "done" | "error" | "cancelled";

export type UrlFetchJob = {
  id: string;
  filename: string;
  total: number;
  received: number;
  status: UrlFetchJobStatus;
  error?: string;
  destRel?: string;
};
