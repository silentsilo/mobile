/** iPhone and iPad get their own patterns (a "+" in the bar, check marks,
 * Face ID); everything else gets Android's. */
export const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent);
