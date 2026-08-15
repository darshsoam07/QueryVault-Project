import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";

export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: api.health,
    refetchInterval: 15_000,
  });
}

export function useStats() {
  return useQuery({ queryKey: ["stats"], queryFn: api.stats, refetchInterval: 10_000 });
}

export function useDocuments() {
  return useQuery({
    queryKey: ["documents"],
    queryFn: api.listDocuments,
    refetchInterval: (query) => {
      const data = query.state.data;
      const busy = data?.some((doc) => doc.status !== "ready" && doc.status !== "error");
      return busy ? 1200 : false;
    },
  });
}
