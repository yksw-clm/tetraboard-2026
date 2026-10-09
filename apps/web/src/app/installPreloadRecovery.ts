import { preloadRecovery } from "../shared/preloadRecovery";

// 初回の遅延ルートを読み込む前に、Viteの失敗通知を受け取ります。
preloadRecovery.listen(window);
