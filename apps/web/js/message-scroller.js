const EDGE = 72;

function viewportOf(root) {
  return root.querySelector('[data-slot="message-scroller-viewport"]');
}

function atLiveEdge(viewport) {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < EDGE;
}

export function mountMessageScroller(root) {
  if (!root) return;
  const viewport = viewportOf(root);
  const jump = root.querySelector('[data-slot="message-scroller-button"]');
  if (!viewport) return;

  const syncJump = () => {
    if (!jump) return;
    jump.hidden = atLiveEdge(viewport) || viewport.scrollHeight <= viewport.clientHeight + 8;
  };

  viewport.addEventListener("scroll", syncJump, { passive: true });
  jump?.addEventListener("click", () => {
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  });

  const anchor = [...viewport.querySelectorAll("[data-scroll-anchor]")].at(-1);
  if (anchor) {
    viewport.scrollTop = Math.max(0, anchor.offsetTop - 16);
  } else {
    viewport.scrollTop = viewport.scrollHeight;
  }
  syncJump();
}
