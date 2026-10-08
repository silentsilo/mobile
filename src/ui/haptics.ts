import { api } from "../api";

/** Touch feedback; silent where the phone has none or turned it off. */
export function haptic(kind: "tick" | "confirm" | "reject" | "heavy") {
  api.haptic(kind).catch(() => undefined);
}
