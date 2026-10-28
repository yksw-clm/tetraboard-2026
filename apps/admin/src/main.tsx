import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { Button, Card } from "@heroui/react";
import { adminSessionSchema } from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
import { Dashboard } from "./Dashboard";
import { LobbyChat } from "./LobbyChat";
import { Users } from "./Users";
import { Announcements, AnnouncementCreatePage, AnnouncementEditPage } from "./Announcements";
import { Feedback, FeedbackDetailPage } from "./Feedback";
import { Tournaments, TournamentCreatePage, TournamentEditPage } from "./Tournaments";
import { AdminNavigation } from "./AdminNavigation";
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
      <AdminNavigation name={session.data.name} />
      <main className="min-w-0 p-3 sm:p-4 lg:p-6">
        <Routes>
          <Route path="/" element={<Dashboard game="all" />} />
          {gameIds.map((id) => (
            <Route
              key={id}
              path={gameCatalog[id].lobbyPath}
              element={<Dashboard key={id} game={id} />}
            />
          ))}
          <Route path="/lobby-chat" element={<LobbyChat />} />
          <Route path="/users" element={<Users />} />
          <Route path="/announcements" element={<Announcements />} />
          <Route path="/announcements/new" element={<AnnouncementCreatePage />} />
          <Route path="/announcements/:id" element={<AnnouncementEditPage />} />
          <Route path="/tournaments" element={<Tournaments />} />
          <Route path="/tournaments/new" element={<TournamentCreatePage />} />
          <Route path="/tournaments/:key" element={<TournamentEditPage />} />
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
