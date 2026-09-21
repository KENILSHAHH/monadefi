import { useQuery } from "@tanstack/react-query";
import { api } from "./api/client";

export const keys = {
  balance: ["balance"] as const,
  positions: ["positions"] as const,
  session: ["session"] as const,
  markets: ["markets"] as const,
  book: (s: string) => ["book", s] as const,
  candles: (s: string) => ["candles", s] as const,
  activity: ["activity"] as const,
  depositAssets: ["deposit-assets"] as const,
  deposits: ["deposits"] as const,
};

export const useBalance = (poll?: number) => useQuery({ queryKey: keys.balance, queryFn: api.balance, refetchInterval: poll ?? 20_000 });
export const usePositions = () => useQuery({ queryKey: keys.positions, queryFn: api.positions, refetchInterval: 15_000 });
export const useSessionStatus = () => useQuery({ queryKey: keys.session, queryFn: api.session.status });
export const useMarkets = () => useQuery({ queryKey: keys.markets, queryFn: api.markets.list, refetchInterval: 10_000 });
export const useBook = (symbol: string) => useQuery({ queryKey: keys.book(symbol), queryFn: () => api.markets.book(symbol, 10), refetchInterval: 4_000 });
export const useCandles = (symbol: string) => useQuery({ queryKey: keys.candles(symbol), queryFn: () => api.markets.candles(symbol, 3600, 24), refetchInterval: 60_000 });
export const useActivity = () => useQuery({ queryKey: keys.activity, queryFn: api.activity, refetchInterval: 30_000 });
