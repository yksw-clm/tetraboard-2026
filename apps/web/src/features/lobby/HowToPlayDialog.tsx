import { AppButton } from "../../shared/ui/AppButton";

import { roomTimeControl } from "@tetraboard/protocol";
import { AppDialog } from "../../shared/ui/AppDialog";
import { FourShogiRules } from "./FourShogiRules";

export function HowToPlayDialog({
  onClose,
  game = "four-reversi",
}: {
  onClose: () => void;
  game?: "four-reversi" | "four-shogi";
}) {
  const shogi = game === "four-shogi";
  return (
    <AppDialog
      title={shogi ? "四人将棋の遊び方" : "四人リバーシの遊び方"}
      onClose={onClose}
      theme={shogi ? "four-shogi" : "default"}
    >
      <div className="flex flex-col gap-[22px] [&_h3]:mb-[6px] [&_h3]:text-[15px] [&_section_p]:text-help-copy [&_section_p]:text-[13px] [&_section_p]:leading-[1.9] [&_section_p+p]:mt-2">
        {shogi ? <FourShogiRules /> : <FourReversiRules />}
        <AppButton slot="close" className="w-full min-h-12">
          {shogi ? "わかった" : "わかった、遊んでみよう"}
        </AppButton>
      </div>
    </AppDialog>
  );
}

function FourReversiRules() {
  return (
    <>
      <p className="text-muted text-[13px] leading-[1.8]">
        8×8の盤で、黒・白・赤・青の4色が競うリバーシです。
      </p>
      <section>
        <h3>まずは遊んでみよう</h3>
        <p>
          「すぐ遊ぶ」なら、あなたとCPU3人で遊べます。ニックネームとモードを選び、待機室で「対局開始」を押してください。
          友達と遊ぶときはルームを作り、URLや5桁のルーム番号を共有します。4席を人間とCPUで埋め、人間全員が準備完了になったらホストが開始します。
        </p>
      </section>
      <section>
        <h3>他の色を挟んで、自分の色に</h3>
        <p>
          色は対局ごとにランダムで決まり、黒→白→赤→青の順に進みます。縦・横・斜めに他の色を1枚以上挟める場所へ石を置きます。
          間に複数の色が混ざっていても、まとめて自分の色に返せます。置ける場所は盤面に表示されます。
        </p>
      </section>
      <section>
        <h3>全滅させる手は禁止</h3>
        <p>
          自分以外の、まだ対局を続けている人の石を0枚にする手は置けません。ダブルスの味方も対象です。
          置ける場所がないときは自動でパスします。自分でパスを選ぶことはできません。
        </p>
      </section>
      <section>
        <h3>シングルスとダブルス</h3>
        <p>
          シングルスは4人それぞれで競い、最後の石数が多い順に順位が決まります。同じ石数なら同順位です。
          ダブルスは黒・赤と白・青のチーム戦。合計石数が多いチームが勝ち、同数なら引き分けです。味方の石も通常どおり返します。
        </p>
      </section>
      <section>
        <h3>対局の終わりと持ち時間</h3>
        <p>
          盤が埋まるか、対局を続けている全員が連続で自動パスすると終局します。持ち時間は1人
          {roomTimeControl.mainTimeMs / 60_000}分。その後は1手
          {roomTimeControl.byoyomiMs / 1000}秒の秒読みです。 自動パスでは時間を消費しません。
        </p>
        <p>
          投了は自分の手番でできます。投了・退室・時間切れ・30秒以内に復帰しない通信切れで脱落すると、シングルスはその時点の最下位になり、残り1人で終局します。ダブルスは1人の脱落でそのチームの敗北になります。
        </p>
      </section>
    </>
  );
}
