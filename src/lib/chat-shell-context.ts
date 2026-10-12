import { createContext, useContext } from "react";

export type ChatShellContextValue = {
  userId: string;
  selectedDocs: string[];
};

export const ChatShellContext = createContext<ChatShellContextValue | null>(null);

export function useChatShell(): ChatShellContextValue {
  const context = useContext(ChatShellContext);
  if (!context) {
    throw new Error("useChatShell must be used inside the chat workspace shell.");
  }
  return context;
}
