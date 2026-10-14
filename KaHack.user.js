// ==UserScript==
// @name         KaHack! (2026 rebuild)
// @version      3.0.0
// @namespace    https://github.com/jokeri2222
// @description  Show / auto-answer for kahoot.it — quiz lookup, auto-detect, answer cache and Claude AI fallback
// @author       jokeri2222 (original), rebuilt 2026
// @match        https://kahoot.it/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=kahoot.it
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      kahoot.it
// @connect      create.kahoot.it
// @connect      api.anthropic.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ------------------------------------------------------------------ storage
    // GM storage is private to the userscript, so the API key isn't readable by kahoot.it's own scripts.
    const hasGM = typeof GM_getValue === 'function';
    const store = {
        get(k, d) {
            try {
                if (hasGM) return GM_getValue(k, d);
                const v = localStorage.getItem('kahack_' + k); return v === null ? d : JSON.parse(v);
            } catch { return d; }
        },
        set(k, v) {
            try { hasGM ? GM_setValue(k, v) : localStorage.setItem('kahack_' + k, JSON.stringify(v)); } catch { /* ignore */ }
        },
    };

    const MODELS = {
        'claude-haiku-5-5': 'Haiku 5.5 — fastest',
        'claude-sonnet-5-5': 'Sonnet 5.5 — balanced',
        'claude-opus-5-5': 'Opus 5.5 — smartest, slowest',
    };

    const state = {
        quiz: null,            // { title, questions: [...] } loaded by ID/search/auto-detect
        showAnswers: store.get('showAnswers', true),
        autoAnswer: store.get('autoAnswer', false),
        autoDetect: store.get('autoDetect', true),
        useAI: store.get('useAI', true),
        apiKey: store.get('apiKey', ''),
        model: store.get('model', 'claude-opus-5-5'),
        targetPoints: store.get('targetPoints', 1000),
        cache: store.get('answerCache', {}), // question+answers fingerprint -> correct answer texts
        screen: null,          // the question currently on screen
        detectTried: new Set(),
        timers: [],
    };

    // ------------------------------------------------------------------ network
    function request(method, url, { headers = {}, body, timeout = 15000 } = {}) {
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                GM_xmlhttpRequest({
                    method, url, timeout,
                    headers: { Accept: 'application/json', ...headers },
                    data: body,
                    onload: r => {
                        let json = null;
                        try { json = JSON.parse(r.responseText); } catch { /* non-JSON */ }
                        if (r.status < 200 || r.status >= 300) {
                            const msg = json && json.error && json.error.message;
                            return reject(new Error('HTTP ' + r.status + (msg ? ': ' + msg : '')));
                        }
                        json ? resolve(json) : reject(new Error('bad JSON'));
                    },
                    onerror: () => reject(new Error('network error')),
                    ontimeout: () => reject(new Error('timeout')),
                });
            });
        }
        return fetch(url, { method, headers, body, credentials: 'omit' }).then(async r => {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        });
    }
    const getJSON = url => request('GET', url);

    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    async function loadQuiz(id) {
        const urls = [
            'https://kahoot.it/rest/kahoots/' + id,
            'https://create.kahoot.it/rest/kahoots/' + id + '/card/?includeKahoot=true',
        ];
        let lastErr;
        for (const url of urls) {
            try {
                const data = await getJSON(url);
                const kahoot = data.kahoot || data;
                if (Array.isArray(kahoot.questions)) return parseQuiz(kahoot);
            } catch (e) { lastErr = e; }
        }
        throw lastErr || new Error('quiz not found');
    }

    async function searchQuizzes(query, limit = 25) {
        const url = 'https://create.kahoot.it/rest/kahoots/?query=' + encodeURIComponent(query) +
            '&limit=' + limit + '&cursor=0&searchCluster=1&includeExtendedCounters=false&inventoryItemId=ANY';
        const data = await getJSON(url);
        return (data.entities || []).map(e => {
            const card = e.card || e;
            return {
                id: card.uuid || card.id,
                title: card.title || '(untitled)',
                creator: card.creator_username || card.creatorUsername || '',
                count: card.number_of_questions ?? card.numberOfQuestions ?? '?',
            };
        }).filter(r => r.id);
    }

    // ------------------------------------------------------------------ parsing
    const stripHtml = s => String(s || '').replace(/<[^>]*>/g, ' ');
    const norm = s => stripHtml(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

    function parseQuiz(kahoot) {
        // Content slides take a slot in the player's counter too, so keep them.
        const questions = kahoot.questions.map((q, i) => ({
            index: i,
            type: q.type,
            time: q.time || 20000,
            text: norm(q.question || q.title),
            choices: (q.choices || []).map((c, ci) => ({ index: ci, text: norm(c.answer), correct: !!c.correct })),
            range: q.choiceRange || null, // slider questions
        }));
        return { title: kahoot.title || '', questions };
    }

    // ------------------------------------------------------------------ DOM detection
    const $ = (sel, root = document) => root.querySelector(sel);
    const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

    function answerButtons() {
        // Current player: <button data-functional-selector="answer-0"> ... answer-N.
        let btns = $$('button[data-functional-selector^="answer-"]')
            .filter(b => /^answer-\d+$/.test(b.getAttribute('data-functional-selector')));
        if (!btns.length) {
            btns = $$('[data-functional-selector*="answer"]')
                .filter(b => /\d+$/.test(b.getAttribute('data-functional-selector')) && !/submit/i.test(b.getAttribute('data-functional-selector')));
        }
        return btns.sort((a, b) => btnIndex(a) - btnIndex(b));
    }
    const btnIndex = b => +(b.getAttribute('data-functional-selector').match(/(\d+)$/) || [0, 0])[1];

    function readQuestionIndex() {
        const el = $('[data-functional-selector="question-index-counter"]') ||
            $('[data-functional-selector*="question-index"]') ||
            $('[data-functional-selector*="question-counter"]');
        if (!el) return -1;
        const m = el.textContent.match(/\d+/);
        return m ? +m[0] - 1 : -1;
    }

    function readQuestionText() {
        const el = $('[data-functional-selector="block-title"]') ||
            $('[data-functional-selector*="question-title"]') ||
            $('[data-functional-selector*="block-title"]');
        return el ? norm(el.textContent) : '';
    }

    // Visible text on an answer button (empty when the host hides answers on player devices).
    function buttonText(btn) {
        const clone = btn.cloneNode(true);
        clone.querySelectorAll('svg, [aria-hidden="true"]').forEach(n => n.remove());
        return norm(clone.textContent);
    }

    const isMultiSelect = () => !!$('[data-functional-selector="multi-select-submit-button"]');

    // ------------------------------------------------------------------ answer sources
    // Each source returns the on-screen positions (0-based) of the correct buttons, or null.

    function fromQuiz(scr) {
        if (!state.quiz) return null;
        const qs = state.quiz.questions;
        let q = null;
        if (scr.text) {
            // With visible question text, only trust a text match; a mismatch means it's a different quiz.
            const matches = qs.filter(x => x.text && x.text === scr.text);
            if (matches.length === 1) q = matches[0];
            else if (matches.length > 1) {
                q = matches.reduce((a, b) => Math.abs(a.index - scr.index) <= Math.abs(b.index - scr.index) ? a : b);
            }
        } else if (scr.index >= 0 && scr.index < qs.length) {
            q = qs[scr.index];
        }
        if (!q || !q.choices.length) return null;
        scr.quizQuestion = q;

        // Answer order may be randomised per player: match on text first, fall back to position.
        const correct = [];
        scr.answers.forEach((t, pos) => {
            let c = t && q.choices.find(c => c.text === t);
            if (!c && t) c = q.choices.find(c => c.text && (c.text.includes(t) || t.includes(c.text)));
            if (!c) c = q.choices[scr.btnIdx[pos]];
            if (c && c.correct) correct.push(pos);
        });
        return correct.length ? correct : null;
    }

    const fingerprint = scr => scr.text + '|' + scr.answers.slice().sort().join('|');

    function fromCache(scr) {
        if (!scr.text || scr.answers.some(a => !a)) return null;
        const hit = state.cache[fingerprint(scr)];
        if (!hit) return null;
        const correct = scr.answers.map((t, i) => hit.includes(t) ? i : -1).filter(i => i >= 0);
        return correct.length ? correct : null;
    }

    function remember(scr, positions) {
        if (!scr.text || scr.answers.some(a => !a)) return;
        state.cache[fingerprint(scr)] = positions.map(i => scr.answers[i]);
        const keys = Object.keys(state.cache);
        if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach(k => delete state.cache[k]);
        store.set('answerCache', state.cache);
    }

    // Find the public quiz the host is running by searching for the on-screen question text.
    async function autoDetect(scr) {
        if (state.detectTried.has(scr.text)) return false;
        state.detectTried.add(scr.text);
        const results = await searchQuizzes(scr.text, 8);
        const loaded = await Promise.all(results.map(r => loadQuiz(r.id).then(q => ({ r, q })).catch(() => null)));
        let best = null, bestScore = 0;
        for (const item of loaded) {
            if (!item) continue;
            const q = item.q.questions.find(x => x.text === scr.text);
            if (!q) continue;
            // Score: matching answer texts, plus a bonus when the question number lines up.
            const texts = new Set(q.choices.map(c => c.text));
            let score = 1 + scr.answers.filter(a => a && texts.has(a)).length;
            if (q.index === scr.index) score += 2;
            if (score > bestScore) { best = item; bestScore = score; }
        }
        if (!best) return false;
        state.quiz = best.q;
        ui.quizLoaded(best.r.id, 'Auto-detected');
        return true;
    }

    async function askClaude(scr) {
        const multi = isMultiSelect();
        const options = scr.answers.map((a, i) => `${i + 1}. ${a}`).join('\n');
        const prompt = `Kahoot quiz question${multi ? ' (multiple correct answers possible)' : ''}:\n${scr.text}\n\nOptions:\n${options}\n\n` +
            (multi ? 'Reply with only the numbers of ALL correct options, comma-separated.' : 'Reply with only the number of the correct option.');

        const body = {
            model: state.model,
            max_tokens: 16,
            system: 'You answer quiz questions instantly. Output only option numbers, nothing else.',
            messages: [{ role: 'user', content: prompt }],
            output_config: { effort: 'low' },
        };
        if (state.model === 'claude-haiku-5-5') body.thinking = { type: 'disabled' };
        else if (state.model === 'claude-sonnet-5-5') body.thinking = { type: 'between_tools' };
        else body.max_tokens = 2048; // Opus 5.5 always thinks; leave room before the answer

        const res = await request('POST', 'https://api.anthropic.com/v1/messages', {
            headers: {
                'content-type': 'application/json',
                'x-api-key': state.apiKey,
                'anthropic-version': '2023-06-01',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify(body),
            timeout: 20000,
        });
        if (res.stop_reason === 'refusal') throw new Error('model declined');
        const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join(' ');
        const picks = [...new Set((text.match(/\d+/g) || []).map(n => +n - 1))]
            .filter(i => i >= 0 && i < scr.answers.length);
        if (!picks.length) throw new Error('no answer in reply');
        return multi ? picks : [picks[0]];
    }

    // Open the TLS connection early so the first AI answer doesn't pay for the handshake.
    function warmUp() {
        if (!state.useAI || !state.apiKey) return;
        request('GET', 'https://api.anthropic.com/v1/models?limit=1', {
            headers: { 'x-api-key': state.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        }).then(() => ui.aiStatus('API key OK'), e => ui.aiStatus('API key problem: ' + e.message));
    }

    // ------------------------------------------------------------------ resolution
    async function resolve(scr) {
        const done = (positions, source) => {
            if (state.screen !== scr || scr.correct) return;
            scr.correct = positions; scr.source = source;
            if (source === 'quiz') remember(scr, positions);
            act(scr);
        };

        let r = fromQuiz(scr);
        if (r) return done(r, 'quiz');
        r = fromCache(scr);
        if (r) return done(r, 'cache');

        const canAI = state.useAI && state.apiKey && scr.text && scr.answers.every(Boolean);
        const tries = [];
        if (canAI) {
            scr.status = 'Asking Claude…';
            tries.push(askClaude(scr).then(p => done(p, 'AI'), e => { scr.status = 'AI failed: ' + e.message; }));
        }
        // Auto-detect runs alongside the AI; if it finds the quiz it overrides an AI guess.
        // Auto answer holds off clicking an AI guess until this settles (see act()).
        if (state.autoDetect && scr.text && !state.detectTried.has(scr.text)) {
            scr.detecting = true;
            tries.push(autoDetect(scr).then(found => {
                if (!found || state.screen !== scr) return;
                const q = fromQuiz(scr);
                if (!q) return;
                const changed = !scr.correct || scr.source === 'AI';
                if (changed) { scr.correct = null; done(q, 'quiz'); }
            }).catch(() => { /* search failures are non-fatal */ }).finally(() => {
                scr.detecting = false;
                if (state.screen === scr && scr.correct) act(scr);
            }));
        }
        if (!tries.length) {
            scr.status = !scr.text || !scr.answers.every(Boolean)
                ? 'Question/answer text not shown on your screen — load the quiz by ID.'
                : 'No source: load a quiz or add an API key.';
        }
        await Promise.all(tries);
    }

    // ------------------------------------------------------------------ actions
    function clearTimers() { state.timers.forEach(clearTimeout); state.timers = []; }
    const clearHighlights = () => $$('[data-kahack]').forEach(el => el.removeAttribute('data-kahack'));

    function highlight(scr) {
        if (!scr.correct) return;
        answerButtons().forEach((btn, pos) => {
            const v = scr.correct.includes(pos) ? 'correct' : 'wrong';
            if (btn.getAttribute('data-kahack') !== v) btn.setAttribute('data-kahack', v);
        });
    }

    // Kahoot scoring: points = 1000 * (1 - (responseTime / questionTime) / 2)
    function delayForPoints(scr) {
        const time = scr.quizQuestion ? scr.quizQuestion.time : 20000;
        const p = Math.min(1000, Math.max(500, state.targetPoints));
        return Math.max(0, time * 2 * (1 - p / 1000));
    }

    function act(scr) {
        if (state.showAnswers) highlight(scr);
        if (!state.autoAnswer || scr.acted) return;
        if (scr.source === 'AI' && scr.detecting) return; // a real quiz match may still arrive
        scr.acted = true;
        const wait = Math.max(0, scr.startedAt + delayForPoints(scr) - Date.now());
        const click = pos => { const b = answerButtons()[pos]; if (b) b.click(); };
        if (isMultiSelect()) {
            state.timers.push(setTimeout(() => {
                scr.correct.forEach((pos, i) => state.timers.push(setTimeout(() => click(pos), i * 60)));
                state.timers.push(setTimeout(clickSubmit, scr.correct.length * 60 + 100));
            }, wait));
        } else {
            state.timers.push(setTimeout(() => click(scr.correct[0]), wait));
        }
    }

    function clickSubmit() {
        const btn = $('[data-functional-selector="multi-select-submit-button"]') ||
            $$('button').find(b => /^(submit|send)$/i.test(b.textContent.trim()));
        if (btn) btn.click();
    }

    // Questions with no buttons to click; just surface the answer in the panel.
    function describeQuizAnswer(q) {
        if (!q) return '';
        if (q.type === 'slider' && q.range) return 'Answer: ' + q.range.correct + (q.range.tolerance ? ' (±' + q.range.tolerance + ')' : '');
        if (q.type === 'jumble') return 'Order: ' + q.choices.map(c => c.text).join(' → ');
        const correct = q.choices.filter(c => c.correct).map(c => c.text || '[image]');
        if (q.type === 'open_ended') return 'Accepted: ' + correct.join(' / ');
        return '';
    }

    const SOURCE_LABEL = { quiz: '✔ quiz match', cache: '✔ remembered', AI: '🤖 AI guess' };

    function tick() {
        const btns = answerButtons();
        if (!btns.length) {
            if (state.screen) { state.screen = null; clearTimers(); }
            // Type-answer / slider / puzzle: show the answer from a loaded quiz if we can place it.
            const idx = readQuestionIndex();
            const q = state.quiz && idx >= 0 ? state.quiz.questions[idx] : null;
            ui.hint(state.showAnswers ? describeQuizAnswer(q) : '');
            return;
        }

        const answers = btns.map(buttonText);
        const text = readQuestionText();
        const index = readQuestionIndex();
        const key = index + '|' + text + '|' + answers.join('|');

        if (!state.screen || state.screen.key !== key) {
            clearTimers();
            clearHighlights();
            state.screen = {
                key, text, index, answers, btnIdx: btns.map(btnIndex),
                startedAt: Date.now(), correct: null, source: null, status: '', acted: false, detecting: false, quizQuestion: null,
            };
            resolve(state.screen);
        }

        const scr = state.screen;
        if (scr.correct) {
            if (state.showAnswers) highlight(scr); else clearHighlights();
            const names = scr.correct.map(i => scr.answers[i] || ('#' + (i + 1)));
            ui.hint(state.showAnswers || state.autoAnswer ? `${SOURCE_LABEL[scr.source]}: ${names.join(' | ')}` : '');
        } else {
            ui.hint(scr.status);
        }
        ui.progress(index);
    }

    // ------------------------------------------------------------------ UI
    const ui = (() => {
        const host = document.createElement('div');
        host.style.cssText = 'position:fixed;top:16px;left:16px;z-index:2147483647;';
        const root = host.attachShadow({ mode: 'open' });
        root.innerHTML = `
<style>
  :host { all: initial; }
  .panel { width: 310px; font: 14px/1.4 system-ui, Montserrat, Arial, sans-serif; color: #fff;
           background: #381272; border-radius: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.4); overflow: hidden; }
  .bar { display: flex; align-items: center; background: #26084f; padding: 8px 10px; cursor: grab; user-select: none; }
  .bar b { flex: 1; }
  .bar button { background: none; border: 0; color: #fff; font-size: 16px; cursor: pointer; padding: 0 6px; }
  .body { padding: 10px 12px 12px; display: grid; gap: 9px; }
  .min .body { display: none; }
  label.sec, summary { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; opacity: .75; }
  summary { cursor: pointer; }
  details > div { display: grid; gap: 8px; margin-top: 8px; }
  input[type=text], input[type=password], select {
      width: 100%; box-sizing: border-box; padding: 7px 9px; border-radius: 8px; border: 2px solid transparent;
      font: inherit; color: #111; background: #fff; outline: none; }
  input.ok { border-color: #26890c; } input.bad { border-color: #e21b3c; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .tog { position: relative; width: 42px; height: 24px; flex: none; }
  .tog input { opacity: 0; width: 0; height: 0; }
  .tog span { position: absolute; inset: 0; background: #6b5a8c; border-radius: 12px; transition: .2s; cursor: pointer; }
  .tog span::before { content: ""; position: absolute; width: 18px; height: 18px; left: 3px; top: 3px; background: #fff; border-radius: 50%; transition: .2s; }
  .tog input:checked + span { background: #26890c; }
  .tog input:checked + span::before { transform: translateX(18px); }
  input[type=range] { width: 100%; accent-color: #26890c; }
  .results { max-height: 170px; overflow: auto; display: grid; gap: 4px; }
  .results:empty { display: none; }
  .results button { text-align: left; background: #4b2189; color: #fff; border: 0; border-radius: 6px; padding: 6px 8px; cursor: pointer; font: inherit; }
  .results button:hover { background: #5d2ea6; }
  .results small, .small { display: block; font-size: 12px; opacity: .75; }
  .hint { font-size: 13px; background: rgba(0,0,0,.28); border-radius: 6px; padding: 6px 8px; word-break: break-word; }
  .hint:empty { display: none; }
</style>
<div class="panel">
  <div class="bar"><b>KaHack!</b><button class="min-btn" title="Minimise">–</button><button class="close-btn" title="Close (Alt+X)">✕</button></div>
  <div class="body">
    <div class="hint"></div>
    <div class="row">Show answers <label class="tog"><input type="checkbox" class="show"><span></span></label></div>
    <div class="row">Auto answer <label class="tog"><input type="checkbox" class="auto"><span></span></label></div>
    <div>
      <label class="sec">Target points: <span class="pts"></span></label>
      <input type="range" class="ppt" min="500" max="1000" step="5">
    </div>
    <details>
      <summary>Quiz</summary>
      <div>
        <input type="text" class="q" placeholder="Quiz ID / URL, or a title + Enter">
        <div class="results"></div>
        <div class="row">Auto-detect public quiz <label class="tog"><input type="checkbox" class="detect"><span></span></label></div>
        <span class="small quiz-status">No quiz loaded.</span>
      </div>
    </details>
    <details class="ai-sec">
      <summary>AI fallback (Claude)</summary>
      <div>
        <div class="row">Use AI when no quiz match <label class="tog"><input type="checkbox" class="ai"><span></span></label></div>
        <input type="password" class="key" placeholder="Anthropic API key (sk-ant-…)">
        <select class="model"></select>
        <span class="small ai-status"></span>
      </div>
    </details>
    <span class="small">Alt+H hide · Alt+X close</span>
  </div>
</div>`;

        const el = s => root.querySelector(s);
        const panel = el('.panel'), input = el('.q'), results = el('.results'), quizStatus = el('.quiz-status'),
            hintEl = el('.hint'), show = el('.show'), auto = el('.auto'), detect = el('.detect'), ai = el('.ai'),
            key = el('.key'), model = el('.model'), aiStatus = el('.ai-status'), ppt = el('.ppt'), pts = el('.pts');

        Object.entries(MODELS).forEach(([id, label]) => model.add(new Option(label, id)));
        show.checked = state.showAnswers;
        auto.checked = state.autoAnswer;
        detect.checked = state.autoDetect;
        ai.checked = state.useAI;
        key.value = state.apiKey;
        model.value = state.model;
        ppt.value = state.targetPoints;
        pts.textContent = state.targetPoints;
        if (!state.apiKey) el('.ai-sec').open = true;

        const bindToggle = (box, prop) => box.onchange = () => { state[prop] = box.checked; store.set(prop, box.checked); };
        bindToggle(show, 'showAnswers');
        bindToggle(auto, 'autoAnswer');
        bindToggle(detect, 'autoDetect');
        bindToggle(ai, 'useAI');
        show.addEventListener('change', () => { if (!show.checked) clearHighlights(); });
        ai.addEventListener('change', warmUp);
        key.onchange = () => { state.apiKey = key.value.trim(); store.set('apiKey', state.apiKey); warmUp(); };
        model.onchange = () => { state.model = model.value; store.set('model', model.value); };
        ppt.oninput = () => { state.targetPoints = +ppt.value; pts.textContent = ppt.value; store.set('targetPoints', +ppt.value); };

        async function useQuiz(id) {
            input.className = 'q';
            results.innerHTML = '';
            quizStatus.textContent = 'Loading…';
            try {
                state.quiz = await loadQuiz(id);
                api.quizLoaded(id, 'Loaded');
            } catch (e) {
                state.quiz = null;
                input.classList.add('bad');
                quizStatus.textContent = 'Could not load quiz (' + e.message + '). It may be private.';
            }
        }

        async function search(q) {
            results.innerHTML = '';
            quizStatus.textContent = 'Searching…';
            try {
                const list = await searchQuizzes(q);
                quizStatus.textContent = list.length ? 'Pick the quiz your host is running:' : 'No results.';
                list.forEach(r => {
                    const b = document.createElement('button');
                    b.textContent = r.title;
                    const s = document.createElement('small');
                    s.textContent = `${r.count} questions${r.creator ? ' · by ' + r.creator : ''}`;
                    b.appendChild(s);
                    b.onclick = () => { input.value = r.id; useQuiz(r.id); };
                    results.appendChild(b);
                });
            } catch (e) {
                quizStatus.textContent = 'Search failed (' + e.message + ').';
            }
        }

        // Keep Kahoot's own key handlers out of our text boxes.
        [input, key].forEach(i => i.addEventListener('keydown', e => e.stopPropagation()));
        input.addEventListener('keydown', e => {
            if (e.key !== 'Enter') return;
            const v = input.value.trim();
            if (!v) return;
            const m = v.match(UUID_RE);
            m ? useQuiz(m[0]) : search(v);
        });
        input.addEventListener('input', () => {
            const m = input.value.match(UUID_RE);
            if (m) useQuiz(m[0]);
        });

        // Dragging
        const bar = el('.bar');
        let drag = null;
        bar.addEventListener('pointerdown', e => {
            if (e.target.tagName === 'BUTTON') return;
            const r = host.getBoundingClientRect();
            drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
            bar.setPointerCapture(e.pointerId);
        });
        bar.addEventListener('pointermove', e => {
            if (!drag) return;
            host.style.left = Math.max(0, e.clientX - drag.dx) + 'px';
            host.style.top = Math.max(0, e.clientY - drag.dy) + 'px';
        });
        bar.addEventListener('pointerup', () => { drag = null; });

        el('.min-btn').onclick = () => panel.classList.toggle('min');
        const close = () => {
            state.autoAnswer = false; state.showAnswers = false; state.useAI = false; state.autoDetect = false;
            clearTimers(); clearHighlights(); host.remove();
        };
        el('.close-btn').onclick = close;

        document.addEventListener('keydown', e => {
            if (!e.altKey) return;
            if (e.code === 'KeyH') host.style.display = host.style.display === 'none' ? '' : 'none';
            if (e.code === 'KeyX') close();
        }, true);

        document.body.appendChild(host);

        let lastProgress = null;
        const api = {
            quizLoaded(id, how) {
                input.value = id;
                input.className = 'q ok';
                lastProgress = null;
                quizStatus.textContent = `${how}: "${state.quiz.title}" (${state.quiz.questions.length} questions)`;
            },
            progress(idx) {
                if (!state.quiz || idx === lastProgress) return;
                lastProgress = idx;
                quizStatus.textContent = `"${state.quiz.title}" — question ${idx >= 0 ? idx + 1 : '-'} / ${state.quiz.questions.length}`;
            },
            hint(text) { if (hintEl.textContent !== text) hintEl.textContent = text; },
            aiStatus(text) { aiStatus.textContent = text; },
        };
        return api;
    })();

    // Highlight styles live in the page (outside the shadow root) so they reach Kahoot's buttons.
    // Attribute-based so React re-renders of className/style don't wipe them.
    const css = document.createElement('style');
    css.textContent = `
      [data-kahack="correct"] { outline: 6px solid #00e05a !important; outline-offset: -6px; filter: none !important; }
      [data-kahack="wrong"]   { opacity: .35 !important; filter: grayscale(.6) !important; }
    `;
    document.head.appendChild(css);

    warmUp();

    // ------------------------------------------------------------------ loop
    let queued = false;
    const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; tick(); }); } };
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(tick, 250);
})();
