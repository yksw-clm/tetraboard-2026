import { AccountMenu } from "../account/AccountMenu";
import { AppHeader } from "../../shared/ui/AppHeader";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";

export function HowToPlayPage() {
  return (
    <div className="app-theme min-h-dvh bg-page text-ink">
      <AppHeader homeTo="/" homeLabel="TetraBoard ホーム">
        <AccountMenu />
      </AppHeader>
      <main aria-label="遊び方" className={`${appPageWidthClasses} py-8`} />
    </div>
  );
}
