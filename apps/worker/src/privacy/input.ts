import { readLimitedBody } from "../feedback/images";
export async function privacyInput(request: Request) {
  const bytes = await readLimitedBody(request, 1024);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}
