type DialogBackgroundElement = {
  inert: boolean;
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
};

export function isolateDialogBackground(
  elements: DialogBackgroundElement[],
): () => void {
  const originalStates = elements.map((element) => ({
    element,
    inert: element.inert,
    ariaHidden: element.getAttribute("aria-hidden"),
  }));
  let restored = false;

  for (const { element } of originalStates) {
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
  }

  return () => {
    if (restored) return;
    restored = true;
    for (const { element, inert, ariaHidden } of originalStates) {
      element.inert = inert;
      if (ariaHidden === null) element.removeAttribute("aria-hidden");
      else element.setAttribute("aria-hidden", ariaHidden);
    }
  };
}
