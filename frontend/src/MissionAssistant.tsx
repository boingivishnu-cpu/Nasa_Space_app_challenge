import { useEffect, useState, type FormEvent } from "react";
import {
  BrainCircuit,
  Check,
  Cpu,
  RotateCcw,
  Route,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";

export type AssistantRouteMode = "shortest" | "safest" | "science";

export interface AssistantRoute {
  mode: AssistantRouteMode;
  distanceM: number;
  steepestSlopeDeg: number;
  sciencePointsUsed: number;
  note: string;
  walkingTimeSeconds: number;
  oxygenLiters: number;
  powerWh: number;
  waterLiters: number;
}

interface AssistantProps {
  routes: AssistantRoute[];
  selectedRoute: AssistantRouteMode;
  onSelectRoute: (mode: AssistantRouteMode) => void;
  missionCheck: {
    verdict: "GO" | "NO-GO";
    reason: string;
    limitingResource: string | null;
    returnTripIncluded: boolean;
  } | null;
  hazard: {
    blockedCells: number;
    totalCells: number;
    slopeLimitDeg: number;
  } | null;
}

interface AssistantTurn {
  question: string;
  answer: string;
  kind: "gemini" | "command";
}

interface GeminiStatus {
  configured: boolean;
  model: string;
}

type ProviderState = "checking" | "ready" | "setup_required" | "offline";

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ??
  (import.meta.env.PROD ? "/api" : "http://localhost:8000");
const ROUTE_LABELS: Record<AssistantRouteMode, string> = {
  shortest: "shortest",
  safest: "safest",
  science: "science-weighted",
};

function routeCommand(text: string): AssistantRouteMode | null {
  if (!/^\s*(find|show|select|switch|set|use|plot|choose|give me)\b/i.test(text)) {
    return null;
  }
  if (/\b(shortest|quickest|fastest)\b/i.test(text)) return "shortest";
  if (/\b(safest|safety-first)\b/i.test(text)) return "safest";
  if (/\b(science|scientific)\b/i.test(text)) return "science";
  return null;
}

function buildContext(
  routes: AssistantRoute[],
  selectedRoute: AssistantRouteMode,
  hazard: AssistantProps["hazard"],
  missionCheck: AssistantProps["missionCheck"],
): string {
  const selected = routes.find((route) => route.mode === selectedRoute);
  const routeFacts = routes.length
    ? routes
        .map(
          (route) =>
            `${route.mode}: distance ${Math.round(route.distanceM)} m; modeled walking time ${Math.round(route.walkingTimeSeconds / 60)} min; steepest sampled slope ${route.steepestSlopeDeg.toFixed(1)} degrees; one-way modeled resources ${route.oxygenLiters.toFixed(1)} L oxygen, ${route.powerWh.toFixed(1)} Wh power, ${route.waterLiters.toFixed(2)} L water; science points used ${route.sciencePointsUsed}; note: ${route.note}`,
        )
        .join("\n")
    : "Routes unavailable: valid waypoints and terrain data are needed.";
  const hazardFacts = hazard
    ? `${hazard.blockedCells} of ${hazard.totalCells} coarse MOLA cells exceed the ${hazard.slopeLimitDeg}-degree slope screen. The grid is about 463 m per cell, not astronaut-scale hazard detection or safety certification.`
    : "Hazard grid is not loaded. Do not claim a hazard count or infer that the area is safe.";
  const resourceFacts = missionCheck
    ? `User-entered suit-resource screen: ${missionCheck.verdict} for ${missionCheck.returnTripIncluded ? "round trip" : "one way"}; reason: ${missionCheck.reason}; limiting resource: ${missionCheck.limitingResource ?? "none reported"}. This is a model screen only, not mission approval.`
    : "GO/NO-GO resource check has not been run.";

  return [
    `Selected route: ${selectedRoute}${selected ? ` (${Math.round(selected.distanceM)} m, steepest sampled slope ${selected.steepestSlopeDeg.toFixed(1)} degrees)` : " (route analysis unavailable)"}.`,
    `Route comparison:\n${routeFacts}`,
    `Hazard screen: ${hazardFacts}`,
    resourceFacts,
    "Shortest minimizes distance. Safest adds terrain and hazard-proximity penalties. Science rewards proximity only to supplied POIs; no verified Jezero science-stop coordinates are connected.",
    "Walking and resource estimates use an illustrative model. Never present them as operational navigation or mission approval.",
  ].join("\n");
}

async function readApiError(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
    ) {
      return body.error.message;
    }
  } catch {
    return `Gemini service returned HTTP ${response.status}.`;
  }
  return `Gemini service returned HTTP ${response.status}.`;
}

function MissionAssistant({
  routes,
  selectedRoute,
  onSelectRoute,
  missionCheck,
  hazard,
}: AssistantProps) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [loading, setLoading] = useState(false);
  const [providerState, setProviderState] = useState<ProviderState>("checking");
  const [modelName, setModelName] = useState("Gemini Flash");
  const [error, setError] = useState("");
  const selectedRouteData = routes.find((route) => route.mode === selectedRoute);
  const modelPhase = loading ? "loading" : providerState;

  useEffect(() => {
    const controller = new AbortController();
    async function checkProvider() {
      try {
        const response = await fetch(`${API_BASE_URL}/ai/status`, { signal: controller.signal });
        if (!response.ok) throw new Error(`AI status endpoint returned HTTP ${response.status}.`);
        const status = (await response.json()) as GeminiStatus;
        if (typeof status.configured !== "boolean" || typeof status.model !== "string") {
          throw new Error("AI status endpoint returned an invalid response.");
        }
        setModelName(status.model);
        setProviderState(status.configured ? "ready" : "setup_required");
      } catch {
        if (!controller.signal.aborted) setProviderState("offline");
      }
    }
    void checkProvider();
    return () => controller.abort();
  }, []);

  function addTurn(turn: AssistantTurn) {
    setTurns((current) => [...current.slice(-5), turn]);
  }

  async function ask(prompt: string) {
    const trimmed = prompt.trim();
    if (!trimmed || loading) return;
    setQuestion("");
    setError("");

    const command = routeCommand(trimmed);
    if (command) {
      const route = routes.find((item) => item.mode === command);
      if (!route) {
        addTurn({
          question: trimmed,
          answer: "I can change the selected objective after route analysis is available. Set two valid waypoints first.",
          kind: "command",
        });
        return;
      }
      onSelectRoute(command);
      addTurn({
        question: trimmed,
        answer: `Selected the ${ROUTE_LABELS[command]} route (${Math.round(route.distanceM)} m). The app applied this allow-listed command directly; Gemini does not control application actions. ${route.note}`,
        kind: "command",
      });
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 35_000);
    try {
      const response = await fetch(`${API_BASE_URL}/ai/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          question: trimmed,
          context: buildContext(routes, selectedRoute, hazard, missionCheck),
          history: turns.slice(-4).flatMap((turn) => [
            { role: "user", text: turn.question },
            { role: "model", text: turn.answer },
          ]),
        }),
      });
      if (!response.ok) throw new Error(await readApiError(response));
      const result: unknown = await response.json();
      if (
        typeof result !== "object" ||
        result === null ||
        !("answer" in result) ||
        typeof result.answer !== "string" ||
        !("model" in result) ||
        typeof result.model !== "string"
      ) {
        throw new Error("Gemini returned an invalid response. Please retry.");
      }
      setModelName(result.model);
      setProviderState("ready");
      addTurn({ question: trimmed, answer: result.answer, kind: "gemini" });
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setError("Gemini timed out after 35 seconds. Please retry; your message was not lost.");
      } else {
        setError(
          caught instanceof Error
            ? caught.message
            : "Gemini could not answer. Check the backend connection and retry.",
        );
      }
    } finally {
      window.clearTimeout(timeoutId);
      setLoading(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void ask(question);
  }

  const statusLabel =
    modelPhase === "loading"
      ? "WAITING FOR GEMINI"
      : providerState === "ready"
        ? "GEMINI CONNECTED"
        : providerState === "setup_required"
          ? "API KEY REQUIRED"
          : providerState === "offline"
            ? "AI API OFFLINE"
            : "CHECKING GEMINI";

  return (
    <section className="mission-assistant" aria-label="Learn from Past AI assistant">
      <header className="ai-console-header">
        <div className="ai-console-identity">
          <span className="assistant-icon"><BrainCircuit size={18} /></span>
          <span className="assistant-toggle-copy">
            <strong>LEARN FROM PAST</strong>
            <small>GEMINI FLASH · ROUTE-AWARE AI ASSISTANT</small>
          </span>
        </div>
        <span className={`ai-model-status is-${modelPhase}`} role="status" aria-live="polite">
          {modelPhase === "ready" ? <Check size={12} /> : modelPhase === "loading" ? <span className="loading-spinner" /> : <Cpu size={12} />}
          {statusLabel}
        </span>
      </header>

      <div className="mission-assistant-body">
        <div className="ai-feature-row">
          <div className="ai-feature">
            <span className="ai-feature-icon"><Sparkles size={14} /></span>
            <span><strong>Explain the route</strong><small>Ask why an option was selected</small></span>
          </div>
          <div className="ai-feature">
            <span className="ai-feature-icon"><ShieldCheck size={14} /></span>
            <span><strong>Read terrain context</strong><small>Uses route and loaded hazard values</small></span>
          </div>
          <div className="ai-feature">
            <span className="ai-feature-icon"><Route size={14} /></span>
            <span><strong>Change route objective</strong><small>Fixed, allow-listed app commands</small></span>
          </div>
        </div>

        <div className="ai-assistant-workspace">
          <div className="ai-conversation" aria-live="polite">
            {turns.length === 0 ? (
              <div className="ai-welcome-state">
                <span className="ai-welcome-orb"><BrainCircuit size={19} /></span>
                <div>
                  <strong>{providerState === "setup_required" ? "Connect your Gemini API key" : "Ask your mission copilot"}</strong>
                  <p>
                    {providerState === "setup_required"
                      ? "Add MARSWAY_GEMINI_API_KEY to the backend .env and restart the API. The key stays on the server."
                      : providerState === "offline"
                        ? "The AI status endpoint is unavailable. Start the FastAPI backend and retry."
                        : "Get quick Gemini explanations grounded in the selected route and loaded terrain data. Missing science locations stay missing."}
                  </p>
                </div>
              </div>
            ) : (
              <div className="ai-turn-list">
                {turns.map((turn, index) => (
                  <article className="ai-turn" key={`${index}-${turn.question}`}>
                    <div className="ai-user-prompt"><span>YOU</span><p>{turn.question}</p></div>
                    <div className="assistant-answer">
                      <span>{turn.kind === "gemini" ? `GEMINI · ${modelName}` : "SAFE APP COMMAND"}</span>
                      <p>{turn.answer}</p>
                    </div>
                  </article>
                ))}
                {loading && (
                  <div className="ai-typing-indicator" role="status">
                    <span /><span /><span /> GEMINI IS THINKING
                  </div>
                )}
              </div>
            )}
          </div>
          <aside className="ai-context-card" aria-label="Context available to Gemini">
            <span className="ai-context-label">LIVE MISSION CONTEXT</span>
            <div><span>SELECTED OBJECTIVE</span><strong>{ROUTE_LABELS[selectedRoute].toUpperCase()}</strong></div>
            <div><span>ROUTES AVAILABLE</span><strong>{routes.length ? `${routes.length} / 3` : "WAITING FOR WAYPOINTS"}</strong></div>
            <div><span>HAZARD GRID</span><strong>{hazard ? `${hazard.blockedCells} / ${hazard.totalCells} CELLS SCREENED` : "NOT LOADED"}</strong></div>
            <div><span>SELECTED ROUTE</span><strong>{selectedRouteData ? `${Math.round(selectedRouteData.distanceM)} m · O₂ ${selectedRouteData.oxygenLiters.toFixed(1)} L` : "NOT CALCULATED"}</strong></div>
            <div><span>SUIT RESOURCE SCREEN</span><strong>{missionCheck ? `${missionCheck.verdict} · ${missionCheck.returnTripIncluded ? "ROUND TRIP" : "ONE WAY"}` : "NOT RUN"}</strong></div>
            <small>Only these app values are sent with your prompt.</small>
          </aside>
        </div>

        <div className="ai-prompt-area">
          <span className="ai-prompt-label">MISSION PROMPTS</span>
          <div className="assistant-suggestions" aria-label="Suggested questions and commands">
            <button type="button" disabled={loading} onClick={() => void ask("Explain the selected route and why it was chosen.")}>
              <Sparkles size={12} /> Explain selection
            </button>
            <button type="button" disabled={loading} onClick={() => void ask("Compare the three route options.")}>Compare routes</button>
            <button type="button" disabled={loading} onClick={() => void ask("Explain the hazard screen and its limitations.")}>Explain hazard limits</button>
            <button type="button" disabled={loading} onClick={() => void ask("Find the safest route.")}>
              <ShieldCheck size={12} /> Choose safest
            </button>
            <button type="button" disabled={loading} onClick={() => void ask("Find the shortest route.")}>Choose shortest</button>
            <button type="button" disabled={loading} onClick={() => void ask("Use the science-weighted route.")}>Choose science</button>
          </div>
        </div>

        {loading && (
          <div className="assistant-progress" role="status" aria-live="polite">
            <span className="ai-progress-orb"><BrainCircuit size={13} /></span>
            <span>CONNECTING TO GEMINI · YOUR ANSWER WILL APPEAR HERE</span>
          </div>
        )}
        {error && <p className="assistant-error" role="alert">{error}</p>}
        <form className="assistant-form ai-composer" onSubmit={submit}>
          <label className="visually-hidden" htmlFor="assistant-question">Ask Gemini about this route or terrain</label>
          <input
            id="assistant-question"
            value={question}
            onChange={(event) => setQuestion(event.currentTarget.value)}
            placeholder="Ask Gemini about this route, terrain risk, or science weighting…"
            maxLength={500}
            disabled={loading}
          />
          {turns.length > 0 && (
            <button
              type="button"
              className="ai-clear-button"
              disabled={loading}
              onClick={() => setTurns([])}
              aria-label="Clear mission copilot conversation"
              title="Clear conversation"
            >
              <RotateCcw size={14} />
            </button>
          )}
          <button type="submit" disabled={loading || !question.trim()} aria-label="Send message to Gemini">
            {loading ? <span className="loading-spinner" /> : <Send size={14} />}
          </button>
        </form>
        <footer className="ai-trust-footer">
          <span><ShieldCheck size={12} /> GEMINI RECEIVES YOUR QUESTION AND CURRENT ROUTE CONTEXT</span>
          <span><Cpu size={12} /> {modelName}</span>
        </footer>
        <small className="assistant-model-credit">
          API KEY IS SERVER-SIDE · AI OUTPUT CAN BE WRONG · NOT MISSION SAFETY ADVICE
        </small>
      </div>
    </section>
  );
}

export default MissionAssistant;
