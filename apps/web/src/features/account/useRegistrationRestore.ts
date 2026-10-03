import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { registrationReturnFromState } from "./registrationReturn";

export function useRegistrationRestore() {
  const location = useLocation();
  const navigate = useNavigate();
  const path = location.pathname + location.search;
  const [restored] = useState(() => registrationReturnFromState(location.state, path));
  useEffect(() => {
    if (restored && registrationReturnFromState(location.state, path)) {
      // 初回描画で入力を取り込み、履歴からは復元情報を除く。戻る／進むで再適用しない。
      void navigate(path, { replace: true, state: null });
    }
  }, [restored, location.state, path, navigate]);
  return restored;
}
