import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

export type LiveRoundState = {
  phase: "waiting" | "countdown" | "playing" | "reveal" | "leaderboard" | "results";
  mode: "mcq" | "text" | null;
  round: number;
  totalRounds: number;
  deadlineMs: number | null;
  previewUrl: string | null;
  media: {
    provider: "spotify" | "deezer" | "apple-music" | "tidal" | "youtube";
    trackId: string;
    sourceUrl: string | null;
    embedUrl: string | null;
  } | null;
  choices: string[] | null;
  reveal: {
    trackId: string;
    provider: "spotify" | "deezer" | "apple-music" | "tidal" | "youtube";
    title: string;
    artist: string;
    acceptedAnswer: string;
    previewUrl: string | null;
    sourceUrl: string | null;
    embedUrl: string | null;
  } | null;
  leaderboard: Array<{
    rank: number;
    playerId: string;
    displayName: string;
    score: number;
    maxStreak: number;
  }> | null;
};

type AccountState = {
  userId: string | null;
  name: string | null;
  email: string | null;
};

type GameSession = {
  roomCode: string | null;
  playerId: string | null;
  displayName: string;
  categoryQuery: string;
};

type GameState = {
  isMuted: boolean;
  account: AccountState;
  session: GameSession;
  liveRound: LiveRoundState | null;
  setMuted: (value: boolean) => void;
  setAccount: (value: Partial<AccountState>) => void;
  clearAccount: () => void;
  setSession: (value: Partial<GameSession>) => void;
  clearSession: () => void;
  setLiveRound: (value: LiveRoundState | null) => void;
};

const DEFAULT_SESSION: GameSession = {
  roomCode: null,
  playerId: null,
  displayName: "",
  categoryQuery: "",
};

const DEFAULT_ACCOUNT: AccountState = {
  userId: null,
  name: null,
  email: null,
};

export const createGameStore = () =>
  createStore<GameState>((set) => ({
    isMuted: false,
    account: DEFAULT_ACCOUNT,
    session: DEFAULT_SESSION,
    liveRound: null,
    setMuted: (value) => set({ isMuted: value }),
    setAccount: (value) =>
      set((state) => ({
        account: { ...state.account, ...value },
      })),
    clearAccount: () => set({ account: DEFAULT_ACCOUNT }),
    setSession: (value) =>
      set((state) => ({
        session: { ...state.session, ...value },
      })),
    clearSession: () => set({ session: DEFAULT_SESSION, liveRound: null }),
    setLiveRound: (value) => set({ liveRound: value }),
  }));

export const gameStore = createGameStore();

export function useGameStore<T>(selector: (state: GameState) => T) {
  return useStore(gameStore, selector);
}
