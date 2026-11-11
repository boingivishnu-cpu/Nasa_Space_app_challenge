import { useEffect, useRef } from "react";

type Star = {
  x: number;
  y: number;
  depth: number;
  radius: number;
  alpha: number;
};

function createStars(width: number, height: number): Star[] {
  const count = Math.min(240, Math.max(100, Math.round((width * height) / 6500)));
  return Array.from({ length: count }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    depth: 0.2 + Math.random() * 0.8,
    radius: 0.35 + Math.random() * 1.15,
    alpha: 0.25 + Math.random() * 0.65,
  }));
}

export default function SpaceBackdrop() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const mountedCanvas = canvasRef.current;
    if (mountedCanvas === null) return;
    const mountedContext = mountedCanvas.getContext("2d");
    if (mountedContext === null) return;
    const canvas: HTMLCanvasElement = mountedCanvas;
    const context: CanvasRenderingContext2D = mountedContext;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let stars: Star[] = [];
    let frameId = 0;
    let parallaxFrameId = 0;
    let pointerX = 0;
    let pointerY = 0;
    let width = 0;
    let height = 0;
    let lastTime = 0;

    function resize() {
      width = window.innerWidth;
      height = window.innerHeight;
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      stars = createStars(width, height);
      draw(0, true);
    }

    function draw(time: number, staticFrame = false) {
      context.clearRect(0, 0, width, height);
      const elapsed = lastTime ? Math.min(time - lastTime, 40) : 0;
      lastTime = time;

      for (const star of stars) {
        if (!staticFrame && !reducedMotion.matches) {
          star.y += elapsed * star.depth * 0.003;
          if (star.y > height + 2) {
            star.y = -2;
            star.x = Math.random() * width;
          }
        }
        const x = star.x + (width * 0.5 - star.x) * star.depth * 0.012;
        context.beginPath();
        context.arc(x, star.y, star.radius * star.depth, 0, Math.PI * 2);
        context.fillStyle = `rgba(211, 224, 240, ${star.alpha})`;
        context.fill();
      }

      if (!staticFrame && !reducedMotion.matches && !document.hidden) {
        frameId = window.requestAnimationFrame(draw);
      }
    }

    function onPointerMove(event: PointerEvent) {
      if (event.pointerType === "touch" || reducedMotion.matches) return;
      pointerX = (event.clientX / window.innerWidth - 0.5) * 12;
      pointerY = (event.clientY / window.innerHeight - 0.5) * 12;
      if (parallaxFrameId) return;
      parallaxFrameId = window.requestAnimationFrame(() => {
        document.documentElement.style.setProperty("--parallax-x", `${pointerX}px`);
        document.documentElement.style.setProperty("--parallax-y", `${pointerY}px`);
        document.documentElement.style.setProperty("--parallax-inverse-x", `${-pointerX}px`);
        document.documentElement.style.setProperty("--parallax-inverse-y", `${-pointerY}px`);
        parallaxFrameId = 0;
      });
    }

    function onVisibilityChange() {
      window.cancelAnimationFrame(frameId);
      if (document.hidden || reducedMotion.matches) {
        draw(0, true);
      } else {
        lastTime = 0;
        frameId = window.requestAnimationFrame(draw);
      }
    }

    function onMotionPreferenceChange() {
      onVisibilityChange();
    }

    resize();
    if (!reducedMotion.matches) frameId = window.requestAnimationFrame(draw);
    window.addEventListener("resize", resize);
    window.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedMotion.addEventListener("change", onMotionPreferenceChange);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.cancelAnimationFrame(parallaxFrameId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      reducedMotion.removeEventListener("change", onMotionPreferenceChange);
      document.documentElement.style.removeProperty("--parallax-x");
      document.documentElement.style.removeProperty("--parallax-y");
      document.documentElement.style.removeProperty("--parallax-inverse-x");
      document.documentElement.style.removeProperty("--parallax-inverse-y");
    };
  }, []);

  return (
    <div className="space-backdrop" aria-hidden="true">
      <canvas ref={canvasRef} className="space-starfield" />
      <div className="space-nebula" />
      <div className="space-orbit space-orbit-one" />
      <div className="space-orbit space-orbit-two" />
    </div>
  );
}
