/**
 * Northern lights behind the main screens (web): a fixed layer of blurred radial gradients in CSS.
 * Only transform and opacity animate (GPU compositing, no repaint). prefers-reduced-motion: no animation.
 * The native build uses Aurora.tsx.
 */
const CSS = `
.mona-aurora{position:absolute;inset:0;overflow:hidden;pointer-events:none;z-index:0;contain:strict}
.mona-aurora>i{position:absolute;display:block;border-radius:50%;filter:blur(48px);will-change:transform,opacity;backface-visibility:hidden}
.mona-aurora>.a1{width:130%;aspect-ratio:1;left:-45%;top:-25%;background:radial-gradient(closest-side,rgba(131,110,249,.42),rgba(131,110,249,.16) 45%,rgba(131,110,249,0));animation:mona-a1 32s ease-in-out infinite alternate}
.mona-aurora>.a2{width:115%;aspect-ratio:1;left:25%;top:0;background:radial-gradient(closest-side,rgba(34,211,197,.26),rgba(34,211,197,.1) 45%,rgba(34,211,197,0));animation:mona-a2 26s ease-in-out infinite alternate}
.mona-aurora>.a3{width:100%;aspect-ratio:1;left:-15%;top:45%;background:radial-gradient(closest-side,rgba(52,232,158,.14),rgba(52,232,158,.05) 45%,rgba(52,232,158,0));animation:mona-a3 38s ease-in-out infinite alternate}
@keyframes mona-a1{0%{transform:translate3d(0,0,0) scale(1,1);opacity:.8}50%{transform:translate3d(14%,8%,0) scale(1.18,.9);opacity:1}100%{transform:translate3d(24%,14%,0) scale(1.05,1.12);opacity:.75}}
@keyframes mona-a2{0%{transform:translate3d(0,0,0) scale(1,1);opacity:.85}50%{transform:translate3d(-16%,12%,0) scale(.9,1.16);opacity:1}100%{transform:translate3d(-24%,20%,0) scale(1.1,.94);opacity:.8}}
@keyframes mona-a3{0%{transform:translate3d(0,0,0) scale(1,1);opacity:.7}50%{transform:translate3d(12%,-10%,0) scale(1.14,.9);opacity:1}100%{transform:translate3d(20%,-16%,0) scale(.95,1.1);opacity:.8}}
@media (prefers-reduced-motion: reduce){.mona-aurora>i{animation:none!important}}
`;

export function useReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Aurora() {
  return (
    <div className="mona-aurora" aria-hidden="true">
      <style>{CSS}</style>
      <i className="a1" />
      <i className="a2" />
      <i className="a3" />
    </div>
  );
}
