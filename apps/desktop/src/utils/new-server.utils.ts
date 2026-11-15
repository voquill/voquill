import { getEffectiveAuth } from "./auth.utils";

export const NEW_SERVER_URL: string =
  import.meta.env.VITE_NEW_SERVER_URL ?? "https://api.voquill.com";

export const getNewServerWebSocketUrl = (path: string): string =>
  NEW_SERVER_URL.replace(/^http/, "ws") + path;

export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

export async function getNewServerIdToken(): Promise<string> {
  const user = getEffectiveAuth().currentUser;
  if (!user) {
    throw new NotAuthenticatedError();
  }
  return await user.getIdToken();
}

/**
 * The signed-in Firebase user's uid with request headers carrying that same
 * user's token, read together so a caller can check whose token it is.
 * Null when nobody is signed in.
 */
export async function getNewServerAuth(
  forceRefresh = false,
): Promise<{ uid: string; headers: Record<string, string> } | null> {
  const user = getEffectiveAuth().currentUser;
  if (!user) {
    return null;
  }
  const idToken = await user.getIdToken(forceRefresh);
  return {
    uid: user.uid,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${idToken}`,
    },
  };
}
