// Every refresh / rotate icon button spins one turn when clicked. One delegated
// listener instead of per-button state, so a new refresh button (core or an
// extension's registry icon) gets it for free. Lucide stamps
// `lucide-refresh-cw`, `lucide-rotate-ccw`, ... on the svg.
const ICON = '[class*="lucide-refresh"], [class*="lucide-rotate"]';

export function installRefreshIconSpin(): void {
  document.addEventListener(
    "click",
    (e) => {
      const btn = (e.target as Element | null)?.closest?.('button, [role="button"]');
      const svg = btn?.querySelector<SVGElement>(ICON);
      if (!svg) return;
      // Restart the animation on a rapid second click.
      svg.classList.remove("tedi-spin-once");
      void svg.getBoundingClientRect();
      svg.classList.add("tedi-spin-once");
      svg.addEventListener("animationend", () => svg.classList.remove("tedi-spin-once"), {
        once: true,
      });
    },
    true,
  );
}
