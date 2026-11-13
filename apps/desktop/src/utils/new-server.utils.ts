import { getEffectiveAuth } from "./auth.utils";

export const NEW_SERVER_URL: string =
  import.meta.env.VITE_NEW_SERVER_URL ?? "https://api.voquill.com";

export async function getNewServerAuthHeaders(
  forceRefresh = false,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const auth = getEffectiveAuth();
  const user = auth.currentUser;
  if (!user) {
    throw new Error("Not authenticated");
  }
  const idToken = await user.getIdToken(forceRefresh);
  if (idToken) {
    headers["Authorization"] = `Bearer ${idToken}`;
  }

  return headers;
}
