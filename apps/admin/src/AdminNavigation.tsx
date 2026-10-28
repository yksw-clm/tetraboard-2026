import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { NavLink, useLocation, useNavigate } from "react-router";

const pages = [
  { path: "/", label: "全体概要" },
  ...gameIds.map((id) => ({ path: gameCatalog[id].lobbyPath, label: gameCatalog[id].name })),
  { path: "/users", label: "ユーザー" },
  { path: "/lobby-chat", label: "公開チャット" },
  { path: "/feedback", label: "フィードバック" },
  { path: "/announcements", label: "お知らせ" },
  { path: "/tournaments", label: "大会" },
];

export function AdminNavigation({ name }: { name: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const current = pages.find(
    ({ path }) => pathname === path || (path !== "/" && pathname.startsWith(`${path}/`)),
  );
  return (
    <aside className="flex min-w-0 flex-col gap-1 border-b border-gray-200 bg-white px-4 py-2 lg:sticky lg:top-0 lg:h-dvh lg:gap-6 lg:overflow-y-auto lg:border-r lg:border-b-0 lg:p-5">
      <div className="flex items-center justify-between gap-3 lg:block">
        <div className="flex items-baseline gap-2 lg:block">
          <p className="text-lg font-bold text-brand">TetraBoard</p>
          <p className="text-xs text-gray-500 lg:mt-1">管理画面</p>
        </div>
        <a className="flex min-h-11 shrink-0 items-center text-xs text-brand lg:hidden" href="/">
          サービスへ ↗
        </a>
      </div>
      <label className="flex items-center gap-3 lg:hidden">
        <span className="shrink-0 text-xs text-gray-500">表示画面</span>
        <select
          className="min-h-11 min-w-0 flex-1 text-base"
          value={current?.path ?? "/"}
          onChange={(event) => void navigate(event.target.value)}
        >
          {pages.map(({ path, label }) => (
            <option key={path} value={path}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <nav aria-label="管理画面" className="hidden flex-col gap-1 lg:flex">
        {pages.map(({ path, label }) => (
          <NavLink
            key={path}
            to={path}
            end={path === "/"}
            className={({ isActive }) =>
              `rounded-lg px-3 py-2.5 text-sm font-medium ${isActive ? "bg-brand text-white" : "text-gray-600 hover:bg-gray-100"}`
            }
          >
            {label}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto hidden text-sm text-gray-600 lg:block">
        <p className="break-words">{name}</p>
        <a className="mt-3 inline-block text-brand" href="/">
          サービスへ戻る ↗
        </a>
      </div>
    </aside>
  );
}
