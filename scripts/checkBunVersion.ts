const config = Bun.TOML.parse(await Bun.file(new URL("../mise.toml", import.meta.url)).text()) as {
  tools: { bun: string };
};

// 旧Bunではcheckスクリプトが再帰実行されるため、内蔵チェッカーの呼出し前に止めます。
if (!Bun.semver.satisfies(Bun.version, `>=${config.tools.bun}`)) {
  console.error(
    `型チェックにはBun ${config.tools.bun}以上が必要です（実行中: ${Bun.version}）。mise exec -- bun run typecheckで実行してください。`,
  );
  process.exit(1);
}
