export const FM_API = "/api/file-manager";

export function joinRel(dir: string, name: string): string {
  const d = dir.replace(/[/\\]+$/, "");
  return d ? `${d}/${name}` : name;
}

export function prefixesOfPath(rel: string): string[] {
  if (!rel) return [];
  const parts = rel.split("/").filter(Boolean);
  const out: string[] = [];
  let acc = "";
  for (const p of parts) {
    acc = acc ? `${acc}/${p}` : p;
    out.push(acc);
  }
  return out;
}

export function breadcrumbItems(relPath: string): { label: string; rel: string }[] {
  const parts = relPath.split("/").filter(Boolean);
  const crumbs: { label: string; rel: string }[] = [{ label: "uploads", rel: "" }];
  let acc = "";
  for (const p of parts) {
    acc = joinRel(acc, p);
    crumbs.push({ label: p, rel: acc });
  }
  return crumbs;
}
