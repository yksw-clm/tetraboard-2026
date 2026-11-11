import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { NavLink, useLocation, useNavigate } from "react-router";
import {
  ActivityIcon,
  BellIcon,
  BlocksIcon,
  CircleHelpIcon,
  ExternalLinkIcon,
  LayoutDashboardIcon,
  MessageCircleIcon,
  TrophyIcon,
  UsersIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "./components/ui/sidebar";
import { NativeSelect, NativeSelectOption } from "./components/ui/native-select";
import { Separator } from "./components/ui/separator";
import { ThemeSelect } from "./components/ThemeProvider";
const analysis = [
  { path: "/", label: "全体概要", icon: LayoutDashboardIcon },
  { path: "/acquisition", label: "集客・登録", icon: ActivityIcon },
  ...gameIds.map((id) => ({
    path: gameCatalog[id].lobbyPath,
    label: gameCatalog[id].name,
    icon: ActivityIcon,
  })),
];
const operations = [
  { path: "/tracking-links", label: "計測リンク", icon: ExternalLinkIcon },
  { path: "/users", label: "ユーザー", icon: UsersIcon },
  { path: "/lobby-chat", label: "公開チャット", icon: MessageCircleIcon },
  { path: "/feedback", label: "フィードバック", icon: CircleHelpIcon },
  { path: "/announcements", label: "お知らせ", icon: BellIcon },
  { path: "/tournaments", label: "大会", icon: TrophyIcon },
];
const pages = [...analysis, ...operations];
const groups = [
  { label: "分析", items: analysis },
  { label: "運営", items: operations },
];
export function adminPage(pathname: string) {
  return pages.find(
    ({ path }) => pathname === path || (path !== "/" && pathname.startsWith(`${path}/`)),
  );
}
export function AdminNavigation({ name }: { name: string }) {
  const { pathname } = useLocation(),
    navigate = useNavigate(),
    { setOpenMobile } = useSidebar();
  const current = adminPage(pathname);
  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader className="gap-5 p-5">
        <div className="flex items-center gap-2">
          <NavLink
            to="/"
            className="flex flex-1 items-center gap-3"
            onClick={() => setOpenMobile(false)}
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <BlocksIcon className="size-5" aria-hidden="true" />
            </span>
            <span>
              <span className="block text-sm font-semibold tracking-tight">TetraBoard</span>
              <span className="text-xs text-muted-foreground">管理画面</span>
            </span>
          </NavLink>
          <SidebarTrigger className="size-10 md:hidden" aria-label="管理メニューを閉じる" />
        </div>
        <label className="flex flex-col gap-2 md:hidden">
          <span className="text-xs text-muted-foreground">表示画面</span>
          <NativeSelect
            value={current?.path ?? "/"}
            onChange={(event) => {
              void navigate(event.target.value);
              setOpenMobile(false);
            }}
          >
            {pages.map(({ path, label }) => (
              <NativeSelectOption key={path} value={path}>
                {label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </label>
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="管理画面">
          {groups.map(({ label: title, items }) => (
            <SidebarGroup key={title}>
              <SidebarGroupLabel>{title}</SidebarGroupLabel>
              <SidebarMenu>
                {items.map(({ path, label, icon: Icon }) => (
                  <SidebarMenuItem key={path}>
                    <SidebarMenuButton
                      isActive={current?.path === path}
                      className="min-h-10"
                      render={
                        <NavLink
                          to={path}
                          end={path === "/"}
                          onClick={() => setOpenMobile(false)}
                        />
                      }
                    >
                      <Icon aria-hidden="true" />
                      <span>{label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter className="gap-4 p-5">
        <ThemeSelect />
        <Separator />
        <p className="break-words text-sm font-medium">{name}</p>
        <a
          href="/"
          className="flex min-h-10 items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        >
          サービスへ戻る
          <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
        </a>
      </SidebarFooter>
    </Sidebar>
  );
}
