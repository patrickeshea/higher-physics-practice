import { useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const SESSION_LENGTH = 10;

/* ---------- helpers ---------- */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

// Convert simple exponent patterns into HTML superscripts.
// Examples: "m s-1" or "m s−1" -> "m s<sup>−1</sup>"
//           "10^3" -> "10<sup>3</sup>"
function formatPhysicsTextToHtml(text) {
  if (!text) return "";
  let t = String(text);

  // unit exponent like s-1 or s−1
  t = t.replace(/([a-zA-Z])\s*(−|-)\s*([0-9]+)/g, (_, unit, __sign, pow) => {
    return `${unit}<sup>−${pow}</sup>`;
  });

  // caret exponent like 10^3 or m^2
  t = t.replace(/(\w+)\^([−-]?\d+)/g, (_, base, pow) => {
    const p = String(pow).replace("-", "−");
    return `${base}<sup>${p}</sup>`;
  });

  return t;
}

function HtmlText({ text }) {
  return <span dangerouslySetInnerHTML={{ __html: formatPhysicsTextToHtml(text) }} />;
}

function loadProgress() {
  try {
    const raw = localStorage.getItem("hp_progress_v1");
    return raw ? JSON.parse(raw) : { attempts: {} };
  } catch {
    return { attempts: {} };
  }
}

function saveProgress(progress) {
  localStorage.setItem("hp_progress_v1", JSON.stringify(progress));
}

function resetProgress(setProgress) {
  localStorage.removeItem("hp_progress_v1");
  setProgress(loadProgress());
}

function loadFeedback() {
  try {
    const raw = localStorage.getItem("hp_feedback_v1");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveFeedbackEntry(entry) {
  const list = loadFeedback();
  list.push(entry);
  localStorage.setItem("hp_feedback_v1", JSON.stringify(list));
}

function topicKey(q) {
  return `${q.unit}__${q.topic}`;
}

// Fetch JSON helper (so errors are consistent and readable)
async function fetchJson(path) {
  const res = await fetch(`${import.meta.env.BASE_URL}${path}`);
  if (!res.ok) throw new Error(`${path} (HTTP ${res.status})`);
  return res.json();
}

/* ---------- App ---------- */

export default function App() {
  const [allQuestions, setAllQuestions] = useState([]);
  const [loadError, setLoadError] = useState("");

  const [sessionIds, setSessionIds] = useState([]);
  const [index, setIndex] = useState(0);

  const [selected, setSelected] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [isCorrect, setIsCorrect] = useState(null);

  const [hintLevel, setHintLevel] = useState(0);
  const [progress, setProgress] = useState(() => loadProgress());

  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedbackText, setFeedbackText] = useState("");

  const startTimeRef = useRef(Date.now());

  // NEW: Load data/index.json, then load all listed files, then merge questions
  useEffect(() => {
    (async () => {
      try {
        setLoadError("");

        // 1) Load the index file which lists all question-bank JSON files
        const indexData = await fetchJson("data/index.json");
        if (!indexData?.files?.length) throw new Error("data/index.json has no files[] list");

        // 2) Load each question-bank file
        const banks = [];
        for (const file of indexData.files) {
          const bank = await fetchJson(file);
          if (!bank?.questions?.length) {
            throw new Error(`${file} loaded but had no questions[]`);
          }
          banks.push(bank);
        }

        // 3) Merge questions and remove any duplicates by id
        const merged = [];
        const seen = new Set();

        for (const bank of banks) {
          for (const q of bank.questions) {
            if (!q?.id) continue;
            if (seen.has(q.id)) continue;
            seen.add(q.id);
            merged.push(q);
          }
        }

        if (!merged.length) throw new Error("No questions found after merging banks");

        setAllQuestions(merged);
      } catch (e) {
        setLoadError(
          "Could not load question bank files.\n\n" +
            "Make sure BOTH exist:\n" +
            "- public/data/index.json\n" +
            "- the files listed inside it (e.g. public/data/2024_p1.json)\n\n" +
            `Details: ${String(e?.message || e)}`
        );
      }
    })();
  }, []);

  function resetPerQuestion() {
    setSelected(null);
    setSubmitted(false);
    setIsCorrect(null);
    setHintLevel(0);
    startTimeRef.current = Date.now();
  }

  function startNewSession() {
    if (!allQuestions.length) return;

    const ids = allQuestions.map((q) => q.id);
    // shuffle
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }

    setSessionIds(ids.slice(0, Math.min(SESSION_LENGTH, ids.length)));
    setIndex(0);
    resetPerQuestion();
  }

  // Auto-start a session once questions are loaded
  useEffect(() => {
    if (allQuestions.length) startNewSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allQuestions]);

  const sessionQuestions = useMemo(() => {
    const map = new Map(allQuestions.map((q) => [q.id, q]));
    return sessionIds.map((id) => map.get(id)).filter(Boolean);
  }, [allQuestions, sessionIds]);

  const total = sessionQuestions.length;
  const current = index < total ? sessionQuestions[index] : null;
  const isFinished = total > 0 && index >= total;

  function recordAttempt({ q, correct, hintsUsed, timeSpentSec }) {
    const p = loadProgress();
    const existing = p.attempts[q.id] || {
      times: 0,
      correctCount: 0,
      hintsTotal: 0,
      timeTotalSec: 0,
      unit: q.unit,
      topic: q.topic,
    };

    const next = {
      ...existing,
      times: existing.times + 1,
      correctCount: existing.correctCount + (correct ? 1 : 0),
      hintsTotal: existing.hintsTotal + hintsUsed,
      timeTotalSec: existing.timeTotalSec + timeSpentSec,
      lastWasCorrect: !!correct,
      lastHintsUsed: hintsUsed,
      lastAttemptIso: new Date().toISOString(),
      unit: q.unit,
      topic: q.topic,
    };

    p.attempts[q.id] = next;
    saveProgress(p);
    setProgress(p);
  }

  function submitAnswer() {
    if (!current || !selected) return;

    const key = current?.answer?.mcq_key;
    const correct = selected === key;

    setSubmitted(true);
    setIsCorrect(correct);

    const timeSpentSec = Math.max(1, Math.round((Date.now() - startTimeRef.current) / 1000));
    recordAttempt({ q: current, correct, hintsUsed: hintLevel, timeSpentSec });
  }

  function nextQuestion() {
    if (index < total - 1) {
      setIndex(index + 1);
      resetPerQuestion();
    } else {
      setIndex(total); // finished screen
    }
  }

  function requestHint() {
    setHintLevel((h) => clamp(h + 1, 0, 3));
  }

  // Summary: treat correct-with-hints as still "needs work"
  const topicSummary = useMemo(() => {
    const byTopic = {};

    for (const q of sessionQuestions) {
      const a = progress?.attempts?.[q.id];
      if (!a) continue;

      const k = topicKey(q);
      if (!byTopic[k]) {
        byTopic[k] = {
          unit: q.unit,
          topic: q.topic,
          total: 0,
          correct: 0,
          hints: 0,
          weaknessTotal: 0,
        };
      }

      byTopic[k].total += 1;
      byTopic[k].correct += a.lastWasCorrect ? 1 : 0;
      byTopic[k].hints += a.lastHintsUsed || 0;

      // weakness: wrong=2, correct-with-hints=1, correct-no-hints=0
      const weakness = a.lastWasCorrect ? (a.lastHintsUsed > 0 ? 1 : 0) : 2;
      byTopic[k].weaknessTotal += weakness;
    }

    const list = Object.values(byTopic).map((t) => {
      const accuracy = t.total ? t.correct / t.total : 0;
      const weaknessAvg = t.total ? t.weaknessTotal / t.total : 0;
      return { ...t, accuracy, weaknessAvg };
    });

    list.sort((a, b) => b.weaknessAvg - a.weaknessAvg || a.accuracy - b.accuracy);
    return list;
  }, [progress, sessionQuestions]);

  /* ---------- screens ---------- */

  if (loadError) {
    return (
      <div className="page">
        <header className="topbar">
          <div className="brand">
            <div className="logo">HP</div>
            <div>
              <div className="title">Higher Physics Practice</div>
              <div className="subtitle">Modern MCQ trainer</div>
            </div>
          </div>
        </header>

        <main className="container">
          <div className="card">
            <h2>Almost there 👇</h2>
            <pre className="pre">{loadError}</pre>
          </div>
        </main>
      </div>
    );
  }

  if (isFinished) {
    return (
      <div className="page">
        <header className="topbar">
          <div className="brand">
            <div className="logo">HP</div>
            <div>
              <div className="title">Higher Physics Practice</div>
              <div className="subtitle">Session complete</div>
            </div>
          </div>

          <div className="topRight">
            <button className="btn btnPrimary" onClick={startNewSession}>
              Start another 10
            </button>
            <button className="btn" onClick={() => resetProgress(setProgress)}>
              Reset progress
            </button>
          </div>
        </header>

        <main className="container">
          <div className="card">
            <h2>Summary</h2>
            <p className="muted">“Correct with hints” still counts as needing practice.</p>

            {topicSummary.length === 0 ? (
              <p>No attempts recorded yet.</p>
            ) : (
              <div className="grid">
                {topicSummary.map((t) => (
                  <div key={`${t.unit}-${t.topic}`} className="miniCard">
                    <div className="miniTop">
                      <div className="badge">{t.unit}</div>
                      <div className="miniTitle">{t.topic}</div>
                    </div>

                    <div className="progressRow">
                      <div className="progressBar">
                        <div className="progressFill" style={{ width: `${Math.round(100 * t.accuracy)}%` }} />
                      </div>
                      <div className="progressText">{Math.round(100 * t.accuracy)}%</div>
                    </div>

                    <div className="miniMeta">
                      <span>Questions: {t.total}</span>
                      <span>Hints: {t.hints}</span>
                    </div>

                    <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
                      Needs-work score: {t.weaknessAvg.toFixed(2)}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="actions">
              <button className="btn" onClick={startNewSession}>
                New session
              </button>
            </div>
          </div>
        </main>
      </div>
    );
  }

  // main question screen
  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <div className="logo">HP</div>
          <div>
            <div className="title">Higher Physics Practice</div>
            <div className="subtitle">
              MCQ • Session: {total ? `${index + 1}/${total}` : "…"} • Bank: {allQuestions.length} questions
            </div>
          </div>
        </div>

        <div className="topRight">
          <button className="btn" onClick={startNewSession}>
            New session
          </button>
          <button className="btn" onClick={() => resetProgress(setProgress)}>
            Reset progress
          </button>
        </div>
      </header>

      <main className="container">
        {!current ? (
          <div className="card">
            <h2>Loading…</h2>
          </div>
        ) : (
          <div className="card">
            <div className="metaRow">
              <div className="badge">{current.unit}</div>
              <div className="badge badgeSoft">{current.topic}</div>
              <div className="spacer" />
              <div className="qid">{current.id}</div>
            </div>

            <h2 className="qStem">
              <HtmlText text={current.prompt?.stem || "(Missing stem)"} />
            </h2>

            {Array.isArray(current.prompt?.assets) && current.prompt.assets.length > 0 && (
              <div className="assetBox">
                {current.prompt.assets.map((a, i) => (
                  <div key={i} className="assetItem">
                    {a.type === "image" ? (
                      <img
                        className="assetImg"
                        src={`${import.meta.env.BASE_URL}${a.src.replace(/^\//, "")}`}
                        alt={a.alt || "diagram"}
                      />
                    ) : (
                      <div className="muted">Unsupported asset</div>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div className="options">
              {(current.prompt?.options || []).map((optText, idx) => {
                const letter = String.fromCharCode("A".charCodeAt(0) + idx);
                const correctKey = current?.answer?.mcq_key;

                const isSelected = selected === letter;
                const showCorrect = submitted && letter === correctKey;
                const showWrong = submitted && isSelected && !isCorrect;

                const cls = [
                  "optionBtn",
                  isSelected ? "optionSelected" : "",
                  showCorrect ? "optionCorrect" : "",
                  showWrong ? "optionWrong" : "",
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <button key={letter} className={cls} onClick={() => !submitted && setSelected(letter)}>
                    <span className="optionLetter">{letter}</span>
                    <span className="optionText">
                      <HtmlText text={optText} />
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="row">
              <button className="btn" onClick={requestHint} disabled={hintLevel >= 3}>
                Hint {hintLevel >= 3 ? "max" : "+1"}
              </button>

              <button
                className="btn"
                onClick={() => {
                  setFeedbackText("");
                  setFeedbackOpen(true);
                }}
              >
                Looks weird?
              </button>

              <div className="hintPills">
                <span className={hintLevel >= 1 ? "pill pillOn" : "pill"}>1</span>
                <span className={hintLevel >= 2 ? "pill pillOn" : "pill"}>2</span>
                <span className={hintLevel >= 3 ? "pill pillOn" : "pill"}>3</span>
              </div>

              <div className="spacer" />

              {!submitted ? (
                <button className="btn btnPrimary" onClick={submitAnswer} disabled={!selected}>
                  Submit
                </button>
              ) : (
                <button className="btn btnPrimary" onClick={nextQuestion}>
                  Next
                </button>
              )}
            </div>

            {hintLevel > 0 && (
              <div className="hintPanel">
                <div className="hintTitle">Hints</div>

                {hintLevel >= 1 && (
                  <div className="hintBlock">
                    <div className="hintLabel">Level 1</div>
                    <ul>
                      {(current.socratic_hints?.level1 || []).map((h, i) => (
                        <li key={`l1-${i}`}>
                          <HtmlText text={h} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {hintLevel >= 2 && (
                  <div className="hintBlock">
                    <div className="hintLabel">Level 2</div>
                    <ul>
                      {(current.socratic_hints?.level2 || []).map((h, i) => (
                        <li key={`l2-${i}`}>
                          <HtmlText text={h} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {hintLevel >= 3 && (
                  <div className="hintBlock">
                    <div className="hintLabel">Level 3 (worked)</div>
                    <ol>
                      {(current.socratic_hints?.level3 || []).map((step, i) => (
                        <li key={`l3-${i}`}>
                          <div className="workedStep">
                            <div className="workedStepTop">
                              <span className="workedStepName">{step.step}</span>
                              {typeof step.mark_award === "number" && (
                                <span className="workedMarks">{step.mark_award} mark</span>
                              )}
                            </div>
                            <div className="workedContent">
                              <HtmlText text={step.content} />
                            </div>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
              </div>
            )}

            {feedbackOpen && (
              <div className="modalBackdrop">
                <div className="modalCard">
                  <div className="modalTop">
                    <div>
                      <div className="modalTitle">Report an issue</div>
                      <div className="muted" style={{ fontSize: 12 }}>
                        Question: {current.id}
                      </div>
                    </div>
                    <button className="btn" onClick={() => setFeedbackOpen(false)}>
                      Close
                    </button>
                  </div>

                  <textarea
                    className="modalTextarea"
                    value={feedbackText}
                    onChange={(e) => setFeedbackText(e.target.value)}
                    placeholder="What looks weird? Missing diagram, odd formatting, etc."
                  />

                  <div className="row" style={{ marginTop: 10 }}>
                    <div className="spacer" />
                    <button
                      className="btn btnPrimary"
                      disabled={!feedbackText.trim()}
                      onClick={() => {
                        saveFeedbackEntry({
                          whenIso: new Date().toISOString(),
                          questionId: current.id,
                          unit: current.unit,
                          topic: current.topic,
                          note: feedbackText.trim(),
                        });
                        setFeedbackOpen(false);
                        setFeedbackText("");
                      }}
                    >
                      Submit report
                    </button>
                  </div>
                </div>
              </div>
            )}

            {submitted && (
              <div className={`feedback ${isCorrect ? "feedbackGood" : "feedbackBad"}`}>
                {isCorrect ? (
                  <div>
                    <strong>Correct.</strong> Nice.
                  </div>
                ) : (
                  <div>
                    <strong>Not quite.</strong> Correct answer:{" "}
                    <strong>{current?.answer?.mcq_key || "?"}</strong>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

