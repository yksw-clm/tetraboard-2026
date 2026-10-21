import { useCallback, useEffect, useRef, useState } from "react";

import {
  lobbyOperationResultSchema,
  lobbyChatSchema,
  lobbyPostResultSchema,
  tournamentChatSchema,
  type LobbyChat,
} from "@tetraboard/protocol/general-lobby";
import { lobbyRequest } from "./generalLobbyApi";
import { createUuid } from "../../shared/createUuid";
const empty: LobbyChat = {
  messages: [],
  nextCursor: null,
  acceptingPosts: true,
  postingStopped: false,
  availableAtMs: 0,
  serverTimeMs: 0,
};
export function useLobbyChat(identity: string | null, tournamentId?: number) {
  const path = tournamentId === undefined ? "/lobby/chat" : `/tournaments/${tournamentId}/chat`;
  const [state, setState] = useState({
    ...empty,
    entered: false,
    closesAtMs: null as number | null,
    ready: false,
    loading: true,
    error: null as string | null,
    sending: false,
    reporting: false,
  });
  const request = useRef<AbortController | null>(null),
    limit = useRef(50),
    known = useRef(new Set<string>()),
    retry = useRef<{ id: string; text: string; identity: string | null } | null>(null),
    sending = useRef(false),
    reporting = useRef(false),
    generation = useRef(0);
  const refresh = useCallback(
    async (more = false) => {
      if (request.current) return;
      const controller = new AbortController();
      request.current = controller;
      try {
        let count = more ? Math.min(500, limit.current + 50) : limit.current;
        let page = await lobbyRequest(
          `${path}?limit=${count}`,
          tournamentId === undefined ? lobbyChatSchema : tournamentChatSchema,
          controller.signal,
        );
        const additions = page.messages.filter((m) => !known.current.has(m.id)).length;
        if (known.current.size && additions && !more && count < 500) {
          count = Math.min(500, count + additions);
          page = await lobbyRequest(
            `${path}?limit=${count}`,
            tournamentId === undefined ? lobbyChatSchema : tournamentChatSchema,
            controller.signal,
          );
        }
        if (controller.signal.aborted) return;
        known.current = new Set(page.messages.map((m) => m.id));
        limit.current = count;
        setState((s) => ({ ...s, ...page, ready: true, loading: false, error: null }));
      } catch (error) {
        if (!controller.signal.aborted)
          setState((s) => ({
            ...s,
            loading: false,
            error: error instanceof Error ? error.message : "チャットを取得できませんでした。",
          }));
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [path, tournamentId],
  );
  useEffect(() => {
    generation.current++;
    sending.current = false;
    reporting.current = false;
    known.current = new Set();
    limit.current = 50;
    retry.current = null;
    const timer = setTimeout(() => {
      setState({
        ...empty,
        entered: false,
        closesAtMs: null,
        ready: false,
        loading: true,
        error: null,
        sending: false,
        reporting: false,
      });
      void refresh();
    }, 0);
    const abortRequest = () => {
      request.current?.abort();
      request.current = null;
    };
    const visible = () => {
      if (document.visibilityState === "visible") void refresh();
      else abortRequest();
    };
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 5000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      generation.current++;
      clearTimeout(timer);
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
      abortRequest();
    };
  }, [identity, refresh]);
  async function send(text: string) {
    const current = generation.current;
    if (sending.current) return false;
    sending.current = true;
    setState((s) => ({ ...s, sending: true, error: null }));
    const operation =
      retry.current?.text === text && retry.current.identity === identity
        ? retry.current
        : { id: createUuid(), text, identity };
    retry.current = operation;
    try {
      const result = await lobbyRequest(path, lobbyPostResultSchema, undefined, {
        requestId: operation.id,
        text,
      });
      if (current !== generation.current) return false;
      retry.current = null;
      setState((s) => ({ ...s, availableAtMs: result.availableAtMs }));
      await refresh();
      return true;
    } catch (error) {
      if (current !== generation.current) return false;
      setState((s) => ({
        ...s,
        error: error instanceof Error ? error.message : "投稿できませんでした。",
      }));
      return false;
    } finally {
      if (current === generation.current) {
        sending.current = false;
        setState((s) => ({ ...s, sending: false }));
      }
    }
  }
  async function report(id: string) {
    const current = generation.current;
    if (reporting.current) return false;
    reporting.current = true;
    setState((s) => ({ ...s, reporting: true }));
    try {
      await lobbyRequest(`${path}/reports`, lobbyOperationResultSchema, undefined, {
        messageId: id,
      });
      return current === generation.current;
    } catch (error) {
      if (current !== generation.current) return false;
      setState((s) => ({
        ...s,
        error: error instanceof Error ? error.message : "通報できませんでした。",
      }));
      return false;
    } finally {
      if (current === generation.current) {
        reporting.current = false;
        setState((s) => ({ ...s, reporting: false }));
      }
    }
  }
  return { ...state, refresh: () => refresh(), loadMore: () => refresh(true), send, report };
}
