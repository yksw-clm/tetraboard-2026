import content from "virtual:public-rules/four-shogi";
import { PublicRulesContent } from "./PublicContent";
export function FourShogiRulesPage() {
  return <PublicRulesContent game="four-shogi" content={content} />;
}
