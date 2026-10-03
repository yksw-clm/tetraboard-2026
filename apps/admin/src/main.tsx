import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router";
import { Button, Card } from "@heroui/react";
import { adminSessionSchema } from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
import { Dashboard } from "./Dashboard";
import { Users } from "./Users";
const parseSession = (body: unknown) => adminSessionSchema.parse(body);
function App() {
  const session = useAdminData("/api/admin/session", parseSession);
  if (!session.data)
    return (
      <main className="mx-auto max-w-xl p-8">
        <Card className="gap-4 p-6">
          <h1 className="text-2xl font-bold">TetraBoard 管理画面</h1>
          {session.loading ? (
            <p role="status">ログイン状態を確認しています…</p>
          ) : (
            <>
              <p role="alert">{session.error}</p>
              {session.status === 401 ? (
                <a href="/login?destination=admin">Googleでログイン</a>
              ) : (
                <Button onPress={session.refresh}>再試行</Button>
              )}
              <a href="/">ロビーへ</a>
            </>
          )}
        </Card>
      </main>
    );
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[224px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-8 border-r border-gray-200 bg-white p-6 lg:sticky lg:top-0 lg:h-dvh">
        <div>
          <p className="text-xl font-bold text-brand">TetraBoard</p>
          <p className="mt-1 text-sm text-gray-500">管理画面</p>
        </div>
        <nav aria-label="管理画面" className="flex flex-wrap gap-2 lg:flex-col">
          {[
            ["/", "全体概要"],
            ["/games/four-reversi", "四人リバーシ"],
            ["/games/four-shogi", "四人将棋"],
            ["/users", "登録ユーザー"],
          ].map(([to, label]) => (
            <NavLink
              key={to}
              to={to}
              end
              className={({ isActive }) =>
                `rounded-lg px-4 py-3 text-sm font-medium ${isActive ? "bg-brand text-white" : "text-gray-600 hover:bg-gray-100"}`
              }
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-auto text-sm text-gray-600">
          <p>{session.data.name}</p>
          <a className="mt-3 inline-block text-brand" href="/">
            サービスへ戻る ↗
          </a>
        </div>
      </aside>
      <main className="min-w-0 p-5 sm:p-8 lg:p-10">
        <Routes>
          <Route path="/" element={<Dashboard game="all" />} />
          <Route
            path="/games/four-reversi"
            element={<Dashboard key="reversi" game="four-reversi" />}
          />
          <Route path="/games/four-shogi" element={<Dashboard key="shogi" game="four-shogi" />} />
          <Route path="/users" element={<Users />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename="/admin">
      <App />
    </BrowserRouter>
  </StrictMode>,
);
