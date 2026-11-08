import { createBackground } from "./backgroundService";
const handle = createBackground(chrome);
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  void handle(message, sender).then(reply, (error) =>
    reply({
      ok: false,
      error: error instanceof Error ? error.message : "ローカルAIへ接続できません",
    }),
  );
  return true;
});
chrome.action.onClicked.addListener(() => {
  void chrome.runtime.openOptionsPage();
});
