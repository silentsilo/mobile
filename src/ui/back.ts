import { useEffect, useRef } from "react";

/*
 * Android's back gesture goes through the web view's history: Tauri goes
 * back while the page has history and leaves the app when it has none. So
 * each open layer (a detail screen, a sheet, a folder below the top one)
 * holds one history entry, and going back closes the newest layer. iOS swipe
 * back can use the same entries.
 */

type Layer = { close: () => void };

const layers: Layer[] = [];
// How many of our entries the history holds below the current one, read
// back from each entry's state.
let depth = 0;
// The depth our own history.go is on its way to.
let going: number | null = null;
let scheduled = false;

const depthOf = (state: unknown) => (state as { layer?: number } | null)?.layer ?? 0;

// Makes the history hold exactly one entry per open layer.
function reconcile() {
  scheduled = false;
  if (going !== null) return;
  const want = layers.length;
  while (depth < want) {
    depth += 1;
    history.pushState({ layer: depth }, "");
  }
  if (depth > want) {
    going = want;
    history.go(want - depth);
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  window.setTimeout(reconcile, 0);
}

window.addEventListener("popstate", (event) => {
  depth = depthOf(event.state);
  if (going !== null && depth === going) {
    going = null;
    schedule();
    return;
  }
  going = null;
  layers[layers.length - 1]?.close();
  // A layer still open afterwards (one folder up, a sheet that must stay) gets its entry back.
  schedule();
});

/** While `open`, the system back closes this layer by calling `onBack`. */
export function useBackLayer(open: boolean, onBack: () => void) {
  const latest = useRef(onBack);
  useEffect(() => {
    latest.current = onBack;
  });
  useEffect(() => {
    if (!open) return;
    const layer: Layer = { close: () => latest.current() };
    layers.push(layer);
    schedule();
    return () => {
      const at = layers.indexOf(layer);
      if (at >= 0) layers.splice(at, 1);
      schedule();
    };
  }, [open]);
}
