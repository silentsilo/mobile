import { common } from "./common";
import { start } from "./start";
import { errors } from "./errors";
import { silo } from "./silo";
import { files } from "./files";
import { passwords } from "./passwords";

/** Every screen's texts. A new screen file is added here. */
export const SCREENS = [
  common,
  start,
  errors,
  silo,
  files,
  passwords,
] as const;
