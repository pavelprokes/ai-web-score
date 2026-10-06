"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Navigation link that exposes the current page to assistive tech (aria-current). */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const current = href === "/" ? pathname === "/" || pathname.startsWith("/domains") : pathname.startsWith(href);
  return (
    <Link href={href} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}
