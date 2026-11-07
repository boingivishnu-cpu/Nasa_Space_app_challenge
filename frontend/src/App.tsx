import {
  BookOpen,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  Compass,
  Home,
  LocateFixed,
  Orbit,
  Play,
  Route,
  Satellite,
  SlidersHorizontal,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import LayerPanel from "./LayerPanel";
import MarsMap from "./MapView";
import SpaceBackdrop from "./SpaceBackdrop";

type ApiLinkState = "checking" | "connected" | "disconnected";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8000";

const APP_NAVIGATION = [
  { label: "Explore", href: "#explore", icon: Home },
  { label: "Plan", href: "#marswalk-plan", icon: Route },
  { label: "Learn", href: "#learn", icon: BookOpen },
  { label: "Community", href: "#community", icon: UsersRound },
  { label: "AI Copilot", href: "#ai-copilot", icon: BrainCircuit },
];

const DEMO_STEPS = [
  {
    title: "01 / ORBITAL CONTEXT",
    duration: "0:35",
    instruction:
      "Start with the Jezero site map. Read the NASA Mars Trek attribution and inspect the live planetocentric coordinates and estimated local solar time.",
    action: "Move the cursor across the map, then continue.",
  },
  {
    title: "02 / TERRAIN SCREEN",
    duration: "0:35",
    instruction:
      "Open the layer controls. Compare MOLA-derived slope and the >25° screening overlay, keeping the ~463 m/cell resolution caveat in view.",
    action: "Enable Slope or Hazard zones; note that zero flagged cells is not proof of safety.",
  },
  {
    title: "03 / PLAN A MARSWALK",
    duration: "0:40",
    instruction:
      "Choose SET START and SET END, then click two traversable locations. Waypoints snap to MOLA cells and can be dragged to adjust.",
    action: "Set both waypoints on the 2D map.",
  },
  {
    title: "04 / COMPARE THE ROUTES",
    duration: "0:40",
    instruction:
      "Compare shortest, safest, and science-weighted alternatives. Select a route, scrub its elevation profile, and move over the route to link a map sample.",
    action: "Try a route card or the elevation-profile slider.",
  },
  {
    title: "05 / CHECK THE RESOURCES",
    duration: "0:30",
    instruction:
      "Enter hypothetical suit capacities, keep the return trip included, and run GO / NO-GO. These modeled rates and coarse terrain are not operational safety guidance.",
    action: "Review the model-only warning, then finish the tour.",
  },
];

function tiltSurface(event: ReactPointerEvent<HTMLElement>) {
  if (event.pointerType !== "mouse") return;
  const bounds = event.currentTarget.getBoundingClientRect();
  const x = (event.clientX - bounds.left) / bounds.width - 0.5;
  const y = (event.clientY - bounds.top) / bounds.height - 0.5;
  event.currentTarget.style.setProperty("--pointer-x", `${(x + 0.5) * 100}%`);
  event.currentTarget.style.setProperty("--pointer-y", `${(y + 0.5) * 100}%`);
  event.currentTarget.style.transform =
    `perspective(1200px) rotateX(${-y * 1.8}deg) rotateY(${x * 1.8}deg) translateY(-2px)`;
}

function resetTilt(event: ReactPointerEvent<HTMLElement>) {
  event.currentTarget.style.transform = "";
  event.currentTarget.style.setProperty("--pointer-x", "50%");
  event.currentTarget.style.setProperty("--pointer-y", "0%");
}

function App() {
  const [demoStep, setDemoStep] = useState<number | null>(null);
  const [apiLinkState, setApiLinkState] = useState<ApiLinkState>("checking");
  const [activeSection, setActiveSection] = useState("#explore");

  useEffect(() => {
    let active = true;
    const controller = new AbortController();

    async function checkApiLink() {
      try {
        const [healthResponse, siteResponse] = await Promise.all([
          fetch(`${API_BASE_URL}/health`, { signal: controller.signal }),
          fetch(`${API_BASE_URL}/site?site_id=jezero`, { signal: controller.signal }),
        ]);
        if (!healthResponse.ok || !siteResponse.ok) {
          throw new Error("API health or site check failed.");
        }
        const [health, site] = await Promise.all([
          healthResponse.json() as Promise<{ status?: unknown }>,
          siteResponse.json() as Promise<{ site?: { id?: unknown } }>,
        ]);
        if (health.status !== "ok" || site.site?.id !== "jezero") {
          throw new Error("API returned an unexpected health or site response.");
        }
        if (active) setApiLinkState("connected");
      } catch {
        if (active && !controller.signal.aborted) setApiLinkState("disconnected");
      }
    }

    void checkApiLink();
    const intervalId = window.setInterval(() => void checkApiLink(), 15_000);
    return () => {
      active = false;
      controller.abort();
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    function updateActiveSection() {
      setActiveSection(window.location.hash || "#explore");
    }
    window.addEventListener("hashchange", updateActiveSection);
    return () => window.removeEventListener("hashchange", updateActiveSection);
  }, []);

  return (
    <main className="shell">
      <SpaceBackdrop />
      <header className="topbar">
        <a className="brand" href="/" aria-label="MARSWAY home">
          <span className="brand-mark"><Orbit size={19} /></span>
          <span>MARS<span className="brand-accent">WAY</span></span>
        </a>
        <div className="mission-tag"><span className="live-dot" /> JEZERO FIELD NOTES</div>
        <button
          className="demo-tour-launch"
          type="button"
          onClick={() => setDemoStep(0)}
          aria-label="Start the three-minute guided MARSWAY demo"
        >
          <Play size={11} /> 3-MIN DEMO
        </button>
        <div
          className={`header-status api-link-status is-${apiLinkState}`}
          role="status"
          aria-live="polite"
          title={apiLinkState === "connected" ? "FastAPI health and Jezero site checks succeeded" : "FastAPI health/site endpoint status"}
        >
          <span className="status-dot" />
          {apiLinkState === "connected"
            ? "API + SITE ONLINE"
            : apiLinkState === "disconnected"
              ? "API DISCONNECTED"
              : "CHECKING API"}
        </div>
        <a className="icon-button" href="#map-layers" aria-label="Jump to map layer controls" title="Map layer controls">
          <SlidersHorizontal size={17} />
        </a>
      </header>

      <nav className="section-nav" aria-label="Mission sections">
        <span className="section-nav-label">MISSION SECTIONS</span>
        {APP_NAVIGATION.map(({ label, href, icon: Icon }, index) => (
          <a
            key={label}
            href={href}
            className={activeSection === href ? "is-current" : ""}
            aria-current={activeSection === href ? "page" : undefined}
            onClick={() => setActiveSection(href)}
          >
            <span className="section-nav-number">0{index + 1}</span>
            <Icon size={15} />
            <span>{label}</span>
          </a>
        ))}
      </nav>

      <div className="app-layout">
        <div className="app-main-column">
      <section className="map-heading" id="explore" onPointerMove={tiltSurface} onPointerLeave={resetTilt}>
        <div className="hero-copy">
          <div className="eyebrow"><span /> A MARS FIELD JOURNAL</div>
          <h1>Learn from <em>Past</em></h1>
          <p>Explore the evidence <span>·</span> PLAN A BETTER MARSWALK</p>
          <div className="hero-actions">
            <a href="#marswalk-plan" className="hero-primary-action"><Route size={15} /> PLAN A MARSWALK <ChevronRight size={14} /></a>
            <a href="#learn" className="hero-secondary-action"><Compass size={14} /> EXPLORE THE EVIDENCE</a>
          </div>
          <div className="hero-site-meta">
            <span><i /> ACTIVE FIELD SITE</span>
            <strong>LEARN FROM PAST</strong>
            <small>JEZERO CRATER · PERSEVERANCE LANDING AREA</small>
          </div>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <div className="hero-planet-ring hero-planet-ring-back" />
          <div className="hero-planet">
            <div className="hero-planet-texture" />
            <div className="hero-planet-glint" />
          </div>
          <div className="hero-planet-ring hero-planet-ring-front" />
          <span className="hero-orbit-label">MARS · 01</span>
          <span className="hero-coordinate-label">18.4° N / 77.5° E</span>
        </div>
      </section>

      {demoStep !== null && (
        <section className="demo-tour" aria-label="Guided three-minute demo" aria-live="polite">
          <div className="demo-tour-progress" aria-hidden="true">
            <span style={{ width: `${((demoStep + 1) / DEMO_STEPS.length) * 100}%` }} />
          </div>
          <div className="demo-tour-content">
            <div className="demo-tour-copy">
              <span className="demo-tour-kicker">GUIDED MISSION WALKTHROUGH <i>·</i> {DEMO_STEPS[demoStep].duration}</span>
              <h2>{DEMO_STEPS[demoStep].title}</h2>
              <p>{DEMO_STEPS[demoStep].instruction}</p>
              <small>{DEMO_STEPS[demoStep].action}</small>
            </div>
            <div className="demo-tour-actions">
              <span>STEP {demoStep + 1} / {DEMO_STEPS.length}</span>
              <div>
                <button
                  type="button"
                  aria-label="Previous demo step"
                  onClick={() => setDemoStep((current) => Math.max(0, (current ?? 1) - 1))}
                  disabled={demoStep === 0}
                >
                  <ChevronLeft size={14} /> BACK
                </button>
                <button
                  type="button"
                  aria-label={demoStep === DEMO_STEPS.length - 1 ? "Finish demo" : "Next demo step"}
                  onClick={() =>
                    setDemoStep((current) =>
                      current !== null && current < DEMO_STEPS.length - 1 ? current + 1 : null,
                    )
                  }
                >
                  {demoStep === DEMO_STEPS.length - 1 ? "FINISH" : "NEXT"} <ChevronRight size={14} />
                </button>
                <button
                  type="button"
                  className="demo-tour-close"
                  onClick={() => setDemoStep(null)}
                  aria-label="Close demo tour"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="section-intro planner-section-intro" aria-labelledby="planner-section-title">
        <div>
          <span className="section-kicker">02 / TERRAIN OPERATIONS</span>
          <h2 id="planner-section-title">Plan your Marswalk</h2>
          <p>Plot a route across Jezero. Compare terrain, risk, and resource needs.</p>
        </div>
        <span className="section-live-badge"><i /> LIVE SITE DATA</span>
      </section>

      <section className="planner-post" id="marswalk-plan" aria-label="Jezero Marswalk planner" onPointerMove={tiltSurface} onPointerLeave={resetTilt}>
        <div className="planner-post-header">
          <span className="planner-post-avatar"><Satellite size={15} /></span>
          <div className="planner-post-byline">
            <strong>LEARN FROM PAST</strong>
            <span>JEZERO CRATER · PERSEVERANCE LANDING AREA <i>·</i> LIVE PLANNER</span>
          </div>
          <a href="#learn" className="post-menu-link" aria-label="Read the terrain data notes">
            DATA NOTES <ChevronRight size={13} />
          </a>
        </div>
      <section className="map-workspace">
        <aside className="map-sidebar">
          <div className="sidebar-section">
            <div className="sidebar-kicker"><LocateFixed size={13} /> MISSION SITE</div>
            <strong className="sidebar-site">Learn from Past</strong>
            <span className="sidebar-description">Jezero Crater · Perseverance landing area</span>
            <div className="sidebar-stat-row">
              <span>MAP FOOTPRINT</span><b>~20 × 20 KM</b>
            </div>
            <div className="sidebar-stat-row">
              <span>COORDINATE SYSTEM</span><b>PLANETOCENTRIC</b>
            </div>
          </div>
          <div id="map-layers"><LayerPanel /></div>
          <div className="sidebar-section source-section">
            <span className="source-label">SOURCE</span>
            <a href="https://trek.nasa.gov/tiles/apidoc/trekAPI.html?body=mars" target="_blank" rel="noreferrer">NASA Mars Trek WMTS ↗</a>
            <span className="source-subtext">Map tiles verified near Jezero · max native zoom 7</span>
          </div>
        </aside>

        <div className="map-column">
          <MarsMap />
          <div className="map-footer">
            <span><i className="footer-live-dot" /> MOLA TERRAIN SCREEN</span>
            <span>DRAG TO PAN / ORBIT <i>·</i> SCROLL TO ZOOM</span>
            <span>3D TILT <b>AVAILABLE IN GLOBE MODE</b></span>
          </div>
        </div>
      </section>
        <div className="planner-post-footer">
          <span><i className="post-live-indicator" /> INTERACTIVE TERRAIN SESSION</span>
          <span>NASA MARS TREK <i>·</i> MGS MOLA <i>·</i> PDS</span>
        </div>
      </section>

      <section className="field-feed" id="learn" aria-labelledby="field-feed-title">
        <div className="field-feed-header">
          <div>
            <span className="field-feed-eyebrow"><Compass size={13} /> 03 / MISSION INTELLIGENCE</span>
            <h2 id="field-feed-title">Evidence worth exploring</h2>
            <p>Field notes built from connected datasets—not invented mission posts.</p>
          </div>
          <a className="feed-refresh" href="#explore" aria-label="Return to the Jezero map">
            BACK TO MAP <ChevronRight size={13} />
          </a>
        </div>
        <div className="field-feed-grid">
          <article className="feed-card feed-card-terrain" onPointerMove={tiltSurface} onPointerLeave={resetTilt}>
            <div className="feed-card-topline">
              <span className="feed-source-mark"><Satellite size={13} /></span>
              <span>ORBITAL TERRAIN NOTE <i>·</i> MGS MOLA</span>
              <span className="feed-verified">SOURCE LINKED</span>
            </div>
            <h3>A regional view, not a boot-level view.</h3>
            <p>
              The connected elevation product samples Jezero at roughly 463 m per
              cell. It reveals broad terrain patterns, but not small rocks, sand
              traps, or astronaut-scale hazards.
            </p>
            <div className="feed-card-stat"><strong>~463 m</strong><span>GRID SPACING · COARSE SCREEN</span></div>
            <div className="feed-card-actions">
              <a href="#map-layers"><SlidersHorizontal size={13} /> Inspect layers</a>
              <a href="https://pds-geosciences.wustl.edu/mgs/urn-nasa-pds-mgs_mola_topography_derived/meg128/megt44n000hb.lbl" target="_blank" rel="noreferrer">PDS SOURCE ↗</a>
            </div>
          </article>
          <article className="feed-card feed-card-route" onPointerMove={tiltSurface} onPointerLeave={resetTilt}>
            <div className="feed-card-topline">
              <span className="feed-source-mark"><Route size={13} /></span>
              <span>WALK PLANNING <i>·</i> THREE OBJECTIVES</span>
              <span className="feed-model-tag">MODEL</span>
            </div>
            <h3>One destination. Three ways to get there.</h3>
            <p>
              Compare the shortest, safest-weighted, and science-weighted routes.
              Science rewards only explicitly supplied points; verified Jezero
              stops are not connected yet.
            </p>
            <div className="feed-route-chips">
              <span>01 <b>SHORTEST</b></span>
              <span>02 <b>SAFEST</b></span>
              <span>03 <b>SCIENCE</b></span>
            </div>
            <div className="feed-card-actions">
              <a href="#marswalk-plan"><Route size={13} /> Set waypoints</a>
              <span>NO VERIFIED POIs LOADED</span>
            </div>
          </article>
          <article className="feed-card feed-card-community" id="community" onPointerMove={tiltSurface} onPointerLeave={resetTilt}>
            <div className="feed-card-topline">
              <span className="feed-source-mark"><UsersRound size={13} /></span>
              <span>COMMUNITY FIELD NOTES</span>
              <span className="feed-empty-tag">QUIET CHANNEL</span>
            </div>
            <h3>No explorer reports yet.</h3>
            <p>
              Community posts are not connected. This feed stays empty until
              verified submissions and attribution are available—there are no
              sample or synthetic posts.
            </p>
            <div className="community-empty-state">
              <Orbit size={18} />
              <span>WAITING FOR VERIFIED CONTRIBUTIONS</span>
            </div>
            <div className="feed-card-actions">
              <span>COMMUNITY POSTS · NOT ENABLED</span>
            </div>
          </article>
        </div>
      </section>

      <footer className="footer">
        <span>MARSWAY <span className="footer-divider">—</span> LEARN FROM PAST</span>
        <span>JEZERO <i>·</i> EVIDENCE BEFORE ASSUMPTION</span>
      </footer>
        </div>

      </div>

      <nav className="app-bottom-nav" aria-label="App navigation">
        {APP_NAVIGATION.map(({ label, href, icon: Icon }) => (
          <a
            key={label}
            href={href}
            className={activeSection === href ? "is-current" : ""}
            aria-current={activeSection === href ? "page" : undefined}
            onClick={() => setActiveSection(href)}
          >
            <Icon size={17} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
    </main>
  );
}

export default App;
