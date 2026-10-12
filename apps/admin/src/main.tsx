import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, NavLink, Navigate, Route, Routes } from "react-router";
import { Button, Card } from "@heroui/react";
import { adminSessionSchema } from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
import { Dashboard } from "./Dashboard";
import { Users } from "./Users";
import { Announcements, AnnouncementCreatePage, AnnouncementEditPage } from "./Announcements";
import { Feedback, FeedbackDetailPage } from "./Feedback";
import { FourShogiAi } from "./FourShogiAi";
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
            ...gameIds.map((id) => [gameCatalog[id].lobbyPath, gameCatalog[id].name]),
            ["/users", "登録ユーザー"],
            ["/feedback", "フィードバック"],
            ["/announcements", "お知らせ"],
            ["/four-shogi-ai", "四人将棋AI"],
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
          {gameIds.map((id) => (
            <Route
              key={id}
              path={gameCatalog[id].lobbyPath}
              element={<Dashboard key={id} game={id} />}
            />
          ))}
          <Route path="/users" element={<Users />} />
          <Route path="/four-shogi-ai" element={<FourShogiAi />} />
          <Route path="/announcements" element={<Announcements />} />
          <Route path="/announcements/new" element={<AnnouncementCreatePage />} />
          <Route path="/announcements/:id" element={<AnnouncementEditPage />} />
          <Route path="/feedback" element={<Feedback />} />
          <Route path="/feedback/:id" element={<FeedbackDetailPage />} />
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
