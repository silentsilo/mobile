import { useEffect, useState } from "react";

/** Wide enough for a list and its detail side by side: a tablet, an unfolded
 * phone, a phone on its side. Follows the window as it changes, so opening a
 * foldable switches the layout without restarting anything. */
const WIDE = "(min-width: 840px)";

export function useWide(): boolean {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const query = window.matchMedia(WIDE);
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return wide;
}
