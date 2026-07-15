import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parse } from "../engine/parser";
import { begin, choose, next } from "../engine/interpreter";
import { deserialize, SaveFile, serialize } from "../engine/saves";
import type { GameState, View } from "../engine/types";
import storySource from "../story/demo.loom?raw";

const SLOT_COUNT = 6;
const slotKey = (index: number) => `loom-save-${index}`;

// background palette: asset keys map to painted gradients so the demo ships
// with zero image files; swap in real art by keying css classes or images
const BG: Record<string, string> = {
  classroom: "linear-gradient(160deg,#2b3a4d 0%,#3d5166 55%,#61758a 100%)",
  courtyard: "linear-gradient(165deg,#3a5a4c 0%,#5b7d64 60%,#a4b58a 100%)",
  clubroom: "linear-gradient(160deg,#4d3b2e 0%,#6a5240 60%,#8a6f52 100%)",
  rooftop: "linear-gradient(170deg,#33415e 0%,#5a6a8f 50%,#c98a6a 100%)",
  sunset: "linear-gradient(175deg,#472d3f 0%,#8a4a4a 45%,#d98a5a 80%,#f0c078 100%)",
  evening: "linear-gradient(170deg,#181c2b 0%,#2b3350 60%,#4a4a6a 100%)",
};

type Overlay = null | "backlog" | "saves" | "settings" | "confirm-title" | "confirm-wipe";
type Phase = "title" | "playing";

type Settings = {
  textSpeed: number; // ms per character, 0 = instant
  textScale: number; // dialogue font size in px
  boxOpacity: number; // 0.3 – 1
  autoAdvance: boolean;
  autoDelay: number; // ms to wait after a line finishes
};

const SETTINGS_KEY = "loom-settings";
const DEFAULT_SETTINGS: Settings = {
  textSpeed: 24,
  textScale: 19,
  boxOpacity: 1,
  autoAdvance: false,
  autoDelay: 2000,
};

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export default function Game() {
  const { story, ready } = useMemo(() => {
    const { story, errors } = parse(storySource);
    if (errors.length) console.error("story parse errors:", errors);
    return { story, ready: errors.length === 0 };
  }, []);

  const [phase, setPhase] = useState<Phase>("title");
  const [state, setState] = useState<GameState | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [settings, setSettings] = useState<Settings>(() => readSettings());
  const [fullscreen, setFullscreen] = useState(false);
  const [typed, setTyped] = useState(0);
  const [boxHidden, setBoxHidden] = useState(false);
  const [slots, setSlots] = useState<(SaveFile | null)[]>(() => readSlots());
  const [toast, setToast] = useState("");
  const history = useRef<{ state: GameState; view: View }[]>([]);
  const typeTimer = useRef<number | null>(null);

  const fullText = view?.kind === "dialogue" ? view.text : "";
  const typing = view?.kind === "dialogue" && typed < fullText.length;

  // ------------------------------------------------------------- settings
  useEffect(() => {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  const updateSetting = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    setSettings((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    const onFullscreenChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  };

  // ------------------------------------------------------------ typewriter
  const stopTypeTimer = () => {
    if (typeTimer.current !== null) {
      clearInterval(typeTimer.current);
      typeTimer.current = null;
    }
  };

  useEffect(() => {
    setTyped(0);
    if (view?.kind !== "dialogue" || settings.textSpeed === 0) {
      setTyped(fullText.length);
      return;
    }
    let count = 0;
    typeTimer.current = window.setInterval(() => {
      count += 1;
      // never regress: if the user skipped ahead, keep the full text shown
      setTyped((prev) => Math.max(prev, count));
      if (count >= fullText.length) stopTypeTimer();
    }, settings.textSpeed);
    return stopTypeTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, settings.textSpeed]);

  const finishTyping = useCallback(() => {
    stopTypeTimer();
    setTyped(fullText.length);
  }, [fullText]);

  // ---------------------------------------------------------------- engine
  const push = useCallback(
    (nextState: GameState, nextView: View) => {
      if (state && view) history.current.push({ state, view });
      if (history.current.length > 200) history.current.shift();
      setState(nextState);
      setView(nextView);
    },
    [state, view]
  );

  const startGame = useCallback(
    (from?: GameState) => {
      const opening = from ?? begin(story);
      const advanced = next(story, opening);
      history.current = [];
      setState(advanced.state);
      setView(advanced.view);
      setPhase("playing");
      setOverlay(null);
      setBoxHidden(false);
    },
    [story]
  );

  const exitToTitle = useCallback(() => {
    history.current = [];
    setState(null);
    setView(null);
    setOverlay(null);
    setBoxHidden(false);
    setPhase("title");
  }, []);

  const advance = useCallback(() => {
    if (!state || !view || overlay) return;
    if (boxHidden) {
      setBoxHidden(false); // a click while hidden just brings the box back
      return;
    }
    if (typing) {
      finishTyping(); // first press completes the line instantly
      return;
    }
    if (view.kind !== "dialogue") return;
    const advanced = next(story, state);
    push(advanced.state, advanced.view);
  }, [state, view, overlay, boxHidden, typing, finishTyping, story, push]);

  // ---------------------------------------------------------- auto-advance
  useEffect(() => {
    if (!settings.autoAdvance || phase !== "playing" || overlay || boxHidden) return;
    if (view?.kind !== "dialogue" || typing) return;
    const timer = setTimeout(advance, settings.autoDelay);
    return () => clearTimeout(timer);
  }, [settings.autoAdvance, settings.autoDelay, phase, overlay, boxHidden, view, typing, advance]);

  const pick = useCallback(
    (index: number) => {
      if (!state) return;
      const chosen = choose(story, state, index);
      const advanced = next(story, chosen);
      push(advanced.state, advanced.view);
    },
    [state, story, push]
  );

  const rollback = useCallback(() => {
    const prev = history.current.pop();
    if (prev) {
      setState(prev.state);
      setView(prev.view);
    }
  }, []);

  // -------------------------------------------------------------- saves
  const saveTo = (index: number) => {
    if (!state) return;
    const file = serialize(story, state);
    localStorage.setItem(slotKey(index), JSON.stringify(file));
    setSlots(readSlots());
    flash(`saved to slot ${index + 1}`);
  };

  const loadFrom = (index: number) => {
    const raw = localStorage.getItem(slotKey(index));
    if (!raw) return;
    try {
      const restored = deserialize(story, JSON.parse(raw));
      startGame(restored);
      flash(`loaded slot ${index + 1}`);
    } catch (error) {
      flash(String(error));
    }
  };

  const latestSlot = slots.reduce<number>((best, slot, index) => {
    if (!slot) return best;
    const bestAt = best >= 0 ? slots[best]?.savedAt ?? 0 : 0;
    return slot.savedAt > bestAt ? index : best;
  }, -1);

  const wipeSaves = () => {
    for (let index = 0; index < SLOT_COUNT; index++) localStorage.removeItem(slotKey(index));
    setSlots(readSlots());
    setOverlay("settings");
    flash("all saves deleted");
  };

  const flash = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(""), 1800);
  };

  // ------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (overlay) setOverlay(null);
        else if (boxHidden) setBoxHidden(false);
        else if (phase === "playing") setOverlay("settings");
        return;
      }
      if (phase !== "playing") return;
      if (event.key === " " || event.key === "Enter") {
        event.preventDefault();
        if (!overlay) advance();
      }
      if ((event.key === "h" || event.key === "H") && !overlay) {
        setBoxHidden((hidden) => !hidden);
      }
      if ((event.key === "a" || event.key === "A") && !overlay) {
        setSettings((current) => ({ ...current, autoAdvance: !current.autoAdvance }));
      }
      if (event.key === "Backspace" && !overlay) rollback();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, overlay, boxHidden, advance, rollback]);

  // ------------------------------------------------------------------- ui
  if (!ready) return <div className="fatal">story failed to parse — see console</div>;

  const overlayPanel = (title: string, body: React.ReactNode) => (
    <div className="overlay" onClick={(event) => event.stopPropagation()}>
      <div className="overlay-head">
        <h3>{title}</h3>
        <button className="overlay-close" onClick={() => setOverlay(null)} aria-label="close">
          ✕
        </button>
      </div>
      {body}
    </div>
  );

  const overlays = (
    <>
      {overlay === "backlog" &&
        overlayPanel(
          "Backlog",
          <div className="backlog">
            {(state?.seen ?? []).slice(-60).map((entry, index) => {
              const character = entry.who ? story.characters.get(entry.who) : null;
              return (
                <p key={index} className={character ? "" : "log-narration"}>
                  {character && (
                    <strong style={{ color: character.color }}>{character.name} </strong>
                  )}
                  {entry.text}
                </p>
              );
            })}
          </div>
        )}

      {overlay === "saves" &&
        overlayPanel(
          phase === "playing" ? "Saves" : "Load Game",
          <div className="slot-grid">
            {slots.map((slot, index) => (
              <div key={index} className="slot">
                <div className="slot-head">slot {index + 1}</div>
                {slot ? (
                  <>
                    <div className="slot-label">{slot.label}</div>
                    <div className="slot-time">{new Date(slot.savedAt).toLocaleString()}</div>
                  </>
                ) : (
                  <div className="slot-empty">empty</div>
                )}
                <div className="slot-actions">
                  <button onClick={() => saveTo(index)} disabled={!state}>
                    save
                  </button>
                  <button onClick={() => loadFrom(index)} disabled={!slot}>
                    load
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

      {overlay === "settings" &&
        overlayPanel(
          "Settings",
          <div className="settings-body">
            <div className="setting-group">
              <h4>Text</h4>
              <label className="setting">
                <span className="setting-name">speed</span>
                <input
                  type="range"
                  min={0}
                  max={60}
                  value={60 - settings.textSpeed}
                  onChange={(event) => updateSetting("textSpeed", 60 - Number(event.target.value))}
                />
                <span>{settings.textSpeed === 0 ? "instant" : `${settings.textSpeed} ms/char`}</span>
              </label>
              <label className="setting">
                <span className="setting-name">size</span>
                <input
                  type="range"
                  min={15}
                  max={26}
                  value={settings.textScale}
                  onChange={(event) => updateSetting("textScale", Number(event.target.value))}
                />
                <span>{settings.textScale} px</span>
              </label>
            </div>

            <div className="setting-group">
              <h4>Auto-advance</h4>
              <label className="setting">
                <span className="setting-name">enabled</span>
                <input
                  type="checkbox"
                  checked={settings.autoAdvance}
                  onChange={(event) => updateSetting("autoAdvance", event.target.checked)}
                />
              </label>
              <label className="setting">
                <span className="setting-name">delay</span>
                <input
                  type="range"
                  min={500}
                  max={6000}
                  step={250}
                  value={settings.autoDelay}
                  onChange={(event) => updateSetting("autoDelay", Number(event.target.value))}
                  disabled={!settings.autoAdvance}
                />
                <span>{settings.autoDelay / 1000} s</span>
              </label>
            </div>

            <div className="setting-group">
              <h4>Display</h4>
              <label className="setting">
                <span className="setting-name">box opacity</span>
                <input
                  type="range"
                  min={30}
                  max={100}
                  value={Math.round(settings.boxOpacity * 100)}
                  onChange={(event) => updateSetting("boxOpacity", Number(event.target.value) / 100)}
                />
                <span>{Math.round(settings.boxOpacity * 100)}%</span>
              </label>
              <label className="setting">
                <span className="setting-name">fullscreen</span>
                <input type="checkbox" checked={fullscreen} onChange={toggleFullscreen} />
              </label>
            </div>

            <div className="setting-group">
              <h4>Data</h4>
              <div className="confirm-actions">
                <button className="ghost-btn" onClick={() => setSettings(DEFAULT_SETTINGS)}>
                  Reset settings
                </button>
                <button
                  className="danger-btn"
                  onClick={() => setOverlay("confirm-wipe")}
                  disabled={slots.every((slot) => slot === null)}
                >
                  Delete all saves
                </button>
              </div>
            </div>

            <div className="setting-keys">
              <p>space / enter — advance · click while typing — show full line</p>
              <p>h — hide / show text box · a — auto-advance · backspace — rollback · esc — menu</p>
            </div>
            {phase === "playing" && (
              <button className="danger-btn" onClick={() => setOverlay("confirm-title")}>
                Exit to main menu
              </button>
            )}
          </div>
        )}

      {overlay === "confirm-wipe" &&
        overlayPanel(
          "Delete Saves",
          <div className="settings-body">
            <p className="confirm-text">Delete all {SLOT_COUNT} save slots? This cannot be undone.</p>
            <div className="confirm-actions">
              <button className="danger-btn" onClick={wipeSaves}>
                Delete
              </button>
              <button className="ghost-btn" onClick={() => setOverlay("settings")}>
                Cancel
              </button>
            </div>
          </div>
        )}

      {overlay === "confirm-title" &&
        overlayPanel(
          "Exit to Menu",
          <div className="settings-body">
            <p className="confirm-text">Return to the main menu? Unsaved progress will be lost.</p>
            <div className="confirm-actions">
              <button className="danger-btn" onClick={exitToTitle}>
                Exit
              </button>
              <button className="ghost-btn" onClick={() => setOverlay(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
    </>
  );

  if (phase === "title") {
    return (
      <div className="stage title-screen" style={{ background: BG.evening }}>
        <div className="title-card">
          <p className="title-kicker">a loom story</p>
          <h1 className="title-name">{story.title}</h1>
          <div className="title-actions">
            <button className="title-btn" onClick={() => startGame()}>
              New Game
            </button>
            <button
              className="title-btn ghost"
              onClick={() => loadFrom(latestSlot)}
              disabled={latestSlot < 0}
            >
              Continue
            </button>
            <button
              className="title-btn ghost"
              onClick={() => setOverlay("saves")}
              disabled={slots.every((slot) => slot === null)}
            >
              Load
            </button>
            <button className="title-btn ghost" onClick={() => setOverlay("settings")}>
              Settings
            </button>
          </div>
          <p className="title-foot">space / enter · advance — backspace · rollback</p>
        </div>
        {overlays}
        {toast && <div className="toast">{toast}</div>}
      </div>
    );
  }

  const bg = state?.visuals.bg ? BG[state.visuals.bg] ?? BG.evening : BG.evening;
  const sprites = state?.visuals.sprites ?? [];
  const stageVars = {
    background: bg,
    "--dialogue-size": `${settings.textScale}px`,
    "--dialogue-line": `${Math.round(settings.textScale * 1.5)}px`,
    "--box-alpha": settings.boxOpacity,
  } as React.CSSProperties;

  return (
    <div className="stage" style={stageVars} onClick={() => !overlay && advance()}>
      {/* sprites */}
      <div className="sprite-row">
        {sprites.map((sprite) => {
          const character = story.characters.get(sprite.who);
          const speaking =
            view?.kind === "dialogue" && view.who?.id === sprite.who;
          return (
            <div
              key={sprite.who}
              className={`sprite ${speaking ? "speaking" : ""}`}
              style={{ borderColor: character?.color ?? "#888" }}
            >
              <span className="sprite-initial" style={{ color: character?.color }}>
                {(character?.name ?? sprite.who)[0]}
              </span>
              <span className="sprite-name">{character?.name ?? sprite.who}</span>
              <span className="sprite-expression">{sprite.expression}</span>
            </div>
          );
        })}
      </div>

      {/* dialogue */}
      {view?.kind === "dialogue" && !boxHidden && (
        <div className="dialogue-dock">
          {view.who && (
            <div className="nameplate" style={{ background: view.who.color }}>
              {view.who.name}
            </div>
          )}
          <div className={`dialogue-box ${view.who ? "" : "narration"}`}>
            <p>
              {fullText.slice(0, typed)}
              {typing && <span className="caret">▏</span>}
            </p>
            {!typing && <span className="advance-hint">▼</span>}
          </div>
        </div>
      )}

      {/* choices */}
      {view?.kind === "choices" && (
        <div className="choices">
          {view.options.map((option) => (
            <button
              key={option.index}
              className="choice"
              onClick={(event) => {
                event.stopPropagation();
                pick(option.index);
              }}
            >
              {option.text}
            </button>
          ))}
        </div>
      )}

      {/* ending */}
      {view?.kind === "ending" && (
        <div className="ending">
          <p className="ending-kicker">ending</p>
          <h2 className="ending-title">{view.title}</h2>
          <button
            className="title-btn"
            onClick={(event) => {
              event.stopPropagation();
              exitToTitle();
            }}
          >
            Back to title
          </button>
        </div>
      )}

      {/* menu strip */}
      {!boxHidden && (
        <nav className="menu-strip" onClick={(event) => event.stopPropagation()}>
          <button onClick={() => setOverlay(overlay === "backlog" ? null : "backlog")}>Log</button>
          <button onClick={() => setOverlay(overlay === "saves" ? null : "saves")}>Save</button>
          <button onClick={rollback}>Back</button>
          <button onClick={() => setBoxHidden(true)} disabled={view?.kind !== "dialogue"}>
            Hide
          </button>
          <button
            className={settings.autoAdvance ? "active" : ""}
            onClick={() => updateSetting("autoAdvance", !settings.autoAdvance)}
          >
            Auto
          </button>
          <button onClick={() => setOverlay(overlay === "confirm-title" ? null : "confirm-title")}>
            Menu
          </button>
          <button onClick={() => setOverlay(overlay === "settings" ? null : "settings")}>⚙</button>
        </nav>
      )}

      {overlays}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function readSlots(): (SaveFile | null)[] {
  return Array.from({ length: SLOT_COUNT }, (_, index) => {
    try {
      const raw = localStorage.getItem(slotKey(index));
      return raw ? (JSON.parse(raw) as SaveFile) : null;
    } catch {
      return null;
    }
  });
}
