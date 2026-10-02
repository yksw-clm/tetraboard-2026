import { getMatchContract } from "@tetraboard/protocol";
import { redirect, type LoaderFunctionArgs } from "react-router";
export async function matchReplayLoader({ params, request }: LoaderFunctionArgs) {
  const parsed = getMatchContract.params.safeParse(params);
  if (!parsed.success) throw new Response(null, { status: 400 });
  let response: Response;
  try {
    response = await fetch(`/api${getMatchContract.pathFor(parsed.data.matchId)}`, {
      credentials: "include",
      signal: request.signal,
    });
  } catch (error) {
    if (request.signal.aborted) throw error;
    throw new Response(null, { status: 503 });
  }
  if (response.status === 401) throw redirect("/login");
  if (!response.ok) throw new Response(null, { status: response.status });
  try {
    return getMatchContract.response.parse(await response.json()).match;
  } catch (error) {
    if (request.signal.aborted) throw error;
    throw new Response(null, { status: 503 });
  }
}
