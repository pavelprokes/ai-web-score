"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navigation link that exposes the current page to assistive tech (aria-current).
 *
 * Links in this admin never prefetch (`prefetch={false}` on every <Link>): every page is dynamic, and Next
 * prefetched each visible link twice on load — 14 full renders behind the domains list, all competing for the
 * same few database connections, so the page the admin actually clicked waited for them.
 */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const current = href === "/" ? pathname === "/" || pathname.startsWith("/domains") : pathname.startsWith(href);
  return (
    <Link prefetch={false} href={href} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}
