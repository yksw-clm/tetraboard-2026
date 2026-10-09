import { gameThemes } from "../../shared/ui/appTheme";
import { defaultGameId, gameCatalog, type GameId } from "@tetraboard/protocol/games";
import { AppButton } from "../../shared/ui/AppButton";

import { AppDialog } from "../../shared/ui/AppDialog";
import { FourShogiRules } from "./FourShogiRules";

export function HowToPlayDialog({
  onClose,
  game = defaultGameId,
}: {
  onClose: () => void;
  game?: GameId;
}) {
  const shogi = game === "four-shogi";
  return (
    <AppDialog
      title={`${gameCatalog[game].name}の遊び方`}
      onClose={onClose}
      theme={gameThemes[game]}
    >
      <div className="flex flex-col gap-[22px] [&_h3]:mb-[6px] [&_h3]:text-[15px] [&_section_p]:text-help-copy [&_section_p]:text-[13px] [&_section_p]:leading-[1.9] [&_section_p+p]:mt-2">
        {shogi ? <FourShogiRules /> : game === "reversi" ? <ReversiRules /> : <FourReversiRules />}
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
          盤が埋まるか、対局を続けている全員が連続で自動パスすると終局します。持ち時間は、なし・1分・3分・5分・10分から、秒読みは、なし・10秒・30秒からルームごとに選べます。
          初期設定は1人5分＋1手30秒です。持ち時間なしでは最初から秒読みになり、秒読みなしでは持ち時間を使い切ると時間切れです。
          秒読みは毎手リセットされ、持ち越しません。両方なしにはできません。
          自動パスでは時間を消費しません。
        </p>
        <p>
          投了は自分の手番でできます。投了・退室・時間切れ・30秒以内に復帰しない通信切れで脱落すると、シングルスはその時点の最下位になり、残り1人で終局します。ダブルスは1人の脱落でそのチームの敗北になります。
        </p>
      </section>
    </>
  );
}

function ReversiRules() {
  return (
    <>
      <p>8×8の盤で黒と白の2人が対戦するリバーシです。</p>
      <section>
        <h3>まずは遊んでみよう</h3>
        <p>
          「すぐ遊ぶ」はCPU1人との待機室へ進みます。2席を人間とCPUで埋め、人間全員が準備完了になったらホストが「対局開始」を押します。友達とはルーム番号や招待リンクで合流できます。
        </p>
      </section>
      <section>
        <h3>相手の石を挟んで返そう</h3>
        <p>
          色は対局ごとにランダムで決まり、黒から交互に石を置きます。縦・横・斜めに相手の石を1枚以上挟む場所が合法手です。挟んだ石をすべて返します。相手の石を0枚にする手も置けます。合法手がない場合は時計を動かさず自動パスします。
        </p>
      </section>
      <section>
        <h3>勝敗と持ち時間</h3>
        <p>
          盤が埋まるか、双方が置けなくなったら終局します。石数が多い側の勝ち、同数は引き分けです。投了は自分の手番で行えます。投了・退室・時間切れ・30秒以内に復帰しない通信切れは敗北です。
        </p>
        <p>
          持ち時間はなし・1分・3分・5分・10分、秒読みはなし・10秒・30秒から選べます。初期値は5分＋30秒。持ち時間を使い切ると毎手の秒読みに入り、秒読みは持ち越しません。両方なしにはできません。
        </p>
      </section>
      <section>
        <h3>CPUと戦績</h3>
        <p>
          CPUはよわい・ふつうの2段階です。CPU戦も履歴・棋譜を保存しますが、戦績とランキングは対人戦だけを集計します。
        </p>
      </section>
    </>
  );
}
