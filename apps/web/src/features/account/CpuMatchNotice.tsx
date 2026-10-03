export function CpuMatchNotice() {
  return (
    <div className="text-sm leading-relaxed">
      <p className="font-semibold">CPUを含んだ対局は、戦績に反映されません。</p>
      <p className="mt-1 text-xs text-muted">
        ランキングにも反映されません。終局した対局の履歴・棋譜は保存されます。
      </p>
    </div>
  );
}
