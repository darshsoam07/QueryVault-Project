import logo from "@/assets/queryvault-logo.png";
import { cn } from "@/lib/utils";

export function VaultMark({ className }: { className?: string }) {
  return (
    <img
      src={logo}
      alt="QueryVault"
      width={816}
      height={816}
      className={cn("h-7 w-7 shrink-0 object-contain", className)}
    />
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "text-foreground text-[15px] leading-none font-semibold tracking-tight",
        className,
      )}
    >
      Query<span className="text-primary">Vault</span>
    </span>
  );
}
