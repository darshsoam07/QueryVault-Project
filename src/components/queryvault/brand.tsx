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
        "font-semibold tracking-tight text-foreground text-[15px] leading-none",
        className,
      )}
    >
      Query<span className="text-[#9aaeb8]">Vault</span>
    </span>
  );
}
