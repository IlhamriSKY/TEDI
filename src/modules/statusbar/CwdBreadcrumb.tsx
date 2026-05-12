import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { segmentsFromCwd } from "./lib/pathUtils";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
};

function dirname(path: string): string {
  const i = path.lastIndexOf("/");
  if (i <= 0) return "/";
  return path.slice(0, i);
}

function basename(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

export function CwdBreadcrumb({ cwd, filePath, home, onCd }: Props) {
  if (!cwd && !filePath) {
    return (
      <span className="text-xs text-muted-foreground/70">no directory</span>
    );
  }

  const dirPath = filePath ? dirname(filePath) : (cwd as string);
  const segments = segmentsFromCwd(dirPath, home);
  const leafLabel = filePath
    ? basename(filePath)
    : segments[segments.length - 1].label;
  const linkSegments = filePath ? segments : segments.slice(0, -1);

  return (
    <Breadcrumb>
      <BreadcrumbList className="gap-1 text-xs sm:gap-1.5">
        {linkSegments.map((s) => (
          <span key={s.fullPath} className="contents">
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <button
                  type="button"
                  onClick={() => onCd(s.fullPath)}
                  className="cursor-pointer text-muted-foreground hover:text-foreground"
                >
                  {s.isHome ? "~" : s.label}
                </button>
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="[&>svg]:size-3" />
          </span>
        ))}
        <BreadcrumbItem>
          <BreadcrumbPage className="text-foreground">
            {leafLabel}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
