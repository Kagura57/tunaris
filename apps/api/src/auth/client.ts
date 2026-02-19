import { auth } from "./auth";

function readCookie(headers: unknown) {
  if (headers instanceof Headers) {
    return headers.get("cookie");
  }

  if (typeof headers === "object" && headers !== null) {
    const record = headers as Record<string, unknown>;
    const cookie = record.cookie;
    if (typeof cookie === "string") return cookie;
  }

  return null;
}

export type AuthSessionContext = {
  session: {
    id: string;
    userId: string;
    expiresAt: Date;
  };
  user: {
    id: string;
    name: string;
    email: string;
  };
};

export async function readSessionFromHeaders(headers: unknown): Promise<AuthSessionContext | null> {
  const cookieHeader = readCookie(headers);
  if (!cookieHeader) return null;

  // Better Auth reads session from request headers/cookies.
  const result = await auth.api.getSession({
    headers: new Headers({
      cookie: cookieHeader,
    }),
  });

  const typed = result as AuthSessionContext | null;
  if (!typed?.session || !typed?.user) return null;
  return typed;
}
