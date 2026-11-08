await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const input = document.querySelector<HTMLInputElement>("#token")!;
const status = document.querySelector<HTMLElement>('[role="status"]')!;
const saved = await chrome.storage.local.get("token");
input.value = typeof saved.token === "string" ? saved.token : "";
document.querySelector("form")!.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const token = input.value.trim();
    if (!/^[\x21-\x7e]{32,256}$/.test(token)) {
      status.textContent = "tokenは32〜256文字のASCII文字にしてください";
      return;
    }
    await chrome.storage.local.set({ token });
    status.textContent = "保存しました";
  })().catch(() => {
    status.textContent = "保存できませんでした";
  });
});
export {};
