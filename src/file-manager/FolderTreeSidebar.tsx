import { ChevronRight, Folder } from "lucide-react";

import type { DirTreeNode } from "./types";

type Props = {
  tree: DirTreeNode | null;
  selectedPath: string;
  expanded: Record<string, boolean>;
  onToggleExpand: (path: string) => void;
  onSelectFolder: (path: string) => void;
};

export function FolderTreeSidebar({ tree, selectedPath, expanded, onToggleExpand, onSelectFolder }: Props) {
  return (
    <aside className="border-mist fm-veil-soft flex w-full shrink-0 flex-col border-b md:w-[280px] md:border-r md:border-b-0">
      <div className="border-mist border-b px-4 py-4">
        <p className="fm-label text-[#868584]">Каталог</p>
        <p className="text-[#faf9f6] mt-1 font-medium tracking-tight">Папки</p>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-3" aria-label="Дерево папок">
        {!tree ? (
          <p className="text-[#868584] px-2 text-sm">Загрузка…</p>
        ) : (
          <TreeBranch
            node={tree}
            depth={0}
            selectedPath={selectedPath}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onSelectFolder={onSelectFolder}
          />
        )}
      </nav>
    </aside>
  );
}

function TreeBranch({
  node,
  depth,
  selectedPath,
  expanded,
  onToggleExpand,
  onSelectFolder,
}: {
  node: DirTreeNode;
  depth: number;
  selectedPath: string;
  expanded: Record<string, boolean>;
  onToggleExpand: (path: string) => void;
  onSelectFolder: (path: string) => void;
}) {
  const isRoot = node.path === "";
  const label = isRoot ? "uploads" : node.name;
  const hasChildren = node.children.length > 0;
  const isOpen = node.path in expanded ? expanded[node.path]! : isRoot;
  const isSelected = selectedPath === node.path;

  return (
    <div className="select-none">
      <div
        className="flex min-h-9 items-center gap-0.5 rounded-lg pr-1"
        style={{ paddingLeft: Math.max(0, depth) * 10 }}
      >
        {hasChildren ? (
          <button
            type="button"
            className="text-[#868584] hover:text-[#faf9f6] flex size-8 shrink-0 items-center justify-center rounded-full transition-opacity hover:opacity-90"
            aria-expanded={isOpen}
            aria-label={isOpen ? "Свернуть" : "Развернуть"}
            onClick={e => {
              e.stopPropagation();
              onToggleExpand(node.path);
            }}
          >
            <ChevronRight className={`size-4 transition-transform ${isOpen ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="size-8 shrink-0" aria-hidden />
        )}
        <button
          type="button"
          onClick={() => onSelectFolder(node.path)}
          className={`flex min-w-0 flex-1 items-center gap-2 rounded-full px-2 py-1.5 text-left text-[15px] transition-colors hover:bg-[rgba(255,255,255,0.06)] ${
            isSelected
              ? "bg-[rgba(255,255,255,0.06)] text-[#faf9f6] ring-1 ring-[rgba(226,226,226,0.35)]"
              : "text-[#afaeac]"
          }`}
        >
          <Folder className="text-[#868584] size-4 shrink-0" />
          <span className="truncate">{label}</span>
        </button>
      </div>
      {hasChildren && isOpen ? (
        <div className="border-mist ml-2 border-l border-dashed pl-1">
          {node.children.map(child => (
            <TreeBranch
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expanded={expanded}
              onToggleExpand={onToggleExpand}
              onSelectFolder={onSelectFolder}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
