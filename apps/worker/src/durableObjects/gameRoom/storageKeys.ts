export const chatKey = "chat";
export const mutedKey = "chat-muted";
export const viewerSecretKey = "viewer-secret";
export const disconnectedAtKey = (playerId: string) => `disconnected-at:${playerId}`;
export const lastChatAtKey = (playerId: string) => `last-chat-at:${playerId}`;
export const reconnectGraceMs = 30_000;
export const stampTag = "room-stamps-v1";
