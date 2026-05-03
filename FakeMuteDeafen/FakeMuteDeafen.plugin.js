/**
 * @name Fake Mute&Deafen
 * @author TSB Inc.
 * @description Speak while Muted and Hear anyone while Deafened
 * @version 1.0.1
 * @authorLink https://github.com/TheScaryBoy
 * @website https://github.com/TheScaryBoy/BetterDiscord-Plugins
 * @source https://github.com/TheScaryBoy/BetterDiscord-Plugins/tree/main/FakeMuteDeafen
 * @updateUrl https://raw.githubusercontent.com/TheScaryBoy/BetterDiscord-Plugins/main/FakeMuteDeafen/FakeMuteDeafen.plugin.js
 * @runAt document-start
 */
module.exports = class FakeMuteDeafen {

    getName()        { return "Fake Mute&Deafen"; }
    getDescription() { return "Speak while Muted and Hear anyone while Deafened"; }
    getVersion()     { return "1.0.1"; }
    getAuthor()      { return "TSB Inc."; }

    // Discord webpack module IDs — update these if Discord changes them
    static M = { DISPATCHER: 228366, GATEWAY: 587626, AUDIO: 827343, STORE: 51760 };

    constructor() {
        this.enabled          = false;
        this.lockedMute       = false;
        this.lockedDeafen     = false;
        this._volumeReduction = 30;
        this._origVolume      = null;
        this._keybind         = null;
        this._keyHandler      = null;
        this._glowTimer       = null;
        this._toggleObserver  = null;
        this._cleanupButton   = null;
        this._resizeHandler   = null;
        // Patch originals
        this._origDispatch         = null;
        this._origVoiceStateUpdate = null;
        // Cached modules
        this._wpRequire  = null;
        this._dispatcher = null;
        this._vsStore    = null; // voice state store
        this._me         = null; // MediaEngineStore
        this._user       = null; // current user
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    _load(key, fallback) {
        try { const v = BdApi.Data.load(this.getName(), key); if (v != null) return v; } catch (_) {}
        return fallback;
    }
    _save(key, val) { try { BdApi.Data.save(this.getName(), key, val); } catch (_) {} }

    get _wp() {
        return this._wpRequire ??= window.webpackChunkdiscord_app?.push([[Symbol()], {}, r => r]);
    }
    _mod(id) { return this._wp?.(id); }

    get _flux() {
        return this._dispatcher ??= this._mod(FakeMuteDeafen.M.DISPATCHER)?.h ?? null;
    }
    get _store() {
        return this._me ??= this._mod(FakeMuteDeafen.M.STORE)?.Ay ?? null;
    }

    _voiceState() {
        this._vsStore ??= BdApi.Webpack.getModule(m => m?.getVoiceStateForUser);
        this._user    ??= BdApi.Webpack.getModule(m => m?.getCurrentUser)?.getCurrentUser();
        const vs = this._vsStore?.getVoiceStateForUser(this._user?.id);
        return { mute: !!vs?.selfMute, deaf: !!vs?.selfDeaf };
    }

    // ─── Volume ───────────────────────────────────────────────────────────────
    // Discord UI scale is non-linear below 100 (empirically: 50→78, 25→61)
    // UI = 100 * (internal/100)^0.3585 for internal ≤ 100, linear above

    _toUI(v)  { return v <= 0 ? 0 : v <= 100 ? Math.round(100 * Math.pow(v / 100, 0.3585)) : v; }
    _fromUI(v){ return v <= 0 ? 0 : v <= 100 ? Math.round(100 * Math.pow(v / 100, 1 / 0.3585)) : v; }

    _setVolume(internal) { this._mod(FakeMuteDeafen.M.AUDIO)?.A?.setOutputVolume(internal); }

    // ─── Keybind ──────────────────────────────────────────────────────────────

    _keybindLabel() {
        if (!this._keybind) return "None";
        const { ctrl, shift, alt, key } = this._keybind;
        return [ctrl && "Ctrl", shift && "Shift", alt && "Alt", key?.toUpperCase()].filter(Boolean).join("+");
    }

    _setupKeybind() {
        this._keybind = this._load("keybind", null);
        if (this._keyHandler) { document.removeEventListener("keydown", this._keyHandler, true); this._keyHandler = null; }
        if (!this._keybind) return;
        this._keyHandler = e => {
            const kb = this._keybind;
            if (e.key?.toLowerCase() === kb.key?.toLowerCase()
                && !!e.ctrlKey === !!kb.ctrl && !!e.shiftKey === !!kb.shift && !!e.altKey === !!kb.alt)
                { e.preventDefault(); this.toggle(); }
        };
        document.addEventListener("keydown", this._keyHandler, true);
    }

    // ─── Glow indicators ──────────────────────────────────────────────────────

    _applyGlow() {
        const GLOW = "drop-shadow(0 0 6px #ed4245) drop-shadow(0 0 12px #ed4245)";
        const set = (sel, on) => {
            const svg = document.querySelector(sel);
            if (svg) { svg.style.filter = on ? GLOW : ""; svg.style.color = on ? "#ed4245" : ""; }
        };
        const on = this.enabled;
        set('[aria-label*="Mute"] svg, [aria-label*="mute"] svg',     on && this.lockedMute);
        set('[aria-label*="Deafen"] svg, [aria-label*="deafen"] svg', on && this.lockedDeafen);
    }

    _startGlow() { this._applyGlow(); this._glowTimer = setInterval(() => this._applyGlow(), 800); }
    _stopGlow()  { clearInterval(this._glowTimer); this._glowTimer = null; this._applyGlow(); }

    // ─── Toggle ───────────────────────────────────────────────────────────────

    toggle() {
        if (!this.enabled) {
            this.enabled = true;
            const vs = this._voiceState();
            this.lockedMute   = vs.mute;
            this.lockedDeafen = vs.deaf;
            // Save and reduce volume
            this._origVolume = this._store?.getOutputVolume() ?? null;
            if (this._origVolume !== null) {
                const targetUI = Math.round(this._toUI(this._origVolume) * (100 - this._volumeReduction) / 100);
                this._setVolume(this._fromUI(targetUI));
            }
            this._startGlow();
            if (!this.lockedMute && !this.lockedDeafen)
                BdApi.UI.showToast("FakeMD: Mute/Deafen yourself first, then enable.", { type: "warning", timeout: 4000 });
        } else {
            this.enabled = this.lockedMute = this.lockedDeafen = false;
            if (this._origVolume !== null) { this._setVolume(this._origVolume); this._origVolume = null; }
            this._stopGlow();
        }
        this._save("enabledState", this.enabled);
        this._updateBtn();
        const kb = this._keybind ? ` [${this._keybindLabel()}]` : "";
        BdApi.UI.showToast(`Fake Mute/Deafen: ${this.enabled ? "ENABLED" : "DISABLED"}${kb}`,
            { type: this.enabled ? "error" : "success" });
    }

    // ─── Patches ──────────────────────────────────────────────────────────────

    _patch() {
        // Socket patch: force selfMute/selfDeaf:true in gateway packets when locked
        const socket = this._mod(FakeMuteDeafen.M.GATEWAY)?.A?.getSocket?.();
        if (socket?.voiceStateUpdate) {
            this._origVoiceStateUpdate = socket.voiceStateUpdate.bind(socket);
            socket.voiceStateUpdate = payload => {
                if (this.enabled) {
                    if (this.lockedMute)   payload = { ...payload, selfMute: true };
                    if (this.lockedDeafen) payload = { ...payload, selfDeaf: true };
                }
                return this._origVoiceStateUpdate(payload);
            };
            this._socket = socket;
        } else {
            console.error("[FakeMD] Gateway socket not found.");
        }

        // Dispatcher patch: track when locks should be set
        if (this._flux) {
            this._origDispatch = this._flux.dispatch.bind(this._flux);
            this._flux.dispatch = action => {
                if (this.enabled) {
                    if (action?.type === "AUDIO_TOGGLE_SELF_MUTE" && !this._voiceState().mute)   this.lockedMute   = true;
                    if (action?.type === "AUDIO_TOGGLE_SELF_DEAF" && !this._voiceState().deaf) this.lockedDeafen = true;
                }
                return this._origDispatch(action);
            };
        } else {
            console.error("[FakeMD] Dispatcher not found.");
        }
    }

    _unpatch() {
        if (this._socket && this._origVoiceStateUpdate)
            this._socket.voiceStateUpdate = this._origVoiceStateUpdate;
        this._socket = this._origVoiceStateUpdate = null;

        if (this._flux && this._origDispatch)
            this._flux.dispatch = this._origDispatch;
        this._origDispatch = null;
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────

    start() {
        this._volumeReduction = this._load("volumeReduction", 30);
        this.enabled          = this._load("enabledState", false);
        this._patch();
        this._setupKeybind();
        this._addBtn();
        if (this.enabled) {
            const vs = this._voiceState();
            this.lockedMute = vs.mute; this.lockedDeafen = vs.deaf;
            this._startGlow();
        }
    }

    stop() {
        this._unpatch();
        if (this._keyHandler) document.removeEventListener("keydown", this._keyHandler, true);
        this._stopGlow();
        if (this._origVolume !== null) { this._setVolume(this._origVolume); this._origVolume = null; }
        this._removeBtn();
        this.enabled = this.lockedMute = this.lockedDeafen = false;
    }

    // ─── Settings panel ───────────────────────────────────────────────────────

    getSettingsPanel() {
        const el = (tag, props, ...children) => {
            const e = Object.assign(document.createElement(tag), props);
            children.forEach(c => e.appendChild(typeof c === "string" ? Object.assign(document.createElement("span"), { textContent: c }) : c));
            return e;
        };
        const section = title => el("div", { textContent: title, style: "font-size:12px;font-weight:700;text-transform:uppercase;color:var(--header-secondary);margin:16px 0 8px;" });
        const hint    = text  => el("div", { textContent: text,  style: "font-size:12px;color:var(--text-muted);margin-bottom:8px;" });

        const panel = el("div", { style: "padding:16px;color:var(--text-normal);font-family:var(--font-primary);" });

        // Keybind
        const kbDisplay = el("div", { textContent: this._keybindLabel(), style: "padding:6px 12px;background:var(--background-secondary);border-radius:4px;min-width:140px;text-align:center;font-size:14px;border:1px solid var(--background-modifier-accent);" });
        const kbBtn     = el("button", { textContent: "Set Keybind", style: "padding:6px 12px;background:var(--brand-experiment);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:14px;" });
        const kbClear   = el("button", { textContent: "Clear",       style: "padding:6px 12px;background:var(--background-secondary);color:var(--text-normal);border:1px solid var(--background-modifier-accent);border-radius:4px;cursor:pointer;font-size:14px;" });

        let listening = false;
        kbBtn.onclick = () => {
            if (listening) return;
            listening = true; kbDisplay.textContent = "Press any key..."; kbBtn.textContent = "Listening..."; kbBtn.style.background = "#ed4245";
            const onKey = e => {
                e.preventDefault(); e.stopPropagation();
                if (["Control","Shift","Alt","Meta"].includes(e.key)) return;
                this._keybind = { key: e.key, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
                this._save("keybind", this._keybind);
                this._setupKeybind();
                kbDisplay.textContent = this._keybindLabel(); kbBtn.textContent = "Set Keybind"; kbBtn.style.background = "var(--brand-experiment)"; listening = false;
                document.removeEventListener("keydown", onKey, true);
            };
            document.addEventListener("keydown", onKey, true);
        };
        kbClear.onclick = () => { this._keybind = null; this._save("keybind", null); this._setupKeybind(); kbDisplay.textContent = "None"; };

        panel.appendChild(section("Keybind"));
        panel.appendChild(el("div", { style: "display:flex;align-items:center;gap:8px;margin-bottom:4px;" }, kbDisplay, kbBtn, kbClear));
        panel.appendChild(hint("Avoid keys Discord already uses (e.g. Ctrl+Shift+M). Try Alt+F or Ctrl+Alt+D."));

        // Volume
        const volLabel = el("div", { textContent: `-${this._volumeReduction}%`, style: "min-width:48px;font-size:14px;font-weight:600;color:#ed4245;" });
        const slider   = el("input", { type: "range", min: "0", max: "100", step: "5", value: String(this._volumeReduction), style: "flex:1;accent-color:#ed4245;" });
        slider.oninput = () => {
            this._volumeReduction = parseInt(slider.value);
            this._save("volumeReduction", this._volumeReduction);
            volLabel.textContent = `-${this._volumeReduction}%`;
        };
        panel.appendChild(section("Volume Reduction on Enable"));
        panel.appendChild(el("div", { style: "display:flex;align-items:center;gap:12px;margin-bottom:4px;" }, slider, volLabel));
        panel.appendChild(hint("Reduces output volume by this % when enabled. Restored on disable."));

        return panel;
    }

    // ─── Floating button ──────────────────────────────────────────────────────

    _updateBtn() {
        const btn = document.getElementById(`${this.getName()}-toggle`);
        if (!btn) return;
        const c = this.enabled ? "#ed4245" : "#3ba55d";
        btn.style.boxShadow = `0 0 12px ${c}`; btn.style.border = `2px solid ${c}`;
    }

    _addBtn() {
        const ensure = () => {
            const id = `${this.getName()}-toggle`;
            if (document.getElementById(id)) return;
            const pos    = this._load("buttonPosition", { x: 1, y: 95 }); // % from left/bottom
            const left   = Math.round((pos.x ?? 1)  / 100 * window.innerWidth);
            const bottom = Math.round((pos.y ?? 95) / 100 * window.innerHeight);
            const c   = this.enabled ? "#ed4245" : "#3ba55d";
            const btn = document.createElement("div");
            btn.id = id;
            btn.style.cssText = `position:fixed;bottom:${bottom}px;left:${left}px;width:32px;height:32px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:move;z-index:9999;user-select:none;background:rgba(0,0,0,0.6);backdrop-filter:blur(5px);transition:box-shadow 0.2s,border 0.2s,transform 0.2s;box-shadow:0 0 12px ${c};border:2px solid ${c};`;
            btn.innerHTML = `<img src="https://em-content.zobj.net/source/apple/391/skull_1f480.png" style="width:18px;height:18px;pointer-events:none;" draggable="false">`;
            btn.title = `Drag to move | Click or ${this._keybindLabel()} to toggle`;

            let drag = false, t0, x0, y0, b0, l0;
            const onDown = e => { drag=true; t0=Date.now(); x0=e.clientX; y0=e.clientY; b0=parseInt(btn.style.bottom)||0; l0=parseInt(btn.style.left)||0; btn.style.cursor="grabbing"; btn.style.transition="none"; e.stopPropagation(); e.preventDefault(); };
            const onMove = e => { if (!drag) return; btn.style.left=Math.max(0,Math.min(window.innerWidth-32,l0+e.clientX-x0))+"px"; btn.style.bottom=Math.max(0,Math.min(window.innerHeight-32,b0-e.clientY+y0))+"px"; };
            const onUp   = e => { if (!drag) return; drag=false; btn.style.cursor="move"; btn.style.transition="box-shadow 0.2s,border 0.2s,transform 0.2s"; e.stopPropagation(); this._save("buttonPosition",{x:(parseInt(btn.style.left)||0)/window.innerWidth*100,y:(parseInt(btn.style.bottom)||0)/window.innerHeight*100}); if(Date.now()-t0<200&&Math.hypot(e.clientX-x0,e.clientY-y0)<5)this.toggle(); };

            btn.addEventListener("mousedown", onDown);
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
            btn.addEventListener("mouseenter", () => btn.style.transform = "scale(1.15)");
            btn.addEventListener("mouseleave", () => btn.style.transform = "scale(1)");
            btn.addEventListener("contextmenu", e => { e.preventDefault(); e.stopPropagation(); });
            document.body.appendChild(btn);
            this._cleanupButton = () => { btn.removeEventListener("mousedown",onDown); document.removeEventListener("mousemove",onMove); document.removeEventListener("mouseup",onUp); btn.remove(); };
        };
        ensure();
        this._toggleObserver?.disconnect();
        this._toggleObserver = new MutationObserver(ensure);
        this._toggleObserver.observe(document.body, { childList: true, subtree: true });

        // Reposition button as % of window on resize (handles moving to different resolution monitor)
        this._resizeHandler = () => {
            const btn = document.getElementById(`${this.getName()}-toggle`);
            if (!btn) return;
            const pos = this._load("buttonPosition", { x: 1, y: 95 });
            btn.style.left   = Math.round((pos.x ?? 1)  / 100 * window.innerWidth)  + "px";
            btn.style.bottom = Math.round((pos.y ?? 95) / 100 * window.innerHeight) + "px";
        };
        window.addEventListener("resize", this._resizeHandler);
    }

    _removeBtn() {
        this._toggleObserver?.disconnect(); this._toggleObserver = null;
        if (this._resizeHandler) { window.removeEventListener("resize", this._resizeHandler); this._resizeHandler = null; }
        this._cleanupButton?.(); this._cleanupButton = null;
        document.getElementById(`${this.getName()}-toggle`)?.remove();
    }
};
