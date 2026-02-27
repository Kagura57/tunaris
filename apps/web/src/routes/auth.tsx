import { FormEvent, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { HttpStatusError, signInWithEmail, signUpWithEmail } from "../lib/api";
import { useGameStore } from "../stores/gameStore";

type AuthMode = "signin" | "signup";

function authErrorMessage(error: unknown, mode: AuthMode) {
  if (error instanceof HttpStatusError) {
    if (error.message === "Invalid email or password" || error.status === 401) {
      return "Email ou mot de passe invalide.";
    }
    if (error.message === "User already exists" || error.message === "User already exists. Use another email") {
      return "Un compte existe déjà avec cet email.";
    }
    if (error.message === "Password too short") {
      return "Le mot de passe est trop court.";
    }
    if (error.message === "Email and password is not enabled") {
      return "La connexion email/mot de passe est désactivée côté serveur.";
    }
    return error.message;
  }

  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }

  return mode === "signin"
    ? "Connexion impossible pour le moment."
    : "Inscription impossible pour le moment.";
}

export function AuthPage() {
  const queryClient = useQueryClient();
  const account = useGameStore((state) => state.account);
  const setAccount = useGameStore((state) => state.setAccount);
  const [mode, setMode] = useState<AuthMode>("signin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const locationSearch = useRouterState({
    select: (state) => state.location.searchStr,
  });

  const redirectTarget = useMemo(() => {
    if (!locationSearch) return "/settings";
    const value = new URLSearchParams(locationSearch).get("returnTo");
    if (!value) return "/settings";
    return value.startsWith("/") ? value : "/settings";
  }, [locationSearch]);

  const authMutation = useMutation({
    mutationFn: async () => {
      if (mode === "signin") {
        return await signInWithEmail({
          email: email.trim(),
          password,
          rememberMe,
        });
      }

      return await signUpWithEmail({
        name: name.trim(),
        email: email.trim(),
        password,
        rememberMe,
      });
    },
    onSuccess: async (payload) => {
      setAccount({
        userId: payload.user.id,
        name: payload.user.name,
        email: payload.user.email,
      });
      await queryClient.invalidateQueries({ queryKey: ["auth-session"] });
      window.location.assign(redirectTarget);
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authMutation.isPending) return;
    if (email.trim().length <= 0 || password.trim().length <= 0) return;
    if (mode === "signup" && name.trim().length <= 0) return;
    authMutation.mutate();
  }

  return (
    <section className="single-panel">
      <article className="panel-card">
        <h2 className="panel-title">Compte Kwizik</h2>
        <p className="panel-copy">
          Connecte-toi pour lier ton compte AniList, synchroniser ta liste et gerer ton profil.
        </p>

        {account.userId ? (
          <div className="panel-form">
            <p className="status">Connecté en tant que {account.name ?? account.email ?? "Utilisateur"}.</p>
            <div className="waiting-actions">
              <Link className="solid-btn" to="/settings">
                Ouvrir mes paramètres
              </Link>
              <Link className="ghost-btn" to="/">
                Retour accueil
              </Link>
            </div>
          </div>
        ) : (
          <>
            <div className="source-preset-grid">
              <button
                type="button"
                className={`source-preset-btn${mode === "signin" ? " active" : ""}`}
                onClick={() => setMode("signin")}
              >
                <strong>Connexion</strong>
                <span>Accéder à ton compte existant</span>
              </button>
              <button
                type="button"
                className={`source-preset-btn${mode === "signup" ? " active" : ""}`}
                onClick={() => setMode("signup")}
              >
                <strong>Inscription</strong>
                <span>Créer un nouveau compte</span>
              </button>
            </div>

            <form className="panel-form" onSubmit={onSubmit}>
              {mode === "signup" && (
                <label>
                  <span>Nom</span>
                  <input
                    value={name}
                    onChange={(event) => setName(event.currentTarget.value)}
                    maxLength={60}
                    placeholder="Ton pseudo"
                  />
                </label>
              )}

              <label>
                <span>Email</span>
                <input
                  value={email}
                  onChange={(event) => setEmail(event.currentTarget.value)}
                  type="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </label>

              <label>
                <span>Mot de passe</span>
                <input
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  type="password"
                  autoComplete={mode === "signin" ? "current-password" : "new-password"}
                  placeholder="••••••••"
                />
              </label>

              {mode === "signin" && (
                <label className="remember-toggle">
                  <input
                    checked={rememberMe}
                    onChange={(event) => setRememberMe(event.currentTarget.checked)}
                    type="checkbox"
                  />
                  <span className="remember-toggle-ui" aria-hidden="true" />
                  <span>Rester connecté</span>
                </label>
              )}

              <button className="solid-btn" type="submit" disabled={authMutation.isPending}>
                {authMutation.isPending
                  ? mode === "signin"
                    ? "Connexion..."
                    : "Inscription..."
                  : mode === "signin"
                    ? "Se connecter"
                    : "Créer mon compte"}
              </button>
            </form>

            <p className={authMutation.isError ? "status error" : "status"}>
              {authMutation.isError ? authErrorMessage(authMutation.error, mode) : ""}
            </p>
          </>
        )}
      </article>
    </section>
  );
}
