import { AppHeader } from "../../shared/ui/AppHeader";
import { AccountMenu } from "../account/AccountMenu";
import { useAccount } from "../account/useAccount";
import { FeedbackForm } from "./FeedbackForm";
import { useFeedback } from "./useFeedback";
import { Link } from "react-router";
import { appPageWidthClasses } from "../../shared/ui/pageLayout";
const context = { page: "feedback", game: "all" } as const;
export function FeedbackPage() {
  const account = useAccount();
  const feedback = useFeedback(context, Boolean(account.user));
  return (
    <div className="app-theme min-h-dvh bg-page text-ink">
      <AppHeader homeTo="/" homeLabel="ロビーへ">
        <AccountMenu />
      </AppHeader>
      <main className={`${appPageWidthClasses} py-8`}>
        <div className="mx-auto max-w-xl rounded-panel border border-line bg-white p-5 sm:p-8">
          <h1 className="mb-5 text-2xl font-bold">不具合・ご意見</h1>
          <FeedbackForm feedback={feedback} context={context} />
        </div>
        <p className="mt-5 text-center">
          <Link to="/" className="text-brand underline">
            ロビーへ戻る
          </Link>
        </p>
      </main>
    </div>
  );
}
