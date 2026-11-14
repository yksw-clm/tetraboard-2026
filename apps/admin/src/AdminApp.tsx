import { lazy, Suspense } from "react";
import { AdminPageBoundary } from "./components/AdminPageBoundary";
import { useLocation } from "react-router";
import { gameCatalog, gameIds } from "@tetraboard/protocol/games";
import { Navigate, Route, Routes } from "react-router";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { AdminShell } from "./components/AdminShell";
import { adminSessionSchema } from "@tetraboard/protocol";
import { useAdminData } from "./useAdminData";
const Tournaments = lazy(() =>
  import("./Tournaments").then((module) => ({ default: module.Tournaments })),
);
const TournamentCreatePage = lazy(() =>
  import("./Tournaments").then((module) => ({ default: module.TournamentCreatePage })),
);
const TournamentEditPage = lazy(() =>
  import("./Tournaments").then((module) => ({ default: module.TournamentEditPage })),
);
const Feedback = lazy(() => import("./Feedback").then((module) => ({ default: module.Feedback })));
const FeedbackDetailPage = lazy(() =>
  import("./Feedback").then((module) => ({ default: module.FeedbackDetailPage })),
);
const Announcements = lazy(() =>
  import("./Announcements").then((module) => ({ default: module.Announcements })),
);
const AnnouncementCreatePage = lazy(() =>
  import("./Announcements").then((module) => ({ default: module.AnnouncementCreatePage })),
);
const AnnouncementEditPage = lazy(() =>
  import("./Announcements").then((module) => ({ default: module.AnnouncementEditPage })),
);
const Users = lazy(() => import("./Users").then((module) => ({ default: module.Users })));
const LobbyChat = lazy(() =>
  import("./LobbyChat").then((module) => ({ default: module.LobbyChat })),
);
const Dashboard = lazy(() =>
  import("./Dashboard").then((module) => ({ default: module.Dashboard })),
);
const Kpi = lazy(() => import("./Kpi").then((module) => ({ default: module.Kpi })));
const AcquisitionDashboard = lazy(() =>
  import("./AcquisitionDashboard").then((m) => ({ default: m.AcquisitionDashboard })),
);
const TrackingLinks = lazy(() =>
  import("./TrackingLinks").then((m) => ({ default: m.TrackingLinks })),
);
const parseSession = (body: unknown) => adminSessionSchema.parse(body);
export function AdminApp() {
  const { pathname } = useLocation();
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
                <Button onClick={session.refresh}>再試行</Button>
              )}
              <a href="/">ロビーへ</a>
            </>
          )}
        </Card>
      </main>
    );
  return (
    <AdminShell name={session.data.name}>
      <AdminPageBoundary key={pathname}>
        <Suspense
          fallback={
            <p role="status" className="p-6 text-sm text-muted-foreground">
              画面を読み込んでいます…
            </p>
          }
        >
          <Routes>
            <Route path="/kpi" element={<Kpi />} />
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
            <Route path="/acquisition" element={<AcquisitionDashboard />} />
            <Route path="/tracking-links" element={<TrackingLinks />} />
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
        </Suspense>
      </AdminPageBoundary>
    </AdminShell>
  );
}
