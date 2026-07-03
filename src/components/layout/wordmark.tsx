import Link from "next/link";

export function Wordmark() {
  return (
    <Link href="/" className="flex items-center gap-2 select-none">
      <span className="text-accent font-bold text-base tracking-tight">
        BITSHURIKEN
      </span>
    </Link>
  );
}
