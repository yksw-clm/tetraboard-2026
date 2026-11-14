const started = new WeakSet<Window>();

function pageType(path: string): string {
  return path === "/"
    ? "general-lobby"
    : path.startsWith("/games/")
      ? "lobby"
      : path.startsWith("/rooms/")
        ? "room"
        : path.startsWith("/account/matches/") || path.startsWith("/matches/")
          ? "replay"
          : path === "/account/setup"
            ? "setup"
            : path === "/login"
              ? "login"
              : path === "/account"
                ? "account"
                : "other";
}

function sanitizeMessage(message: string): string {
  return message.replace(/(?:[a-z][a-z\d+.-]*:)?\/\/[^\s"'<>`]+/gi, (url) => url.split(/[?#]/)[0]!);
}

export function startClientErrors(target: Window = window): void {
  if (started.has(target)) return;
  started.add(target);
  const seen = new Set<string>();
  let sentAt: number[] = [];

  function send(kind: string, rawMessage: string) {
    try {
      if (rawMessage === "Script error.") return;
      const message = Array.from(sanitizeMessage(rawMessage)).slice(0, 200).join("");
      kind = Array.from(kind || "Error")
        .slice(0, 100)
        .join("");
      const key = JSON.stringify([kind, message]);
      if (seen.has(key)) return;
      const now = target.performance.now();
      sentAt = sentAt.filter((at) => now - at < 60000);
      if (sentAt.length >= 10) return;
      seen.add(key);
      sentAt.push(now);
      const body = JSON.stringify({ page: pageType(target.location.pathname), kind, message });
      if (typeof target.navigator.sendBeacon === "function") {
        target.navigator.sendBeacon(
          "/api/client-errors",
          new Blob([body], { type: "application/json" }),
        );
      } else {
        void target
          .fetch("/api/client-errors", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
            keepalive: true,
          })
          .catch(() => {});
      }
    } catch {
      // 計測の失敗を新たな未処理エラーにしません。
    }
  }

  target.addEventListener("error", (event) => {
    try {
      if (event.filename && new URL(event.filename).origin !== target.location.origin) return;
      send(typeof event.error?.name === "string" ? event.error.name : "Error", event.message);
    } catch {
      // 拡張機能や読み取れないエラーを記録しません。
    }
  });
  target.addEventListener("unhandledrejection", (event) => {
    try {
      const reason: unknown = event.reason;
      const message =
        typeof reason === "string" ? reason : reason instanceof Error ? reason.message : "";
      send("UnhandledRejection", message);
    } catch {
      // 拒否理由の取得に失敗しても、元のエラー処理を妨げません。
    }
  });
}

startClientErrors();
