import type { ReactNode } from "react";
import { useLocation } from "react-router";
import { AdminNavigation, adminPage } from "../AdminNavigation";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "./ui/sidebar";
import { Separator } from "./ui/separator";
import { Badge } from "./ui/badge";
export function AdminShell({ name, children }: { name: string; children: ReactNode }) {
  const { pathname } = useLocation(),
    page = adminPage(pathname);
  return (
    <SidebarProvider>
      <a
        href="#admin-main"
        className="sr-only z-50 rounded-lg bg-background p-3 text-sm shadow focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        本文へ移動
      </a>
      <AdminNavigation name={name} />
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-16 shrink-0 items-center gap-3 border-b bg-background/95 px-4 backdrop-blur supports-backdrop-filter:bg-background/85 lg:px-6">
          <SidebarTrigger aria-label="管理メニューを開閉" className="size-10" />
          <Separator orientation="vertical" className="h-4" />
          <div className="min-w-0 flex-1 truncate text-sm font-medium">
            {page?.label ?? "管理画面"}
          </div>
          <Badge variant="outline" className="hidden sm:inline-flex">
            管理者
          </Badge>
          <span className="max-w-40 truncate text-xs text-muted-foreground">{name}</span>
        </header>
        <main id="admin-main" tabIndex={-1} className="min-w-0 flex-1 p-4 lg:p-6">
          <div className="mx-auto max-w-[1600px]">{children}</div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
