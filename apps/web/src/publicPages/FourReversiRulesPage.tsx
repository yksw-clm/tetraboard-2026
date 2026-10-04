import content from "virtual:public-rules/four-reversi";
import { PublicRulesContent } from "./PublicContent";
export function FourReversiRulesPage() {
  return <PublicRulesContent game="four-reversi" content={content} />;
}
