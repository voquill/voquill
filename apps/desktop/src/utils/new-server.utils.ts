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

export async function getNewServerAuthHeaders(): Promise<
  Record<string, string>
> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const idToken = await getNewServerIdToken();
  if (idToken) {
    headers["Authorization"] = `Bearer ${idToken}`;
  }

  return headers;
}
