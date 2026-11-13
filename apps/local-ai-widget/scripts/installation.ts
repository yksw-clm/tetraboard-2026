import { createHash } from "node:crypto";

export function extensionIdForPath(path: string): string {
  return createHash("sha256")
    .update(path)
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (n) => String.fromCharCode(97 + Number.parseInt(n, 16)));
}

export function readLocalToken(contents: string): string {
  const token = /^AI_LOCAL_TOKEN=([a-f0-9]{64})\r?$/m.exec(contents)?.[1];
  if (!token)
    throw Error("AI_LOCAL_TOKENが不正です。setup:localで作成した.env.localを指定してください");
  return token;
}
